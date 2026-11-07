'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const { createFfmpegRunner, createFfprobeRunner, createMediaServer, isHostRequest, isLoopbackRemoteAddress, parseUploadLimit, resolveMediaCommand, selectLanAddresses, UPLOAD_PROTOCOL } = require('../server');

function request(port, options = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...options }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function multipart(boundary, filename, content) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
}

function rawUpload(port, filename, content, extra = {}) {
  return request(port, {
    path: '/api/upload?token=test-room-token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Media-Filename': filename,
      'Content-Length': content.length,
      ...extra
    }
  }, content);
}

function replaceLibrary(port, mediaIds) {
  return request(port, {
    path: '/api/library/replace?token=test-room-token',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Token': 'test-room-token' }
  }, Buffer.from(JSON.stringify({ mediaIds })));
}

function appendLibrary(port, mediaIds) {
  return request(port, {
    path: '/api/library/append?token=test-room-token',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Token': 'test-room-token' }
  }, Buffer.from(JSON.stringify({ mediaIds })));
}

function roomCommand(port, body, extra = {}) {
  return request(port, {
    path: '/api/room/commands?token=test-room-token',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Token': 'test-room-token', ...extra }
  }, Buffer.from(JSON.stringify(body)));
}

function openEvents(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events?token=test-room-token' });
    req.once('error', reject);
    req.once('response', (response) => {
      let buffer = '';
      const events = [];
      const waiters = [];
      const nextEvent = () => events.length
        ? Promise.resolve(events.shift())
        : new Promise((nextResolve) => waiters.push(nextResolve));
      response.on('data', (chunk) => {
        buffer += chunk;
        let delimiter;
        while ((delimiter = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, delimiter);
          buffer = buffer.slice(delimiter + 2);
          const event = /^event: ([^\n]+)\ndata: (.+)$/s.exec(frame);
          if (!event) continue;
          const value = { type: event[1], data: JSON.parse(event[2]) };
          const waiter = waiters.shift();
          if (waiter) waiter(value);
          else events.push(value);
        }
      });
      resolve({ response, nextEvent });
    });
  });
}

async function startFixture(t, options = {}) {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-test-'));
  const app = createMediaServer({ storageDir, token: 'test-room-token', lanAddresses: () => [], ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  t.after(async () => {
    await app.close();
  });
  return { app, port };
}

test('portable runtime resolution prefers packaged Windows tools and leaves development on PATH', () => {
  const appDirectory = path.join(path.sep, 'portable', 'app');
  const packaged = path.join(path.sep, 'portable', 'runtime', 'ffprobe.exe');
  assert.equal(resolveMediaCommand('ffprobe', { appDirectory, exists: (candidate) => candidate === packaged }), packaged);
  assert.equal(resolveMediaCommand('ffmpeg', { appDirectory, exists: () => false }), 'ffmpeg');
  assert.throws(() => resolveMediaCommand('unknown', { appDirectory, exists: () => true }), /Unknown media tool/);
});

test('upload limit defaults to 100 GiB and preserves explicit byte configuration', () => {
  assert.equal(parseUploadLimit(undefined), 107374182400);
  assert.equal(parseUploadLimit('1073741824'), 1024 * 1024 * 1024);
  assert.equal(UPLOAD_PROTOCOL.maximumBytes, 107374182400);
  assert.throws(() => parseUploadLimit('0'), /MAX_UPLOAD_BYTES/);
  assert.throws(() => parseUploadLimit('50gb'), /MAX_UPLOAD_BYTES/);
});

test('LAN address selection prefers physical adapters and falls back to virtual adapters', () => {
  const interfaces = {
    LogMeIn: [{ family: 'IPv4', address: '100.64.0.1', internal: false }],
    Hamachi: [{ family: 'IPv4', address: '25.13.49.234', internal: false }],
    DockerNAT: [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
    'Wi-Fi': [{ family: 'IPv4', address: '192.168.100.11', internal: false }],
    vEthernet: [{ family: 'IPv4', address: '172.30.64.1', internal: false }],
    Ethernet: [{ family: 'IPv4', address: '10.0.0.18', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    WSL: [{ family: 'IPv4', address: '172.28.192.1', internal: false }]
  };

  assert.deepEqual(selectLanAddresses(interfaces), ['192.168.100.11', '10.0.0.18']);
  assert.deepEqual(selectLanAddresses({ LogMeIn: interfaces.LogMeIn, Hamachi: interfaces.Hamachi, DockerNAT: interfaces.DockerNAT, WSL: interfaces.WSL, vEthernet: interfaces.vEthernet }), ['100.64.0.1', '25.13.49.234', '172.20.0.1', '172.28.192.1', '172.30.64.1']);
});

test('LAN routes require the room token while static UI remains public', async (t) => {
  const { port } = await startFixture(t);
  const staticResponse = await request(port, { path: '/', method: 'GET' });
  const protectedResponse = await request(port, { path: '/api/library', method: 'GET' });

  assert.equal(staticResponse.status, 200);
  assert.equal(protectedResponse.status, 401);
});

test('session role is token-protected and identifies tokenized loopback clients as host', async (t) => {
  const { port } = await startFixture(t);
  const denied = await request(port, { path: '/api/session', method: 'GET' });
  assert.equal(denied.status, 401);

  const session = await request(port, {
    path: '/api/session?token=test-room-token',
    method: 'GET',
    headers: { 'X-Forwarded-For': '203.0.113.50', Host: 'guest.example.test' }
  });
  assert.equal(session.status, 200);
  const metadata = JSON.parse(session.body);
  assert.equal(metadata.role, 'host');
  assert.equal(metadata.roomUrl, `http://127.0.0.1:${port}/?token=test-room-token`);
});

test('protected session metadata returns the preferred LAN room URL at the actual bound port', async (t) => {
  const { port } = await startFixture(t, {
    lanAddresses: () => ['192.168.1.24', '10.0.0.18']
  });
  const response = await request(port, { path: '/api/session?token=test-room-token', method: 'GET' });

  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).roomUrl, `http://192.168.1.24:${port}/?token=test-room-token`);
});

test('host authority accepts only real loopback remote addresses', () => {
  for (const address of ['127.0.0.1', '127.255.255.255', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackRemoteAddress(address), true, address);
    assert.equal(isHostRequest({ socket: { remoteAddress: address }, headers: { host: 'lan.example', 'x-forwarded-for': '198.51.100.9' } }), true, address);
  }
  for (const address of ['::ffff:192.168.1.20', '192.168.1.20', '::', 'localhost', undefined]) {
    assert.equal(isLoopbackRemoteAddress(address), false, String(address));
    assert.equal(isHostRequest({ socket: { remoteAddress: address }, headers: { host: 'localhost', origin: 'http://localhost', 'x-forwarded-for': '127.0.0.1' } }), false, String(address));
  }
});

test('guest sessions cannot mutate the library even with a valid token', async (t) => {
  const { port } = await startFixture(t, { hostAuthority: () => false });
  const session = await request(port, { path: '/api/session?token=test-room-token', method: 'GET' });
  const metadata = JSON.parse(session.body);
  assert.equal(metadata.role, 'guest');
  assert.equal(metadata.roomUrl, `http://127.0.0.1:${port}/?token=test-room-token`);

  const upload = await rawUpload(port, 'clip.mp4', Buffer.from('media'));
  assert.equal(upload.status, 403);
  const replacement = await replaceLibrary(port, ['unavailable']);
  assert.equal(replacement.status, 403);
  const append = await appendLibrary(port, ['unavailable']);
  assert.equal(append.status, 403);
  const clear = await request(port, {
    path: '/api/library/clear?token=test-room-token',
    method: 'POST',
    headers: { 'X-Room-Token': 'test-room-token' }
  });
  assert.equal(clear.status, 403);
});

test('upload rejects multipart payloads and only accepts the raw upload contract', async (t) => {
  const { port, app } = await startFixture(t);
  const boundary = 'media-boundary';
  const payload = multipart(boundary, 'clip.mp4', Buffer.from('media'));
  const response = await request(port, {
    path: '/api/upload?token=test-room-token',
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': payload.length }
  }, payload);
  assert.equal(response.status, 415);
  assert.equal(fs.readdirSync(app.storageDir).length, 0);
});

test('upload streams raw binary media and serves valid byte ranges', async (t) => {
  const { port } = await startFixture(t);
  const upload = await rawUpload(port, 'clip.mp4', Buffer.from('abcdefghij'));
  assert.equal(upload.status, 201);
  const { media } = JSON.parse(upload.body);
  const replacement = await replaceLibrary(port, [media.id]);
  assert.equal(replacement.status, 200);

  const response = await request(port, {
    path: `/media/${media.id}?token=test-room-token`,
    method: 'GET',
    headers: { Range: 'bytes=2-5' }
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers['content-range'], 'bytes 2-5/10');
  assert.equal(response.headers['accept-ranges'], 'bytes');
  assert.equal(response.headers['content-length'], '4');
  assert.deepEqual(response.body, Buffer.from('cdef'));
});

test('uploaded media exposes normalized embedded audio and subtitle tracks only through protected responses', async (t) => {
  const observedPaths = [];
  const { port } = await startFixture(t, {
    ffprobeRunner: async (filePath) => {
      observedPaths.push(filePath);
      return JSON.stringify({
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' }, channels: 2 },
          { index: 2, codec_type: 'subtitle', codec_name: 'ass', tags: { language: 'spa' } },
          { index: 'bad', codec_type: 'audio', codec_name: 'aac', channels: 2 },
          { index: 3, codec_type: 'subtitle' }
        ]
      });
    }
  });
  const uploaded = await rawUpload(port, 'clip.mkv', Buffer.from('media'));
  assert.equal(uploaded.status, 201);
  const media = JSON.parse(uploaded.body).media;
  assert.equal(observedPaths.length, 1);
  assert.deepEqual(media.tracks, {
    status: 'available',
    audio: [{ index: 1, kind: 'audio', codec: 'aac', language: 'eng', title: 'English', channels: 2 }],
    subtitles: [{ index: 2, kind: 'subtitle', codec: 'ass', language: 'spa' }]
  });

  assert.equal((await appendLibrary(port, [media.id])).status, 200);
  const library = await request(port, { path: '/api/library?token=test-room-token' });
  assert.equal(library.status, 200);
  assert.deepEqual(JSON.parse(library.body).media[0].tracks, media.tracks);
  assert.equal((await request(port, { path: '/api/library' })).status, 401);
  assert.equal((await request(port, { path: `/media/${media.id}?token=test-room-token` })).status, 200);
});

test('ffprobe stdout errors settle once and preserve the non-sensitive upload fallback', async (t) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = () => true;
  const sensitiveError = new Error('/private/path: ffprobe stdout exploded');
  const spawned = [];
  const runner = createFfprobeRunner({
    spawnProcess(command, args, options) {
      spawned.push({ command, args, options });
      queueMicrotask(() => {
        child.stdout.emit('error', sensitiveError);
        child.stdout.emit('error', sensitiveError);
        child.emit('close', 0);
      });
      return child;
    }
  });
  let settlements = 0;
  const { port } = await startFixture(t, {
    ffprobeRunner: async (filePath) => {
      try {
        return await runner(filePath);
      } finally {
        settlements += 1;
      }
    }
  });

  const uploaded = await rawUpload(port, 'clip.mkv', Buffer.from('abcdefghij'));
  assert.equal(uploaded.status, 201);
  const media = JSON.parse(uploaded.body).media;
  assert.deepEqual(media.tracks, { status: 'unavailable' });
  assert.equal(settlements, 1);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].options.shell, false);
  assert.equal(spawned[0].args.at(-1).startsWith('/'), true);
  assert.doesNotMatch(uploaded.body.toString(), /private|ffprobe|stdout|exploded/i);

  assert.equal((await replaceLibrary(port, [media.id])).status, 200);
  const playback = await request(port, { path: `/media/${media.id}?token=test-room-token`, headers: { Range: 'bytes=2-5' } });
  assert.equal(playback.status, 206);
  assert.deepEqual(playback.body, Buffer.from('cdef'));
});

test('failed media-track probing leaves upload and raw playback usable without exposing probe details', async (t) => {
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => { throw new Error('/private/path: ffprobe exploded'); }
  });
  const uploaded = await rawUpload(port, 'clip.mkv', Buffer.from('abcdefghij'));
  assert.equal(uploaded.status, 201);
  const media = JSON.parse(uploaded.body).media;
  assert.deepEqual(media.tracks, { status: 'unavailable' });

  assert.equal((await replaceLibrary(port, [media.id])).status, 200);
  const playback = await request(port, { path: `/media/${media.id}?token=test-room-token`, headers: { Range: 'bytes=2-5' } });
  assert.equal(playback.status, 206);
  assert.deepEqual(playback.body, Buffer.from('cdef'));
  assert.doesNotMatch(uploaded.body.toString(), /private|ffprobe|exploded/i);
});

test('upload exposes a stable SHA-256 content identity independently of random media IDs', async (t) => {
  const { port } = await startFixture(t);
  const first = JSON.parse((await rawUpload(port, 'first.mp4', Buffer.from('same bytes'))).body).media;
  const second = JSON.parse((await rawUpload(port, 'renamed.mp4', Buffer.from('same bytes'))).body).media;

  assert.notEqual(first.id, second.id);
  assert.equal(first.contentId, crypto.createHash('sha256').update('same bytes').digest('hex'));
  assert.equal(second.contentId, first.contentId);
});

test('streamed uploads enforce the byte limit and remove partial files', async (t) => {
  const { port, app } = await startFixture(t, { maxUploadBytes: 4 });
  const response = await request(port, {
    path: '/api/upload?token=test-room-token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Media-Filename': 'clip.mp4',
      'Transfer-Encoding': 'chunked'
    }
  }, Buffer.from('12345'));
  assert.equal(response.status, 413);
  assert.deepEqual(fs.readdirSync(app.storageDir), []);
});

test('aborted streamed uploads remove temporary files', async (t) => {
  const { port, app } = await startFixture(t);
  await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/upload?token=test-room-token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Media-Filename': 'clip.mp4',
        'Transfer-Encoding': 'chunked'
      }
    });
    req.once('error', resolve);
    req.write(Buffer.alloc(1024, 1));
    setTimeout(() => req.destroy(), 10);
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(fs.readdirSync(app.storageDir), []);
});

test('room commands update authoritative state and reject invalid commands', async (t) => {
  const { port } = await startFixture(t);
  const headers = { 'Content-Type': 'application/json', 'X-Room-Token': 'test-room-token' };
  const selected = await request(port, { path: '/api/room/commands', method: 'POST', headers }, Buffer.from(JSON.stringify({ type: 'select', mediaId: 'missing' })));
  assert.equal(selected.status, 422);

  const seek = await request(port, { path: '/api/room/commands', method: 'POST', headers }, Buffer.from(JSON.stringify({ type: 'seek', position: 12.5 })));
  assert.equal(seek.status, 200);
  const state = JSON.parse(seek.body).state;
  assert.equal(state.position, 12.5);
  assert.equal(state.sequence, 1);

  const play = await request(port, { path: '/api/room/commands', method: 'POST', headers }, Buffer.from(JSON.stringify({ type: 'play' })));
  assert.equal(play.status, 200);
  assert.equal(JSON.parse(play.body).state.playing, true);
});

test('play and pause commands preserve the caller position, while rate commands are rejected', async (t) => {
  const { port } = await startFixture(t);
  const headers = { 'Content-Type': 'application/json', 'X-Room-Token': 'test-room-token' };

  for (const [type, position] of [
    ['play', 12.5],
    ['pause', 24.75]
  ]) {
    const response = await request(port, { path: '/api/room/commands', method: 'POST', headers }, Buffer.from(JSON.stringify({ type, position })));
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(response.body).state.position, position);
  }

  const rate = await request(port, { path: '/api/room/commands', method: 'POST', headers }, Buffer.from(JSON.stringify({ type: 'rate', rate: 1.5, position: 36 })));
  assert.equal(rate.status, 400);
  assert.equal(JSON.parse(rate.body).error, 'Unsupported room command');
});

test('previous selects the final item when no media is currently selected', async (t) => {
  const { port } = await startFixture(t);
  const uploads = await Promise.all([
    rawUpload(port, 'first.mp4', Buffer.from('a')),
    rawUpload(port, 'second.mp4', Buffer.from('b')),
    rawUpload(port, 'third.mp4', Buffer.from('c'))
  ]);
  const media = uploads.map((response) => JSON.parse(response.body).media);
  const replacement = await replaceLibrary(port, media.map((item) => item.id));
  assert.equal(replacement.status, 200);
  const response = await request(port, {
    path: '/api/room/commands',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Token': 'test-room-token' }
  }, Buffer.from(JSON.stringify({ type: 'previous' })));
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).state.mediaId, media[media.length - 1].id);
});

test('library replacement requires a token and atomically selects the first ordered media paused at the beginning', async (t) => {
  const { port, app } = await startFixture(t);
  const first = JSON.parse((await rawUpload(port, 'first.mp4', Buffer.from('first'))).body).media;
  const initial = await replaceLibrary(port, [first.id]);
  assert.equal(initial.status, 200);
  const headers = { 'Content-Type': 'application/json', 'X-Room-Token': 'test-room-token' };
  await request(port, { path: '/api/room/commands', method: 'POST', headers }, Buffer.from(JSON.stringify({ type: 'select', mediaId: first.id })));
  await request(port, { path: '/api/room/commands', method: 'POST', headers }, Buffer.from(JSON.stringify({ type: 'play', position: 8 }))); 

  const second = JSON.parse((await rawUpload(port, 'second.mp4', Buffer.from('second'))).body).media;
  const denied = await request(port, { path: '/api/library/replace', method: 'POST', headers: { 'Content-Type': 'application/json' } }, Buffer.from(JSON.stringify({ mediaIds: [second.id] })));
  assert.equal(denied.status, 401);
  const replacement = await replaceLibrary(port, [second.id]);
  assert.equal(replacement.status, 200);
  const result = JSON.parse(replacement.body);
  assert.deepEqual(result.media.map((item) => item.id), [second.id]);
  assert.equal(result.state.mediaId, second.id);
  assert.equal(result.state.playing, false);
  assert.equal(result.state.position, 0);
  assert.ok(result.state.sequence > 2);
  assert.equal((await request(port, { path: `/media/${first.id}?token=test-room-token` })).status, 404);
  assert.equal(fs.readdirSync(app.storageDir).length, 1);
});

test('library append preserves existing media and room state while selecting the first ready item', async (t) => {
  const { port } = await startFixture(t);
  const first = JSON.parse((await rawUpload(port, 'first.mp4', Buffer.from('first'))).body).media;
  const initial = await appendLibrary(port, [first.id]);
  assert.equal(initial.status, 200);
  assert.deepEqual(JSON.parse(initial.body).media.map((item) => item.id), [first.id]);
  assert.equal(JSON.parse(initial.body).state.mediaId, first.id);

  const headers = { 'Content-Type': 'application/json', 'X-Room-Token': 'test-room-token' };
  await request(port, { path: '/api/room/commands', method: 'POST', headers }, Buffer.from(JSON.stringify({ type: 'play', position: 12.5 })));
  const second = JSON.parse((await rawUpload(port, 'second.mp4', Buffer.from('second'))).body).media;
  const appended = await appendLibrary(port, [second.id]);
  const result = JSON.parse(appended.body);
  assert.equal(appended.status, 200);
  assert.deepEqual(result.media.map((item) => item.id), [first.id, second.id]);
  assert.equal(result.state.mediaId, first.id);
  assert.equal(result.state.playing, true);
  assert.equal(result.state.position, 12.5);
  assert.equal((await request(port, { path: `/media/${first.id}?token=test-room-token` })).status, 200);
  assert.equal((await request(port, { path: `/media/${second.id}?token=test-room-token` })).status, 200);
});

test('library append broadcasts each ready media item progressively', async (t) => {
  const { port } = await startFixture(t);
  const events = await openEvents(port);
  await events.nextEvent();
  const first = JSON.parse((await rawUpload(port, 'first.mp4', Buffer.from('first'))).body).media;
  await appendLibrary(port, [first.id]);
  const firstLibrary = await events.nextEvent();
  const firstState = await events.nextEvent();
  assert.equal(firstLibrary.type, 'library');
  assert.deepEqual(firstLibrary.data.media.map((item) => item.id), [first.id]);
  assert.equal(firstState.type, 'state');
  assert.equal(firstState.data.mediaId, first.id);

  const second = JSON.parse((await rawUpload(port, 'second.mp4', Buffer.from('second'))).body).media;
  await appendLibrary(port, [second.id]);
  const secondLibrary = await events.nextEvent();
  assert.equal(secondLibrary.type, 'library');
  assert.deepEqual(secondLibrary.data.media.map((item) => item.id), [first.id, second.id]);
  events.response.destroy();
});

test('library replacement atomically restores a host-provided saved position only for matching content', async (t) => {
  const { port } = await startFixture(t);
  const first = JSON.parse((await rawUpload(port, 'clip.mp4', Buffer.from('stable content'))).body).media;
  const replacement = await request(port, {
    path: '/api/library/replace?token=test-room-token',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Token': 'test-room-token' }
  }, Buffer.from(JSON.stringify({
    mediaIds: [first.id],
    resume: { contentId: first.contentId, position: 42.5 }
  })));
  assert.equal(replacement.status, 200);
  assert.equal(JSON.parse(replacement.body).state.position, 42.5);

  const second = JSON.parse((await rawUpload(port, 'other.mp4', Buffer.from('other content'))).body).media;
  const mismatch = await request(port, {
    path: '/api/library/replace?token=test-room-token',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Token': 'test-room-token' }
  }, Buffer.from(JSON.stringify({
    mediaIds: [second.id],
    resume: { contentId: first.contentId, position: 99 }
  })));
  assert.equal(mismatch.status, 400);
});

test('SSE sends an authoritative initial snapshot and broadcasts replacement and clear updates', async (t) => {
  const { port } = await startFixture(t);
  const first = JSON.parse((await rawUpload(port, 'first.mp4', Buffer.from('first'))).body).media;
  await replaceLibrary(port, [first.id]);
  const events = await openEvents(port);
  const snapshot = await events.nextEvent();
  assert.equal(snapshot.type, 'snapshot');
  assert.deepEqual(snapshot.data.media.map((item) => item.id), [first.id]);
  assert.equal(snapshot.data.state.mediaId, first.id);
  assert.equal(snapshot.data.state.playing, false);
  assert.equal(snapshot.data.state.position, 0);

  const second = JSON.parse((await rawUpload(port, 'second.mp4', Buffer.from('second'))).body).media;
  await replaceLibrary(port, [second.id]);
  const replacementLibrary = await events.nextEvent();
  const replacementState = await events.nextEvent();
  assert.equal(replacementLibrary.type, 'library');
  assert.deepEqual(replacementLibrary.data.media.map((item) => item.id), [second.id]);
  assert.equal(replacementState.type, 'state');
  assert.equal(replacementState.data.mediaId, second.id);
  assert.equal(replacementState.data.playing, false);
  assert.equal(replacementState.data.position, 0);

  const clear = await request(port, {
    path: '/api/library/clear?token=test-room-token',
    method: 'POST',
    headers: { 'X-Room-Token': 'test-room-token' }
  });
  assert.equal(clear.status, 200);
  const clearLibrary = await events.nextEvent();
  const clearState = await events.nextEvent();
  assert.equal(clearLibrary.type, 'library');
  assert.deepEqual(clearLibrary.data.media, []);
  assert.equal(clearState.type, 'state');
  assert.equal(clearState.data.mediaId, null);
  assert.equal(clearState.data.playing, false);
  assert.equal(clearState.data.position, 0);
  events.response.destroy();
});

test('clearing the library deletes room media, resets state, and broadcasts library and state', async (t) => {
  const { port, app } = await startFixture(t);
  const media = JSON.parse((await rawUpload(port, 'clip.mp4', Buffer.from('clip'))).body).media;
  await replaceLibrary(port, [media.id]);
  const events = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events?token=test-room-token' }, resolve);
    req.once('error', reject);
  });
  let payload = '';
  const broadcast = new Promise((resolve) => {
    events.on('data', (chunk) => {
      payload += chunk;
      if (payload.includes('event: library') && payload.includes('event: state') && payload.includes('"media":[]')) resolve();
    });
  });
  const denied = await request(port, { path: '/api/library/clear', method: 'POST' });
  assert.equal(denied.status, 401);
  const clear = await request(port, {
    path: '/api/library/clear?token=test-room-token',
    method: 'POST',
    headers: { 'X-Room-Token': 'test-room-token' }
  });
  assert.equal(clear.status, 200);
  await broadcast;
  const result = JSON.parse(clear.body);
  assert.deepEqual(result.media, []);
  assert.equal(result.state.mediaId, null);
  assert.equal(result.state.playing, false);
  assert.equal(fs.readdirSync(app.storageDir).length, 0);
  events.destroy();
});

test('SSE disconnect cleanup keeps broadcasts and later requests alive', async (t) => {
  const { port, app } = await startFixture(t);
  const events = await openEvents(port);
  await events.nextEvent();
  const closed = new Promise((resolve) => events.response.once('close', resolve));
  events.response.destroy();
  await closed;

  const headers = { 'Content-Type': 'application/json', 'X-Room-Token': 'test-room-token' };
  const command = await request(port, {
    path: '/api/room/commands',
    method: 'POST',
    headers
  }, Buffer.from(JSON.stringify({ type: 'seek', position: 7 })));
  assert.equal(command.status, 200);

  const room = await request(port, { path: '/api/room?token=test-room-token' });
  assert.equal(room.status, 200);
  assert.equal(JSON.parse(room.body).state.position, 7);
  assert.equal(app.server.listening, true);
});

test('malformed static paths return an error without crashing the request listener', async (t) => {
  const { port, app } = await startFixture(t);
  const malformed = await request(port, { path: '/%E0%A4%A', method: 'GET' });
  assert.equal(malformed.status, 400);
  assert.match(String(malformed.headers['x-request-id']), /^[a-f0-9]{12}$/);

  const followUp = await request(port, { path: '/', method: 'GET' });
  assert.equal(followUp.status, 200);
  assert.equal(app.server.listening, true);
});

test('host-only track selection converges through room and SSE state and validates text tracks', async (t) => {
  const { port } = await startFixture(t, {
    hostAuthority: (req) => req.headers['x-host'] === 'yes',
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'audio', codec_name: 'opus' },
      { index: 3, codec_type: 'subtitle', codec_name: 'ass' },
      { index: 4, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle' },
      { index: 5, codec_type: 'subtitle', codec_name: 'dvd_subtitle' }
    ] })
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'), { 'X-Host': 'yes' })).body).media;
  assert.equal((await replaceLibrary(port, [media.id])).status, 403);
  assert.equal((await request(port, {
    path: '/api/library/replace?token=test-room-token', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Token': 'test-room-token', 'X-Host': 'yes' }
  }, Buffer.from(JSON.stringify({ mediaIds: [media.id] })))).status, 200);

  const events = await openEvents(port);
  await events.nextEvent();
  const guest = await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 2, subtitleTrackIndex: 3 });
  assert.equal(guest.status, 403);
  const selected = await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 2, subtitleTrackIndex: 3 }, { 'X-Host': 'yes' });
  assert.equal(selected.status, 200);
  assert.deepEqual(JSON.parse(selected.body).state.trackSelection, { audioTrackIndex: 2, subtitleTrackIndex: 3 });
  const stateEvent = await events.nextEvent();
  assert.equal(stateEvent.type, 'state');
  assert.deepEqual(stateEvent.data.trackSelection, { audioTrackIndex: 2, subtitleTrackIndex: 3 });
  assert.deepEqual(JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.trackSelection, { audioTrackIndex: 2, subtitleTrackIndex: 3 });

  for (const subtitleTrackIndex of [4, 5, 99]) {
    const rejected = await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex }, { 'X-Host': 'yes' });
    assert.equal(rejected.status, 422);
    assert.doesNotMatch(rejected.body.toString(), /ffmpeg|path|pgs|vobsub/i);
  }
  const clearSubtitle = await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null }, { 'X-Host': 'yes' });
  assert.equal(clearSubtitle.status, 200);
  assert.deepEqual(JSON.parse(clearSubtitle.body).state.trackSelection, { audioTrackIndex: 1, subtitleTrackIndex: null });
  events.response.destroy();
});

test('protected HLS master playlist tokenizes generated child playlists, segments, and WebVTT renditions', async (t) => {
  const invocations = [];
  const { port, app } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip' }
    ] }),
    ffmpegRunner: async (input, outputDir, selection) => {
      invocations.push({ input, outputDir, selection });
      if (selection.subtitleTrackIndex === null) throw new Error('/private/ffmpeg unavailable');
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(outputDir, 'master.m3u8'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="subtitle_0.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="subs"\nmedia_0.m3u8\n');
      fs.writeFileSync(path.join(outputDir, 'media_0.m3u8'), '#EXTM3U\nsegment000.ts\n');
      fs.writeFileSync(path.join(outputDir, 'subtitle_0.m3u8'), '#EXTM3U\nsubtitle_000.vtt\n');
      fs.writeFileSync(path.join(outputDir, 'segment000.ts'), 'segment');
      fs.writeFileSync(path.join(outputDir, 'subtitle_000.vtt'), 'WEBVTT\n');
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  assert.equal((await replaceLibrary(port, [media.id])).status, 200);
  assert.equal((await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: 2 })).status, 200);
  assert.equal((await request(port, { path: `/hls/${media.id}/master.m3u8` })).status, 401);
  const playlist = await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  assert.equal(playlist.status, 200);
  assert.match(playlist.body.toString(), /URI="subtitle_0\.m3u8\?token=test-room-token"/);
  assert.match(playlist.body.toString(), /media_0\.m3u8\?token=test-room-token/);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].input.startsWith(app.storageDir), true);
  assert.equal(invocations[0].outputDir.startsWith(path.join(app.storageDir, 'hls') + path.sep), true);
  assert.deepEqual(invocations[0].selection, { audioTrackIndex: 1, subtitleTrackIndex: 2 });
  const mediaPlaylist = await request(port, { path: `/hls/${media.id}/media_0.m3u8?token=test-room-token` });
  assert.match(mediaPlaylist.body.toString(), /segment000\.ts\?token=test-room-token/);
  assert.equal((await request(port, { path: `/hls/${media.id}/segment000.ts?token=test-room-token` })).status, 200);
  const subtitlePlaylist = await request(port, { path: `/hls/${media.id}/subtitle_0.m3u8?token=test-room-token` });
  assert.match(subtitlePlaylist.body.toString(), /subtitle_000\.vtt\?token=test-room-token/);
  const subtitle = await request(port, { path: `/hls/${media.id}/subtitle_000.vtt?token=test-room-token` });
  assert.equal(subtitle.status, 200);
  assert.equal(subtitle.headers['content-type'], 'text/vtt; charset=utf-8');

  assert.equal((await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null })).status, 200);
  assert.equal(fs.existsSync(invocations[0].outputDir), false);
  const unavailable = await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(unavailable.body.toString(), /ffmpeg|path|private/i);
  assert.equal((await request(port, { path: `/media/${media.id}?token=test-room-token` })).status, 200);

  assert.equal((await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: 2 })).status, 200);
  assert.equal((await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` })).status, 200);
  const replacementDirectory = invocations.at(-1).outputDir;
  const replacementMedia = JSON.parse((await rawUpload(port, 'replacement.mkv', Buffer.from('replacement'))).body).media;
  assert.equal((await replaceLibrary(port, [replacementMedia.id])).status, 200);
  assert.equal(fs.existsSync(replacementDirectory), false);
  assert.equal((await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: 2 })).status, 200);
  assert.equal((await request(port, { path: `/hls/${replacementMedia.id}/master.m3u8?token=test-room-token` })).status, 200);
  const clearDirectory = invocations.at(-1).outputDir;
  assert.equal((await request(port, { path: '/api/library/clear?token=test-room-token', method: 'POST', headers: { 'X-Room-Token': 'test-room-token' } })).status, 200);
  assert.equal(fs.existsSync(clearDirectory), false);
});

test('HLS invalidation cancels in-flight generation for selection, library clear, and shutdown', async (t) => {
  for (const action of ['selection', 'replace', 'clear', 'shutdown']) {
    let cancel;
    let outputDir;
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const { port, app } = await startFixture(t, {
      ffprobeRunner: async () => ({ streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'aac' },
        { index: 2, codec_type: 'subtitle', codec_name: 'subrip' }
      ] }),
      ffmpegRunner: (input, directory) => {
        outputDir = directory;
        const pending = new Promise((resolve, reject) => { cancel = () => reject(new Error('cancelled')); });
        pending.cancel = cancel;
        started();
        return pending;
      }
    });
    const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
    await replaceLibrary(port, [media.id]);
    await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: 2 });
    const pendingRequest = request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` }).then(
      (response) => ({ response }),
      (error) => ({ error })
    );
    await startedPromise;
    if (action === 'selection') await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
    if (action === 'replace') {
      const replacement = JSON.parse((await rawUpload(port, 'replacement.mkv', Buffer.from('replacement'))).body).media;
      await replaceLibrary(port, [replacement.id]);
    }
    if (action === 'clear') await request(port, { path: '/api/library/clear?token=test-room-token', method: 'POST', headers: { 'X-Room-Token': 'test-room-token' } });
    if (action === 'shutdown') await app.close();
    assert.equal(typeof cancel, 'function', action);
    const outcome = await pendingRequest;
    if (action === 'shutdown') assert.match(outcome.error?.message || '', /socket hang up/);
    else assert.equal(outcome.response?.status, 503, action);
    assert.equal(fs.existsSync(outputDir), false, action);
  }
});

test('HLS admission rejects old selection requests while invalidation cleanup is paused', async (t) => {
  let releaseCleanup;
  let cleanupPaused;
  const cleanupPausedPromise = new Promise((resolve) => { cleanupPaused = resolve; });
  let generationStarted;
  const generationStartedPromise = new Promise((resolve) => { generationStarted = resolve; });
  let generations = 0;
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip' }
    ] }),
    ffmpegRunner: (input, outputDir) => {
      generations += 1;
      if (generations === 1) {
        generationStarted();
        const pending = new Promise((resolve, reject) => {
          releaseCleanup = () => reject(new Error('cancelled'));
        });
        pending.cancel = () => cleanupPaused();
        return pending;
      }
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(outputDir, 'master.m3u8'), '#EXTM3U\n');
      return Promise.resolve();
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: 2 });
  const initial = request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  await generationStartedPromise;
  const changingSelection = roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  await cleanupPausedPromise;
  const concurrent = await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  releaseCleanup();
  assert.equal((await changingSelection).status, 200);
  assert.equal((await initial).status, 503);
  assert.equal(concurrent.status, 503);
  assert.equal(generations, 1);
});

test('ffmpeg runner uses fixed argv without a shell and reports failures without process details', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  const calls = [];
  const runner = createFfmpegRunner({
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('close', 1));
      return child;
    }
  });
  await assert.rejects(runner('/safe/input.mkv', '/safe/output', { audioTrackIndex: 7, subtitleTrackIndex: 9 }), /FFmpeg failed/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].args.filter((arg) => /^-map$/.test(arg)).length, 3);
  assert.equal(calls[0].args.includes('0:7'), true);
  assert.equal(calls[0].args.includes('0:9'), true);
  assert.equal(calls[0].args.includes('/safe/output/media_%v.m3u8'), true);
  assert.equal(calls[0].args.includes('-master_pl_name'), true);
  assert.equal(calls[0].args.some((arg) => arg.includes('s:0,sgroup:subs')), true);
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('-c:v'), calls[0].args.indexOf('-f')), ['-c:v', 'copy', '-c:a', 'aac', '-c:s', 'webvtt']);
  assert.equal(calls[0].args.includes('libx264'), false);
});

test('ffmpeg runner stops injected children for child, output, timeout, and output-limit failures', async () => {
  const cases = [
    ['child error', (child) => child.emit('error', new Error('missing')), {}],
    ['stdout error', (child) => child.stdout.emit('error', new Error('broken')), {}],
    ['stderr error', (child) => child.stderr.emit('error', new Error('broken')), {}],
    ['timeout', () => {}, { timeoutMs: 1 }],
    ['output limit', (child) => child.stderr.write(Buffer.from('too much')), { maximumOutputBytes: 1 }]
  ];
  for (const [name, trigger, options] of cases) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let kills = 0;
    child.kill = () => { kills += 1; return true; };
    const runner = createFfmpegRunner({
      ...options,
      spawnProcess() {
        queueMicrotask(() => trigger(child));
        return child;
      }
    });
    await assert.rejects(runner('/safe/input.mkv', '/safe/output', { audioTrackIndex: 7, subtitleTrackIndex: null }), /FFmpeg/);
    assert.equal(kills, 1, name);
  }
});

test('factory shutdown closes SSE clients, generated HLS artifacts, the server, and temporary storage idempotently', async (t) => {
  const { port, app } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }, { index: 1, codec_type: 'audio', codec_name: 'aac' }] }),
    ffmpegRunner: async (input, outputDir) => {
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(outputDir, 'index.m3u8'), '#EXTM3U\\n');
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${media.id}/index.m3u8?token=test-room-token` })).status, 200);
  assert.equal(fs.existsSync(path.join(app.storageDir, 'hls')), true);
  const eventResponse = await new Promise((resolve, reject) => {
    const events = http.get({ host: '127.0.0.1', port, path: '/api/events?token=test-room-token' });
    events.once('response', resolve);
    events.once('error', reject);
  });
  const closed = new Promise((resolve) => eventResponse.once('close', resolve));
  assert.equal(typeof app.close, 'function');
  await Promise.all([app.close(), app.close()]);
  await closed;
  assert.equal(app.server.listening, false);
  assert.equal(fs.existsSync(app.storageDir), false);
});
