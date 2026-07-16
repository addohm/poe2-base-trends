/** Local preview of dist/ — GitHub Pages serves these files the same way. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const DIST = path.join(process.cwd(), 'dist');
const PORT = Number(process.env.PORT ?? 4173);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.js': 'text/javascript',
};

createServer(async (req, res) => {
  const rel = decodeURIComponent((req.url ?? '/').split('?')[0]!);
  const file = path.join(DIST, rel.endsWith('/') ? `${rel}index.html` : rel);
  // Refuse to serve outside dist/, even though this only ever binds to localhost.
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`preview: http://localhost:${PORT}`));
