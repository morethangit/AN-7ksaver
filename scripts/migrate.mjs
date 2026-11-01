import { readFileSync } from 'node:fs';
import { q } from '../lib/db.js';

// The schema is plain statements, one per ';' + newline; Neon's HTTP driver runs one at a time.
const statements = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
  .split(/;\s*\n/).map((s) => s.trim()).filter(Boolean);
for (const s of statements) await q(s);
console.log(`ran ${statements.length} statements`);
