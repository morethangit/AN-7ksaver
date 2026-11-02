// node scripts/reset-game.mjs --yes
// Wipes ALL game data (deposits, spends, dates, RPS rounds, audit log, login lockouts) but keeps the two players,
// their PINs and the settings. For clearing out test data before the real game starts. Saves a snapshot first.
import { q } from '../lib/db.js';
import { takeSnapshot } from '../lib/snapshot.js';

if (!process.argv.includes('--yes')) {
  console.error('This deletes every deposit, spend, date and RPS round. Re-run with --yes to confirm.');
  process.exit(1);
}
const snap = await takeSnapshot('manual');
console.log(`Saved snapshot #${snap.id} first (restore it with: npm run restore -- ${snap.id} --apply)`);
await q('TRUNCATE spends, deposits, dates, rps_rounds, audit_log, login_failures RESTART IDENTITY');
console.log('Game data cleared. Players, PINs and settings are untouched.');
