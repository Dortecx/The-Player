'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
}

function resolveStaticPath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath.split('?')[0]);
  const normalizedPath = path.normalize(decodedPath).replace(/^([/\\])+/, '');
  const requestedPath = normalizedPath === '' ? 'index.html' : normalizedPath;
  const filePath = path.join(PUBLIC_DIR, requestedPath);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) {
    return null;
  }

  return filePath;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    return;
  }

  let filePath;
  try {
    filePath = resolveStaticPath(req.url || '/');
  } catch (error) {
    send(res, 400, 'Bad Request');
    return;
  }

  if (!filePath) {
    send(res, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      send(res, 404, 'Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Local video player available at http://${HOST}:${PORT}`);
});

server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
