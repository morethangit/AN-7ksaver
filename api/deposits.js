import { q, createRows, mutateRow } from '../lib/db.js';
import { requireAuth } from '../lib/auth.js';
import { gameStatus, validateDeposit } from '../lib/game.js';

export default async function handler(req, res) {
  const me = requireAuth(req, res);
  if (me === null) return;

  const [settings] = await q('SELECT start_date::text, end_date::text FROM settings');
  const status = settings ? gameStatus(settings) : 'prelaunch';
  if (status !== 'open') return res.status(403).json({ error: `game is ${status}; nothing can be changed` });

  if (req.method === 'POST') {
    const v = validateDeposit(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const [row] = await createRows('deposits', [{ player_id: me, ...v.row }], me);
    return res.status(201).json(row);
  }

  const id = Number.parseInt(req.query.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id required' });

  if (req.method === 'PATCH') {
    const v = validateDeposit(req.body);
    if (v.error) return res.status(400).json({ error: v.error });
    const [row] = await mutateRow('deposits', id, me, { set: v.row });
    return row ? res.status(200).json(row) : res.status(404).json({ error: 'not found, or not yours' });
  }
  if (req.method === 'DELETE') {
    const [row] = await mutateRow('deposits', id, me, { remove: true });
    return row ? res.status(200).json(row) : res.status(404).json({ error: 'not found, or not yours' });
  }
  return res.status(405).json({ error: 'POST, PATCH or DELETE only' });
}
