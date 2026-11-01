import { q, createRows, mutateRow } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { gameStatus, validateSpend, checkSpendAgainstDate, checkRpsRound, isGas, CATEGORIES } from '../lib/game.js';

export default async function handler(req, res) {
  const me = requireAuth(req, res);
  if (me === null) return;

  const [settings] = await q('SELECT start_date::text, end_date::text FROM settings');
  const status = settings ? gameStatus(settings) : 'prelaunch';
  if (status !== 'open') return res.status(403).json({ error: `game is ${status}; nothing can be changed` });

  if (req.method === 'POST') {
    const [other] = await q('SELECT id FROM players WHERE id <> $1 ORDER BY id LIMIT 1', [me]);
    if (!other) return res.status(500).json({ error: 'second player missing: run npm run seed' });
    const v = validateSpend(req.body, me, other.id);
    if (v.error) return res.status(v.status ?? 400).json({ error: v.error });
    const dateId = v.rows[0].date_id;
    if (dateId !== null) {
      const [date] = await q('SELECT * FROM dates WHERE id = $1', [dateId]);
      const problem = checkSpendAgainstDate(v.rows[0].category, date);
      if (problem) return res.status(400).json({ error: problem });
    }
    if (v.rows[0].via === 'rps') {
      const rid = v.rows[0].rps_round_id;
      const [[round], [{ n }]] = await Promise.all([
        q('SELECT * FROM rps_rounds WHERE id = $1', [rid]),
        q('SELECT count(*)::int AS n FROM spends WHERE rps_round_id = $1 AND deleted_at IS NULL', [rid]),
      ]);
      const problem = checkRpsRound(round, me, n > 0);
      if (problem) return res.status(400).json({ error: problem });
    }
    try {
      return res.status(201).json(await createRows('spends', v.rows, me));
    } catch (e) {
      // Two taps at once on the same RPS round: the unique index lets only one through.
      if (/unique|duplicate/i.test(e.message)) return res.status(409).json({ error: 'that round has already been used for a spend' });
      throw e;
    }
  }

  const id = Number.parseInt(req.query.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id required' });

  // Immunity halves are two people's rows linked by split_group. Editing or
  // deleting one half alone would unbalance the bill, so that is blocked until
  // the UI can change both together.
  const [existing] = await q('SELECT split_group FROM spends WHERE id = $1', [id]);
  if (existing?.split_group) {
    return res.status(409).json({ error: 'split (immunity) spends cannot be edited or deleted yet' });
  }

  if (req.method === 'PATCH') {
    const b = req.body ?? {};
    const set = {};
    if (b.amount_cents !== undefined) {
      if (!Number.isInteger(b.amount_cents) || b.amount_cents <= 0) return res.status(400).json({ error: 'bad amount_cents' });
      set.amount_cents = b.amount_cents;
    }
    if (b.category !== undefined) {
      if (!CATEGORIES.includes(b.category)) return res.status(400).json({ error: 'bad category' });
      set.category = b.category;
      set.is_gas = isGas(b.category);
    }
    if (b.note !== undefined) set.note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 280) : null;
    if (b.texted_first !== undefined) set.texted_first = b.texted_first === true;
    if (!Object.keys(set).length) return res.status(400).json({ error: 'nothing to change' });
    const [row] = await mutateRow('spends', id, me, { set });
    return row ? res.status(200).json(row) : res.status(404).json({ error: 'not found, or not yours' });
  }
  if (req.method === 'DELETE') {
    const [row] = await mutateRow('spends', id, me, { remove: true });
    return row ? res.status(200).json(row) : res.status(404).json({ error: 'not found, or not yours' });
  }
  return res.status(405).json({ error: 'POST, PATCH or DELETE only' });
}
