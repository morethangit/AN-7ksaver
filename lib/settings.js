import { q } from './db.js';

/** The single settings row (dates as 'YYYY-MM-DD' strings), or null if the database has not been seeded. */
export async function loadSettings() {
  const [s] = await q(
    'SELECT start_date::text, end_date::text, milestone_cents, first_date_planner_id, timezone FROM settings',
  );
  return s ?? null;
}
