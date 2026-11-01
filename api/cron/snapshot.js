import crypto from 'node:crypto';
import { takeSnapshot } from '../../lib/snapshot.js';

// Vercel Cron calls this daily with `Authorization: Bearer $CRON_SECRET`.
export default async function handler(req, res) {
  const want = `Bearer ${process.env.CRON_SECRET ?? ''}`;
  const got = String(req.headers.authorization ?? '');
  const ok = process.env.CRON_SECRET && got.length === want.length &&
    crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!ok) return res.status(401).json({ error: 'unauthorized' });
  res.status(200).json(await takeSnapshot('cron'));
}
