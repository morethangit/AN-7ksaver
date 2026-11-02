// node scripts/set-dates.mjs <start YYYY-MM-DD> <end YYYY-MM-DD> [timezone]
// start is the first day logging is open, end is the first day it is closed (first day of fall classes).
import { q } from '../lib/db.js';
import { todayIn } from '../lib/game.js';

const [start, end, tz] = process.argv.slice(2);
const day = /^\d{4}-\d{2}-\d{2}$/;
if (!day.test(start ?? '') || !day.test(end ?? '') || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
  console.error('usage: node scripts/set-dates.mjs 2027-05-15 2027-08-23 [America/New_York]'); process.exit(1);
}
if (start >= end) { console.error('start must be before end'); process.exit(1); }
if (tz) { try { todayIn(tz); } catch { console.error(`unknown timezone: ${tz}`); process.exit(1); } }

const rows = await q(
  `UPDATE settings SET start_date = $1, end_date = $2, timezone = coalesce($3, timezone) WHERE id = 1
   RETURNING start_date::text, end_date::text, timezone`, [start, end, tz ?? null]);
if (!rows.length) { console.error('no settings row: run npm run seed first'); process.exit(1); }
console.log('game window is now', rows[0]);
