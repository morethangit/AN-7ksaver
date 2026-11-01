import { requireAuth } from '../lib/auth.js';
import { takeSnapshot } from '../lib/snapshot.js';

// "Save snapshot now" button: either player may take one.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (requireAuth(req, res) === null) return;
  res.status(201).json(await takeSnapshot('manual'));
}
