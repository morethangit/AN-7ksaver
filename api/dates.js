import { q, createRows, mutateRow } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { loadSettings } from '../lib/settings.js';
import { gameStatus, validateDate, nextPlanner } from '../lib/game.js';

export default async function handler(req, res) {
  const me = requireAuth(req, res);
  if (me === null) return;

  const settings = await loadSettings();
  const status = settings ? gameStatus(settings) : 'prelaunch';
  if (status !== 'open') return res.status(403).json({ error: `game is ${status}; nothing can be changed` });

  if (req.method === 'POST') {
    const [players, dates] = await Promise.all([
      q('SELECT id, name FROM players ORDER BY id'),
      q('SELECT * FROM dates WHERE deleted_at IS NULL'),
    ]);
    // One date at a time keeps the flip-flop honest: finish or skip it before the next.
    if (dates.some((d) => d.status === 'planned')) {
      return res.status(409).json({ error: 'finish or skip the current date before planning another' });
    }
    const turn = nextPlanner(settings.first_date_planner_id, dates, players.map((p) => p.id));
    if (turn !== me) {
      const who = players.find((p) => p.id === turn)?.name ?? 'the other person';
      return res.status(403).json({ error: `it's ${who}'s turn to plan a date` });
    }
    const v = validateDate(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const [row] = await createRows('dates', [{ planner_id: me, ...v.row, status: 'planned' }], me);
    return res.status(201).json(row);
  }

  const id = Number.parseInt(req.query.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id required' });
  const [date] = await q('SELECT * FROM dates WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!date) return res.status(404).json({ error: 'date not found' });
  if (date.status !== 'planned') return res.status(409).json({ error: `this date is already ${date.status}` });

  if (req.method === 'PATCH' && req.body?.status !== undefined) {
    // Either person can close out the shared date.
    if (!['done', 'skipped'].includes(req.body.status)) return res.status(400).json({ error: 'status must be done or skipped' });
    const [row] = await mutateRow('dates', id, me, { set: { status: req.body.status }, owner: null });
    return res.status(200).json(row);
  }

  // Everything else is the planner's own to change, and only while it is still just a plan.
  if (date.planner_id !== me) return res.status(403).json({ error: 'only the planner can change this date' });

  if (req.method === 'PATCH') {
    const v = validateDate(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const [row] = await mutateRow('dates', id, me, { set: v.row, owner: 'planner_id' });
    return res.status(200).json(row);
  }
  if (req.method === 'DELETE') {
    const [{ n }] = await q('SELECT count(*)::int AS n FROM spends WHERE date_id = $1 AND deleted_at IS NULL', [id]);
    if (n > 0) return res.status(409).json({ error: 'spends are logged against this date; mark it done or skipped instead' });
    const [row] = await mutateRow('dates', id, me, { remove: true, owner: 'planner_id' });
    return res.status(200).json(row);
  }
  return res.status(405).json({ error: 'POST or PATCH or DELETE only' });
}
