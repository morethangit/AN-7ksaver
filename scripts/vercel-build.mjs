// Vercel build step: keep the database schema current on every deploy (migrate is idempotent), and seed the
// players only while NOLAN_PIN / AURORA_PIN are set, and applies GAME_START_DATE / GAME_END_DATE when both are set (set them for the first deploy, then delete them in Vercel so
// plaintext PINs are not kept around; existing PIN hashes are untouched by later builds).
import { execFileSync } from 'node:child_process';

const run = (s, ...args) => execFileSync(process.execPath, [`scripts/${s}`, ...args], { stdio: 'inherit' });
if (!process.env.DATABASE_URL) {
  console.log('No DATABASE_URL for this deployment: skipping migrate and seed.');
} else {
  run('migrate.mjs');
  if (process.env.NOLAN_PIN && process.env.AURORA_PIN) run('seed.mjs');
  else console.log('NOLAN_PIN/AURORA_PIN not set: players left as they are.');
  // While GAME_START_DATE / GAME_END_DATE are set in Vercel, every deploy enforces them (set-dates). Remove them to
  // leave the dates alone; changing them and redeploying is how the window is moved without a terminal.
  const { GAME_START_DATE: gs, GAME_END_DATE: ge } = process.env;
  if (gs && ge) run('set-dates.mjs', gs, ge);
}
