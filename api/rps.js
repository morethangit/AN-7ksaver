import { q, createRows } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { loadSettings } from '../lib/settings.js';
import { gameStatus, MOVES, rpsOutcome, sanitizeRound, cleanTopic } from '../lib/game.js';

// One audited step on an open round. Params: $1 id, $2 actor, $3 event, then `extra`.
// The audit row records WHAT happened ("move", "tie", "resolved"), never the hidden moves.
function step(id, actor, event, setSql, guard, extra = []) {
  return q(
    `WITH u AS (UPDATE rps_rounds SET ${setSql}
                WHERE id = $1 AND resolved_at IS NULL AND cancelled_at IS NULL ${guard} RETURNING *),
          a AS (INSERT INTO audit_log (table_name,row_id,action,actor_id,after)
                SELECT 'rps_rounds', id, 'update', $2, jsonb_build_object('event', $3::text) FROM u)
     SELECT * FROM u`,
    [id, actor, event, ...extra],
  );
}

export default async function handler(req, res) {
  const me = requireAuth(req, res);
  if (me === null) return;

  const settings = await loadSettings();
  const status = settings ? gameStatus(settings) : 'prelaunch';
  if (status !== 'open') return res.status(403).json({ error: `game is ${status}; nothing can be changed` });

  const players = await q('SELECT id FROM players ORDER BY id');
  const p1 = players[0].id;
  const out = (row) => sanitizeRound({ ...row, used: false }, me, p1);

  if (req.method === 'POST') {
    const topic = cleanTopic(req.body?.topic);
    if (!topic) return res.status(400).json({ error: 'say what you are deciding (e.g. "pizza vs. sushi")' });
    const [open] = await q('SELECT id FROM rps_rounds WHERE resolved_at IS NULL AND cancelled_at IS NULL');
    if (open) return res.status(409).json({ error: 'finish or cancel the current round first' });
    const [row] = await createRows('rps_rounds', [{ topic, started_by: me }], me);
    return res.status(201).json(out(row));
  }

  const id = Number.parseInt(req.query.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id required' });

  if (req.method === 'DELETE') {
    const [row] = await step(id, me, 'cancelled', 'cancelled_at = now()', '');
    return row ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'no open round with that id' });
  }
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'POST, PATCH or DELETE only' });

  const move = req.body?.move;
  if (!MOVES.includes(move)) return res.status(400).json({ error: `move must be one of: ${MOVES.join(', ')}` });
  const col = me === p1 ? 'p1_move' : 'p2_move';
  let [row] = await step(id, me, 'move', `${col} = $4`, `AND ${col} IS NULL`, [move]);
  if (!row) return res.status(409).json({ error: 'round not open, or you already picked (picks are final)' });

  if (row.p1_move && row.p2_move) {
    const outcome = rpsOutcome(row.p1_move, row.p2_move);
    const guard = 'AND p1_move = $4 AND p2_move = $5';
    const moves = [row.p1_move, row.p2_move];
    const next = outcome === 'tie'
      ? await step(id, me, 'tie', 'p1_move = NULL, p2_move = NULL, ties = ties + 1', guard, moves)
      : await step(id, me, 'resolved', 'winner_id = $6, resolved_at = now()', guard, [...moves, outcome === 'p1' ? p1 : players[1].id]);
    // Both players picking at the same instant: the other request may have settled it already.
    row = next[0] ?? (await q('SELECT * FROM rps_rounds WHERE id = $1', [id]))[0];
  }
  return res.status(200).json(out(row));
}
