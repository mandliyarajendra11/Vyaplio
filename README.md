# Vyaplio · व्याप्लियो

Hindi-first shop-operations PWA for retail shops: fast sales, stock, udhaar (credit) ledger,
low-stock / expiry / dead-stock alerts and WhatsApp sharing. Local-first (IndexedDB via Dexie) –
works with **no backend and no internet**. Optional Supabase cloud sync (email login, multi-phone recovery) and
offline backup files (plain or password-locked JSON) protect the data if a phone is lost.

The app was previously named DukaanMitra. Its internal database, authentication and backup-format identifiers remain unchanged to preserve existing accounts and shop data. Existing local sample shops remain on their original devices; public demo creation is disabled.

## Bill discounts

Item and whole-bill discounts are available at checkout in rupees or percent (including Hindi digits).
An item's rupee discount applies to its whole selected quantity, not each unit. Item discounts apply
first; the bill discount applies to the remaining subtotal. Percentage discounts follow quantity changes;
fixed rupee discounts stay fixed and must be corrected if they exceed the new item total.
The draft keeps the input; a completed bill stores each item's share of the discount in paise.
Payments, profit and partial returns use the amount after discount, while original prices and
stock quantities stay unchanged. Repeat baskets start at current prices without reusing an old
discount. Backup version 7 preserves discounts and still reads earlier backups. Update all linked
devices to this release before using discounts; older app builds do not understand the new line field.
The combined `discount` field remains compatible with version 7's return calculations; `itemDiscount`
records the item-only share for the receipt breakdown. Removing an item clears its draft discount.
At checkout, **Round bill to nearest rupee** is optional and saved with the draft. It applies
after item and bill discounts, moves the final payable amount by at most 50 paise, and appears
on shared/printed bills. Payment, profit, credit and partial returns use the rounded amount.
The round-off is distributed across sale lines so returning every line reverses every paise.
Backup format v8 preserves this adjustment and reads earlier versions. Update linked devices
before using rounding; older builds do not know the new line field.

## Printable sales receipts

After saving a sale, or opening an existing bill, choose **Print / save receipt**.
Preview in the current Hindi/English language, select A4, 80 mm or 58 mm, then open the device's
print dialog (including Save as PDF where supported). Select the matching paper in the printer
settings and disable browser headers/footers. Thermal widths constrain the content; roll length
and paper cutting are controlled by the printer driver. Physical printer alignment still needs
device testing. This is a sales receipt, not a GST tax invoice.

Receipts are generated locally without remote fonts or resources. They include returned quantities,
net amounts, pending UPI and available refund history, but never purchase costs or profit.
Receipt regression tests: `node tests/receipt.test.cjs` (also included in `npm test`).

## Run

The current paid-pilot work is tracked in [PILOT_BACKLOG.md](PILOT_BACKLOG.md).
Admin setup and paid account provisioning are described in [ADMIN_SETUP.md](ADMIN_SETUP.md).

```bash
npm install
npm run dev
# open http://localhost:3001
```

On the local development server, `/login` shows **Preview shop without login** and **Preview admin dashboard**. Both are temporary sample previews. The shop preview saves only local demo data; the admin preview cannot create accounts. These entry points are disabled outside local development.

Public demo creation and displayed demo credentials are disabled. A seller can continue using an existing local sample shop on their own device.

Production / PWA test (service worker is registered only in production builds):

```bash
npm run build && npm start
```

On Android Chrome open the site (HTTPS or localhost) → menu ⋮ → *Add to Home screen*.

## Routes

| Route | What |
| --- | --- |
| `/` | Home: today's ₹, 3 alert chips, 4 big actions (Sale / Stock / Udhaar / Alerts) |
| `/sale` | Fast sale: search / voice (hi-IN) / barcode → packs: +1 per tap (whole-number stepper); loose goods: weight / ₹ picker (100 g · 250 g · 500 g · 1 kg or g / kg keypad; *₹ से*: ₹10 · 20 · 50 · 100 or keypad, “₹20 = 440 ग्राम”) → cash / UPI / credit → confirm → WhatsApp bill |
| `/sales` | Bills: today / yesterday / this week / this month / all or a date range, payment + status filters, search (customer, phone, bill no., item, ₹), range summary, WhatsApp, CSV of the selection; open any bill to return / cancel / share |
| `/stock` | Inventory CRUD (packed / loose, loose step, MRP, *opens into* loose item + pack size), ± stock by the item's step, low-stock threshold, expiry, barcode, supplier; *पैक खोलें → खुला माल* on linked packs |
| `/udhaar` | Customers (udhaar and cash, with phone / address / landmark), balances, ledger (gave / received), WhatsApp reminder, link to the customer page and to orders |
| `/customer` | `?id=` one customer: address / landmark (edit), udhaar summary, *repeat last bill* (one tap → sale cart), saved baskets (bill / order / edit / delete), their orders, their bills |
| `/basket` | Basket editor: `?customer=` builds a basket by hand, `?id=` edits one (name, items, quantities) |
| `/orders` | Customer orders (WhatsApp): status filters (pending / new / packing / ready / on the way / done / cancelled / all), CSV (orders, baskets); `?id=` = one order: packing checklist (tick, packed qty), status steps, bill sheet at the billing point, WhatsApp confirm / ready / out / packing-list links, cancel, history. Reached from Home (small line when something is pending), Sale, Udhaar and More |
| `/orders/new` | New order: paste the customer's WhatsApp text (Hinglish / Hindi / English lines read with the voice matcher), pick or ignore unrecognised lines, or load a basket / the last bill; choose *bill when packed* or *bill at delivery*; `?customer=&basket=&repeat=1` |
| `/hisaab` | Honest profit report: today / this week / this month / a date range – net sales, cost coverage (“रक़म के 82% बिक्री का मुनाफ़ा पता है”), gross margin, expenses + damage/theft, earned after expenses, udhaar vs collected, items missing a buy price (add it in place), top / low-margin items, plain-language lines, WhatsApp, CSV |
| `/closeout` | Three-step evening check: today's sales and udhaar collected, pending UPI and stock alerts, simple cash count and close, then a manually sent WhatsApp summary. Home's Galla card opens this screen. |
| `/firstweek` | Five-step first-week checklist: priced products, a practice bill that saves nothing, shelf stock check, real backup/cloud sync and first cash close. Skip/resume is device-local; Home shows it until complete and More keeps a link. |
| `/pricing` | Public Hindi/English offer: ₹2,999 yearly or ₹11,000 lifetime for one shop, same core features. WhatsApp purchase enquiries go to the seller's +91 9993904447 number (overridable with `NEXT_PUBLIC_SALES_WHATSAPP`). This page does not take payment or activate access. |
| `/galla` | Detailed daily cash closing (आज का गल्ला): opening, cash in/out, expenses, count by notes, corrections, past closings, WhatsApp, CSV |
| `/alerts` | Low stock (+ WhatsApp order list), expiring / expired, dead stock |
| `/suppliers` | Supplier diary (सप्लायर डायरी): suppliers, total owed, overdue; `?id=` = one supplier: balance + due badge, pay (cash → galla, UPI separate), purchase, WhatsApp order, return / debit note, adjustment with reason, open bills, full ledger; CSV (suppliers, purchases, ledger). Reached from Stock and More |
| `/purchase` | Purchase bill: supplier, date, bill no., lines (qty × buy price), total, paid now cash / UPI / rest on credit, due date from terms; `?order=` receives a WhatsApp order |
| `/order` | Order low / short stock per supplier: suggested qty = reorder target − stock (editable), opens `wa.me` to the supplier (you press send), saved as “ordered”; `?supplier=` for a manual order |
| `/more` | Shop profile, language, cloud link + sync status, backup file make/restore, recovery help + backup reminder + recovery card, app lock (PIN), CSV export, offline status, install, reset demo, logout |
| `/login`, `/setup`, `/restore` | Shop or server-verified admin login, plans for new shops, and existing-shop recovery from cloud or a validated backup file. Public demo creation and new-shop setup are disabled pending paid activation. |

## Key files

- `src/lib/db.ts` – Dexie schema (users, shops, products, customers, sales, ledger, corrections, stock moves, outbox, meta)
- `src/lib/ops.ts` – all writes (sale + stock decrement + ledger in one transaction, outbox queue)
- `src/lib/seed.ts` – demo shop data · `src/lib/alerts.ts` – alert rules
- `src/lib/sync.ts` – outbox push (only server-confirmed rows leave the queue) + paged pull (last-write-wins)
- `src/lib/syncSchema.ts` – local ↔ Postgres column mapping · `src/lib/cloud.ts` – Supabase Auth, link shop, recover on a new phone
- `src/lib/backup.ts` – backup file create / validate / preview / restore
- `src/lib/payments.ts` – split payments (parts, auto-fill, change, UPI link, refund caps/plan, CSV) · `src/components/PaymentPanel.tsx` – checkout payment block · `src/components/PendingUpiSheet.tsx` – confirm / convert pending UPI
- `src/lib/cash.ts` – cash drawer day math, append-only drawer entries, close / correct, WhatsApp text, CSV · `src/app/(shop)/galla/page.tsx` – the screen
- `src/lib/bills.ts` – bill date presets / ranges, filters, search, URL ↔ filter, indexed query + summary, CSV rows
- `src/lib/profit.ts` – honest margin: cost snapshot, coverage, returns, expenses + losses, item lists · `src/lib/report.ts` – range loading, plain-language lines, WhatsApp, CSV · `src/app/(shop)/hisaab/page.tsx` – the report screen
- `src/components/StockAdjustSheet.tsx` – reasoned stock count / correction + recent stock history · `src/lib/stockHistory.ts` – stock history CSV
- `supabase/schema.sql` – Postgres tables, triggers (last-write-wins, delete wins) + RLS (one shop per account)
- `src/lib/orders.ts` – baskets, repeat plan → cart, pasted-text parser, order status machine, bill-once, WhatsApp texts, CSV · `src/app/(shop)/orders`, `orders/new`, `customer`, `basket` pages, `src/components/OrderBits.tsx`
- `src/lib/suppliers.ts` – supplier balance, dues, purchase / payment / return / order writes, CSV · `src/lib/supplierMigrate.ts` – free text → supplier records · `src/app/(shop)/suppliers`, `purchase`, `order` pages, `src/components/SupplierSheets.tsx`
- `tests/mock-supabase.cjs` – local fake Supabase (Auth + PostgREST + RLS rules) used by `tests/cloud-sync.test.cjs`
- `src/lib/onboarding.ts` – setup steps (state machine, validation, resumable draft) · `src/lib/starter.ts` – starter product lists per shop type · `src/lib/setupShop.ts` – creates the shop in one transaction
- `src/lib/pin.ts` – app PIN (PBKDF2 hash, attempts + backoff) · `src/lib/lock.ts` – lock state / background re-lock · `src/components/PinLock.tsx` – lock screen + forgot PIN
- `src/lib/backupReminder.ts` – last backup + reminder · `src/lib/recoveryCard.ts` – secret-free recovery card · `src/lib/actor.ts` – "who" name for corrections / drawer entries
- `src/lib/units.ts` – packed vs loose rules (kind from unit, steps, valid quantities, ₹ → qty, line totals, pro-rata returns, g / ml formatting, product CSV) · `src/components/WeightPicker.tsx` – weight / ₹ picker · `src/components/OpenPackSheet.tsx` – open packs into loose stock · `src/components/SaleQuantity.tsx` – bill-line quantity
- `src/messages/{hi,en}.json` – next-intl messages (Hindi default)
- `public/sw.js` – hand-written service worker · `src/app/manifest.ts` – web manifest

## Cloud sync with Supabase (optional)

Without keys the app is fully local; nothing is sent anywhere. To turn on cloud backup + multi-phone recovery:

1. **Create the project** – sign in at <https://supabase.com/dashboard> → *New project* → pick a name, a database
   password and the region nearest your shops (e.g. *Mumbai / ap-south-1*) → *Create new project*. Wait until it is ready.
2. **Create the tables** – in the project open *SQL Editor* → *New query* → paste the whole content of
   `supabase/schema.sql` → *Run*. It should finish with "Success. No rows returned". The script is re-runnable
   (safe to run again after an app update). Check *Table Editor*: `shops, products, customers, sales, sale_items,
   credit_ledger, sale_corrections, stock_moves` exist, each with RLS enabled.
3. **Email login** – *Authentication → Sign In / Providers → Email* must be enabled (it is by default).
   - "Confirm email" ON (recommended for real use): after *Create cloud account* the shopkeeper must tap the link
     in the email, then sign in. Set *Authentication → URL Configuration → Site URL* to the app's public URL so the
     link opens the app.
   - For a quick test you may turn "Confirm email" OFF so sign-up signs in immediately.
   - SMS recovery is available after a cloud-linked shop verifies its mobile number in *More → Cloud backup & sync*.
     Enable Phone Auth and configure an SMS provider under *Authentication → Providers → Phone* first. New-phone
     recovery sends an OTP only to an existing account (`shouldCreateUser: false`), then asks for a local password
     so the restored shop can be opened offline. Test with a real number before offering this to pilot shops.
4. **Keys** – *Project Settings → API* (or *Data API*): copy the **Project URL** (`https://<ref>.supabase.co`) and the
   **anon / publishable key**. Never use the `service_role` / secret key in the app.
5. **Configure the app** – copy `.env.example` to `.env.local` and fill in both values, then rebuild:
   `npm run build && npm start` (`NEXT_PUBLIC_*` values are baked in at build time; `npm run dev` picks them up on restart).
6. **Link the shop** – in the app: *More → Cloud backup & sync* → create a cloud account / sign in → the shop and all
   its history upload. The panel shows what is still waiting ("# changes waiting to reach the server"), the last
   sync time and the real error if the server refused something. The demo shop cannot be linked.
7. **New / second phone** – open the app → *Bring your shop to a new phone* → same cloud email + password. The whole
   shop downloads (stock, udhaar, bills, returns); later the same email/password also logs in offline.

How sync stays honest: every change is queued in the phone's outbox with a client-generated UUID. Upserts are
idempotent (`on conflict (id)`), append-only history (`credit_ledger`, `sale_corrections`, `stock_moves`) is
`insert … on conflict do nothing`, and an item leaves the queue only after the server returns that row id. Stock,
udhaar balances and bill status are re-derived from the history after each download, so two phones selling at the
same time add up. Edits to the same product/customer are last-write-wins by `updated_at`; a product delete always wins.

## Stock discrepancies (selling more than recorded)

The counter is never blocked: a sale of more than the recorded stock goes through, the cart shows a gentle
warning first, and stock goes **below zero** instead of being silently clamped. The sale's stock move records
`shortBy` (how much was sold beyond the record), so the shortage is part of the history and syncs like any other
move. Below-zero items get a red "रिकॉर्ड से ज़्यादा बिका" badge on the stock list, a "गड़बड़" filter, a
"स्टॉक में गड़बड़" (Stock mismatch) chip on Home and a section at the top of `/alerts`.

Fixing it is a reasoned correction, never an overwrite: *Stock count / correction* (tap the quantity on `/stock`,
the button in the item form, or *गिनती / सुधार* on `/alerts`) records a move with reason `count` (enter the counted
quantity; the move is the difference), `damage`, `theft` or `purchase` (arrived but not entered), plus an optional
note. Editing an item's details no longer changes its quantity. Two phones overselling the same item while
offline both end with the same negative stock after sync, and one count on either phone fixes both.
*More → CSV → Stock history / corrections* exports every move (reason, change, short_by, counted, note, value).
Low stock covers 0…threshold, below-zero items are listed under the mismatch instead; expiry and dead-stock
alerts ignore items not on the shelf; profit is per sale (sell − buy price) and is not affected by the stock level.

## Split payments, change and UPI confirmation

Checkout stays one tap: pick नकद / UPI / उधार and confirm. *भुगतान बाँटें* (Split payment) lets one bill be paid by any
mix of cash + UPI + udhaar: switch the methods on, type amounts, and the one box left empty takes the remainder
(the status line says what is still unassigned or typed too much). An udhaar part needs a customer, and only that
part goes on the customer's ledger.

*Cash*: optional "cash handed over" with quick notes (₹10…₹2000, tapping again adds) and *पूरे छुट्टे* (exact);
the change is shown big as **लौटाना ₹X** (also on the success screen and saved on the bill).
*UPI*: shows a QR and an "Open in UPI app" link (`upi://pay` with the shop's UPI ID from *More → shop details*,
the exact amount and `cu=INR`; drawn by the bundled `uqr` encoder, so it works offline). Nothing is assumed:
the shopkeeper taps **पैसे आ गए** (optional UTR / last digits) or **बाद में देखेंगे**. A pending UPI part shows on
Home, on today's bills and at the top of `/alerts` until it is confirmed, or converted to cash or udhaar.

Data: `sales.payments` = `[{method, amount, status, tendered, change, ref, confirmedAt, convertedFrom}]` and
`payment` = the single method or `split`. Bills from before (Dexie v5 upgrade, cloud rows with `payments` NULL,
v1 backup files) are read as one paid part of their old method – nothing is rewritten on the server.
Returns / cancellations split the refund (`sale_corrections.refunds`): pending UPI is reduced first (that money
never arrived), then the chosen route up to what that route can give back – udhaar up to the bill's remaining
udhaar part, cash/UPI up to the money actually received – then the rest. The udhaar part posts a `return`
credit on the ledger. Today's totals, the day's WhatsApp summary, bill WhatsApp text and the bills/corrections
CSVs (cash, upi, upi_pending, credit, cash_tendered, change, upi_ref, refund_split) show the breakdown.
Cash/UPI refunds never go beyond what that method brought in on the bill (so the day's cash or UPI does not go
negative); refunding through a method beyond that needs the explicit *पूरा … से ही लौटाएँ* tick, shows a warning and
is recorded as `cross_method`. Backups are format v2 (v1 files still restore). Re-run `supabase/schema.sql` to add `payments` / `refunds` and
allow `split`.

## Daily cash closing (आज का गल्ला)

`/galla` (bottom nav *गल्ला*, and the card on Home) shows one day of the cash drawer:

- **Opening** = the last counted closing of an earlier day (carried forward, with its date). Changing it needs a reason.
- **Cash in**: cash parts of bills (money kept, i.e. net of change – what customers handed over and the change are
  shown under it), udhaar payments received in cash, and *cash added*. **Cash out**: cash refunds, expenses
  (category + note), supplier payments (name, optional `supplierId` for the coming supplier diary), owner
  withdrawals and bank deposits. **Expected = opening + cash in − cash out.**
- **UPI** (bills, udhaar received by UPI, UPI refunds, still-pending UPI) is shown apart – it is not in the drawer.
  The udhaar screen now asks *नकद (गल्ले में)* / *UPI* when money is received (`credit_ledger.method`).
- **Count**: by notes (₹2000…₹10 + coins) or a plain total; the difference shows as कम / ज़्यादा with an optional reason;
  *दिन बंद करें* saves counted, expected, difference and the note counts.
- A closed day is locked. *सुधार करें* (with a reason) allows entries, a re-count (new close) or re-opening (voiding the
  close); everything is logged. Bills, payments or entries that arrive after the day was closed are flagged as late
  and the screen shows how far the expected cash moved since closing.
- Past closings, WhatsApp day summary, CSV of days and of all drawer entries (also *More → Export*).

Data: `cash_entries` (Dexie v6) – append-only rows of kind `opening | added | expense | supplier | withdrawal | bank |
void | close`; a correction is a new row (a `void` points at the row it cancels). Expenses keep `category`, so profit
after expenses can be computed later. Synced like the other append-only tables (re-run `supabase/schema.sql`: new
table + CHECKs + RLS, `credit_ledger.method`, `sale_corrections.cross_method`). Backups are format v3 (v1/v2 files
still restore). Known limit: a pending UPI later converted to cash counts in the drawer of the bill's day.

## Older bills and search (/sales)

Chips *आज / कल / इस हफ़्ते / इस महीने / सभी* or *तारीख चुनें* (from–to). Days are the phone's calendar days (IST in
India): a bill at 11:58 pm is that day's, 12:00 am starts the next; weeks start on Monday. Filters (any of):
payment नकद / UPI (received) / उधार / बँटा भुगतान / UPI बाकी, and status चालू / कुछ वापसी / रद्द / *गल्ला बंद होने के बाद*
(bill entered after that day's drawer was closed). Search matches customer name, phone digits, bill number
(`#A1B2C3`, first 6 letters of the id – also shown on each bill and in the WhatsApp bill), item name (Hindi or
English) and amount (₹, commas and Hindi digits allowed).

The summary follows the selection: with only dates, it is the same day-book as Home / गल्ला (bills of those days,
returns made on those days – a return today on an old bill counts today – and udhaar received). With a filter or
search it shows only the matching bills and their own returns inside the range. CSV exports exactly the selection.

A bill shows its customer (→ their udhaar account); a customer's sheet has *इनके सभी बिल देखें*
(`/sales?range=all&customer=<id>`). The filter lives in the address bar (`range`, `from`, `to`, `pay`, `status`,
`q`, `customer`), so links can be shared or bookmarked and work offline (the service worker serves `/sales` for any
query), and is remembered for the browser tab (sessionStorage). Speed: date ranges use the `[shopId+day]` index, a
customer's bills the new `customerId` index (Dexie v7, index only); 40 bills are drawn at a time (*और बिल दिखाएँ*).

## Hindi search and voice

Product search (sale, stock incl. its कम/एक्सपायरी filters, and bill item search on /sales) understands Hindi,
Roman Hindi and English: `chini` / `cheeni` / `shakkar` / `sugar` all find चीनी, `maggi` finds मैगी and vice versa.
It works offline: `src/lib/translit.ts` turns both scripts into one phonetic key (matras and vowel length, nukta,
anusvara/chandrabindu, aspirates, sh/s, z/j, w/v, common spellings), `src/lib/aliases.ts` has ~100 common kirana
items (Hindi, English, usual Roman spellings), and each product can have its own *दूसरे नाम* (product form; synced as
`products.aliases jsonb`, in backups). Ranking (`src/lib/search.ts`): barcode > exact name > name/word prefix >
contains > alias > fuzzy (edit distance 1, or 2 for long words); best-sellers break ties. Keys are precomputed once
per product list, so 1500 products search in a few ms. With no match the sale screen shows the closest items and
*“…” नया सामान जोड़ें* (opens the stock form with that name, `/stock?add=`).

Voice (mic next to search, Web Speech API): recognition language follows the app (hi-IN / en-IN) with a
हिंदी/English toggle on the mic sheet (remembered), shows the words while you speak, and runs the result (up to 3
alternatives, Hinglish fine) through the same matcher. On the sale screen a spoken quantity is filled in when one
product clearly matches and the unit fits: *do kilo chini* / *दो किलो चीनी* → चीनी 2 kg, *aadha kilo dal*, *ढाई सौ
ग्राम जीरा* (0.25 kg), *sava / saade / paune*, *3 packet maggi*, *ek dozen*; otherwise the words just go into the
search box. Errors are explained in Hindi/English: browser not supported (use Chrome on Android), microphone
blocked (how to allow it), nothing heard, no microphone, language not available, and network – Chrome's recogniser
sends audio to Google's servers, so when offline it says voice needs internet (typing always works). The mic button
is hidden only when the browser has no speech recognition at all.

## Mobile readability

Checked at 320, 360, 375, 390, 412 px, a landscape phone (844×390) and desktop, in Hindi and English, and with
the text at 200%. Font sizes are in rem, so a larger phone/browser font scales the whole UI. Long Hindi labels and
product/customer names wrap (two-line clamp for secondary lines), big ₹ amounts shrink with the screen and break
rather than overflow, rows and grids wrap at narrow widths, the date chips on /sales wrap (no hidden sideways
scroll), the 6-tab bottom nav caps its label size to the column width, and sheets respect safe-area insets and stay
above the on-screen keyboard (`interactive-widget=resizes-content` + the focused field is scrolled into view).
Contrast (WCAG AA): text-only tokens `--mustard-ink` (body) and `--mustard-strong` (large accent text) next to the
mustard fills, slightly darker `--brick`, `--leaf` and WhatsApp `--wa`, disabled buttons as ink-soft on paper-2, a
visible 3px focus ring, all tap targets ≥ 48px, and animations off under *reduce motion*. `tests/readability.test.cjs`
guards the token ratios and the class rules.

## Simpler onboarding, app lock and recovery

**Setup (`/setup`)** opens for an account without a shop: see plans, restore from a backup file,
or bring an existing shop to a new phone through cloud recovery. Public new-shop onboarding is
disabled until paid activation is implemented. The retained onboarding flow asks one question per screen with
a progress bar — language, shop name, your name, phone, shop type, starter products, UPI ID, PIN, "what if the
phone is lost" — and every step can be skipped (defaults: "मेरी दुकान", kirana, no products, no UPI, no PIN).
Answers are saved on the phone after every change, so closing the app resumes at the same question. The shop
type preloads a starter list from the built-in alias catalogue (kirana, general, dairy, medical, stationery,
vegetables) with typical units; tick what you stock and optionally type price / opening stock (opening stock
becomes an `opening` stock move). Phone (10-digit Indian mobile) and UPI ID (`name@bank`) are validated. Existing
shops never see setup again; nothing in the database was changed for them.

**App lock (PIN)**: optional 4 digits, set during setup or in More → App lock. Only a random salt +
PBKDF2-SHA-256 hash (150k iterations, WebCrypto) is stored, on this phone (`meta` table — never synced, never in
backup files). The app asks for it on every start and after being in the background longer than the chosen time
(immediately / 1 / 5 / 15 / 30 min). 5 free tries, then waits of 30 s, 1 min, 2 min… (max 15 min), counted on disk
so a reload does not reset them. "Forgot PIN" asks for the account password and removes only the PIN; without the
password it explains the cloud / backup-file routes and offers sign-out — data is never wiped. A password sign-in
opens the app. Insecure (plain http LAN) pages cannot make a PIN (no WebCrypto) and say so.

**Who**: corrections and drawer entries record the signed-in person's own name (asked in setup), falling back to
the shop's owner name for older accounts, then the email — never the shop name.

**Recovery**: plain guidance in setup and in More (phone lost, WhatsApp the backup file to yourself, how cloud
helps, PIN is not a backup), the last backup (file shared/saved or a successful cloud sync), a reminder every
3 / 7 / 14 / 30 days shown on Home ("remind me tomorrow" snoozes a day; never for the demo shop), and a recovery
card (shop name + ID, account email, cloud email, where backups are, steps) to send to yourself on WhatsApp or
print. It holds no password, PIN or keys.

## Honest profit (/hisaab)

Home's margin line, the bills summary and `/hisaab` (Home → मुनाफ़ा, *More → हिसाब*) use one set of rules
(`src/lib/profit.ts`, loaded by `src/lib/report.ts`):

- **Cost snapshot per bill line.** At sale time each line stores `cost` (the buy price then), `costKnown` and
  `costAt` (when that buy price was entered; products keep `buyPriceAt`). A product with no buy price (0, e.g.
  starter items from setup) gives `costKnown: false` – never "cost 0 = 100% margin". Returns copy `costKnown` onto
  the correction line.
- **Old data.** Lines saved before this (no `costKnown`) are read with one rule: cost > 0 = known, cost 0 =
  unknown. Nothing is rewritten and the database version stays 7, so old bills, synced rows and backup files keep
  working. Old damage/theft moves without a saved cost are valued at today's buy price and marked "estimate".
- **Coverage.** Margin = net sales − cost of goods sold over known-cost lines only; returns reverse their own line's
  value and cost (an older bill is looked up). The share of net sales with a known cost is shown as a whole %
  that never rounds an incomplete figure up to 100; Home and the bills summary show a ⚠ marker below 100%.
- **Missing / suspicious costs.** Sold items without a buy price are listed with *खरीद दाम डालें*: it sets the
  product's buy price and, by default, fills the older bill lines that had none (`costFilled`, shown as
  "filled in later (estimate)"; lines that had a cost are never changed). Buy price above the selling price and
  buy prices older than 90 days (`STALE_COST_DAYS`) are flagged; under 10% margin is listed as low.
- **Earned after expenses** = gross margin − galla expenses (by category, voided ones left out) − damage/theft
  at cost (the move stores `unitCost`; no buy price = listed, not valued). Owner withdrawals, supplier payments and
  bank deposits are shown as *not expenses*. Udhaar: collected (cash + UPI) vs on credit, with the approximate
  margin not yet in hand; udhaar received in the period is shown as old money, not new profit.
- Ranges reuse the bills screen's presets and local (IST) days; `?range=week` / `?from=&to=` deep links; the page
  is cached for offline use. WhatsApp summary and a CSV (summary rows, items, missing-cost items, losses).
- Cloud: `products.buy_price_at`, `stock_moves.unit_cost`, `sale_items.cost_known` (schema.sql is re-runnable);
  the line snapshot travels inside `sales.items`. Backups carry the same fields and validate them.

## Supplier diary (सप्लायर डायरी)

- **Suppliers** (name, WhatsApp phone, items, payment terms in days, notes). Opening the app after the update
  (Dexie v8) turns every free-text product supplier and every named galla “supplier payment” into a supplier
  record – same name (case/space-insensitive) = one supplier, ids are derived from shop + name so two phones
  migrating separately create the same row. Product text is kept; the product → supplier link is added.
- **Purchase bill** → stock goes up through the stock history (reason *purchase*, ids `pur-<bill>-<n>`, so a
  re-sync never doubles it), the product's buy price is updated (old price kept in `prevBuyPrice`, time in
  `buyPriceAt` – later sales snapshot it for `/hisaab`), cash paid now becomes a galla *supplier payment* (not an
  expense), UPI is only in the diary, the rest is credit with a due date = bill date + terms.
- **Ledger** is append-only: purchase, payment (cash / UPI), return to supplier (debit note, optional stock out),
  adjustment (± with a reason). Balance = purchases − payments − returns ± adjustments. Payments settle the bill
  they were made on, then the oldest due first; the earliest unpaid due drives the badge (late / today / ≤ 3 days).
  Upcoming and late dues show on the Home alerts chip and `/alerts#suppliers`.
- **WhatsApp order** from `/alerts` (low stock) or a supplier's page; reorder target per product
  (“कितना भरना है”, default 2 × low-stock level). The app only opens the link; on delivery tap *माल आया* to
  turn the order into a purchase with the received quantities.
- Old galla supplier payments written before the diary are shown on the supplier page (“डायरी से पहले”) but are
  not counted against purchases, so they don't create a fake advance – add an adjustment if needed.
- Cloud: `suppliers` and `purchase_orders` (last write wins), `purchases` and `supplier_ledger` (append-only),
  `products.supplier_id / reorder_to`, stock reason `supplierReturn` – `supabase/schema.sql` is re-runnable.
  Backup format v4 carries all four tables; v1–v3 files still restore (suppliers rebuilt from names).

## WhatsApp repeat orders (ग्राहक ऑर्डर)

- **Customers**: udhaar and cash customers are the same list; phone, address and landmark are optional. A cash /
  UPI bill keeps its customer when one is chosen (*ग्राहक जोड़ें (वैकल्पिक)* at checkout, or a repeat), so the
  customer's bills (`/sales?customer=`) find cash bills too. Udhaar still needs a customer.
- **Baskets** (`महीने का राशन`, `हफ्ते का दूध` …): per customer, built by hand (`/basket`) or *Save as basket* on any
  bill (what is left after returns). Quantities are editable; delete is a synced tombstone.
- **Repeat bill**: one tap (customer page → basket *बिल बनाएँ* or *पिछला बिल दोबारा*) fills the sale cart at today's
  prices. A banner lists price changes (old → new), items now out of stock / short (item 4 rules: sold anyway,
  shortage recorded) and items no longer sold (skipped). Then the normal checkout (split payments, udhaar).
- **Orders** are not bills: created from a pasted WhatsApp message (lines split on new lines, commas and
  “aur”; `do kilo chini` → चीनी 2 kg via the item-8 matcher; a line is taken only when one product clearly
  matches, otherwise it is shown for a manual pick or ignore and kept on the order), a basket or the last bill.
  Status: new → packing → ready → out for delivery / picked up → delivered, or cancelled (only before the bill).
  Each order says when it becomes a bill: *bill when packed* (on *ready*) or *bill at delivery* (on picked up /
  delivered). Stock moves only with the bill. The bill uses the packed quantities at that moment's prices and the
  usual payment panel; its id is fixed (`<order>-bill`, stock moves `-m<n>`, udhaar `-udhaar`), so a retry or a
  second phone can never bill twice. A billed order cannot be cancelled – correct the bill instead.
- **Packing checklist**: tick each line, change the packed quantity (0 = not available; unticked lines are set
  to 0 after a confirm when marking ready). Locked once ready / billed.
- **WhatsApp**: order confirmation with the estimate, “ready” and “out for delivery” messages to the customer's
  phone and a packing list to share – all `wa.me` links, you press send.
- **Sync / backup**: `baskets` and `customer_orders` (last write wins), `order_events` (append-only status + bill
  history; status is derived = furthest step reached), `customers.address / landmark`, `sales.order_id` –
  `supabase/schema.sql` stays re-runnable. Backup v5 carries them; v1–v4 files restore. CSV: orders, baskets.

## Sealed packs vs loose goods, and “₹20 का सामान”

- **Two kinds** (item 14). *पैक वाला* (packed: पीस / पैकेट / डिब्बा) is sold by count – whole numbers only, optional
  MRP and barcode, expiry per batch. *खुला* (loose: किलो / लीटर) is sold by weight / volume: stock and price are per
  kg / L, quantities are entered in g / kg or ml / L, no MRP. The kind always matches the unit (the product form
  only offers units of the chosen kind; `saveProduct` refuses a mismatch), so existing products were migrated
  without touching stock or prices: kg / ltr → loose, pcs / pkt / box → packed (Dexie v10 sets `kind` locally;
  cloud rows and old backups without a kind are read by unit). A loose item can't be turned into a pack while its
  stock has a fraction.
- **Counter**: one tap on a pack adds 1. One tap on a loose item opens the weight picker (no more “0.5 kg per tap”);
  the + / − step of a loose item is its own setting (100 g / 250 g / 500 g / **1 kg default**), also used by ± on
  the stock screen.
- **Same goods both ways** (1 kg sealed atta packet and loose atta): two products, the pack linked to the loose one
  with a pack size (*खोलने पर बनता है*, *एक पैक में कितना*). *पैक खोलें* records two `openPack` stock moves with the
  same reference and an optional note: −N on the pack, +N × size on the loose item. Like a sale it never blocks:
  opening more packs than on record is recorded with the shortage and the pack stock goes negative (item 4).
- **Sell by amount** (loose only): *₹ से* on the item or the picker's *₹ रकम से* tab – ₹10 / 20 / 50 / 100 or the
  keypad – shows the weight big (“₹20 = 440 ग्राम”). **Rounding: the price is the anchor.** qty = amount ÷ price per
  kg / L, rounded to the nearest **10 g / 10 ml** (stock, bills and the cloud keep two decimals of a kg / L, so 5 g
  steps can't be stored); the bill line keeps both `amount` and the derived `qty`, and its total is exactly the
  amount (₹20 of ₹45/kg chini = 0.44 kg, line ₹20 – not 0.44 × 45 = ₹19.80). Stock and the cost snapshot use the
  derived qty. Returns of such a line are valued pro rata of what was paid (cumulative, so all parts add up to
  exactly the amount). Changing the weight on the bill turns it back into a normal weight line. Packs can't be sold
  by amount: voice says why (“पैक वाला सामान है — गिनती से बिकता है”), a pasted order assumes 1 and flags it.
- **Voice / pasted orders**: “20 rupaye ki chini”, “₹20 का तेल”, “Rs.30 ki dal”, “50 ka atta” (a number ≥ 5 joined
  by ka / ki / ke without a unit) are read as money. Orders and baskets keep the amount; the bill is made for that
  amount at the billing price (qty derived again). Packing a different weight drops the amount; repeat / basket
  carry it.
- **Elsewhere**: purchases accept whole packs / 10 g steps only and an optional per-line batch expiry for packs (the
  product keeps one date: the new batch's when the shelf was empty, otherwise the earlier one); suggested orders
  round up to whole kg / L or whole packs; CSVs carry kind / step / MRP / pack link and “(Rs 20)” on amount lines;
  backup v6 (v1–v5 files restore); `products.kind / step / mrp / loose_id / pack_size` and the `openPack` move
  reason in `supabase/schema.sql`.

## Backup file (no internet needed)

*More → Backup file* makes one `.json` file with the whole shop (optionally AES-GCM encrypted with a password,
PBKDF2 250k) and opens the share sheet (WhatsApp, Files, Drive) or downloads it. *Restore* (on *More* or on the
shop-setup screen of a new account) checks format, checksum and every reference, shows a preview (shop, counts,
udhaar total, warnings) and replaces the shop only after confirmation – nothing is merged and a bad file changes nothing.

## Tests

`npm test` runs the Node tests, including `tests/cloud-sync.test.cjs` which drives the real `@supabase/supabase-js`
against the local mock in `tests/mock-supabase.cjs` (partial failures, lost responses, retries, second-phone
recovery, incremental pull, tombstones, backup round-trip) and `tests/stock-shortage.test.cjs` (oversell →
negative → return → corrections, and two phones overselling at once through the mock) and
`tests/split-payments.test.cjs` (split totals, change, pending UPI confirm/convert, returns on split bills,
old bills, backups, two phones syncing split bills through the mock) and `tests/cash-closing.test.cjs` (expected
cash with change, refunds, udhaar cash vs UPI, expenses/withdrawals; per-method refund caps; close/lock, late entries,
re-count/re-open; carry-forward; backup v3/v2; two phones syncing drawer entries through the mock) and `tests/bills-search.test.cjs` (IST day boundaries and
presets, URL filter, search, filters, summaries, a return on an old bill in today's drawer, 5000-bill index timing) and `tests/hindi-search.test.cjs` (phonetic keys, aliases,
ranking and 1500-product timing, spoken quantities, mocked SpeechRecognition errors, custom aliases in sync/backup) `tests/readability.test.cjs` (contrast of theme tokens, tap-target / colour class rules) and `tests/profit.test.cjs` (cost snapshot, coverage, returns reversing cost, expenses + stock losses, udhaar split, add-buy-price fill, flags, migration of old lines, sync/schema/backup fields, ranges, WhatsApp/CSV) and `tests/onboarding.test.cjs` (setup state machine + resume, starter lists, atomic shop creation, PIN hash / verify / backoff, forgot PIN, backup reminder, recovery card, existing-account migration) and `tests/suppliers.test.cjs` (migration without loss, purchase → stock / buy price / galla, partial payments, outstanding + overdue, order → purchase, return to supplier, adjustments, CSV, backup v4 + v3, schema, two phones syncing through the mock) and `tests/orders.test.cjs` (cash customers + address, paste parse incl. “do kilo chini”, basket from bill / by hand / tombstone, repeat with price change + shortage + removed item, status machine, bill once only incl. replays, cancel, CSV, backup v5 + v4, schema, two phones through the mock) and `tests/packs-loose.test.cjs` (Dexie v9 → v10 kind migration with stock / prices unchanged, packed / loose save rules, open pack incl. shortage, ₹ → qty rounding with exact totals, pro-rata returns, “20 rupaye ki chini” / “₹20 का तेल” / “50 ka atta” parsing, orders / baskets / repeat with amounts, reorder + purchases in whole units with batch expiry, CSV, backup v6 + v5, schema / sync, two phones through the mock). To poke the mock by hand: `node tests/mock-supabase.cjs 54329`.
