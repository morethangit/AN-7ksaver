// Drives the real UI in a real browser (two people, two sessions) against the dev server and a local Postgres.
// Needs TEST_DATABASE_URL and Playwright; skipped otherwise (CI has no Playwright installed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }
const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ ? 'set TEST_DATABASE_URL to run the browser tests' : !chromium ? 'playwright is not installed' : false;
const SHOTS = process.env.SCREENSHOT_DIR;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

let pool, server, browser, base;
const problems = [];

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const text = (page, sel) => page.locator(sel).innerText();

async function session(name, pin) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  // Chrome logs failed requests. The sign-in screen's first /api/state is a deliberate 401, and the test makes one
  // deliberate out-of-scope spend (400); the UI's handling of each is asserted separately.
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (401|400)/.test(m.text())) problems.push(`${name} console: ${m.text()}`); });
  page.on('dialog', (d) => d.type() === 'prompt' ? d.accept(page.answers?.shift() ?? d.defaultValue()) : d.accept());
  await page.goto(base);
  await page.selectOption('#who', name);
  await page.fill('#pin', pin);
  await page.click('#login button');
  await page.waitForSelector('#game:not([hidden])');
  return page;
}

test('setup', { skip }, async () => {
  const { default: pg } = await import('pg');
  const { hashPin } = await import('../lib/auth.js');
  pool = new pg.Pool({ connectionString: URL_ });
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const s of readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8').split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await pool.query(s);
  await pool.query('INSERT INTO players (name, pin_hash) VALUES ($1,$2),($3,$4)', ['Nolan', hashPin('1111'), 'Aurora', hashPin('2222')]);
  await pool.query('INSERT INTO settings (id,start_date,end_date,first_date_planner_id) VALUES (1,$1,$2,1)', [day(-2), day(60)]);
  process.env.DEV_DATABASE_URL = URL_;
  const { startServer } = await import('../scripts/dev-server.mjs');
  server = await startServer(0);
  base = `http://localhost:${server.address().port}`;
  browser = await chromium.launch();
});

let nolan, aurora;

test('both sign in; wrong PIN shows an error', { skip }, async () => {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(base);
  await p.selectOption('#who', 'Nolan'); await p.fill('#pin', '0000'); await p.click('#login button');
  await p.waitForFunction(() => document.getElementById('err').textContent.length > 0);
  assert.match(await text(p, '#err'), /wrong name or PIN/);
  await ctx.close();
  problems.length = 0; // the 401 above is expected
  nolan = await session('Nolan', '1111');
  aurora = await session('Aurora', '2222');
  assert.match(await text(nolan, '#board'), /Nolan \(you\)/);
});

test('deposits move the scoreboard; bad amounts are caught before the server', { skip }, async () => {
  await nolan.fill('#depAmt', '500'); await nolan.fill('#depNote', 'paycheck'); await nolan.click('#depForm button');
  await nolan.waitForFunction(() => document.getElementById('board').innerText.includes('$500.00'));
  await aurora.fill('#depAmt', '400.50'); await aurora.click('#depForm button');
  await aurora.waitForFunction(() => document.getElementById('board').innerText.includes('$400.50'));
  await nolan.fill('#depAmt', 'abc'); await nolan.click('#depForm button');
  assert.match(await text(nolan, '#err'), /Enter an amount/);
  await nolan.fill('#depAmt', '');
  await nolan.reload(); await nolan.waitForFunction(() => document.getElementById('board').innerText.includes('$400.50'));
  assert.match(await text(nolan, '#board'), /leads by \$99\.50/);
});

test('gas does not count; a normal spend does', { skip }, async () => {
  await nolan.fill('#spAmt', '60'); await nolan.selectOption('#spCat', 'gas'); await nolan.click('#spendForm button');
  await nolan.waitForFunction(() => document.getElementById('board').innerText.includes('gas $60.00'));
  assert.match(await text(nolan, '#board'), /\$500\.00/);
  await nolan.fill('#spAmt', '25'); await nolan.selectOption('#spCat', 'treat'); await nolan.check('#spText'); await nolan.click('#spendForm button');
  await nolan.waitForFunction(() => document.getElementById('board').innerText.includes('$475.00'));
});

test('immunity: one line for the pair; the partner can edit the total and delete it', { skip }, async () => {
  await aurora.fill('#spAmt', '60.01'); await aurora.selectOption('#spCat', 'dinner'); await aurora.check('#spSplit'); await aurora.click('#spendForm button');
  await aurora.waitForSelector('#feed li:has-text("split")');
  const line = await text(aurora, '#feed li:has-text("split")');
  assert.match(line, /\$60\.01/);
  assert.match(line, /Aurora \$30\.01/);
  assert.match(line, /Nolan \$30\.00/);
  assert.equal(await aurora.locator('#feed li:has-text("split")').count(), 1);

  nolan.answers = ['80.01', 'bigger bill'];
  await nolan.reload(); await nolan.waitForSelector('#feed li:has-text("split")');
  await nolan.click('#feed li:has-text("split") [data-edit]');
  await nolan.waitForFunction(() => document.getElementById('feed').innerText.includes('$80.01'));
  assert.match(await text(nolan, '#feed li:has-text("split")'), /edited/);
  assert.match(await text(nolan, '#board'), /\$434\.99/); // 475 - 40.01

  await aurora.reload(); await aurora.waitForSelector('#feed li:has-text("split")');
  await aurora.click('#feed li:has-text("split") [data-del]');
  await aurora.waitForFunction(() => !document.getElementById('feed').innerText.includes('split'));
  assert.match(await text(aurora, '#board'), /\$400\.50/);
});

test('dates: only the planner sees the form; scope limits spends', { skip }, async () => {
  await aurora.reload(); await aurora.waitForSelector('#game:not([hidden])');
  assert.equal(await aurora.locator('#dateForm').isHidden(), true);
  assert.match(await text(aurora, '#dateInfo'), /Waiting on Nolan/);
  await nolan.fill('#dtTitle', 'Taco night'); await nolan.check('input[name=scope][value=dinner]'); await nolan.fill('#dtCap', '80'); await nolan.click('#dateForm button');
  await nolan.waitForFunction(() => document.getElementById('dateInfo').innerText.includes('Taco night'));
  assert.equal(await nolan.locator('#dateForm').isHidden(), true);
  await nolan.selectOption('#spDate', { label: 'Date: Taco night' });
  await nolan.fill('#spAmt', '30'); await nolan.selectOption('#spCat', 'activity'); await nolan.click('#spendForm button');
  await nolan.waitForFunction(() => document.getElementById('err').textContent.includes('scope'));
  await nolan.selectOption('#spCat', 'dinner'); await nolan.click('#spendForm button');
  await nolan.waitForFunction(() => document.getElementById('board').innerText.includes('$445.00'));
  await nolan.click('[data-dstatus]');
  await nolan.waitForFunction(() => document.getElementById('dateHist').innerText.includes('done'));
  await aurora.reload(); await aurora.waitForSelector('#game:not([hidden])');
  assert.equal(await aurora.locator('#dateForm').isVisible(), true, 'turn passed to Aurora');
});

test('rock-paper-scissors: hidden picks, winner picks and pays', { skip }, async () => {
  await aurora.fill('#rpsTopic', 'pizza vs. sushi'); await aurora.click('#rpsForm button');
  await aurora.waitForSelector('[data-move]');
  await aurora.click('[data-move$=":scissors"]');
  await aurora.waitForFunction(() => document.getElementById('rpsInfo').innerText.includes('Locked in'));
  await nolan.reload(); await nolan.waitForSelector('[data-move]');
  assert.match(await text(nolan, '#rpsInfo'), /They have picked/);
  assert.equal(/scissors/.test(await text(nolan, '#rpsInfo')) && /Aurora.*scissors/.test(await text(nolan, '#rpsInfo')), false);
  await nolan.click('[data-move$=":rock"]');
  await nolan.waitForFunction(() => document.getElementById('rpsHist').innerText.includes('picks & pays'));
  assert.match(await text(nolan, '#rpsHist'), /Nolan's .* beats/);
  assert.equal(await nolan.locator('#spRps').isVisible(), true);
  await nolan.fill('#spAmt', '45'); await nolan.selectOption('#spCat', 'dinner'); await nolan.selectOption('#spRps', { index: 1 }); await nolan.click('#spendForm button');
  await nolan.waitForFunction(() => document.getElementById('feed').innerText.includes('RPS win'));
  await nolan.waitForFunction(() => document.getElementById('board').innerText.includes('$400.00'));
  await aurora.reload(); await aurora.waitForSelector('#game:not([hidden])');
  assert.equal(await aurora.locator('#spRps').isHidden(), true, 'the loser cannot claim it');
});

test('trend chart appears once activity spans days', { skip }, async () => {
  await pool.query(`UPDATE deposits SET created_at = now() - interval '3 days' WHERE amount_cents = 50000`);
  await nolan.reload(); await nolan.waitForSelector('#chart svg polyline');
  assert.equal(await nolan.locator('#chart polyline').count(), 2);
  if (SHOTS) { await nolan.screenshot({ path: `${SHOTS}/nolan-full.png`, fullPage: true }); await aurora.screenshot({ path: `${SHOTS}/aurora-full.png`, fullPage: true }); }
});

test('the game can be over or not started: forms vanish, winner shows', { skip }, async () => {
  await pool.query('UPDATE settings SET end_date = $1', [day(-1)]);
  await nolan.reload(); await nolan.waitForSelector('#winner:not([hidden])');
  assert.match(await text(nolan, '#winner'), /Aurora wins[\s\S]*saved \$400\.50, ahead by \$0\.50/);
  assert.equal(await nolan.locator('#actions').isHidden(), true);
  assert.equal(await nolan.locator('#feed [data-del]').count(), 0, 'no edits after the game ends');
  if (SHOTS) await nolan.screenshot({ path: `${SHOTS}/ended.png`, fullPage: true });
  await pool.query('UPDATE settings SET start_date = $1, end_date = $2', [day(30), day(90)]);
  await nolan.reload(); await nolan.waitForFunction(() => document.getElementById('board').innerText.includes('Game starts in 30 days'));
  assert.equal(await nolan.locator('#actions').isHidden(), true);
});

test('PWA bits are served and sign-out works', { skip }, async () => {
  const m = await (await fetch(`${base}/manifest.webmanifest`)).json();
  assert.equal(m.display, 'standalone');
  for (const f of m.icons) assert.equal((await fetch(base + f.src)).status, 200);
  assert.equal((await fetch(`${base}/sw.js`)).status, 200);
  await nolan.click('#out');
  await nolan.waitForSelector('#login:not([hidden])');
});

test('no console or page errors in any session', { skip }, async () => {
  assert.deepEqual(problems, []);
});

test('teardown', { skip }, async () => { await browser.close(); server.close(); await pool.end(); });
