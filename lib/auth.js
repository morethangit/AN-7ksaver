import crypto from 'node:crypto';

const THIRTY_DAYS = 30 * 24 * 3600 * 1000;

export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pin), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPin(pin, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(pin), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const mac = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('hex');

export function signSession(playerId, secret, now = Date.now()) {
  const payload = `${playerId}.${now + THIRTY_DAYS}`;
  return `${payload}.${mac(payload, secret)}`;
}

/** Returns the player id, or null if the token is forged, malformed or expired. */
export function verifySession(token, secret, now = Date.now()) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  const [id, exp, sig] = parts;
  const good = mac(`${id}.${exp}`, secret);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  if (Number(exp) < now) return null;
  return Number.isInteger(Number(id)) ? Number(id) : null;
}

export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export const sessionCookie = (token) =>
  `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${THIRTY_DAYS / 1000}`;
export const clearCookie = 'session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';

export function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET must be set (16+ chars)');
  return s;
}

/** Returns the signed-in player id, or sends 401 and returns null. */
export function requireAuth(req, res) {
  const id = verifySession(readCookie(req.headers.cookie, 'session'), secret());
  if (id === null) { res.status(401).json({ error: 'not signed in' }); return null; }
  return id;
}
