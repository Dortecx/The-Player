'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const SHARE_LAN = process.env.SHARE_LAN === '1';
const HOST = SHARE_LAN ? '0.0.0.0' : '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024;

function parseUploadLimit(value) {
  if (value === undefined || value === '') return DEFAULT_MAX_UPLOAD_BYTES;
  if (!/^\d+$/.test(value)) throw new RangeError('MAX_UPLOAD_BYTES must be a positive whole number of bytes');
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new RangeError('MAX_UPLOAD_BYTES must be a positive whole number of bytes');
  return bytes;
}

const MAX_UPLOAD_BYTES = parseUploadLimit(process.env.MAX_UPLOAD_BYTES);
const MAX_METADATA_BYTES = 1024;
const UPLOAD_PROTOCOL = Object.freeze({
  contentType: 'application/octet-stream',
  filenameHeader: 'x-media-filename',
  maximumBytes: MAX_UPLOAD_BYTES
});
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_POSITION_SECONDS = 7 * 24 * 60 * 60;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const MEDIA_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo'
};

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

function resolveStaticPath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath.split('?')[0]);
  const normalizedPath = path.normalize(decodedPath).replace(/^([/\\])+/, '');
  const requestedPath = normalizedPath === '' ? 'index.html' : normalizedPath;
  const filePath = path.join(PUBLIC_DIR, requestedPath);

  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== PUBLIC_DIR) return null;
  return filePath;
}

function readRequestBody(req, maximum) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > maximum) {
      reject(Object.assign(new Error('Payload Too Large'), { statusCode: 413 }));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximum) {
        reject(Object.assign(new Error('Payload Too Large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function uploadMetadata(req, maximum) {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/octet-stream(?:\s*;\s*[^;]+)?$/i.test(contentType)) {
    throw Object.assign(new Error(`Expected ${UPLOAD_PROTOCOL.contentType} upload body`), { statusCode: 415 });
  }
  const filename = req.headers[UPLOAD_PROTOCOL.filenameHeader];
  if (typeof filename !== 'string' || Buffer.byteLength(filename) === 0 || Buffer.byteLength(filename) > MAX_METADATA_BYTES || /[\0\r\n\\/]/.test(filename)) {
    throw Object.assign(new Error('Invalid media filename'), { statusCode: 400 });
  }
  const extension = path.extname(filename).toLowerCase();
  const mime = MEDIA_TYPES[extension];
  if (!mime) throw Object.assign(new Error('Unsupported media type'), { statusCode: 415 });
  const declaredLength = req.headers['content-length'];
  if (declaredLength !== undefined) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) throw Object.assign(new Error('Invalid Content-Length'), { statusCode: 400 });
    if (length > maximum) throw Object.assign(new Error('Payload Too Large'), { statusCode: 413 });
  }
  return { filename, extension, mime };
}

async function streamUpload(req, filePath, maximum) {
  let size = 0;
  const digest = crypto.createHash('sha256');
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length;
      if (size > maximum) {
        callback(Object.assign(new Error('Payload Too Large'), { statusCode: 413 }));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    }
  });
  try {
    await pipeline(req, limiter, fs.createWriteStream(filePath, { flags: 'wx', mode: 0o600 }));
    if (size === 0) throw Object.assign(new Error('Empty media file'), { statusCode: 400 });
    return { size, contentId: digest.digest('hex') };
  } catch (error) {
    await fsp.rm(filePath, { force: true });
    throw error;
  }
}

function getRoomToken(req, url) {
  const header = req.headers['x-room-token'];
  if (typeof header === 'string' && header) return header;
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) return authorization.slice(7);
  return url.searchParams.get('token') || '';
}

function isLoopbackRemoteAddress(address) {
  if (typeof address !== 'string') return false;
  const normalized = address.toLowerCase();
  if (normalized === '::1') return true;
  const mapped = normalized.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  const ipv4 = mapped ? mapped.slice(1).map(Number) : normalized.split('.').map(Number);
  return ipv4.length === 4 && ipv4.every(Number.isInteger) && ipv4.every((part) => part >= 0 && part <= 255) && ipv4[0] === 127;
}

function isHostRequest(req) {
  return isLoopbackRemoteAddress(req.socket?.remoteAddress);
}

function selectLanAddresses(networkInterfaces) {
  const virtualAdapter = /docker|veth|\bbr[-\d]|virbr|vmnet|vbox|virtual|hyper-v|vethernet|wsl|vpn|\btun\d*\b|\btap\d*\b|\bppp\d*\b|tailscale|zerotier|wireguard|\bwg\d*\b/i;
  const addresses = Object.entries(networkInterfaces || {})
    .flatMap(([name, entries]) => (entries || [])
      .filter((address) => address && address.family === 'IPv4' && !address.internal)
      .map((address) => ({ name, address: address.address })));
  const physical = addresses.filter(({ name }) => !virtualAdapter.test(name));
  return (physical.length ? physical : addresses).map(({ address }) => address);
}

function formatRoomUrl(address, port, token) {
  return `http://${address}:${port}/?token=${encodeURIComponent(token)}`;
}

function parseRange(range, size) {
  if (!range) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return undefined;
  let start;
  let end;
  if (match[1] === '') {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return undefined;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return undefined;
  return { start, end: Math.min(end, size - 1) };
}

function createMediaServer({
  storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-media-')),
  token = crypto.randomBytes(32).toString('base64url'),
  maxUploadBytes = MAX_UPLOAD_BYTES,
  hostAuthority = isHostRequest,
  lanAddresses = () => selectLanAddresses(os.networkInterfaces())
} = {}) {
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) {
    throw new RangeError('maxUploadBytes must be a positive whole number of bytes');
  }
  fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  const library = new Map();
  const stagedMedia = new Map();
  const clients = new Set();
  let state = { mediaId: null, playing: false, position: 0, sequence: 0, updatedAt: Date.now() };

  function publicMedia(media) {
    return { id: media.id, contentId: media.contentId, name: media.name, size: media.size, mime: media.mime, uploadedAt: media.uploadedAt };
  }
  function roomState() { return { ...state, serverTime: Date.now() }; }
  function getRoomUrl() {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    if (!Number.isSafeInteger(port) || port <= 0) return null;
    const preferredLanAddress = lanAddresses()[0];
    return formatRoomUrl(preferredLanAddress || '127.0.0.1', port, token);
  }
  function removeClient(client) {
    clients.delete(client);
  }
  function writeSse(client, payload) {
    if (client.destroyed || client.writableEnded || !client.writable) {
      removeClient(client);
      return;
    }
    try {
      client.write(payload);
    } catch (error) {
      removeClient(client);
      console.warn(`SSE client write failed: ${error.message}`);
    }
  }
  function broadcastState() {
    const payload = `event: state\ndata: ${JSON.stringify(roomState())}\n\n`;
    for (const client of clients) writeSse(client, payload);
  }
  function broadcastLibrary() {
    const payload = `event: library\ndata: ${JSON.stringify({ media: [...library.values()].map(publicMedia) })}\n\n`;
    for (const client of clients) writeSse(client, payload);
  }
  function updateState(next, { libraryChanged = false } = {}) {
    state = { ...next, sequence: state.sequence + 1, updatedAt: Date.now() };
    if (libraryChanged) broadcastLibrary();
    broadcastState();
    return roomState();
  }
  function resetRoomState() {
    return { mediaId: null, playing: false, position: 0 };
  }
  async function removeMedia(media) {
    const diskName = path.basename(media.diskName);
    if (diskName !== media.diskName) return;
    try {
      await fsp.rm(path.join(storageDir, diskName), { force: true });
    } catch (error) {
      console.error(`Could not remove temporary media ${media.id}:`, error.message);
    }
  }
  async function replaceLibrary(req, res) {
    try {
      const body = JSON.parse((await readRequestBody(req, MAX_COMMAND_BYTES)).toString('utf8'));
      const mediaIds = body?.mediaIds;
      if (!Array.isArray(mediaIds) || !mediaIds.length || mediaIds.some((id) => typeof id !== 'string') || new Set(mediaIds).size !== mediaIds.length) {
        throw Object.assign(new Error('Replacement requires one or more unique staged media IDs'), { statusCode: 400 });
      }
      const replacement = mediaIds.map((id) => stagedMedia.get(id));
      if (replacement.some((media) => !media)) throw Object.assign(new Error('Unknown staged media ID'), { statusCode: 422 });
      const resume = body?.resume;
      let position = 0;
      if (resume !== undefined) {
        if (!resume || typeof resume.contentId !== 'string' || !Number.isFinite(resume.position)
          || resume.position < 0 || resume.position > MAX_POSITION_SECONDS
          || replacement[0].contentId !== resume.contentId) {
          throw Object.assign(new Error('Invalid replacement resume position'), { statusCode: 400 });
        }
        position = resume.position;
      }
      const obsolete = [...library.values(), ...stagedMedia.values()].filter((media) => !mediaIds.includes(media.id));
      library.clear();
      stagedMedia.clear();
      for (const media of replacement) library.set(media.id, media);
      updateState({ mediaId: replacement[0].id, playing: false, position }, { libraryChanged: true });
      await Promise.all(obsolete.map(removeMedia));
      sendJson(res, 200, { media: [...library.values()].map(publicMedia), state: roomState() });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.statusCode ? error.message : 'Invalid library replacement' });
    }
  }
  async function appendLibrary(req, res) {
    try {
      const body = JSON.parse((await readRequestBody(req, MAX_COMMAND_BYTES)).toString('utf8'));
      const mediaIds = body?.mediaIds;
      if (!Array.isArray(mediaIds) || !mediaIds.length || mediaIds.some((id) => typeof id !== 'string') || new Set(mediaIds).size !== mediaIds.length) {
        throw Object.assign(new Error('Append requires one or more unique staged media IDs'), { statusCode: 400 });
      }
      const additions = mediaIds.map((id) => stagedMedia.get(id));
      if (additions.some((media) => !media)) throw Object.assign(new Error('Unknown staged media ID'), { statusCode: 422 });
      for (const media of additions) {
        stagedMedia.delete(media.id);
        library.set(media.id, media);
      }
      const next = state.mediaId ? state : { ...state, mediaId: additions[0].id, playing: false, position: 0 };
      updateState(next, { libraryChanged: true });
      sendJson(res, 200, { media: [...library.values()].map(publicMedia), state: roomState() });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.statusCode ? error.message : 'Invalid library append' });
    }
  }
  async function clearLibrary(res) {
    const obsolete = [...library.values(), ...stagedMedia.values()];
    library.clear();
    stagedMedia.clear();
    updateState(resetRoomState(), { libraryChanged: true });
    await Promise.all(obsolete.map(removeMedia));
    sendJson(res, 200, { media: [], state: roomState() });
  }
  function requireToken(req, res, url) {
    const supplied = getRoomToken(req, url);
    const suppliedBytes = Buffer.from(supplied);
    const tokenBytes = Buffer.from(token);
    const valid = suppliedBytes.length === tokenBytes.length && crypto.timingSafeEqual(suppliedBytes, tokenBytes);
    if (valid) return true;
    sendJson(res, 401, { error: 'Valid room token required' });
    return false;
  }
  function requireHost(req, res) {
    if (hostAuthority(req)) return true;
    sendJson(res, 403, { error: 'Only the localhost host may modify the shared library' });
    return false;
  }
  async function upload(req, res) {
    let filePath;
    try {
      const file = uploadMetadata(req, maxUploadBytes);
      const id = crypto.randomBytes(18).toString('base64url');
      const diskName = `${id}${file.extension}`;
      filePath = path.join(storageDir, diskName);
      const { size, contentId } = await streamUpload(req, filePath, maxUploadBytes);
      const media = { id, contentId, diskName, name: file.filename, size, mime: file.mime, uploadedAt: Date.now() };
      stagedMedia.set(id, media);
      sendJson(res, 201, { media: publicMedia(media) });
    } catch (error) {
      if (filePath) await fsp.rm(filePath, { force: true });
      if (!res.destroyed) sendJson(res, error.statusCode || 500, { error: error.statusCode ? error.message : 'Upload failed' });
    }
  }
  async function streamMedia(req, res, id) {
    const media = library.get(id);
    if (!media) return send(res, 404, 'Not Found');
    const range = parseRange(req.headers.range, media.size);
    if (range === undefined) return send(res, 416, 'Range Not Satisfiable', { 'Content-Range': `bytes */${media.size}`, 'Accept-Ranges': 'bytes' });
    const start = range ? range.start : 0;
    const end = range ? range.end : media.size - 1;
    const length = end - start + 1;
    res.writeHead(range ? 206 : 200, {
      'Content-Type': media.mime,
      'Content-Length': length,
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${media.size}` } : {}),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(path.join(storageDir, media.diskName), { start, end });
    stream.on('error', () => { if (!res.headersSent) send(res, 500, 'Media unavailable'); else res.destroy(); });
    stream.pipe(res);
  }
  async function command(req, res) {
    try {
      const body = JSON.parse((await readRequestBody(req, MAX_COMMAND_BYTES)).toString('utf8'));
      if (!body || typeof body !== 'object' || typeof body.type !== 'string') throw Object.assign(new Error('Invalid room command'), { statusCode: 400 });
      const next = { ...state };
      if (body.type === 'select') {
        if (typeof body.mediaId !== 'string' || !library.has(body.mediaId)) throw Object.assign(new Error('Unknown media ID'), { statusCode: 422 });
        next.mediaId = body.mediaId; next.position = 0;
      } else if (body.type === 'play' || body.type === 'pause') {
        if (body.position !== undefined) {
          if (!Number.isFinite(body.position) || body.position < 0 || body.position > MAX_POSITION_SECONDS) throw Object.assign(new Error('Invalid seek position'), { statusCode: 422 });
          next.position = body.position;
        }
        next.playing = body.type === 'play';
      } else if (body.type === 'seek') {
        if (!Number.isFinite(body.position) || body.position < 0 || body.position > MAX_POSITION_SECONDS) throw Object.assign(new Error('Invalid seek position'), { statusCode: 422 });
        next.position = body.position;
      } else if (body.type === 'previous' || body.type === 'next') {
        const items = [...library.values()];
        if (!items.length) throw Object.assign(new Error('Library is empty'), { statusCode: 422 });
        const current = items.findIndex((item) => item.id === state.mediaId);
        const index = current === -1 ? (body.type === 'previous' ? items.length - 1 : 0) : (current + (body.type === 'next' ? 1 : -1) + items.length) % items.length;
        next.mediaId = items[index].id;
        next.position = 0;
      } else throw Object.assign(new Error('Unsupported room command'), { statusCode: 400 });
      sendJson(res, 200, { state: updateState(next) });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.statusCode ? error.message : 'Invalid room command' });
    }
  }
  function serveStatic(req, res, url) {
    let filePath;
    try { filePath = resolveStaticPath(url.pathname); } catch { return send(res, 400, 'Bad Request'); }
    if (!filePath) return send(res, 403, 'Forbidden');
    fs.stat(filePath, (error, stat) => {
      if (error || !stat.isFile()) return send(res, 404, 'Not Found');
      const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(filePath);
      stream.on('error', (error) => {
        console.warn(`Static stream failed for ${url.pathname}: ${error.message}`);
        if (!res.headersSent) send(res, 500, 'Static file unavailable');
        else res.destroy();
      });
      stream.pipe(res);
    });
  }
  async function handleRequest(req, res) {
    const requestId = crypto.randomBytes(6).toString('hex');
    res.setHeader('X-Request-Id', requestId);
    const url = new URL(req.url || '/', 'http://localhost');
    const protectedRoute = url.pathname === '/api/session' || url.pathname === '/api/upload' || url.pathname === '/api/library' || url.pathname === '/api/library/replace' || url.pathname === '/api/library/append' || url.pathname === '/api/library/clear' || url.pathname === '/api/room' || url.pathname === '/api/room/commands' || url.pathname === '/api/events' || url.pathname.startsWith('/media/');
    if (protectedRoute && !requireToken(req, res, url)) return;
    if (url.pathname === '/api/session') return req.method === 'GET' ? sendJson(res, 200, { role: hostAuthority(req) ? 'host' : 'guest', roomUrl: getRoomUrl() }) : send(res, 405, 'Method Not Allowed', { Allow: 'GET' });
    if (url.pathname === '/api/upload') return req.method === 'POST' ? (requireHost(req, res) ? upload(req, res) : undefined) : send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
    if (url.pathname === '/api/library/replace') return req.method === 'POST' ? (requireHost(req, res) ? replaceLibrary(req, res) : undefined) : send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
    if (url.pathname === '/api/library/append') return req.method === 'POST' ? (requireHost(req, res) ? appendLibrary(req, res) : undefined) : send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
    if (url.pathname === '/api/library/clear') return req.method === 'POST' ? (requireHost(req, res) ? clearLibrary(res) : undefined) : send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
    if (url.pathname === '/api/library') return req.method === 'GET' ? sendJson(res, 200, { media: [...library.values()].map(publicMedia) }) : send(res, 405, 'Method Not Allowed', { Allow: 'GET' });
    if (url.pathname.startsWith('/media/')) return (req.method === 'GET' || req.method === 'HEAD') ? streamMedia(req, res, url.pathname.slice('/media/'.length)) : send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    if (url.pathname === '/api/room') return req.method === 'GET' ? sendJson(res, 200, { state: roomState() }) : send(res, 405, 'Method Not Allowed', { Allow: 'GET' });
    if (url.pathname === '/api/room/commands') return req.method === 'POST' ? command(req, res) : send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
    if (url.pathname === '/api/events') {
      if (req.method !== 'GET') return send(res, 405, 'Method Not Allowed', { Allow: 'GET' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
      clients.add(res);
      const cleanupClient = () => removeClient(res);
      req.once('close', cleanupClient);
      res.once('close', cleanupClient);
      res.once('error', cleanupClient);
      writeSse(res, `event: snapshot\ndata: ${JSON.stringify({ media: [...library.values()].map(publicMedia), state: roomState() })}\n\n`);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    serveStatic(req, res, url);
  }
  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      const requestId = res.getHeader('X-Request-Id') || 'unknown';
      const requestPath = (() => {
        try { return new URL(req.url || '/', 'http://localhost').pathname; } catch { return '<invalid-path>'; }
      })();
      const message = String(error?.message || 'Unexpected request failure').replace(/[\r\n]/g, ' ').slice(0, 240);
      console.warn(`Request ${requestId} ${req.method || 'UNKNOWN'} ${requestPath} failed: ${message}`);
      if (!res.destroyed && !res.writableEnded) sendJson(res, error.statusCode || 500, { error: 'Request failed', requestId });
    });
  });
  let closePromise;
  async function cleanup() {
    await fsp.rm(storageDir, { recursive: true, force: true });
  }
  function closeServer() {
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  function close() {
    if (!closePromise) {
      closePromise = (async () => {
        for (const client of clients) client.destroy();
        clients.clear();
        server.closeAllConnections?.();
        await closeServer();
        await cleanup();
      })();
    }
    return closePromise;
  }
  return { server, token, storageDir, cleanup, close, getRoomUrl };
}

if (require.main === module) {
  const app = createMediaServer();
  let shutdownPromise;
  const shutdown = () => {
    if (!shutdownPromise) {
      shutdownPromise = app.close().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
    }
    return shutdownPromise;
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  app.server.listen(PORT, HOST, () => {
    console.log(`Effective MAX_UPLOAD_BYTES=${MAX_UPLOAD_BYTES} (${MAX_UPLOAD_BYTES / (1024 ** 3)} GiB)`);
    if (!SHARE_LAN) {
      console.log(`Local video player available at http://${HOST}:${PORT}`);
      return;
    }

    const lanAddresses = selectLanAddresses(os.networkInterfaces());
    const boundPort = app.server.address().port;
    console.log('LAN sharing enabled. Anyone with a room URL can control playback and access uploaded media.');
    console.log(`Host library URL: ${formatRoomUrl('127.0.0.1', boundPort, app.token)}`);
    if (!lanAddresses.length) {
      console.warn('No usable LAN IPv4 address was found. Connect to a network, then restart with SHARE_LAN=1.');
      console.log(`Shared room URL (loopback fallback): ${app.getRoomUrl()}`);
      return;
    }
    console.log(`Shared room URL: ${app.getRoomUrl()}`);
  });
  app.server.on('error', (error) => { console.error(error.message); process.exitCode = 1; void shutdown(); });
}

module.exports = { createMediaServer, isHostRequest, isLoopbackRemoteAddress, parseRange, parseUploadLimit, selectLanAddresses, UPLOAD_PROTOCOL };
