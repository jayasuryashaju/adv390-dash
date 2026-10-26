import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, normalize } from 'node:path';

// Serves web/ on localhost, which browsers treat as secure, so Web Bluetooth works here.
const root = fileURLToPath(new URL('../web/', import.meta.url));
const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.mjs': 'application/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (req, res) => {
  let path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/') path = '/index.html';
  const file = normalize(root + path);
  if (!file.startsWith(normalize(root)) || !types[extname(file)]) { res.writeHead(404); res.end('Not found'); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(Number(process.env.PORT || 3900), '127.0.0.1', () => {
  const base = `http://127.0.0.1:${server.address().port}/`;
  console.log(`Dashboard: ${base}\nDemo data: ${base}?demo=1`);
});
