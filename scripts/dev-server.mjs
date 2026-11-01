// Local stand-in for Vercel: serves public/ and runs api/*.js handlers.
//   DEV_DATABASE_URL=postgres://... node scripts/dev-server.mjs   (a local Postgres, via `pg`)
//   DATABASE_URL=postgres://...     node scripts/dev-server.mjs   (Neon)
import http from 'node:http';
import { readFile, access } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

export async function startServer(port = 3000) {
  if (process.env.DEV_DATABASE_URL) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: process.env.DEV_DATABASE_URL });
    (await import('../lib/db.js')).setRunner((t, p) => pool.query(t, p).then((r) => r.rows));
  }
  process.env.SESSION_SECRET ??= 'dev-only-secret-not-for-production';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        const file = join(ROOT, normalize(url.pathname).replace(/^\/+/, '') + '.js');
        if (!file.startsWith(join(ROOT, 'api'))) throw Object.assign(new Error('nope'), { status: 404 });
        await access(file).catch(() => { throw Object.assign(new Error('no such endpoint'), { status: 404 }); });
        const chunks = []; for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString();
        let body; try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
        const vres = Object.assign(res, {
          status(c) { res.statusCode = c; return vres; },
          json(b) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(b)); return vres; },
        });
        const handler = (await import(pathToFileURL(file).href)).default;
        return await handler({ method: req.method, headers: req.headers, body, query: Object.fromEntries(url.searchParams) }, vres);
      }
      const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^\/+/, '');
      const file = join(ROOT, 'public', rel);
      if (!file.startsWith(join(ROOT, 'public'))) throw Object.assign(new Error('nope'), { status: 404 });
      const data = await readFile(file).catch(() => { throw Object.assign(new Error('not found'), { status: 404 }); });
      res.setHeader('content-type', TYPES[extname(file)] ?? 'application/octet-stream');
      res.end(data);
    } catch (e) {
      res.statusCode = e.status ?? 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: e.status ? e.message : 'server error' }));
      if (!e.status) console.error(e);
    }
  });
  await new Promise((r) => server.listen(port, r));
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  await startServer(port);
  console.log(`http://localhost:${port}`);
}
