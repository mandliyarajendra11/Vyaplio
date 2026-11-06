-- Paid-pilot provisioning. Run after schema.sql. Admin identities are added manually in the
-- Supabase SQL editor, after creating their Supabase Auth user:
-- insert into admin_users (user_id) values ('<auth.users.id>');
-- Never put a service-role key or an admin UUID in the browser bundle.

create table if not exists admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  must_change_password boolean not null default false,
  created_at timestamptz not null default now()
);
alter table admin_users add column if not exists must_change_password boolean not null default false;
alter table admin_users enable row level security;
-- No client policies: only the server, using the service role, reads admin_users.

create table if not exists shop_access (
  shop_id text primary key references shops (id) on delete cascade,
  owner_id uuid not null unique references auth.users (id) on delete cascade,
  email text not null,
  plan text not null check (plan in ('yearly', 'lifetime', 'legacy')),
  amount_paid integer not null default 0 check (amount_paid >= 0),
  payment_reference text unique,
  paid_at timestamptz,
  expires_at timestamptz,
  status text not null default 'active' check (status in ('active', 'disabled')),
  must_change_password boolean not null default false,
  created_by uuid references auth.users (id),
  last_action_by uuid references auth.users (id),
  last_action_id uuid,
  created_at timestamptz not null default now(),
  constraint paid_plan_has_payment check (plan = 'legacy' or (paid_at is not null and payment_reference is not null)),
  constraint yearly_has_expiry check (plan <> 'yearly' or expires_at is not null)
);
alter table shop_access add column if not exists last_action_by uuid references auth.users (id);
alter table shop_access add column if not exists last_action_id uuid;
create index if not exists shop_access_expiry_idx on shop_access (expires_at) where status = 'active';
alter table shop_access enable row level security;
drop policy if exists "owner reads access" on shop_access;
create policy "owner reads access" on shop_access for select to authenticated using (owner_id = auth.uid());

-- Existing cloud shops are grandfathered so applying this migration never erases their access.
-- They are visibly marked legacy and contribute zero to paid revenue.
insert into shop_access (shop_id, owner_id, email, plan, status, must_change_password)
select s.id, s.owner_id, coalesce(u.email, ''), 'legacy', 'active', false
from shops s join auth.users u on u.id = s.owner_id
on conflict do nothing;

-- Keep account history on the database side so the account change and its audit
-- record succeed or fail together. No authenticated client can edit this table.
create table if not exists shop_access_audit (
  id bigint generated always as identity primary key,
  shop_id text not null,
  actor_id uuid not null,
  event text not null check (event in ('created', 'activated', 'renewed', 'disabled', 'enabled')),
  old_plan text,
  new_plan text,
  old_status text,
  new_status text,
  old_expires_at timestamptz,
  new_expires_at timestamptz,
  occurred_at timestamptz not null default now()
);
create index if not exists shop_access_audit_shop_time_idx on shop_access_audit (shop_id, occurred_at desc);
alter table shop_access_audit enable row level security;
revoke all on table shop_access_audit from anon, authenticated;

create or replace function record_shop_access_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  actor uuid;
begin
  if tg_op = 'INSERT' then
    if new.plan <> 'legacy' then
      if new.created_by is null then raise exception 'paid account requires an audit actor'; end if;
      insert into shop_access_audit (shop_id, actor_id, event, new_plan, new_status, new_expires_at)
      values (new.shop_id, new.created_by, 'created', new.plan, new.status, new.expires_at);
    end if;
    return new;
  end if;

  if (old.must_change_password and not new.must_change_password)
     or old.status is distinct from new.status
     or old.plan is distinct from new.plan
     or old.expires_at is distinct from new.expires_at then
    actor := new.last_action_by;
    if actor is null or new.last_action_id is null or new.last_action_id is not distinct from old.last_action_id then
      raise exception 'account change requires a fresh audit actor and action id';
    end if;
    if old.must_change_password and not new.must_change_password then
      insert into shop_access_audit (shop_id, actor_id, event, old_plan, new_plan, old_status, new_status, old_expires_at, new_expires_at)
      values (new.shop_id, actor, 'activated', old.plan, new.plan, old.status, new.status, old.expires_at, new.expires_at);
    end if;
    if old.plan is distinct from new.plan or old.expires_at is distinct from new.expires_at then
      insert into shop_access_audit (shop_id, actor_id, event, old_plan, new_plan, old_status, new_status, old_expires_at, new_expires_at)
      values (new.shop_id, actor, 'renewed', old.plan, new.plan, old.status, new.status, old.expires_at, new.expires_at);
    end if;
    if old.status is distinct from new.status then
      insert into shop_access_audit (shop_id, actor_id, event, old_plan, new_plan, old_status, new_status, old_expires_at, new_expires_at)
      values (new.shop_id, actor, case when new.status = 'disabled' then 'disabled' else 'enabled' end, old.plan, new.plan, old.status, new.status, old.expires_at, new.expires_at);
    end if;
  end if;
  return new;
end;
$$;
revoke all on function record_shop_access_audit() from public;
drop trigger if exists shop_access_audit_trigger on shop_access;
create trigger shop_access_audit_trigger after insert or update on shop_access
for each row execute function record_shop_access_audit();

create or replace function has_active_shop_access(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from shop_access a
    where a.owner_id = uid and a.status = 'active' and not a.must_change_password
      and (a.expires_at is null or a.expires_at > now())
  )
$$;
revoke all on function has_active_shop_access(uuid) from public;
grant execute on function has_active_shop_access(uuid) to authenticated, service_role;

-- The original schema gave any cloud signup permission to insert a new shop. Close that path.
drop policy if exists "own shops" on shops;
drop policy if exists "own shops read" on shops;
drop policy if exists "own shops update" on shops;
create policy "own shops read" on shops for select to authenticated
  using (owner_id = auth.uid() and has_active_shop_access(auth.uid()));
create policy "own shops update" on shops for update to authenticated
  using (owner_id = auth.uid() and has_active_shop_access(auth.uid()))
  with check (owner_id = auth.uid() and has_active_shop_access(auth.uid()));
-- No authenticated INSERT or DELETE policy. Provisioning uses a verified server admin action.

create or replace function my_shop_ids() returns setof text
language sql stable security definer set search_path = public as $$
  select id from shops where owner_id = auth.uid() and has_active_shop_access(auth.uid())
$$;
