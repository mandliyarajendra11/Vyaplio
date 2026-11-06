/* eslint-disable @typescript-eslint/no-require-imports -- Node CommonJS test helper. */
/**
 * In-memory fake of the parts of Supabase the app uses (GoTrue auth + PostgREST), driven by the
 * real @supabase/supabase-js client. Table columns, NOT NULL and the sync rules are taken from
 * supabase/schema.sql so the client is tested against the real schema:
 *   - unknown column -> PGRST204, NULL in a NOT NULL column -> 23502, missing parent row -> 23503
 *   - RLS: a user only reads/writes rows of the shop they own (42501 otherwise)
 *   - shops/products/customers/sales/suppliers/purchase_orders/baskets/customer_orders: upsert with last-write-wins on updated_at
 *   - credit_ledger/sale_corrections/stock_moves/cash_entries/purchases/supplier_ledger/order_events: insert-only (an UPDATE on conflict -> 42501)
 *   - server_updated_at stamped by the server; sale_items mirrored from sales.items
 * Fault injection (in-process `faults` array or POST /__mock/faults) simulates outages,
 * partial confirmations and "committed but the answer was lost".
 *
 * CLI: node tests/mock-supabase.cjs <port>   (used by the browser e2e)
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const APPEND_ONLY = new Set(['credit_ledger', 'sale_corrections', 'stock_moves', 'cash_entries', 'purchases', 'supplier_ledger', 'order_events']);
const LWW = new Set(['shops', 'products', 'customers', 'sales', 'suppliers', 'purchase_orders', 'baskets', 'customer_orders']);
const FK = {
  products: [['shop_id', 'shops']],
  customers: [['shop_id', 'shops']],
  sales: [['shop_id', 'shops'], ['customer_id', 'customers']],
  credit_ledger: [['shop_id', 'shops'], ['customer_id', 'customers'], ['sale_id', 'sales']],
  sale_corrections: [['shop_id', 'shops'], ['sale_id', 'sales'], ['customer_id', 'customers']],
  stock_moves: [['shop_id', 'shops']],
  cash_entries: [['shop_id', 'shops']],
  suppliers: [['shop_id', 'shops']],
  purchases: [['shop_id', 'shops'], ['supplier_id', 'suppliers']],
  supplier_ledger: [['shop_id', 'shops'], ['supplier_id', 'suppliers']],
  purchase_orders: [['shop_id', 'shops'], ['supplier_id', 'suppliers']],
  baskets: [['shop_id', 'shops'], ['customer_id', 'customers']],
  customer_orders: [['shop_id', 'shops'], ['customer_id', 'customers']],
  order_events: [['shop_id', 'shops'], ['order_id', 'customer_orders']],
};

function parseSchema(sql) {
  const tables = {};
  const re = /create table if not exists (\w+) \(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) {
    const cols = {};
    for (const raw of m[2].split('\n')) {
      const line = raw.replace(/--.*$/, '').trim();
      if (!line || /^(primary|unique|constraint|check|foreign)\b/i.test(line)) continue;
      const name = line.split(/\s+/)[0];
      cols[name] = { notNull: /not null|primary key/i.test(line), hasDefault: /\bdefault\b/i.test(line) };
    }
    tables[m[1]] = cols;
  }
  return tables;
}

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function createMock({ schemaPath = path.join(__dirname, '..', 'supabase', 'schema.sql') } = {}) {
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const schema = parseSchema(schemaSql);
  // CHECK (col in ('a', 'b')) constraints added by `alter table … add constraint`, e.g. stock_moves.reason.
  const CHECKS = [...schemaSql.matchAll(/alter table (\w+) add constraint (\w+)\s+check \((\w+) in \(([^)]*)\)\)/g)].map(
    ([, table, name, col, list]) => ({ table, name, col, allowed: new Set(list.split(',').map((x) => x.trim().replace(/^'|'$/g, ''))) }),
  );
  const state = { users: new Map(), tokens: new Map(), rows: {}, faults: [], log: [], confirmEmail: false };
  const reset = () => {
    state.users.clear();
    state.tokens.clear();
    state.faults.length = 0;
    state.log.length = 0;
    for (const t of Object.keys(schema)) state.rows[t] = new Map();
  };
  reset();
  let lastStamp = 0;
  const stamp = () => {
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    return new Date(lastStamp).toISOString();
  };

  const session = (user) => {
    const access = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })}.${crypto.randomBytes(8).toString('hex')}`;
    const refresh = crypto.randomBytes(12).toString('hex');
    state.tokens.set(access, user.id);
    state.tokens.set('r:' + refresh, user.id);
    return {
      access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: refresh,
      user: { id: user.id, aud: 'authenticated', role: 'authenticated', email: user.email, app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() },
    };
  };
  const uidOf = (req) => state.tokens.get(String(req.headers.authorization || '').replace(/^Bearer /i, '')) || null;
  const ownedShops = (uid) => new Set([...state.rows.shops.values()].filter((s) => s.owner_id === uid).map((s) => s.id));
  const visible = (table, row, uid) => {
    if (!uid) return false;
    if (table === 'shops') return row.owner_id === uid;
    if (table === 'sale_items') return ownedShops(uid).has(state.rows.sales.get(row.sale_id)?.shop_id);
    return ownedShops(uid).has(row.shop_id);
  };

  const pgErr = (status, code, message) => ({ status, body: { code, message, details: null, hint: null } });
  const takeFault = (table, op) => {
    const f = state.faults.find((x) => x.table === table && (x.op || 'write') === op && (x.times ?? 1) > 0);
    if (f) f.times = (f.times ?? 1) - 1;
    return f;
  };

  function write(table, rows, prefer, uid, select) {
    const cols = schema[table];
    if (!cols) return pgErr(404, '42P01', `relation "public.${table}" does not exist`);
    const fault = takeFault(table, 'write');
    if (fault && fault.status && !fault.afterCommit) return pgErr(fault.status, fault.code || '', fault.message || 'injected failure');
    const ignore = /resolution=ignore-duplicates/.test(prefer);
    const merge = /resolution=merge-duplicates/.test(prefer);
    const staged = new Map(); // atomic: build every change first, then commit
    const out = [];
    for (const r of rows) {
      for (const k of Object.keys(r)) if (!cols[k]) return pgErr(400, 'PGRST204', `Could not find the '${k}' column of '${table}' in the schema cache`);
      const cur = staged.get(r.id) || state.rows[table].get(r.id);
      if (cur) {
        if (!visible(table, cur, uid)) return pgErr(403, '42501', `new row violates row-level security policy for table "${table}"`);
        if (ignore) continue;
        if (!merge) return pgErr(409, '23505', `duplicate key value violates unique constraint "${table}_pkey"`);
        if (APPEND_ONLY.has(table)) return pgErr(403, '42501', `new row violates row-level security policy (USING expression) for table "${table}"`);
        const tombstoned = cur.deleted_at != null && r.deleted_at == null; // a delete is final
        const older = r.deleted_at == null && cur.updated_at && r.updated_at && Date.parse(r.updated_at) < Date.parse(cur.updated_at);
        if (LWW.has(table) && (tombstoned || older)) {
          out.push(cur); // lww_guard(): keep the newer row, still answer with it
          continue;
        }
      }
      const row = cur ? { ...cur, ...r } : {};
      if (!cur) for (const [c, def] of Object.entries(cols)) row[c] = c in r ? r[c] : def.hasDefault ? undefined : null;
      if (!cur) Object.assign(row, r);
      for (const [c, def] of Object.entries(cols)) {
        if (row[c] === undefined) row[c] = defaultFor(table, c, uid);
        if (def.notNull && row[c] === null) return pgErr(400, '23502', `null value in column "${c}" of relation "${table}" violates not-null constraint`);
      }
      for (const ck of CHECKS)
        if (ck.table === table && row[ck.col] != null && !ck.allowed.has(row[ck.col]))
          return pgErr(400, '23514', `new row for relation "${table}" violates check constraint "${ck.name}"`);
      if (table === 'shops' && row.owner_id !== uid) return pgErr(403, '42501', 'new row violates row-level security policy for table "shops"');
      if (table !== 'shops' && !ownedShops(uid).has(row.shop_id)) return pgErr(403, '42501', `new row violates row-level security policy for table "${table}"`);
      if (table === 'shops' && [...state.rows.shops.values()].some((s) => s.owner_id === uid && s.id !== row.id) && !cur)
        return pgErr(409, '23505', 'duplicate key value violates unique constraint "shops_one_per_owner"');
      for (const [c, parent] of FK[table] || []) {
        if (row[c] == null) continue;
        if (!state.rows[parent].has(row[c]) && !staged.has(row[c])) return pgErr(409, '23503', `insert or update on table "${table}" violates foreign key constraint "${table}_${c}_fkey"`);
      }
      row.server_updated_at = stamp();
      staged.set(row.id, row);
      out.push(row);
    }
    for (const [id, row] of staged) {
      state.rows[table].set(id, row);
      if (table === 'sales') {
        for (const [k, it] of state.rows.sale_items) if (it.sale_id === id) state.rows.sale_items.delete(k);
        (row.items || []).forEach((it, i) => state.rows.sale_items.set(`${id}-${i}`, { id: `${id}-${i}`, sale_id: id, product_id: it.productId, qty: it.qty, price: it.price, cost: it.cost ?? 0, cost_known: typeof it.costKnown === 'boolean' ? it.costKnown : (it.cost ?? 0) > 0, returned_qty: it.returnedQty ?? 0 }));
      }
    }
    state.log.push({ op: 'write', table, rows: rows.length, committed: staged.size });
    if (fault && fault.afterCommit) return pgErr(fault.status || 503, '', 'injected: committed but the answer was lost');
    let body = out;
    if (fault && fault.confirmOnly !== undefined) body = out.slice(0, fault.confirmOnly);
    return { status: 201, body: body.map((r) => project(r, select)) };
  }

  function defaultFor(table, c, uid) {
    if (c === 'owner_id') return uid;
    if (/_at$/.test(c) && c !== 'deleted_at' && c !== 'last_sold_at' && c !== 'last_paid_at' && !(table === 'sales' && c === 'updated_at')) return new Date().toISOString();
    if (c === 'items') return [];
    if (c === 'status') return 'active';
    if (c === 'language') return 'hi';
    if (c === 'is_demo') return false;
    return 0;
  }
  const project = (r, select) => {
    if (!select || select === '*') return { ...r };
    const o = {};
    for (const c of select.split(',')) o[c.trim()] = r[c.trim()];
    return o;
  };

  function read(table, params, uid) {
    if (!schema[table]) return pgErr(404, '42P01', `relation "public.${table}" does not exist`);
    const fault = takeFault(table, 'read');
    if (fault) return pgErr(fault.status || 503, fault.code || '', fault.message || 'injected failure');
    let rows = [...state.rows[table].values()].filter((r) => visible(table, r, uid));
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'offset'].includes(k)) continue;
      const [op, ...rest] = v.split('.');
      const val = rest.join('.');
      if (op === 'eq') rows = rows.filter((r) => String(r[k]) === val);
      else if (op === 'gt') rows = rows.filter((r) => r[k] != null && String(r[k]) > val);
      else if (op === 'gte') rows = rows.filter((r) => r[k] != null && String(r[k]) >= val);
      else if (op === 'in') {
        const set = new Set(val.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, '')));
        rows = rows.filter((r) => set.has(String(r[k])));
      } else if (op === 'is' && val === 'null') rows = rows.filter((r) => r[k] == null);
    }
    const order = params.get('order');
    if (order) {
      const keys = order.split(',').map((o) => o.split('.'));
      rows.sort((a, b) => {
        for (const [c, dir] of keys) {
          const x = String(a[c] ?? ''), y = String(b[c] ?? '');
          if (x !== y) return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
        }
        return 0;
      });
    }
    const off = Number(params.get('offset') || 0);
    const lim = params.has('limit') ? Number(params.get('limit')) : rows.length;
    state.log.push({ op: 'read', table });
    return { status: 200, body: rows.slice(off, off + lim).map((r) => project(r, params.get('select'))) };
  }

  function auth(req, url, body) {
    const p = url.pathname.replace('/auth/v1', '');
    if (p === '/signup') {
      const email = String(body.email || '').toLowerCase();
      if (state.users.has(email)) return { status: 422, body: { code: 'user_already_exists', msg: 'User already registered', error_code: 'user_already_exists' } };
      if (String(body.password || '').length < 6) return { status: 422, body: { code: 'weak_password', msg: 'Password should be at least 6 characters.', error_code: 'weak_password' } };
      const user = { id: crypto.randomUUID(), email, password: body.password };
      state.users.set(email, user);
      if (state.confirmEmail) return { status: 200, body: { id: user.id, aud: 'authenticated', role: 'authenticated', email, confirmation_sent_at: new Date().toISOString(), app_metadata: {}, user_metadata: {}, identities: [{}] } };
      return { status: 200, body: session(user) };
    }
    if (p === '/token') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const user = state.users.get(String(body.email || '').toLowerCase());
        if (!user || user.password !== body.password) return { status: 400, body: { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials' } };
        return { status: 200, body: session(user) };
      }
      if (grant === 'refresh_token') {
        const uid = state.tokens.get('r:' + body.refresh_token);
        const user = [...state.users.values()].find((u) => u.id === uid);
        if (!user) return { status: 400, body: { code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' } };
        return { status: 200, body: session(user) };
      }
    }
    if (p === '/user') {
      const uid = uidOf(req);
      const user = [...state.users.values()].find((u) => u.id === uid);
      if (!user) return { status: 401, body: { code: 'bad_jwt', msg: 'invalid JWT' } };
      return { status: 200, body: session(user).user };
    }
    if (p === '/logout') return { status: 204, body: null };
    if (p === '/otp') return { status: 400, body: { code: 'sms_send_failed', msg: 'Phone provider not configured (mock)' } };
    return { status: 404, body: { msg: 'not found' } };
  }

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'Access-Control-Expose-Headers': 'Content-Range' };
      const send = ({ status, body }) => {
        res.writeHead(status, { ...cors, 'Content-Type': 'application/json', 'Content-Range': Array.isArray(body) ? `0-${Math.max(0, body.length - 1)}/*` : '*/*' });
        res.end(body === null ? '' : JSON.stringify(body));
      };
      if (req.method === 'OPTIONS') return send({ status: 204, body: null });
      const url = new URL(req.url, 'http://mock');
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(pgErr(400, 'PGRST102', 'bad json')); }
      if (url.pathname.startsWith('/__mock/')) {
        const what = url.pathname.slice(8);
        if (what === 'faults') { state.faults.push(...(Array.isArray(body) ? body : [body])); return send({ status: 200, body: { ok: true } }); }
        if (what === 'clear-faults') { state.faults.length = 0; return send({ status: 200, body: { ok: true } }); }
        if (what === 'dump') return send({ status: 200, body: Object.fromEntries(Object.entries(state.rows).map(([t, m]) => [t, [...m.values()]])) });
        if (what === 'log') return send({ status: 200, body: state.log });
        return send({ status: 404, body: null });
      }
      if (!req.headers.apikey) return send({ status: 401, body: { message: 'No API key found in request' } });
      if (url.pathname.startsWith('/auth/v1/')) return send(auth(req, url, body));
      const m = url.pathname.match(/^\/rest\/v1\/(\w+)$/);
      if (!m) return send({ status: 404, body: null });
      const uid = uidOf(req);
      if (req.method === 'GET') return send(read(m[1], url.searchParams, uid));
      if (req.method === 'POST') {
        if (!uid) return send(pgErr(401, 'PGRST301', 'JWT required'));
        const rows = Array.isArray(body) ? body : [body];
        const prefer = String(req.headers.prefer || '');
        const r = write(m[1], rows, prefer, uid, url.searchParams.get('select'));
        if (r.status === 201 && !/return=representation/.test(prefer)) return send({ status: 201, body: null });
        return send(r);
      }
      return send(pgErr(405, '', 'method not supported by mock'));
    });
  });

  return {
    state,
    reset,
    faults: state.faults,
    rows: (t) => [...state.rows[t].values()],
    listen: (port = 0) => new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))),
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

module.exports = { createMock, parseSchema };

if (require.main === module) {
  const mock = createMock();
  mock.listen(Number(process.argv[2] || 54329)).then((url) => console.log('mock supabase ready at ' + url));
}
