// node scripts/restore.mjs list
// node scripts/restore.mjs <snapshot-id|latest>            dry run: shows what would change
// node scripts/restore.mjs <snapshot-id|latest> --apply    does it
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import { q } from '../lib/db.js';
import { takeSnapshot } from '../lib/snapshot.js';
import { checkPayload, summarize, applyRestore } from '../lib/restore.js';

neonConfig.webSocketConstructor = ws;
const [target, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');

if (!target || target === 'list') {
  const rows = await q(`SELECT id, taken_at, trigger, jsonb_array_length(payload->'spends') AS spends,
                               jsonb_array_length(payload->'deposits') AS deposits FROM snapshots ORDER BY id DESC LIMIT 30`);
  console.table(rows);
  process.exit(0);
}

const [snap] = target === 'latest'
  ? await q('SELECT * FROM snapshots ORDER BY id DESC LIMIT 1')
  : await q('SELECT * FROM snapshots WHERE id = $1', [Number(target)]);
if (!snap) { console.error('no such snapshot'); process.exit(1); }

const players = await q('SELECT id, name FROM players');
const problems = checkPayload(snap.payload, players);
if (problems.length) { console.error('Cannot restore:\n - ' + problems.join('\n - ')); process.exit(1); }

const [live] = await q(`SELECT (SELECT count(*) FROM spends)::int AS spends, (SELECT count(*) FROM deposits)::int AS deposits,
  (SELECT count(*) FROM dates)::int AS dates, (SELECT count(*) FROM rps_rounds)::int AS rps_rounds, (SELECT count(*) FROM audit_log)::int AS audit_log`);
console.log(`Snapshot #${snap.id} from ${snap.taken_at} (${snap.trigger})`);
console.table({ now: live, 'after restore': summarize(snap.payload) });
if (!apply) { console.log('Dry run. Add --apply to restore.'); process.exit(0); }

const safety = await takeSnapshot('manual'); // undo point: restore this id to undo
console.log(`Saved the current state as snapshot #${safety.id} first.`);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await applyRestore(client, snap.payload);
  await client.query('COMMIT');
  console.log(`Restored snapshot #${snap.id}. To undo: node scripts/restore.mjs ${safety.id} --apply`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error('Restore failed and was rolled back; nothing changed.', e.message);
  process.exitCode = 1;
} finally { client.release(); await pool.end(); }
