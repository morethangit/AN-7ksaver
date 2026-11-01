import { q } from '../lib/db.js';
import { verifyPin, signSession, sessionCookie, clearCookie, secret } from '../lib/auth.js';

const MAX_FAILURES = 10; // per player per 15 minutes; 4-digit PINs need this

export default async function handler(req, res) {
  if (req.method === 'DELETE') {
    res.setHeader('Set-Cookie', clearCookie);
    return res.status(200).json({ ok: true });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { name, pin } = req.body ?? {};
  const [player] = await q('SELECT id, name, pin_hash FROM players WHERE lower(name) = lower($1)', [String(name ?? '')]);
  // Same answer for unknown name and wrong PIN.
  const bad = () => res.status(401).json({ error: 'wrong name or PIN' });
  if (!player) return bad();

  const [{ n }] = await q(
    `SELECT count(*)::int AS n FROM login_failures WHERE player_id = $1 AND at > now() - interval '15 minutes'`,
    [player.id],
  );
  if (n >= MAX_FAILURES) return res.status(429).json({ error: 'too many attempts, try again in 15 minutes' });

  if (!verifyPin(pin ?? '', player.pin_hash)) {
    await q('INSERT INTO login_failures (player_id) VALUES ($1)', [player.id]);
    return bad();
  }
  res.setHeader('Set-Cookie', sessionCookie(signSession(player.id, secret())));
  return res.status(200).json({ ok: true, id: player.id, name: player.name });
}
