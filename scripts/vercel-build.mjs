// Vercel build step: keep the database schema current on every deploy (migrate is idempotent), and seed the
// players only while NOLAN_PIN / AURORA_PIN are set (set them for the first deploy, then delete them in Vercel so
// plaintext PINs are not kept around; existing PIN hashes are untouched by later builds).
import { execFileSync } from 'node:child_process';

const run = (s) => execFileSync(process.execPath, [`scripts/${s}`], { stdio: 'inherit' });
if (!process.env.DATABASE_URL) {
  console.log('No DATABASE_URL for this deployment: skipping migrate and seed.');
} else {
  run('migrate.mjs');
  if (process.env.NOLAN_PIN && process.env.AURORA_PIN) run('seed.mjs');
  else console.log('NOLAN_PIN/AURORA_PIN not set: players left as they are.');
}
