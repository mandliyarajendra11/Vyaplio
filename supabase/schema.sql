-- DukaanMitra – Supabase / Postgres schema for cloud sync + recovery.
-- The app works fully local (IndexedDB) until NEXT_PUBLIC_SUPABASE_URL / ANON_KEY are set.
-- Run the whole file once in Supabase → SQL Editor (safe to run again).
--
-- Sync rules (mirrors src/lib/sync.ts):
--   * Every id is a client-generated UUID, so every upload is idempotent (a retry never duplicates).
--   * shops / products / customers / sales: upsert, last write wins by updated_at
--     (an older update never overwrites a newer row – see lww_guard()).
--   * credit_ledger / sale_corrections / stock_moves / cash_entries: append-only. Clients use
--     INSERT … ON CONFLICT DO NOTHING; RLS allows insert + select only.
--   * server_updated_at is set by the server on every write; phones pull changes after it.
--   * Stock = sum(stock_moves.delta), udhaar = sum(credit_ledger), bill returns = sum(sale_corrections):
--     the phone recomputes them after a pull, so changes from two phones add up.
--   * Each auth user owns at most one shop (shops.owner_id = auth.uid()).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- tables
create table if not exists shops (
  id text primary key,
  owner_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  owner_name text,
  phone text,
  upi_id text,
  language text not null default 'hi' check (language in ('hi', 'en')),
  dead_stock_days int not null default 30,
  expiry_warn_days int not null default 7,
  is_demo boolean not null default false check (is_demo = false), -- the demo shop is never uploaded
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
create unique index if not exists shops_one_per_owner on shops (owner_id);

create table if not exists products (
  id text primary key,
  shop_id text not null references shops (id) on delete cascade,
  name_hi text not null,
  name_en text,
  barcode text,
  unit text not null default 'pcs' check (unit in ('pcs', 'kg', 'ltr', 'pkt', 'box')),
  qty numeric(12, 2) not null default 0, -- informational; the phone derives stock from stock_moves
  buy_price numeric(12, 2) not null default 0, -- 0 = not entered yet (profit unknown, never "free")
  buy_price_at timestamptz, -- when the buy price was last entered/changed ("old buy price" checks)
  sell_price numeric(12, 2) not null default 0,
  low_stock_at numeric(12, 2) not null default 0,
  expiry_date date,
  supplier text, -- free text as typed (kept); supplier_id links the supplier diary
  supplier_id text,
  reorder_to numeric(12, 3), -- suggested order = reorder_to - stock (empty: 2 x low_stock_at)
  aliases jsonb, -- the shop's own search names ["shakkar", "Tata salt"]; built-in Hindi/English aliases live in the app
  -- Sealed pack vs loose (item 14). kind always matches unit: pcs/pkt/box = packed (whole numbers),
  -- kg/ltr = loose (price per kg / L, stock kept to 10 g / 10 ml). NULL (older rows) = read from unit.
  kind text check (kind in ('packed', 'loose')),
  step numeric(12, 2), -- loose: + / - step in kg / L (0.1 .. 1); NULL = 1
  mrp numeric(12, 2), -- packed: printed MRP per piece / packet
  loose_id text, -- packed: the loose product this pack is opened into (no FK: same shop, may sync later)
  pack_size numeric(12, 2), -- packed: loose quantity one pack gives (in the loose product's unit)
  last_sold_at timestamptz,
  sales_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz, -- tombstone: deleted on a phone, removed from the others on pull
  server_updated_at timestamptz not null default now()
);
create index if not exists products_shop_idx on products (shop_id, server_updated_at);
create index if not exists products_barcode_idx on products (shop_id, barcode);
alter table products add column if not exists aliases jsonb;
alter table products add column if not exists buy_price_at timestamptz;
-- Supplier diary: link to suppliers (no FK: older phones only send the free-text supplier) and
-- the reorder target used for suggested order quantities.
alter table products add column if not exists supplier_id text;
alter table products add column if not exists reorder_to numeric(12, 3);
-- Packs vs loose goods (item 14). Existing rows keep NULL kind and are read by unit (kg/ltr = loose).
alter table products add column if not exists kind text;
alter table products add column if not exists step numeric(12, 2);
alter table products add column if not exists mrp numeric(12, 2);
alter table products add column if not exists loose_id text;
alter table products add column if not exists pack_size numeric(12, 2);
alter table products drop constraint if exists products_kind_check;
alter table products add constraint products_kind_check check (kind is null or kind in ('packed', 'loose'));

create table if not exists customers (
  id text primary key,
  shop_id text not null references shops (id) on delete cascade,
  name text not null,
  phone text,
  address text, -- delivery address (WhatsApp orders)
  landmark text,
  balance numeric(12, 2) not null default 0, -- informational; derived from credit_ledger
  last_paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
create index if not exists customers_shop_idx on customers (shop_id, server_updated_at);
-- Repeat orders: cash customers are saved too, with a delivery address and landmark.
alter table customers add column if not exists address text;
alter table customers add column if not exists landmark text;

create table if not exists sales (
  id text primary key,
  shop_id text not null references shops (id) on delete cascade,
  -- [{productId, nameHi, nameEn, unit, qty, price, cost, costKnown, costAt, costFilled, returnedQty, amount?}]
  -- amount = "₹20 का सामान" (loose only): the line total is exactly amount; qty = amount / price to 10 g.
  -- cost = buy price snapshot at sale time; costKnown false (or missing with cost 0 on old lines) = unknown.
  items jsonb not null default '[]',
  total numeric(12, 2) not null,
  cost numeric(12, 2) not null default 0,
  payment text not null, -- 'cash' | 'upi' | 'credit' | 'split' (several methods: see payments)
  -- Split payments: [{method, amount, status ('paid' | 'pending' UPI), tendered, change, ref, confirmedAt, convertedFrom}].
  -- Sum of amounts = total. NULL on bills made before split payments = one paid part of `payment`.
  payments jsonb,
  customer_id text references customers (id) on delete set null, -- required when a credit (udhaar) part exists
  day date not null,
  -- Bills are never deleted: returns/cancellations set status + returned totals.
  status text not null default 'active' check (status in ('active', 'partially_returned', 'cancelled')),
  returned_total numeric(12, 2) not null default 0,
  returned_cost numeric(12, 2) not null default 0,
  order_id text, -- the customer order this bill came from (id = '<order>-bill')
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  server_updated_at timestamptz not null default now()
);
-- Upgrade a table created by an earlier version of this script (re-runnable).
alter table sales add column if not exists payments jsonb;
alter table sales add column if not exists order_id text;
alter table sales drop constraint if exists sales_payment_check;
alter table sales add constraint sales_payment_check
  check (payment in ('cash', 'upi', 'credit', 'split'));
create index if not exists sales_shop_day_idx on sales (shop_id, day);
create index if not exists sales_shop_sync_idx on sales (shop_id, server_updated_at);

-- One row per bill line for reporting / SQL; filled from sales.items by a trigger (never by the app).
create table if not exists sale_items (
  id text primary key, -- "<sale id>-<line index>"
  sale_id text not null references sales (id) on delete cascade,
  product_id text, -- no FK: a bill keeps its lines even if the product is deleted later
  qty numeric(12, 2) not null,
  price numeric(12, 2) not null,
  cost numeric(12, 2) not null default 0,
  cost_known boolean not null default false, -- false = no buy price was known (cost 0 means unknown, not free)
  returned_qty numeric(12, 2) not null default 0 check (returned_qty >= 0 and returned_qty <= qty)
);
alter table sale_items add column if not exists cost_known boolean not null default false;

create table if not exists credit_ledger (
  id text primary key,
  shop_id text not null references shops (id) on delete cascade,
  customer_id text not null references customers (id) on delete cascade,
  type text not null check (type in ('debit', 'credit')), -- debit = gave udhaar, credit = payment received
  amount numeric(12, 2) not null check (amount > 0),
  note text,
  sale_id text references sales (id) on delete set null,
  kind text check (kind in ('return')), -- 'return' = udhaar reduced by a bill return, not a payment
  method text check (method in ('cash', 'upi')), -- payments received: cash goes into the drawer; NULL on old rows = cash
  correction_id text,
  created_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
alter table credit_ledger add column if not exists method text check (method in ('cash', 'upi'));
create index if not exists ledger_customer_idx on credit_ledger (customer_id, created_at desc);
create index if not exists ledger_shop_sync_idx on credit_ledger (shop_id, server_updated_at);

-- Append-only correction history for bills (returns / cancellations).
create table if not exists sale_corrections (
  id text primary key,
  shop_id text not null references shops (id) on delete cascade,
  sale_id text not null references sales (id) on delete restrict,
  type text not null check (type in ('return', 'cancel')),
  reason text not null check (length(trim(reason)) > 0),
  lines jsonb not null, -- [{index, productId, nameHi, nameEn, unit, qty, price, cost, costKnown, amount?}] (amount: part of a "₹20" line)
  amount numeric(12, 2) not null check (amount >= 0),
  cost numeric(12, 2) not null default 0,
  refund_method text not null check (refund_method in ('cash', 'upi', 'credit')), -- route the shopkeeper chose
  -- How the amount was split: [{method: 'cash'|'upi'|'credit'|'upiPending', amount}]; NULL = all refund_method.
  refunds jsonb,
  cross_method boolean, -- refunded cash/UPI beyond what that method brought in (explicit choice)
  customer_id text references customers (id) on delete set null,
  by_user_id text,
  by_name text,
  day date not null,
  created_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
alter table sale_corrections add column if not exists refunds jsonb;
alter table sale_corrections add column if not exists cross_method boolean;
create index if not exists corrections_sale_idx on sale_corrections (sale_id, created_at);
create index if not exists corrections_shop_day_idx on sale_corrections (shop_id, day);
create index if not exists corrections_shop_sync_idx on sale_corrections (shop_id, server_updated_at);

-- Append-only stock history: stock of a product = sum(delta). Stock may go below zero (a sale is
-- never blocked); short_by records how much a sale exceeded the stock that phone had on record.
-- count / damage / theft / purchase are the shopkeeper's reasoned corrections.
create table if not exists stock_moves (
  id text primary key,
  shop_id text not null references shops (id) on delete cascade,
  product_id text not null, -- no FK: history outlives a deleted product
  delta numeric(12, 2) not null,
  reason text not null,
  ref_id text,
  short_by numeric(12, 2),
  counted numeric(12, 2),
  unit_cost numeric(12, 2), -- damage / theft: buy price per unit at that moment (losses valued at cost)
  note text,
  created_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
-- Upgrade a table created by an earlier version of this script.
alter table stock_moves add column if not exists short_by numeric(12, 2);
alter table stock_moves add column if not exists counted numeric(12, 2);
alter table stock_moves add column if not exists note text;
alter table stock_moves add column if not exists unit_cost numeric(12, 2);
alter table stock_moves drop constraint if exists stock_moves_reason_check;
alter table stock_moves add constraint stock_moves_reason_check
  check (reason in ('opening', 'sale', 'return', 'adjust', 'edit', 'count', 'damage', 'theft', 'purchase', 'supplierReturn', 'openPack'));
create index if not exists stock_moves_shop_sync_idx on stock_moves (shop_id, server_updated_at);
create index if not exists stock_moves_product_idx on stock_moves (product_id);

-- Daily cash closing (गल्ला): append-only drawer entries. Expected cash = opening + cash in − cash out,
-- where bill cash, cash refunds and udhaar cash payments come from sales / sale_corrections / credit_ledger.
-- Nothing is edited: kind 'void' cancels an entry (voids_id + reason), a later 'close' corrects a count.
-- Expenses (category) feed profit-after-expenses; supplier_id is for the supplier diary (no FK yet).
create table if not exists cash_entries (
  id text primary key,
  shop_id text not null references shops (id) on delete cascade,
  day date not null,
  kind text not null,
  amount numeric(12, 2) not null check (amount >= 0),
  category text,
  note text,
  supplier_id text,
  supplier_name text,
  reason text,
  voids_id text,
  expected numeric(12, 2),
  diff numeric(12, 2),
  denoms jsonb, -- close: {"2000": n, "500": n, …, "coins": rupees}
  after_close boolean,
  by_name text,
  created_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
alter table cash_entries drop constraint if exists cash_entries_kind_check;
alter table cash_entries add constraint cash_entries_kind_check
  check (kind in ('opening', 'added', 'expense', 'supplier', 'withdrawal', 'bank', 'void', 'close'));
alter table cash_entries drop constraint if exists cash_entries_category_check;
alter table cash_entries add constraint cash_entries_category_check
  check (category in ('rent', 'electricity', 'salary', 'transport', 'tea', 'packaging', 'repair', 'other'));
create index if not exists cash_entries_shop_day_idx on cash_entries (shop_id, day);
create index if not exists cash_entries_shop_sync_idx on cash_entries (shop_id, server_updated_at);

-- Supplier diary. Suppliers and orders are edited (last write wins). Purchase bills and the supplier
-- ledger are append-only: what we owe = sum(purchase) - sum(payment) - sum(return) + sum(adjust),
-- so entries made on two phones add up. Cash payments also appear in cash_entries (kind 'supplier').
create table if not exists suppliers (
  id text primary key,
  shop_id text not null references shops (id) on delete cascade,
  name text not null,
  phone text,
  items text,
  terms_days integer check (terms_days is null or terms_days between 0 and 365),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
create index if not exists suppliers_shop_sync_idx on suppliers (shop_id, server_updated_at);

create table if not exists purchases (
  id text primary key,
  shop_id text not null references shops (id) on delete cascade,
  supplier_id text not null references suppliers (id) on delete cascade,
  day date not null,
  bill_no text,
  lines jsonb not null default '[]', -- [{productId, nameHi, nameEn, unit, qty, buyPrice, prevBuyPrice?, expiryDate?}]
  total numeric(12, 2) not null check (total >= 0),
  paid_cash numeric(12, 2) not null default 0 check (paid_cash >= 0),
  paid_upi numeric(12, 2) not null default 0 check (paid_upi >= 0),
  credit numeric(12, 2) not null default 0,
  due_date date,
  order_id text,
  note text,
  by_name text,
  created_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
create index if not exists purchases_shop_day_idx on purchases (shop_id, day);
create index if not exists purchases_shop_sync_idx on purchases (shop_id, server_updated_at);

create table if not exists supplier_ledger (
  id text primary key,
  shop_id text not null references shops (id) on delete cascade,
  supplier_id text not null references suppliers (id) on delete cascade,
  type text not null,
  amount numeric(12, 2) not null, -- positive; only 'adjust' may be negative
  day date not null,
  method text,
  purchase_id text,
  cash_entry_id text,
  due_date date,
  bill_no text,
  reason text,
  note text,
  by_name text,
  created_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
alter table supplier_ledger drop constraint if exists supplier_ledger_type_check;
alter table supplier_ledger add constraint supplier_ledger_type_check
  check (type in ('purchase', 'payment', 'return', 'adjust'));
alter table supplier_ledger drop constraint if exists supplier_ledger_method_check;
alter table supplier_ledger add constraint supplier_ledger_method_check
  check (method in ('cash', 'upi'));
create index if not exists supplier_ledger_supplier_idx on supplier_ledger (supplier_id);
create index if not exists supplier_ledger_shop_sync_idx on supplier_ledger (shop_id, server_updated_at);

create table if not exists purchase_orders (
  id text primary key,
  shop_id text not null references shops (id) on delete cascade,
  supplier_id text not null references suppliers (id) on delete cascade,
  lines jsonb not null default '[]', -- [{productId, nameHi, nameEn, unit, qty}]
  status text not null default 'ordered',
  purchase_id text,
  by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
alter table purchase_orders drop constraint if exists purchase_orders_status_check;
alter table purchase_orders add constraint purchase_orders_status_check
  check (status in ('ordered', 'received', 'cancelled'));
create index if not exists purchase_orders_shop_sync_idx on purchase_orders (shop_id, server_updated_at);

-- WhatsApp repeat orders. Baskets and orders (lines + packing checklist) are edited, last write wins;
-- a removed basket keeps deleted_at. The order status is not stored on the order: it comes from the
-- append-only order_events (furthest step reached; 'cancelled' only while no bill exists). An order's
-- bill is sales.id = '<order id>-bill', so it can be made only once even from two phones.
create table if not exists baskets (
  id text primary key,
  shop_id text not null references shops (id) on delete cascade,
  customer_id text not null references customers (id) on delete cascade,
  name text not null,
  lines jsonb not null default '[]', -- [{productId, nameHi, nameEn, unit, qty, price, amount?}] (amount: loose item asked as "₹20 की चीनी")
  from_sale_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now()
);
create index if not exists baskets_shop_sync_idx on baskets (shop_id, server_updated_at);
create index if not exists baskets_customer_idx on baskets (customer_id);

create table if not exists customer_orders (
  id text primary key,
  shop_id text not null references shops (id) on delete cascade,
  customer_id text not null references customers (id) on delete cascade,
  -- [{productId, nameHi, nameEn, unit, qty, price, packed, packedQty, amount?}] (amount: asked as "₹20 की चीनी")
  lines jsonb not null default '[]',
  source text not null default 'manual',
  basket_id text,
  text text, -- the pasted WhatsApp message
  unmatched jsonb, -- pasted lines no product was picked for
  bill_at text not null default 'delivery',
  note text,
  by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
alter table customer_orders drop constraint if exists customer_orders_bill_at_check;
alter table customer_orders add constraint customer_orders_bill_at_check
  check (bill_at in ('packed', 'delivery'));
alter table customer_orders drop constraint if exists customer_orders_source_check;
alter table customer_orders add constraint customer_orders_source_check
  check (source in ('paste', 'basket', 'repeat', 'manual'));
create index if not exists customer_orders_shop_sync_idx on customer_orders (shop_id, server_updated_at);
create index if not exists customer_orders_customer_idx on customer_orders (customer_id);

create table if not exists order_events (
  id text primary key,
  shop_id text not null references shops (id) on delete cascade,
  order_id text not null references customer_orders (id) on delete cascade,
  type text not null,
  status text,
  sale_id text,
  note text,
  by_name text,
  created_at timestamptz not null default now(),
  server_updated_at timestamptz not null default now()
);
alter table order_events drop constraint if exists order_events_type_check;
alter table order_events add constraint order_events_type_check
  check (type in ('status', 'bill'));
alter table order_events drop constraint if exists order_events_status_check;
alter table order_events add constraint order_events_status_check
  check (status is null or status in ('new', 'packing', 'ready', 'out', 'picked', 'delivered', 'cancelled'));
create index if not exists order_events_order_idx on order_events (order_id);
create index if not exists order_events_shop_sync_idx on order_events (shop_id, server_updated_at);

create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  shop_id text not null references shops (id) on delete cascade,
  type text not null,
  product_id text references products (id) on delete cascade,
  customer_id text references customers (id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'dismissed', 'resolved')),
  created_at timestamptz not null default now()
);
alter table alerts drop constraint if exists alerts_type_check;
alter table alerts add constraint alerts_type_check
  check (type in ('low_stock', 'stock_shortage', 'expiry', 'dead_stock', 'udhaar_due'));

-- ---------------------------------------------------------------- triggers
-- Server clock for incremental pulls (phones' clocks may be wrong).
create or replace function touch_server_updated_at() returns trigger language plpgsql as $$
begin
  new.server_updated_at := now();
  return new;
end $$;

-- Last write wins: an upload with an older updated_at keeps the newer row (still answers with it,
-- so the phone counts the row as confirmed and pulls the newer version later).
-- A delete (products.deleted_at) always wins and is final.
create or replace function lww_guard() returns trigger language plpgsql as $$
begin
  if (to_jsonb(old) ->> 'deleted_at') is not null and (to_jsonb(new) ->> 'deleted_at') is null then
    return old;
  end if;
  if (to_jsonb(new) ->> 'deleted_at') is null and old.updated_at is not null and new.updated_at is not null
     and new.updated_at < old.updated_at then
    return old;
  end if;
  new.server_updated_at := now();
  return new;
end $$;

-- sale_items mirror sales.items.
create or replace function sync_sale_items() returns trigger language plpgsql as $$
begin
  delete from sale_items where sale_id = new.id;
  insert into sale_items (id, sale_id, product_id, qty, price, cost, cost_known, returned_qty)
  select new.id || '-' || (ord - 1), new.id, it ->> 'productId', (it ->> 'qty')::numeric, (it ->> 'price')::numeric,
         coalesce((it ->> 'cost')::numeric, 0),
         -- old lines have no costKnown: a cost of 0 there meant "no buy price entered"
         coalesce((it ->> 'costKnown')::boolean, coalesce((it ->> 'cost')::numeric, 0) > 0),
         coalesce((it ->> 'returnedQty')::numeric, 0)
  from jsonb_array_elements(new.items) with ordinality as t(it, ord);
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['shops', 'products', 'customers', 'sales', 'credit_ledger', 'sale_corrections', 'stock_moves', 'cash_entries',
                          'suppliers', 'purchases', 'supplier_ledger', 'purchase_orders', 'baskets', 'customer_orders', 'order_events'] loop
    execute format('drop trigger if exists %I_touch on %I', t, t);
    execute format('create trigger %I_touch before insert on %I for each row execute function touch_server_updated_at()', t, t);
  end loop;
  foreach t in array array['shops', 'products', 'customers', 'sales', 'suppliers', 'purchase_orders', 'baskets', 'customer_orders'] loop
    execute format('drop trigger if exists %I_lww on %I', t, t);
    execute format('create trigger %I_lww before update on %I for each row execute function lww_guard()', t, t);
  end loop;
end $$;
drop trigger if exists sales_items_mirror on sales;
create trigger sales_items_mirror after insert or update of items on sales for each row execute function sync_sale_items();

-- ---------------------------------------------------------------- row level security
alter table shops enable row level security;
alter table products enable row level security;
alter table customers enable row level security;
alter table sales enable row level security;
alter table sale_items enable row level security;
alter table credit_ledger enable row level security;
alter table sale_corrections enable row level security;
alter table stock_moves enable row level security;
alter table cash_entries enable row level security;
alter table suppliers enable row level security;
alter table purchases enable row level security;
alter table supplier_ledger enable row level security;
alter table purchase_orders enable row level security;
alter table baskets enable row level security;
alter table customer_orders enable row level security;
alter table order_events enable row level security;
alter table alerts enable row level security;

-- Shops the signed-in user owns.
create or replace function my_shop_ids() returns setof text language sql stable security definer set search_path = public as $$
  select id from shops where owner_id = auth.uid()
$$;

drop policy if exists "own shops" on shops;
-- New shop creation is a server-side paid provisioning action (see admin.sql).
-- Keep these basic policies for deployments that have not yet run admin.sql; admin.sql
-- replaces them with entitlement-aware versions.
drop policy if exists "own shops read" on shops;
drop policy if exists "own shops update" on shops;
create policy "own shops read" on shops for select to authenticated using (owner_id = auth.uid());
create policy "own shops update" on shops for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "own products" on products;
create policy "own products" on products for all to authenticated using (shop_id in (select my_shop_ids())) with check (shop_id in (select my_shop_ids()));
drop policy if exists "own customers" on customers;
create policy "own customers" on customers for all to authenticated using (shop_id in (select my_shop_ids())) with check (shop_id in (select my_shop_ids()));
drop policy if exists "own sales" on sales;
create policy "own sales" on sales for all to authenticated using (shop_id in (select my_shop_ids())) with check (shop_id in (select my_shop_ids()));
drop policy if exists "own sale items" on sale_items;
create policy "own sale items" on sale_items for all to authenticated
  using (sale_id in (select id from sales where shop_id in (select my_shop_ids())))
  with check (sale_id in (select id from sales where shop_id in (select my_shop_ids())));
drop policy if exists "own alerts" on alerts;
create policy "own alerts" on alerts for all to authenticated using (shop_id in (select my_shop_ids())) with check (shop_id in (select my_shop_ids()));

-- Append-only history: read + insert, never update or delete.
drop policy if exists "own ledger" on credit_ledger;
drop policy if exists "own ledger read" on credit_ledger;
drop policy if exists "own ledger insert" on credit_ledger;
create policy "own ledger read" on credit_ledger for select to authenticated using (shop_id in (select my_shop_ids()));
create policy "own ledger insert" on credit_ledger for insert to authenticated with check (shop_id in (select my_shop_ids()));
drop policy if exists "own corrections read" on sale_corrections;
drop policy if exists "own corrections insert" on sale_corrections;
create policy "own corrections read" on sale_corrections for select to authenticated using (shop_id in (select my_shop_ids()));
create policy "own corrections insert" on sale_corrections for insert to authenticated with check (shop_id in (select my_shop_ids()));
drop policy if exists "own moves read" on stock_moves;
drop policy if exists "own moves insert" on stock_moves;
create policy "own moves read" on stock_moves for select to authenticated using (shop_id in (select my_shop_ids()));
create policy "own moves insert" on stock_moves for insert to authenticated with check (shop_id in (select my_shop_ids()));
drop policy if exists "own cash read" on cash_entries;
drop policy if exists "own cash insert" on cash_entries;
create policy "own cash read" on cash_entries for select to authenticated using (shop_id in (select my_shop_ids()));
create policy "own cash insert" on cash_entries for insert to authenticated with check (shop_id in (select my_shop_ids()));
drop policy if exists "own suppliers" on suppliers;
create policy "own suppliers" on suppliers for all to authenticated using (shop_id in (select my_shop_ids())) with check (shop_id in (select my_shop_ids()));
drop policy if exists "own orders" on purchase_orders;
create policy "own orders" on purchase_orders for all to authenticated using (shop_id in (select my_shop_ids())) with check (shop_id in (select my_shop_ids()));
drop policy if exists "own purchases read" on purchases;
drop policy if exists "own purchases insert" on purchases;
create policy "own purchases read" on purchases for select to authenticated using (shop_id in (select my_shop_ids()));
create policy "own purchases insert" on purchases for insert to authenticated with check (shop_id in (select my_shop_ids()));
drop policy if exists "own supplier ledger read" on supplier_ledger;
drop policy if exists "own supplier ledger insert" on supplier_ledger;
create policy "own supplier ledger read" on supplier_ledger for select to authenticated using (shop_id in (select my_shop_ids()));
create policy "own supplier ledger insert" on supplier_ledger for insert to authenticated with check (shop_id in (select my_shop_ids()));
drop policy if exists "own baskets" on baskets;
create policy "own baskets" on baskets for all to authenticated using (shop_id in (select my_shop_ids())) with check (shop_id in (select my_shop_ids()));
drop policy if exists "own customer orders" on customer_orders;
create policy "own customer orders" on customer_orders for all to authenticated using (shop_id in (select my_shop_ids())) with check (shop_id in (select my_shop_ids()));
drop policy if exists "own order events read" on order_events;
drop policy if exists "own order events insert" on order_events;
create policy "own order events read" on order_events for select to authenticated using (shop_id in (select my_shop_ids()));
create policy "own order events insert" on order_events for insert to authenticated with check (shop_id in (select my_shop_ids()));

-- If paid provisioning was installed earlier, a rerun of this base schema must not reopen
-- cloud access for expired or temporary-password accounts.
do $$
begin
  if to_regclass('public.shop_access') is not null
     and to_regprocedure('public.has_active_shop_access(uuid)') is not null then
    drop policy if exists "own shops read" on shops;
    drop policy if exists "own shops update" on shops;
    create policy "own shops read" on shops for select to authenticated
      using (owner_id = auth.uid() and has_active_shop_access(auth.uid()));
    create policy "own shops update" on shops for update to authenticated
      using (owner_id = auth.uid() and has_active_shop_access(auth.uid()))
      with check (owner_id = auth.uid() and has_active_shop_access(auth.uid()));
    execute 'create or replace function my_shop_ids() returns setof text
      language sql stable security definer set search_path = public as $fn$
        select id from shops where owner_id = auth.uid() and has_active_shop_access(auth.uid())
      $fn$';
  end if;
end $$;
