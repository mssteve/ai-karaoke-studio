import http from 'node:http';
import path from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const portText = args.length === 0 ? '4173' : args.length === 2 && args[0] === '--port' ? args[1] : '';
const port = Number(portText);
if (!/^\d+$/.test(portText) || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Usage: node scripts\\serve-docs.mjs [--port 4173]');
  process.exit(1);
}

const root = await realpath(fileURLToPath(new URL('../docs/', import.meta.url)));
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function insideRoot(file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const server = http.createServer(async (request, response) => {
  const send = (status, text, headers = {}) => {
    response.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(text),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    });
    response.end(request.method === 'HEAD' ? undefined : text);
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
    return;
  }
  try {
    const rawPath = request.url.split('?')[0];
    const pathname = decodeURIComponent(rawPath);
    const segments = pathname.split('/').filter(Boolean);
    if (!pathname.startsWith('/') || pathname.startsWith('//') ||
        /[\\\u0000-\u001f\u007f:*?"<>|]/.test(pathname) ||
        segments.some(segment => segment === '.' || segment === '..' || /[ .]$/.test(segment))) {
      send(400, 'Invalid path\n');
      return;
    }

    let file = path.resolve(root, ...segments);
    if (!insideRoot(file)) {
      send(403, 'Forbidden\n');
      return;
    }
    file = await realpath(file);
    if (!insideRoot(file)) {
      send(403, 'Forbidden\n');
      return;
    }
    let details = await stat(file);
    if (details.isDirectory()) {
      if (!pathname.endsWith('/')) {
        const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
        const location = `/${segments.map(encodeURIComponent).join('/')}/${query}`;
        send(301, 'Moved permanently\n', { Location: location });
        return;
      }
      file = await realpath(path.join(file, 'index.html'));
      if (!insideRoot(file)) {
        send(403, 'Forbidden\n');
        return;
      }
      details = await stat(file);
    }
    if (!details.isFile()) {
      send(404, 'Not found\n');
      return;
    }
    const body = request.method === 'HEAD' ? undefined : await readFile(file);
    response.writeHead(200, {
      'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body?.length ?? details.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    response.end(body);
  } catch (error) {
    const status = ['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code) ? 404 : error instanceof URIError ? 400 : 500;
    send(status, status === 404 ? 'Not found\n' : status === 400 ? 'Invalid path\n' : 'Unable to serve file\n');
  }
});

server.on('error', error => {
  console.error(`Docs preview could not start: ${error.message}`);
  process.exitCode = 1;
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Karaoke Studio docs: http://127.0.0.1:${port}/`);
});
