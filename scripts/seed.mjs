import { q } from '../lib/db.js';
import { hashPin } from '../lib/auth.js';

const { NOLAN_PIN, AURORA_PIN } = process.env;
if (!NOLAN_PIN || !AURORA_PIN) throw new Error('set NOLAN_PIN and AURORA_PIN');
for (const pin of [NOLAN_PIN, AURORA_PIN]) if (!/^\d{4,12}$/.test(pin)) throw new Error('PINs must be 4-12 digits');
// Optional, for a throwaway test database only: open the window right away. Only used when settings do not exist yet.
const start = process.env.SEED_START_DATE ?? '2027-05-15';
const end = process.env.SEED_END_DATE ?? '2027-08-23';

// PIN is re-hashed on every run, so re-running this is how a PIN gets changed.
for (const [name, pin] of [['Nolan', NOLAN_PIN], ['Aurora', AURORA_PIN]]) {
  await q(
    `INSERT INTO players (name, pin_hash, starting_cents) VALUES ($1, $2, 0)
     ON CONFLICT (name) DO UPDATE SET pin_hash = EXCLUDED.pin_hash`,
    [name, hashPin(pin)],
  );
}

// PLACEHOLDER dates: replace with the later UC/Miami spring end, and the earlier
// fall start, once both registrars publish 2027 calendars (Miami: late Jan 2027).
// Coin flip (2026-11-01) picked Nolan to plan the first date.
await q(
  `INSERT INTO settings (id, start_date, end_date, milestone_cents, first_date_planner_id)
   VALUES (1, $1, $2, 700000, (SELECT id FROM players WHERE name = 'Nolan'))
   ON CONFLICT (id) DO NOTHING`,
  [start, end],
);
console.log('seeded Nolan, Aurora and settings');
