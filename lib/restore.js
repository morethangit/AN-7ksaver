// Restoring a snapshot. The decisions (is this payload safe to apply, what will change) are
// plain functions so they are unit-tested; applyRestore only needs a client with
// query(text, params), so the same code runs on Neon's Pool and on node-postgres in tests.

const DATA_TABLES = ['dates', 'rps_rounds', 'spends', 'deposits', 'audit_log'];

/** Problems that make a snapshot unsafe to apply. Empty array = fine. */
export function checkPayload(payload, livePlayers) {
  const errors = [];
  if (!payload || typeof payload !== 'object') return ['snapshot payload is missing'];
  for (const t of DATA_TABLES) if (!Array.isArray(payload[t])) errors.push(`snapshot has no "${t}" list`);
  if (!Array.isArray(payload.players) || !payload.players.length) errors.push('snapshot has no players');
  else {
    // PINs are never stored in snapshots, so players must already exist (npm run seed) with the same ids and names.
    for (const p of payload.players) {
      const live = livePlayers.find((l) => l.id === p.id);
      if (!live) errors.push(`player ${p.name} (id ${p.id}) is not in the database: run npm run seed first`);
      else if (live.name !== p.name) errors.push(`player id ${p.id} is "${live.name}" now but "${p.name}" in the snapshot`);
    }
  }
  return errors;
}

export function summarize(payload) {
  return Object.fromEntries(DATA_TABLES.map((t) => [t, payload?.[t]?.length ?? 0]));
}

/** Run INSIDE a transaction the caller opened; any failure should roll the caller's transaction back. */
export async function applyRestore(client, payload) {
  for (const p of payload.players) {
    await client.query('UPDATE players SET starting_cents = $2 WHERE id = $1', [p.id, p.starting_cents]);
  }
  if (payload.settings) {
    await client.query(
      `INSERT INTO settings (id, start_date, end_date, milestone_cents, first_date_planner_id)
       SELECT 1, start_date, end_date, milestone_cents, first_date_planner_id
       FROM jsonb_populate_record(null::settings, $1::jsonb)
       ON CONFLICT (id) DO UPDATE SET start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date,
         milestone_cents = EXCLUDED.milestone_cents, first_date_planner_id = EXCLUDED.first_date_planner_id`,
      [JSON.stringify(payload.settings)],
    );
  }
  await client.query(`TRUNCATE ${DATA_TABLES.join(', ')}`);
  for (const t of DATA_TABLES) {
    await client.query(`INSERT INTO ${t} SELECT * FROM jsonb_populate_recordset(null::${t}, $1::jsonb)`, [JSON.stringify(payload[t])]);
    await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), coalesce(max(id), 0) + 1, false) FROM ${t}`);
  }
}
