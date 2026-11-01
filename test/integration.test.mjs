// Runs the REAL schema, SQL and API handlers against a local Postgres.
//   TEST_DATABASE_URL=postgres://postgres@localhost:5432/showdown_test npm test
// Skipped when TEST_DATABASE_URL is unset. It DROPS the public schema of that database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const URL_ = process.env.TEST_DATABASE_URL;
const skip = URL_ ? false : 'set TEST_DATABASE_URL to run the database integration tests';

process.env.SESSION_SECRET = 'integration-test-secret-123';
process.env.CRON_SECRET = 'cron-secret-123';

const NOLAN = 1, AURORA = 2;
let pool, call, app;

function days(n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); }

test('setup: schema applies twice, players and settings seed', { skip }, async () => {
  const { default: pg } = await import('pg');
  const { setRunner } = await import('../lib/db.js');
  const { hashPin, signSession } = await import('../lib/auth.js');
  pool = new pg.Pool({ connectionString: URL_ });
  setRunner((text, params) => pool.query(text, params).then((r) => r.rows));

  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  const statements = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8').split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
  for (let pass = 0; pass < 2; pass++) for (const s of statements) await pool.query(s); // migrate is idempotent

  await pool.query('INSERT INTO players (name, pin_hash) VALUES ($1,$2),($3,$4)', ['Nolan', hashPin('1111'), 'Aurora', hashPin('2222')]);
  await pool.query(`INSERT INTO settings (id,start_date,end_date,first_date_planner_id) VALUES (1,$1,$2,1)`, [days(-1), days(60)]);

  app = {
    login: (await import('../api/login.js')).default,
    state: (await import('../api/state.js')).default,
    deposits: (await import('../api/deposits.js')).default,
    spends: (await import('../api/spends.js')).default,
    dates: (await import('../api/dates.js')).default,
    rps: (await import('../api/rps.js')).default,
    snapshot: (await import('../api/snapshot.js')).default,
    cron: (await import('../api/cron/snapshot.js')).default,
  };
  call = (handler, { method = 'GET', body, query = {}, as, headers = {} } = {}) => new Promise((resolve, reject) => {
    const res = {
      headers: {}, code: undefined,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.code = c; return this; },
      json(b) { resolve({ status: this.code ?? 200, body: b, headers: this.headers }); return this; },
    };
    const cookie = as ? `session=${signSession(as, process.env.SESSION_SECRET)}` : '';
    Promise.resolve(handler({ method, body, query, headers: { cookie, ...headers } }, res)).catch(reject);
  });
});

const state = async (as) => (await call(app.state, { as })).body;
const saved = (st, id) => st.standings.find((p) => p.id === id).saved_cents;

test('login: right PIN sets a cookie, wrong PIN and unknown name look identical', { skip }, async () => {
  const ok = await call(app.login, { method: 'POST', body: { name: 'nolan', pin: '1111' } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['Set-Cookie'], /HttpOnly/);
  const badPin = await call(app.login, { method: 'POST', body: { name: 'Nolan', pin: '0000' } });
  const badName = await call(app.login, { method: 'POST', body: { name: 'Zed', pin: '1111' } });
  assert.equal(badPin.status, 401);
  assert.deepEqual(badPin.body, badName.body);
  assert.equal((await call(app.state)).status, 401);
});

test('lockout after 10 wrong PINs, even with the right PIN afterwards', { skip }, async () => {
  for (let i = 0; i < 10; i++) await call(app.login, { method: 'POST', body: { name: 'Aurora', pin: '9999' } });
  assert.equal((await call(app.login, { method: 'POST', body: { name: 'Aurora', pin: '2222' } })).status, 429);
  await pool.query('DELETE FROM login_failures');
});

test('deposits: create, edit (audited, flagged), soft-delete; only the owner may touch them', { skip }, async () => {
  const c = await call(app.deposits, { method: 'POST', as: NOLAN, body: { amount_cents: 10000, note: 'paycheck' } });
  assert.equal(c.status, 201);
  assert.equal(saved(await state(NOLAN), NOLAN), 10000);

  assert.equal((await call(app.deposits, { method: 'PATCH', as: AURORA, query: { id: String(c.body.id) }, body: { amount_cents: 1 } })).status, 404);
  const e = await call(app.deposits, { method: 'PATCH', as: NOLAN, query: { id: String(c.body.id) }, body: { amount_cents: 12000, note: 'paycheck + tip' } });
  assert.equal(e.status, 200);
  const st = await state(AURORA);
  assert.equal(saved(st, NOLAN), 12000);
  assert.equal(st.feed.find((f) => f.id === c.body.id && f.kind === 'deposit').edited, true);

  const { rows: audit } = await pool.query(`SELECT action, before->>'amount_cents' AS b, after->>'amount_cents' AS a FROM audit_log WHERE table_name='deposits' AND row_id=$1 ORDER BY id`, [c.body.id]);
  assert.deepEqual(audit.map((r) => [r.action, r.b, r.a]), [['create', null, '10000'], ['update', '10000', '12000']]);

  const d = await call(app.deposits, { method: 'DELETE', as: NOLAN, query: { id: String(c.body.id) } });
  assert.equal(d.status, 200);
  assert.equal(saved(await state(NOLAN), NOLAN), 0);
  const { rows } = await pool.query('SELECT deleted_at FROM deposits WHERE id=$1', [c.body.id]);
  assert.ok(rows[0].deleted_at, 'row is kept, just marked deleted');
  await call(app.deposits, { method: 'POST', as: NOLAN, body: { amount_cents: 50000 } });
  await call(app.deposits, { method: 'POST', as: AURORA, body: { amount_cents: 40000 } });
});

test('spends: solo charges the logger, gas is ignored, immunity splits and is locked', { skip }, async () => {
  assert.equal((await call(app.spends, { method: 'POST', as: NOLAN, body: { amount_cents: 2500, category: 'treat', texted_first: true } })).status, 201);
  assert.equal((await call(app.spends, { method: 'POST', as: NOLAN, body: { amount_cents: 6000, category: 'gas' } })).status, 201);
  let st = await state(NOLAN);
  assert.equal(saved(st, NOLAN), 47500);
  assert.equal(st.standings.find((p) => p.id === NOLAN).gas_cents, 6000);

  const imm = await call(app.spends, { method: 'POST', as: AURORA, body: { amount_cents: 6001, category: 'dinner', via: 'immunity' } });
  assert.equal(imm.status, 201);
  assert.deepEqual(imm.body.map((r) => [r.player_id, r.amount_cents]), [[AURORA, 3001], [NOLAN, 3000]]);
  assert.equal(imm.body[0].split_group, imm.body[1].split_group);
  st = await state(NOLAN);
  assert.equal(saved(st, NOLAN), 44500);
  assert.equal(saved(st, AURORA), 36999);
  assert.equal((await call(app.spends, { method: 'DELETE', as: AURORA, query: { id: String(imm.body[0].id) } })).status, 409);
});

test('dates: turn order, scope, one open date, scope-checked spends', { skip }, async () => {
  const plan = { title: 'Taco night', scope: ['dinner', 'treat'], budget_cap_cents: 8000 };
  assert.equal((await call(app.dates, { method: 'POST', as: AURORA, body: plan })).status, 403); // Nolan won the flip
  assert.equal((await call(app.dates, { method: 'POST', as: NOLAN, body: { title: 'x', scope: [] } })).status, 400);
  const d = await call(app.dates, { method: 'POST', as: NOLAN, body: plan });
  assert.equal(d.status, 201);
  assert.deepEqual(d.body.scope, ['dinner', 'treat']);
  assert.equal((await call(app.dates, { method: 'POST', as: NOLAN, body: plan })).status, 409); // one at a time

  const bad = await call(app.spends, { method: 'POST', as: NOLAN, body: { amount_cents: 1500, category: 'activity', date_id: d.body.id } });
  assert.equal(bad.status, 400);
  const good = await call(app.spends, { method: 'POST', as: NOLAN, body: { amount_cents: 1500, category: 'dinner', date_id: d.body.id } });
  assert.equal(good.status, 201);
  assert.equal((await call(app.dates, { method: 'DELETE', as: NOLAN, query: { id: String(d.body.id) } })).status, 409); // has spends

  const done = await call(app.dates, { method: 'PATCH', as: AURORA, query: { id: String(d.body.id) }, body: { status: 'done' } }); // either may close it
  assert.equal(done.status, 200);
  const st = await state(NOLAN);
  assert.equal(st.next_planner_id, AURORA);
  assert.equal(st.open_date, null);
});

test('rps: moves stay hidden, winner pays once, loser cannot claim it', { skip }, async () => {
  assert.equal((await call(app.rps, { method: 'POST', as: AURORA, body: { topic: ' ' } })).status, 400);
  const r = await call(app.rps, { method: 'POST', as: AURORA, body: { topic: 'pizza vs. sushi' } });
  assert.equal(r.status, 201);
  assert.equal((await call(app.rps, { method: 'POST', as: NOLAN, body: { topic: 'again' } })).status, 409);

  assert.equal((await call(app.rps, { method: 'PATCH', as: NOLAN, query: { id: String(r.body.id) }, body: { move: 'rock' } })).status, 200);
  assert.equal((await call(app.rps, { method: 'PATCH', as: NOLAN, query: { id: String(r.body.id) }, body: { move: 'paper' } })).status, 409); // final
  const aurSees = JSON.stringify((await state(AURORA)).rps);
  assert.equal(aurSees.includes('rock'), false, 'Aurora must not see Nolan\'s pick');
  assert.equal((await state(AURORA)).rps[0].they_moved, true);

  const fin = await call(app.rps, { method: 'PATCH', as: AURORA, query: { id: String(r.body.id) }, body: { move: 'scissors' } });
  assert.equal(fin.body.resolved, true);
  assert.equal(fin.body.winner_id, NOLAN); // rock beats scissors

  const lose = await call(app.spends, { method: 'POST', as: AURORA, body: { amount_cents: 4000, category: 'dinner', via: 'rps', rps_round_id: r.body.id } });
  assert.equal(lose.status, 400);
  const win = await call(app.spends, { method: 'POST', as: NOLAN, body: { amount_cents: 4000, category: 'dinner', via: 'rps', rps_round_id: r.body.id } });
  assert.equal(win.status, 201);
  assert.equal((await call(app.spends, { method: 'POST', as: NOLAN, body: { amount_cents: 100, category: 'dinner', via: 'rps', rps_round_id: r.body.id } })).status, 400);
  assert.equal((await state(NOLAN)).rps[0].used, true);

  // ties replay with the counter bumped
  const t = await call(app.rps, { method: 'POST', as: NOLAN, body: { topic: 'movie' } });
  for (const as of [NOLAN, AURORA]) await call(app.rps, { method: 'PATCH', as, query: { id: String(t.body.id) }, body: { move: 'paper' } });
  const after = (await state(NOLAN)).rps[0];
  assert.deepEqual([after.resolved, after.ties, after.i_moved], [false, 1, false]);
  assert.equal((await call(app.rps, { method: 'DELETE', as: AURORA, query: { id: String(t.body.id) } })).status, 200);
  const { rows } = await pool.query(`SELECT after->>'event' AS e, after::text AS raw FROM audit_log WHERE table_name='rps_rounds' AND row_id=$1 ORDER BY id`, [t.body.id]);
  assert.deepEqual(rows.map((x) => x.e), [null, 'move', 'move', 'tie', 'cancelled']);
  assert.equal(rows.some((x) => x.raw.includes('paper')), false, 'hidden moves are not written to the audit log');
});

test('snapshot -> more changes -> restore returns to the snapshot, and ids keep counting', { skip }, async () => {
  const snapRes = await call(app.snapshot, { method: 'POST', as: NOLAN });
  assert.equal(snapRes.status, 201);
  const before = await state(NOLAN);

  await call(app.deposits, { method: 'POST', as: NOLAN, body: { amount_cents: 999900 } });
  await call(app.spends, { method: 'POST', as: AURORA, body: { amount_cents: 7777, category: 'shopping' } });
  assert.notEqual(saved(await state(NOLAN), NOLAN), saved(before, NOLAN));

  const { checkPayload, applyRestore } = await import('../lib/restore.js');
  const { rows: [snap] } = await pool.query('SELECT * FROM snapshots WHERE id=$1', [snapRes.body.id]);
  const { rows: players } = await pool.query('SELECT id, name FROM players');
  assert.deepEqual(checkPayload(snap.payload, players), []);
  assert.ok(checkPayload(snap.payload, [{ id: 1, name: 'Someone' }]).length, 'mismatched players are refused');
  assert.equal(JSON.stringify(snap.payload).includes('pin_hash'), false, 'PIN hashes never enter snapshots');

  const client = await pool.connect();
  try { await client.query('BEGIN'); await applyRestore(client, snap.payload); await client.query('COMMIT'); } finally { client.release(); }

  const afterRestore = await state(NOLAN);
  assert.deepEqual(afterRestore.standings.map((p) => [p.id, p.saved_cents]), before.standings.map((p) => [p.id, p.saved_cents]));
  assert.equal(afterRestore.feed.length, before.feed.length);
  const next = await call(app.deposits, { method: 'POST', as: NOLAN, body: { amount_cents: 100 } });
  assert.equal(next.status, 201, 'sequences were reset past the restored rows');

  // a broken restore rolls back completely
  const broken = { ...snap.payload, spends: [{ id: 1, player_id: 999 }] };
  const c2 = await pool.connect();
  try {
    await c2.query('BEGIN');
    await assert.rejects(applyRestore(c2, broken));
    await c2.query('ROLLBACK');
  } finally { c2.release(); }
  assert.equal(saved(await state(NOLAN), NOLAN), saved(before, NOLAN) + 100);
});

test('cron endpoint: refuses without the bearer secret, snapshots with it', { skip }, async () => {
  assert.equal((await call(app.cron)).status, 401);
  assert.equal((await call(app.cron, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await call(app.cron, { headers: { authorization: 'Bearer cron-secret-123' } })).status, 200);
});

test('teardown', { skip }, async () => { await pool.end(); });
