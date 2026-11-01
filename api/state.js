import { q } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { computeBalances, gameStatus, daysUntil, nextPlanner, sanitizeRound } from '../lib/game.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const me = requireAuth(req, res);
  if (me === null) return;

  const [players, [settings], deposits, spends, edited, dates, rounds] = await Promise.all([
    q('SELECT id, name, starting_cents FROM players ORDER BY id'),
    q('SELECT start_date::text, end_date::text, milestone_cents, first_date_planner_id FROM settings'),
    q('SELECT * FROM deposits WHERE deleted_at IS NULL ORDER BY created_at DESC'),
    q('SELECT * FROM spends WHERE deleted_at IS NULL ORDER BY created_at DESC'),
    q(`SELECT DISTINCT table_name, row_id FROM audit_log WHERE action = 'update'`),
    q('SELECT * FROM dates WHERE deleted_at IS NULL ORDER BY id DESC'),
    q(`SELECT r.*, EXISTS (SELECT 1 FROM spends s WHERE s.rps_round_id = r.id AND s.deleted_at IS NULL) AS used
       FROM rps_rounds r WHERE r.cancelled_at IS NULL ORDER BY r.id DESC LIMIT 10`),
  ]);
  if (!settings) return res.status(500).json({ error: 'settings row missing: run npm run seed' });

  const editedKeys = new Set(edited.map((e) => `${e.table_name}:${e.row_id}`));
  const balances = computeBalances({ players, deposits, spends });
  const standings = Object.values(balances)
    .map((b) => ({ ...b, hit_milestone: b.saved_cents >= settings.milestone_cents }))
    .sort((a, b) => b.saved_cents - a.saved_cents);

  const feed = [
    ...deposits.map((d) => ({ kind: 'deposit', edited: editedKeys.has(`deposits:${d.id}`), ...d })),
    ...spends.map((s) => ({ kind: 'spend', edited: editedKeys.has(`spends:${s.id}`), ...s })),
  ].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, 100);

  res.status(200).json({
    me,
    status: gameStatus(settings),
    days_to_start: daysUntil(settings.start_date),
    days_to_end: daysUntil(settings.end_date),
    settings,
    standings,
    leader_gap_cents: standings.length > 1 ? standings[0].saved_cents - standings[1].saved_cents : 0,
    feed,
    dates: dates.map((d) => ({ ...d, edited: editedKeys.has(`dates:${d.id}`) })),
    rps: rounds.map((r) => sanitizeRound(r, me, players[0].id)),
    open_date: dates.find((d) => d.status === 'planned') ?? null,
    next_planner_id: nextPlanner(settings.first_date_planner_id, dates, players.map((p) => p.id)),
  });
}
