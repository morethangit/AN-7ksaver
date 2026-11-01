import { q } from './db.js';

/** Full backup of every table into `snapshots` (PINs deliberately excluded). */
export async function takeSnapshot(trigger) {
  const agg = (t) => `(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]') FROM ${t} x)`;
  const [row] = await q(
    `INSERT INTO snapshots (trigger, payload) VALUES ($1, jsonb_build_object(
       'players', (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'starting_cents',starting_cents)), '[]') FROM players),
       'settings', (SELECT to_jsonb(s) FROM settings s),
       'deposits', ${agg('deposits')}, 'spends', ${agg('spends')},
       'dates', ${agg('dates')}, 'rps_rounds', ${agg('rps_rounds')},
       'audit_log', ${agg('audit_log')}
     )) RETURNING id, taken_at`,
    [trigger],
  );
  // Keep 90 days of snapshots, plus every Sunday's after that.
  await q(`DELETE FROM snapshots WHERE taken_at < now() - interval '90 days' AND extract(dow FROM taken_at) <> 0`);
  return row;
}
