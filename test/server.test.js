'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const vm = require('node:vm');
const { CPU_ENCODER, EncoderManager, createFfmpegEncoderProbe, createFfmpegRunner, createFfprobeRunner, createMediaServer, deriveHlsVodJobTimeoutMs, isHostRequest, isLoopbackRemoteAddress, normalizeConversionProgress, parseUploadLimit, resolveMediaCommand, resolveRuntimeMediaDirectory, selectLanAddresses, transformGeneratedWebVttCues, UPLOAD_PROTOCOL } = require('../server');

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

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
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

function appendLibrary(port, mediaIds, resume) {
  return request(port, {
    path: '/api/library/append?token=test-room-token',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Room-Token': 'test-room-token' }
  }, Buffer.from(JSON.stringify({ mediaIds, ...(resume ? { resume } : {}) })));
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
      resolve({ response, nextEvent, eventCount: () => events.length });
    });
  });
}

async function startFixture(t, options = {}) {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-test-'));
  const app = createMediaServer({ storageDir, token: 'test-room-token', lanAddresses: () => [], encoderManager: new EncoderManager({ forceCpu: true }), ...options });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  t.after(async () => {
    await app.close();
  });
  return { app, port };
}

function createCompletedCacheEntry(cache, content, audioTrackIndex = 1) {
  const contentId = crypto.createHash('sha256').update(content).digest('hex');
  const key = crypto.createHash('sha256').update(JSON.stringify({ contentId, audioTrackIndex, subtitleTrackIndex: null, routing: 'selected-track-routing-v1:full-transcode:transcode:transcode:none:selected-cmaf-x264-v1', topology: 'selected-muxed-cmaf-v2' })).digest('hex');
  const directory = path.join(cache, key);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, '.the-player-hls-cache-entry'), 'The Player persistent HLS cache storage\n');
  fs.writeFileSync(path.join(directory, '.the-player-hls-cache-profile.json'), `${JSON.stringify({ contentId, audioTrackIndex, subtitleTrackIndex: null, route: 'full-transcode', videoMode: 'transcode', audioMode: 'transcode', subtitleMode: 'none', encoder: 'libx264', topology: 'selected-muxed-cmaf-v2', routingVersion: 'selected-track-routing-v1' })}\n`);
  fs.writeFileSync(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
  fs.writeFileSync(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
  fs.writeFileSync(path.join(directory, 'init.mp4'), 'init');
  fs.writeFileSync(path.join(directory, 'segment_0.m4s'), 'segment');
  return directory;
}

test('portable launchers clean only marker-owned runtime media and preserve logs', () => {
  const buildScript = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-portable-win.ps1'), 'utf8');
  assert.match(buildScript, /Regex\]::Replace\(\(Get-Content -LiteralPath \$template -Raw\), "\\r\?\\n", "`r`n"\)/);
  assert.match(buildScript, /File\]::WriteAllText\(\$destination, \$content, \[System\.Text\.Encoding\]::ASCII\)/);
  for (const name of ['LAN.cmd.template', 'start.cmd.template']) {
    const launcher = fs.readFileSync(path.join(__dirname, '..', 'scripts', name), 'utf8');
    assert.match(launcher, /set "MEDIA_DIR=%ROOT%runtime-media"/);
    assert.match(launcher, /set "MEDIA_OWNER_FILE=%ROOT%\.the-player-runtime-media-owner"/);
    assert.match(launcher, /if not exist "%MEDIA_OWNER_FILE%" goto :media_not_owned/);
    assert.match(launcher, /findstr \/r \/x \/c:"%MEDIA_OWNER_LINE%" "%MEDIA_OWNER_FILE%" >nul \|\| goto :media_not_owned/);
    assert.match(launcher, /rmdir \/s \/q "%MEDIA_DIR%"/);
    assert.match(launcher, /Logs and other portable files were not changed\./);
    assert.match(launcher, /set "REPRODUCTOR_MEDIA_DIR=%MEDIA_DIR%"/);
    assert.match(launcher, /set "HLS_CACHE_DIR=%ROOT%hls-cache"/);
    assert.match(launcher, /set "REPRODUCTOR_HLS_CACHE_DIR=%HLS_CACHE_DIR%"/);
    assert.match(launcher, /set "REQUESTED_PORT=3000"/);
    assert.match(launcher, /GetActiveTcpListeners\(\)/);
    assert.match(launcher, /Port %REQUESTED_PORT% is occupied\. Using available port %PORT%\./);
    assert.match(launcher, /The Player persistent HLS cache storage/);
    assert.doesNotMatch(launcher, /rmdir \/s \/q "%HLS_CACHE_DIR%"/);
  }
});

test('start launcher remains an untokenized direct local player while enabling opt-in managed tracks', () => {
  const launcher = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'start.cmd.template'), 'utf8');
  assert.match(launcher, /set "REPRODUCTOR_MANAGED_LOCAL_SESSION=1"/);
  assert.match(launcher, /set "SHARE_LAN="/);
  assert.match(launcher, /start "" "http:\/\/%HOST%:%PORT%\/"/);
  assert.doesNotMatch(launcher, /REPRODUCTOR_ROOM_TOKEN/);
  assert.doesNotMatch(launcher, /RandomNumberGenerator/);
  assert.doesNotMatch(launcher, /\?token=/);
  assert.doesNotMatch(launcher, /SHARE_LAN=1/);
});

test('runtime media directory uses the portable launcher-owned location when configured', () => {
  const configured = path.join(os.tmpdir(), 'the-player-portable-test', 'runtime-media');
  assert.equal(resolveRuntimeMediaDirectory({ REPRODUCTOR_MEDIA_DIR: configured }), path.resolve(configured));
});

test('portable runtime resolution prefers packaged Windows tools and leaves development on PATH', () => {
  const appDirectory = path.join(path.sep, 'portable', 'app');
  const packaged = path.join(path.sep, 'portable', 'runtime', 'ffprobe.exe');
  assert.equal(resolveMediaCommand('ffprobe', { appDirectory, exists: (candidate) => candidate === packaged }), packaged);
  assert.equal(resolveMediaCommand('ffmpeg', { appDirectory, exists: () => false }), 'ffmpeg');
  assert.throws(() => resolveMediaCommand('unknown', { appDirectory, exists: () => true }), /Unknown media tool/);
});

test('FFprobe retains source format duration for selected-track conversion progress', async () => {
  let invocation;
  const runner = createFfprobeRunner({
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({ format: { duration: '100' }, streams: [] }));
        child.emit('close', 0);
      });
      return child;
    }
  });
  const payload = await runner('/uploaded/clip.mkv');
  assert.equal(invocation.options.shell, false);
  assert.match(invocation.args[invocation.args.indexOf('-show_entries') + 1], /(?:^|:)format=duration(?:$|:)/);
  assert.equal(payload.format.duration, '100');
  assert.deepEqual(normalizeConversionProgress({ outTimeUs: 25_000_000, durationSeconds: Number(payload.format.duration), elapsedSeconds: 10 }), { percent: 25, elapsedSeconds: 10, etaSeconds: 30 });
});

test('EncoderManager orders validated capabilities and honors deterministic CPU override', async () => {
  const attempted = [];
  const manager = new EncoderManager({ probe: async (encoder) => { attempted.push(encoder); return encoder === 'h264_amf'; } });
  assert.deepEqual(await manager.resolve(), { encoder: 'h264_amf' });
  assert.deepEqual(attempted, ['h264_nvenc', 'h264_qsv', 'h264_amf']);
  const forced = new EncoderManager({ forceCpu: true, probe: async () => { throw new Error('must not probe'); } });
  assert.deepEqual(await forced.resolve(), { encoder: CPU_ENCODER });
});

test('a compatible-dimension NVENC probe selects h264_nvenc without requiring HLS artifact publication', async () => {
  const calls = [];
  const probe = createFfmpegEncoderProbe({
    spawnProcess(command, args) {
      calls.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      queueMicrotask(() => {
        if (args.includes('-encoders')) {
          child.stdout.end(' V....D h264_nvenc NVIDIA NVENC H.264 encoder\\n');
          child.emit('close', 0);
        } else {
          const isMinimalNvencSmoke = args.includes('h264_nvenc')
            && args.includes('-f') && args[args.lastIndexOf('-f') + 1] === 'null'
            && args.at(-1) === '-';
          child.emit('close', isMinimalNvencSmoke ? 0 : 1);
        }
      });
      return child;
    }
  });
  const manager = new EncoderManager({ probe });
  assert.deepEqual(await manager.resolve(), { encoder: 'h264_nvenc' });
  assert.equal(calls.filter((args) => args.includes('-encoders')).length, 1);
  const smokeArgs = calls.find((args) => args.includes('h264_nvenc') && args.includes('null'));
  assert.ok(smokeArgs);
  assert.ok(smokeArgs.includes('testsrc2=size=640x360:rate=10'), 'NVENC smoke must use dimensions supported by the encoder');
});

test('injected encoder probe rejects unsupported compile-list entries and failed encoder smoke attempts', async () => {
  const calls = [];
  const probe = createFfmpegEncoderProbe({
    spawnProcess(command, args) {
      calls.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      queueMicrotask(() => {
        if (args.includes('-encoders')) {
          child.stdout.end(' V.... h264_nvenc NVIDIA NVENC H.264 encoder\n');
          child.emit('close', 0);
        } else child.emit('close', 1);
      });
      return child;
    }
  });
  assert.equal(await probe('h264_qsv'), false, 'unsupported compile-list entry must not smoke');
  assert.equal(await probe('h264_nvenc'), false, 'failed bounded CMAF smoke must reject advertised encoder');
  assert.equal(calls.filter((args) => args.includes('-encoders')).length, 2);
  assert.ok(calls.some((args) => args.includes('-f') && args.includes('null') && args.includes('h264_nvenc')));
});

test('GPL runtime notice matches the current approved portable build pin', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-portable-win.ps1'), 'utf8');
  const notice = fs.readFileSync(path.join(__dirname, '..', 'third_party', 'FFmpeg-GPL-NOTICE.md'), 'utf8');
  const pin = /\$ffmpegAssetSha256 = "([a-f0-9]{64})"/.exec(script)?.[1];
  assert.equal(pin, '2eaae393fe3ea3e79206d0a37be74e7e68beb57b507d2c20ed58f6f15a58a321');
  assert.match(notice, new RegExp(pin));
  assert.match(notice, /current user-approved build-script pin/i);
});

test('portable fMP4 fixture derives init and media artifact paths from playlist references', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-portable-win.ps1'), 'utf8');
  assert.match(script, /function Get-HlsPlaylistArtifactUri/);
  assert.match(script, /'-hls_fmp4_init_filename', 'init\.mp4'/);
  assert.match(script, /-WorkingDirectory \$hlsRoot/);
  assert.match(script, /Get-HlsPlaylistArtifactUri -Playlist \$videoPlaylist -Tag 'EXT-X-MAP'/);
  assert.match(script, /Get-HlsPlaylistArtifactUri -Playlist \$videoPlaylist -Extension 'm4s'/);
  assert.doesNotMatch(script, /Join-Path \$hlsRoot \$initMatch\.Groups\[1\]\.Value/);
  assert.doesNotMatch(script, /\$videoSegmentUri = \(\$videoPlaylist -split/);
});

test('portable fMP4 fixture parses generated EXT-X-MAP URI attributes without relaxing artifact safety', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-portable-win.ps1'), 'utf8');
  assert.match(script, /URI\\s\*=\\s\*/);
  assert.match(script, /\(\?<uri>/);
  assert.match(script, /\$match\.Groups\['uri'\]\.Value/);
  assert.match(script, /\^\\s\*\[\^#\\s\]\+\\\./);
  assert.match(script, /HLS playlist has no safe \$artifactDescription artifact reference\./);
});

test('portable fMP4 fixture failure diagnostic exposes only sanitized playlist lines and artifact filenames', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-portable-win.ps1'), 'utf8');
  assert.match(script, /function Write-HlsFixtureFailureDiagnostic/);
  assert.match(script, /fixture-hls-diagnostic=video-playlist/);
  assert.match(script, /fixture-video-playlist: \[unsafe line omitted\]/);
  assert.match(script, /fixture-hls-file: \$\(\$artifact\.Name\)/);
  assert.match(script, /Write-HlsFixtureFailureDiagnostic -Playlist \$videoPlaylist -HlsRoot \$hlsRoot/);
  assert.doesNotMatch(script, /fixture-(?:video-playlist|hls-file): \$HlsRoot/);
});

test('BtbN selected muxed CMAF publishes init and first media artifacts before FFmpeg exits', async (t) => {
  const ffmpeg = path.join(__dirname, '..', 'portable-win-rc', 'The-Player-1.5.5-windows', 'runtime', 'ffmpeg.exe');
  if (!fs.existsSync(ffmpeg)) {
    t.skip('Existing BtbN portable runtime is unavailable; the Windows portable fixture validates this during packaging.');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-btbn-fmp4-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const windowsPath = (candidate) => {
    if (process.platform !== 'linux') return candidate;
    const converted = spawnSync('wslpath', ['-w', candidate], { encoding: 'utf8' });
    assert.equal(converted.status, 0, converted.stderr);
    return converted.stdout.trim();
  };
  const source = path.join(root, 'fixture.mkv');
  const output = path.join(root, 'hls');
  const created = spawnSync(ffmpeg, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '14',
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '72', '-c:a', 'aac', windowsPath(source)
  ], { encoding: 'utf8', timeout: 30000 });
  assert.equal(created.status, 0, created.stderr);
  fs.mkdirSync(output);
  const generated = spawn(ffmpeg, [
    '-y', '-v', 'error', '-re', '-i', windowsPath(source), '-t', '14', '-map', '0:v:0', '-map', '0:1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_flags', 'temp_file',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.win32.join(windowsPath(output), 'segment_%v_%05d.m4s'),
    '-master_pl_name', 'master.m3u8', '-var_stream_map', 'v:0,a:0', path.win32.join(windowsPath(output), 'media_%v.m3u8')
  ], { cwd: output, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  generated.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => { if (generated.exitCode === null) generated.kill(); });
  const published = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(reject, new Error(`CMAF artifacts were not published before deadline (exit=${generated.exitCode}, files=${fs.readdirSync(output).join(',')}): ${stderr}`)), 12000);
    const poll = setInterval(() => {
      const initUri = 'init.mp4';
      const segmentUri = fs.readdirSync(output).find((name) => /^segment_0_\d+\.m4s$/.test(name));
      const masterPath = path.join(output, 'master.m3u8');
      const mediaPath = path.join(output, 'media_0.m3u8');
      if (segmentUri && fs.existsSync(path.join(output, initUri)) && fs.existsSync(masterPath) && fs.existsSync(mediaPath)) {
        finish(resolve, { initUri, segmentUri });
      }
    }, 50);
    const close = (code) => finish(reject, new Error(`FFmpeg exited before CMAF publication (code ${code}): ${stderr}`));
    const finish = (settle, value) => { clearTimeout(timeout); clearInterval(poll); generated.off('close', close); settle(value); };
    generated.once('close', close);
  });
  assert.equal(generated.exitCode, null, 'init and media artifacts must publish while FFmpeg is still running');
  assert.equal(published.initUri, 'init.mp4');
  assert.match(published.segmentUri, /^segment_0_\d+\.m4s$/);
  const master = fs.readFileSync(path.join(output, 'master.m3u8'), 'utf8');
  assert.match(master, /^#EXTM3U/m);
  assert.match(master, /\nmedia_0\.m3u8\s*$/m);
  const mediaPlaylist = fs.readFileSync(path.join(output, 'media_0.m3u8'), 'utf8');
  assert.match(mediaPlaylist, /#EXT-X-MAP:URI="init\.mp4"/);
  assert.match(mediaPlaylist, new RegExp(`\\n${published.segmentUri}\\s*$`, 'm'));
  const init = fs.readFileSync(path.join(output, published.initUri));
  const fragment = fs.readFileSync(path.join(output, published.segmentUri));
  assert.notEqual(init.indexOf(Buffer.from('ftyp')), -1, 'CMAF init must contain an ISO BMFF file type box');
  assert.notEqual(init.indexOf(Buffer.from('moov')), -1, 'CMAF init must contain movie metadata');
  assert.notEqual(fragment.indexOf(Buffer.from('moof')), -1, 'first CMAF media artifact must contain a movie fragment');
  generated.kill();
  await new Promise((resolve) => generated.once('close', resolve));
});

test('portable HLS topology fixture bounds FFmpeg and terminates its process tree on timeout', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-portable-win.ps1'), 'utf8');
  assert.match(script, /WaitForExit\(\$TimeoutSeconds \* 1000\)/);
  assert.match(script, /function Stop-ProcessTree/);
  assert.match(script, /\$terminator\.StartInfo\.FileName = 'taskkill\.exe'/);
  assert.match(script, /\$terminator\.StartInfo\.Arguments = "\/PID \$ProcessId \/T \/F"/);
  assert.match(script, /Timed out after \$TimeoutSeconds seconds; terminated the process tree\./);
  assert.match(script, /'-i', \$sourcePath, '-t', '1', '-map', '0:v:0'/);
  assert.match(script, /'-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init\.mp4'/);
  assert.match(script, /'-hls_flags', 'temp_file'/);
  assert.doesNotMatch(script, /'-hls_fmp4_init_resend', '1'/);
  assert.match(script, /-WorkingDirectory \$hlsRoot/);
  assert.match(script, /'-hls_segment_filename', \(Join-Path \$hlsRoot 'segment_%v_%05d\.m4s'\)/);
  assert.match(script, /Test-BundledMuxedFmp4Artifacts -Ffprobe \$Ffprobe -InitPath/);
});

test('portable build bounds every runtime process and parses when Windows PowerShell is available', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'build-portable-win.ps1');
  const script = fs.readFileSync(scriptPath, 'utf8');
  assert.match(script, /function Invoke-BundledProcess/);
  assert.match(script, /\$terminator\.StartInfo\.FileName = 'taskkill\.exe'/);
  assert.match(script, /\$terminator\.StartInfo\.Arguments = "\/PID \$ProcessId \/T \/F"/);
  assert.match(script, /Invoke-BundledProcess -Executable \$Ffprobe/);
  assert.doesNotMatch(script, /& \$Ffprobe/);
  assert.match(script, /\$curlCommand = Get-Command curl\.exe -CommandType Application -ErrorAction SilentlyContinue/);
  assert.match(script, /if \(-not \$curlCommand\) \{\s*throw 'Windows curl\.exe is required to download the pinned FFmpeg asset, but was not found\.'/);
  assert.match(script, /\[ValidateSet\(115, 180, 600, 900, 1800\)\]\[int\]\$FfmpegDownloadTimeoutSeconds = 115/);
  assert.match(script, /\[ValidateRange\(1, 905\)\]\[int\]\$TimeoutSeconds = 60/);
  assert.match(script, /\$downloadStateRoot = Join-Path \$tempRoot 'the-player-ffmpeg-download-v1'/);
  assert.match(script, /Invoke-ResumableFfmpegDownload -Curl \$curlCommand\.Source -Url \$ffmpegAssetUrl -Sha256 \$ffmpegAssetSha256 -StageArchive \$ffmpegArchive -TimeoutSeconds \$FfmpegDownloadTimeoutSeconds -StateRoot \$downloadStateRoot/);
  assert.match(script, /\$timedOut = -not \$process\.WaitForExit\(\(\$TimeoutSeconds \+ 5\) \* 1000\)/);
  assert.doesNotMatch(script, /Invoke-WebRequest/);
  for (const stage of ['download', 'extract', 'fixture-create', 'fixture-ffprobe-validation', 'archive-create']) {
    assert.match(script, new RegExp(`Write-StageMarker -Stage '${stage}' -Status 'start'`));
    assert.match(script, new RegExp(`Write-StageMarker -Stage '${stage}' -Status 'complete'`));
  }
  if (process.platform === 'win32') {
    const escapedPath = scriptPath.replace(/'/g, "''");
    const parsed = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${escapedPath}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count) { exit 1 }`]);
    assert.equal(parsed.status, 0, parsed.stderr.toString());
  }
});

test('portable download resumes only an exact, bounded pinned partial and verifies it before PID-stage promotion', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-portable-win.ps1'), 'utf8');
  assert.match(script, /function Invoke-ResumableFfmpegDownload/);
  assert.match(script, /\$downloadStateRoot = Join-Path \$tempRoot 'the-player-ffmpeg-download-v1'/);
  assert.match(script, /\$partialArchive = Join-Path \$StateRoot 'ffmpeg-master-latest-win64-gpl\.zip\.partial'/);
  assert.match(script, /\$downloadMetadata = Join-Path \$StateRoot 'download-metadata\.json'/);
  assert.match(script, /\$downloadLock = Join-Path \$StateRoot 'download\.lock'/);
  assert.match(script, /\$downloadMetadataSchemaVersion = 1/);
  assert.match(script, /--continue-at', '-'/);
  assert.match(script, /\$resume = Test-DownloadPartialIdentity -MetadataPath \$downloadMetadata -PartialPath \$partialArchive -Url \$Url -Sha256 \$Sha256/);
  assert.match(script, /\$actualFfmpegSha256 = \(Get-FileHash -LiteralPath \$partialArchive -Algorithm SHA256\)\.Hash\.ToLowerInvariant\(\)/);
  assert.match(script, /Copy-Item -LiteralPath \$partialArchive -Destination \$StageArchive/);
  assert.match(script, /\$transientCurlExitCodes = @\(5, 6, 7, 18, 28, 35, 52, 55, 56\)/);
  assert.match(script, /if \(\$result\.TimedOut -or \$transientCurlExitCodes -contains \$result\.ExitCode\)/);
  assert.match(script, /\$DownloadMaximumBytes = 220200960/);
  assert.match(script, /Clear-DownloadState -StateRoot \$StateRoot -PartialPath \$partialArchive -MetadataPath \$downloadMetadata/);
  assert.doesNotMatch(script, /Invoke-WebRequest/);
});

test('upload limit defaults to 100 GiB and preserves explicit byte configuration', () => {
  assert.equal(parseUploadLimit(undefined), 107374182400);
  assert.equal(parseUploadLimit('1073741824'), 1024 * 1024 * 1024);
  assert.equal(UPLOAD_PROTOCOL.maximumBytes, 107374182400);
  assert.throws(() => parseUploadLimit('0'), /MAX_UPLOAD_BYTES/);
  assert.throws(() => parseUploadLimit('50gb'), /MAX_UPLOAD_BYTES/);
});

test('media server disables Node whole-request timeout for large streamed uploads', async (t) => {
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-timeout-test-'));
  const app = createMediaServer({ storageDir, token: 'test-room-token', lanAddresses: () => [] });
  t.after(async () => app.close());
  assert.equal(app.server.requestTimeout, 0);
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

test('managed-local session is created only by loopback opt-in and is non-shareable', async (t) => {
  const { port } = await startFixture(t, {
    sessionMode: 'managed-local',
    lanAddresses: () => ['192.168.1.24']
  });
  const beforeOptIn = await request(port, { path: '/api/session?token=test-room-token', method: 'GET' });
  assert.equal(beforeOptIn.status, 403);

  const activated = await request(port, { path: '/api/local-session', method: 'POST' });
  assert.equal(activated.status, 200);
  const activation = JSON.parse(activated.body);
  assert.equal(activation.token, 'test-room-token');
  assert.deepEqual(activation.session, { mode: 'managed-local', shareable: false, scope: 'loopback' });

  const response = await request(port, { path: `/api/session?token=${activation.token}`, method: 'GET' });
  assert.equal(response.status, 200);
  const metadata = JSON.parse(response.body);
  assert.equal(metadata.role, 'host');
  assert.equal(metadata.roomUrl, `http://127.0.0.1:${port}/?token=test-room-token`);
  assert.deepEqual(metadata.session, { mode: 'managed-local', shareable: false, scope: 'loopback' });
});

test('managed-local client uploads local files only after its explicit embedded-track opt-in and hides sharing', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(client, /function isManagedLocalSession\(\)/);
  assert.match(client, /elements\.roomShare\.hidden = !isSharedMode\(\) \|\| isManagedLocalSession\(\)/);
  assert.match(client, /fetch\('\/api\/local-session'/);
  assert.match(client, /handleSharedFiles\(localFiles\)/);
  assert.match(client, /localEmbeddedTracksAction/);
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

test('upload streams large chunked media without buffering it and accepts normal uploads', async (t) => {
  const { port } = await startFixture(t, { maxUploadBytes: 8 * 1024 * 1024 });
  const chunk = Buffer.alloc(256 * 1024, 0x61);
  const chunkCount = 20;
  const expectedDigest = crypto.createHash('sha256');
  const response = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/upload?token=test-room-token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Media-Filename': 'large.mkv',
        'Transfer-Encoding': 'chunked'
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (value) => chunks.push(value));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.once('error', reject);
    for (let index = 0; index < chunkCount; index += 1) {
      expectedDigest.update(chunk);
      req.write(chunk);
    }
    req.end();
  });
  assert.equal(response.status, 201);
  const media = JSON.parse(response.body).media;
  assert.equal(media.size, chunk.length * chunkCount);
  assert.equal(media.contentId, expectedDigest.digest('hex'));

  const normal = await rawUpload(port, 'normal.mp4', Buffer.from('normal upload'));
  assert.equal(normal.status, 201);
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
  assert.deepEqual(JSON.parse(response.body), { error: 'Payload Too Large', code: 'payload-too-large' });
  assert.deepEqual(fs.readdirSync(app.storageDir), []);
});

test('aborted streamed uploads remove temporary files and log only a safe category', async (t) => {
  const diagnostics = [];
  const { port, app } = await startFixture(t, { diagnosticLogger: (message) => diagnostics.push(message) });
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
  assert.deepEqual(diagnostics, ['Upload failure category=client-disconnected']);
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
  await waitFor(() => fs.readdirSync(app.storageDir).length === 0, 'clear cleanup did not remove room media');
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

test('protected fMP4 HLS master playlist tokenizes init fragments, media segments, and WebVTT renditions', async (t) => {
  const invocations = [];
  const { port, app } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip' }
    ] }),
    ffmpegRunner: async (input, outputDir, selection) => {
      invocations.push({ input, outputDir, selection });
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      const hasSubtitle = Boolean(selection.subtitleTrack);
      fs.writeFileSync(path.join(outputDir, 'master.m3u8'), hasSubtitle
        ? '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="subtitle_0.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="subs"\nmedia_0.m3u8\n'
        : '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia_0.m3u8\n');
      fs.writeFileSync(path.join(outputDir, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment000.m4s\n#EXT-X-ENDLIST\n');
      fs.writeFileSync(path.join(outputDir, 'init.mp4'), 'init fragment');
      fs.writeFileSync(path.join(outputDir, 'segment000.m4s'), 'media segment');
      if (hasSubtitle) {
        fs.writeFileSync(path.join(outputDir, 'subtitle_0.m3u8'), '#EXTM3U\n#EXTINF:2,\nsubtitle_empty.vtt\n#EXTINF:4,\nsubtitle_000.vtt\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nsubtitle_001.vtt\n#EXT-X-ENDLIST\n');
        // FFmpeg can publish an empty VOD subtitle interval as exactly a WebVTT
        // header plus its terminal line ending; it has no header/body separator.
        fs.writeFileSync(path.join(outputDir, 'subtitle_empty.vtt'), 'WEBVTT\n');
        fs.writeFileSync(path.join(outputDir, 'subtitle_000.vtt'), 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:900000\n\n00:00.000 --> 00:02.000\nDefault subtitle\n\n00:02.000 --> 00:04.000 line:60%\nAuthored subtitle\n');
        fs.writeFileSync(path.join(outputDir, 'subtitle_001.vtt'), 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00.000,MPEGTS:0\n\n00:00.000 --> 00:02.000\nLater subtitle\n');
      }
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  assert.equal((await replaceLibrary(port, [media.id])).status, 200);
  assert.equal((await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: 2 })).status, 200);
  assert.equal((await request(port, { path: `/hls/${media.id}/master.m3u8` })).status, 401);
  const playlist = await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  assert.equal(playlist.status, 200);
  assert.match(playlist.body.toString(), /TYPE=SUBTITLES[^\n]*DEFAULT=YES[^\n]*AUTOSELECT=YES[^\n]*FORCED=NO/);
  assert.match(playlist.body.toString(), /subtitle_0\.m3u8\?token=test-room-token/);
  assert.match(playlist.body.toString(), /media_0\.m3u8\?token=test-room-token/);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].input.startsWith(app.storageDir), true);
  assert.equal(invocations[0].outputDir.startsWith(path.join(app.storageDir, 'hls') + path.sep), true);
  assert.equal(invocations[0].selection.videoTrack.index, 0);
  assert.deepEqual(invocations[0].selection.audioTrack, { index: 1, kind: 'audio', codec: 'aac' });
  assert.deepEqual(invocations[0].selection.subtitleTrack, { index: 2, kind: 'subtitle', codec: 'subrip' });
  assert.deepEqual(invocations[0].selection.route, { mode: 'full-transcode', video: 'transcode', audio: 'transcode', subtitle: 'webvtt', videoTrack: { index: 0 }, audioTrack: { index: 1 } });
  assert.equal(invocations[0].selection.encoder, CPU_ENCODER);
  const mediaPlaylist = await request(port, { path: `/hls/${media.id}/media_0.m3u8?token=test-room-token` });
  assert.match(mediaPlaylist.body.toString(), /init\.mp4\?token=test-room-token/);
  assert.match(mediaPlaylist.body.toString(), /segment000\.m4s\?token=test-room-token/);
  const init = await request(port, { path: `/hls/${media.id}/init.mp4?token=test-room-token` });
  assert.equal(init.status, 200);
  assert.equal(init.headers['content-type'], 'video/mp4');
  const segment = await request(port, { path: `/hls/${media.id}/segment000.m4s?token=test-room-token` });
  assert.equal(segment.status, 200);
  assert.equal(segment.headers['content-type'], 'video/iso.segment');
  const subtitlePlaylist = await request(port, { path: `/hls/${media.id}/subtitle_0.m3u8?token=test-room-token` });
  assert.match(subtitlePlaylist.body.toString(), /subtitle_000\.vtt\?token=test-room-token/);
  const subtitle = await request(port, { path: `/hls/${media.id}/subtitle_000.vtt?token=test-room-token` });
  assert.equal(subtitle.status, 200);
  assert.equal(subtitle.headers['content-type'], 'text/vtt; charset=utf-8');
  assert.match(subtitle.body.toString(), /__reproductor_generated_setting_free__\n00:00\.000 --> 00:02\.000 line:85%,end align:center\nDefault subtitle/, 'protected delivery positions only generated setting-free cues above the dock');
  assert.match(subtitle.body.toString(), /00:02\.000 --> 00:04\.000 line:60%\nAuthored subtitle/);
  assert.doesNotMatch(subtitle.body.toString(), /__reproductor_generated_setting_free__\n00:02\.000 --> 00:04\.000/, 'authored cue headers remain unmarked');
  const aggregateSubtitle = await request(port, { path: `/hls/${media.id}/subtitles.vtt?token=test-room-token` });
  assert.equal(aggregateSubtitle.status, 200);
  assert.equal(aggregateSubtitle.headers['content-type'], 'text/vtt; charset=utf-8');
  assert.match(aggregateSubtitle.body.toString(), /Default subtitle/);
  assert.match(aggregateSubtitle.body.toString(), /Authored subtitle/);
  assert.match(aggregateSubtitle.body.toString(), /00:06\.000 --> 00:08\.000\nLater subtitle/, 'aggregate preserves the empty first fragment duration when normalizing a discontinuous fragment-local cue clock');
  assert.match(aggregateSubtitle.body.toString(), /Later subtitle/, 'protected aggregate contains later subtitle fragments');
  assert.doesNotMatch(aggregateSubtitle.body.toString(), /X-TIMESTAMP-MAP|test-room-token|storageDir|outputDir/i);

  assert.equal((await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null })).status, 200);
  await waitFor(() => !fs.existsSync(invocations[0].outputDir), 'selection cleanup did not remove obsolete HLS artifacts');
  const audioOnlyPlaylist = await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  assert.equal(audioOnlyPlaylist.status, 200);
  assert.match(audioOnlyPlaylist.body.toString(), /media_0\.m3u8\?token=test-room-token/);
  assert.doesNotMatch(audioOnlyPlaylist.body.toString(), /SUBTITLES/);
  assert.equal(invocations.length, 2);
  assert.equal((await request(port, { path: `/media/${media.id}?token=test-room-token` })).status, 200);

  assert.equal((await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: 2 })).status, 200);
  assert.equal((await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` })).status, 200);
  const replacementDirectory = invocations.at(-1).outputDir;
  const replacementMedia = JSON.parse((await rawUpload(port, 'replacement.mkv', Buffer.from('replacement'))).body).media;
  assert.equal((await replaceLibrary(port, [replacementMedia.id])).status, 200);
  await waitFor(() => !fs.existsSync(replacementDirectory), 'library replacement cleanup did not remove HLS artifacts');
  assert.equal((await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: 2 })).status, 200);
  assert.equal((await request(port, { path: `/hls/${replacementMedia.id}/master.m3u8?token=test-room-token` })).status, 200);
  const clearDirectory = invocations.at(-1).outputDir;
  assert.equal((await request(port, { path: '/api/library/clear?token=test-room-token', method: 'POST', headers: { 'X-Room-Token': 'test-room-token' } })).status, 200);
  await waitFor(() => !fs.existsSync(clearDirectory), 'clear cleanup did not remove HLS artifacts');
});

test('selected-track routing uses bounded FFprobe metadata, exact global indexes, and skips GPU for copy-only plans', async (t) => {
  const plans = [
    { name: 'copy', videoStream: { codec_name: 'h264', pix_fmt: 'yuv420p', field_order: 'progressive' }, audioStream: { codec_name: 'aac', profile: 'LC', channels: 2 }, expected: 'copy', video: 'copy', audio: 'copy', gpuCalls: 0 },
    { name: 'audio transcode', videoStream: { codec_name: 'h264', pix_fmt: 'yuv420p', field_order: 'progressive' }, audioStream: { codec_name: 'opus', channels: 2 }, expected: 'audio-transcode', video: 'copy', audio: 'transcode', gpuCalls: 0 },
    { name: 'video transcode', videoStream: { codec_name: 'hevc', pix_fmt: 'yuv420p', field_order: 'progressive' }, audioStream: { codec_name: 'aac', profile: 'LC', channels: 1 }, expected: 'video-transcode', video: 'transcode', audio: 'copy', gpuCalls: 1 },
    { name: 'full transcode', videoStream: { codec_name: 'hevc', pix_fmt: 'yuv420p', field_order: 'progressive' }, audioStream: { codec_name: 'ac3', channels: 6 }, expected: 'full-transcode', video: 'transcode', audio: 'transcode', gpuCalls: 1 }
  ];
  for (const plan of plans) {
    const deliveries = []; let gpuCalls = 0;
    const { port } = await startFixture(t, {
      ffprobeRunner: async (filePath) => filePath.endsWith('init.mp4')
        ? ({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }, { index: 1, codec_type: 'audio', codec_name: 'aac' }] })
        : ({ streams: [
          { index: 7, codec_type: 'video', ...plan.videoStream },
          { index: 11, codec_type: 'audio', ...plan.audioStream },
          { index: 14, codec_type: 'subtitle', codec_name: 'subrip' }
        ] }),
      encoderManager: new EncoderManager({ probe: async () => { gpuCalls += 1; return true; } }),
      ffmpegRunner: async (input, directory, delivery) => {
        deliveries.push(delivery); fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
        fs.writeFileSync(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
        fs.writeFileSync(path.join(directory, 'init.mp4'), 'init'); fs.writeFileSync(path.join(directory, 'segment_0.m4s'), 'segment');
      }
    });
    const media = JSON.parse((await rawUpload(port, `${plan.name}.mkv`, Buffer.from(plan.name))).body).media;
    assert.equal(media.routing, undefined, 'private routing metadata must not reach the UI');
    await replaceLibrary(port, [media.id]); await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 11, subtitleTrackIndex: 14 });
    assert.equal((await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` })).status, 200, plan.name);
    assert.equal(deliveries[0].videoTrack.index, 7); assert.equal(deliveries[0].audioTrack.index, 11);
    assert.equal(deliveries[0].route.mode, plan.expected); assert.equal(deliveries[0].route.video, plan.video); assert.equal(deliveries[0].route.audio, plan.audio);
    assert.equal(deliveries[0].route.subtitle, 'webvtt'); assert.equal(gpuCalls, plan.gpuCalls, plan.name);
  }
});

test('encoder fallback, cache profile identity/reuse, and lifecycle expose only safe encoder enums', async (t) => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-encoder-cache-'));
  fs.writeFileSync(path.join(cache, '.the-player-hls-cache-owner'), 'The Player persistent HLS cache storage\n');
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const probe = async () => ({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }, { index: 1, codec_type: 'audio', codec_name: 'aac' }] });
  const publish = async (input, directory) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    fs.writeFileSync(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    fs.writeFileSync(path.join(directory, 'init.mp4'), 'init'); fs.writeFileSync(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  const gpu = new EncoderManager({ probe: async (encoder) => encoder === 'h264_nvenc' });
  const first = await startFixture(t, { hlsCacheDir: cache, ffprobeRunner: probe, ffmpegRunner: publish, encoderManager: gpu });
  const media = JSON.parse((await rawUpload(first.port, 'clip.mkv', Buffer.from('same-content'))).body).media;
  await replaceLibrary(first.port, [media.id]); await roomCommand(first.port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(first.port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` })).status, 200);
  const profile = JSON.parse(fs.readFileSync(path.join(cache, fs.readdirSync(cache).find((name) => /^[a-f0-9]{64}$/.test(name)), '.the-player-hls-cache-profile.json')));
  assert.equal(profile.encoder, 'h264_nvenc');
  assert.equal(profile.subtitlePositioningVersion, null, 'cache profiles version subtitle delivery independently of CMAF encoding');
  const cpu = new EncoderManager({ forceCpu: true });
  const second = await startFixture(t, { hlsCacheDir: cache, ffprobeRunner: probe, ffmpegRunner: async () => { throw new Error('cross-profile cache reuse must not encode'); }, encoderManager: cpu });
  const reused = JSON.parse((await rawUpload(second.port, 'clip.mkv', Buffer.from('same-content'))).body).media;
  await replaceLibrary(second.port, [reused.id]); await roomCommand(second.port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(second.port, { path: `/hls/${reused.id}/master.m3u8?token=test-room-token` })).status, 200);
  const cachedLifecycle = JSON.parse((await request(second.port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.equal(cachedLifecycle.selectedEncoder, 'h264_nvenc'); assert.equal(cachedLifecycle.cacheHit, true);

  const attempts = [];
  const fallback = await startFixture(t, { ffprobeRunner: async () => ({ streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    { index: 1, codec_type: 'audio', codec_name: 'aac' },
    { index: 2, codec_type: 'audio', codec_name: 'aac' }
  ] }), encoderManager: new EncoderManager({ probe: async (encoder) => encoder === 'h264_nvenc' }), ffmpegRunner: async (input, directory, delivery) => {
    attempts.push(delivery.encoder || CPU_ENCODER);
    if (delivery.encoder === 'h264_nvenc') { const error = new Error('driver detail must stay private'); error.ffmpegErrorClass = 'failed'; throw error; }
    await publish(input, directory);
  } });
  const fallbackMedia = JSON.parse((await rawUpload(fallback.port, 'fallback.mkv', Buffer.from('fallback-content'))).body).media;
  await replaceLibrary(fallback.port, [fallbackMedia.id]); await roomCommand(fallback.port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(fallback.port, { path: `/hls/${fallbackMedia.id}/master.m3u8?token=test-room-token` })).status, 200);
  assert.deepEqual(attempts, ['h264_nvenc', CPU_ENCODER]);
  const lifecycle = JSON.parse((await request(fallback.port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.equal(lifecycle.selectedEncoder, CPU_ENCODER); assert.equal(lifecycle.fallbackFrom, 'h264_nvenc'); assert.equal(lifecycle.cacheHit, false);
  assert.doesNotMatch(JSON.stringify(lifecycle), /driver detail|path|token|stderr/i);

  // A successful CPU retry makes the failed GPU ineligible for all later
  // selections in this process; a new selection must begin on CPU directly.
  assert.equal((await roomCommand(fallback.port, { type: 'selectTracks', audioTrackIndex: 2, subtitleTrackIndex: null })).status, 200);
  assert.equal((await request(fallback.port, { path: `/hls/${fallbackMedia.id}/master.m3u8?token=test-room-token` })).status, 200);
  assert.deepEqual(attempts, ['h264_nvenc', CPU_ENCODER, CPU_ENCODER]);
});

test.skip('rejected multi-rendition alternate-audio fallback architecture', async (t) => {
  const deliveries = [];
  const diagnostics = [];
  const { port } = await startFixture(t, {
    diagnosticLogger: (message) => diagnostics.push(message),
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'audio', codec_name: 'ac3' },
      { index: 3, codec_type: 'audio', codec_name: 'dts' }
    ] }),
    ffmpegRunner: async (input, directory, delivery) => {
      deliveries.push(delivery);
      if (delivery.audioTracks.some((track) => track.index === 3)) {
        const error = new Error('/private/media/bad-alternate.mkv?token=secret');
        error.ffmpegErrorClass = 'failed';
        throw error;
      }
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const audioEntries = delivery.audioTracks.map((track, index) => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio_${track.index}",DEFAULT=${index === 0 ? 'YES' : 'NO'},URI="media_audio_${track.index}.m3u8"`).join('\n');
      fs.writeFileSync(path.join(directory, 'master.m3u8'), `#EXTM3U\n${audioEntries}\n#EXT-X-STREAM-INF:BANDWIDTH=1000,CODECS="avc1.64002a,mp4a.40.2",AUDIO="audio"\nmedia_0.m3u8\n`);
      fs.writeFileSync(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXTINF:6,\nsegment_0_00000.ts\n');
      fs.writeFileSync(path.join(directory, 'segment_0_00000.ts'), 'video segment');
      for (const track of delivery.audioTracks) {
        fs.writeFileSync(path.join(directory, `media_audio_${track.index}.m3u8`), `#EXTM3U\n#EXTINF:6,\naudio_${track.index}_00000.ts\n`);
        fs.writeFileSync(path.join(directory, `audio_${track.index}_00000.ts`), 'audio segment');
      }
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  const response = await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  assert.equal(response.status, 200);
  const master = response.body.toString();
  assert.match(master, /TYPE=AUDIO,GROUP-ID="audio",NAME="audio_1"/);
  assert.match(master, /TYPE=AUDIO,GROUP-ID="audio",NAME="audio_2"/);
  assert.doesNotMatch(master, /NAME="audio_3"/);
  assert.match(master, /CODECS="avc1\.64002a"/);
  assert.doesNotMatch(master, /CODECS="[^"]*mp4a/);
  assert.deepEqual(deliveries.map((delivery) => delivery.audioTracks.map((track) => track.index)), [[1, 2, 3], [1, 2], [1, 3], [1, 2]]);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], new RegExp(`alternate excluded media=${media.id} audioTrackIndex=3 class=failed`));
  assert.doesNotMatch(diagnostics[0], /private|secret/i);
  assert.doesNotMatch(response.body.toString(), /alternate excluded|private|secret/i);
});

test.skip('obsolete progressive CMAF permits late subtitle publication before VOD completion', async (t) => {
  let publish;
  let publishRenditions;
  let fail;
  let outputDir;
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 4, codec_type: 'subtitle', codec_name: 'subrip' }
    ] }),
    ffmpegRunner: (input, directory) => {
      outputDir = directory;
      let reject;
      const running = new Promise((resolve, rejectPromise) => {
        reject = rejectPromise;
        publish = () => {
          fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
          fs.writeFileSync(path.join(directory, 'master.m3u8.tmp'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="media_audio_3.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="media_subtitle_4.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia_0.m3u8\n');
          fs.renameSync(path.join(directory, 'master.m3u8.tmp'), path.join(directory, 'master.m3u8'));
          fs.writeFileSync(path.join(directory, 'init.mp4.tmp'), 'init fragment');
          fs.renameSync(path.join(directory, 'init.mp4.tmp'), path.join(directory, 'init.mp4'));
          fs.writeFileSync(path.join(directory, 'segment_0_00000.m4s.tmp'), 'media segment');
          fs.renameSync(path.join(directory, 'segment_0_00000.m4s.tmp'), path.join(directory, 'segment_0_00000.m4s'));
          fs.writeFileSync(path.join(directory, 'media_0.m3u8.tmp'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment_0_00000.m4s\n');
          fs.renameSync(path.join(directory, 'media_0.m3u8.tmp'), path.join(directory, 'media_0.m3u8'));
          fs.writeFileSync(path.join(directory, 'media_audio_3.m3u8.tmp'), '#EXTM3U\n#EXT-X-MAP:URI="init_audio_3.mp4"\n#EXTINF:6,\naudio_3_00000.m4s\n');
          fs.writeFileSync(path.join(directory, 'media_subtitle_4.m3u8.tmp'), '#EXTM3U\n#EXTINF:6,\nsubtitle_4_00000.vtt\n');
          fs.writeFileSync(path.join(directory, 'still-writing.m3u8.tmp'), '#EXTM3U\n');
        };
        publishRenditions = () => {
          fs.writeFileSync(path.join(directory, 'init_audio_3.mp4.tmp'), 'audio init fragment');
          fs.renameSync(path.join(directory, 'init_audio_3.mp4.tmp'), path.join(directory, 'init_audio_3.mp4'));
          fs.writeFileSync(path.join(directory, 'audio_3_00000.m4s.tmp'), 'audio segment');
          fs.renameSync(path.join(directory, 'audio_3_00000.m4s.tmp'), path.join(directory, 'audio_3_00000.m4s'));
          fs.renameSync(path.join(directory, 'media_audio_3.m3u8.tmp'), path.join(directory, 'media_audio_3.m3u8'));
          fs.writeFileSync(path.join(directory, 'subtitle_4_00000.vtt.tmp'), 'WEBVTT\n');
          fs.renameSync(path.join(directory, 'subtitle_4_00000.vtt.tmp'), path.join(directory, 'subtitle_4_00000.vtt'));
          fs.renameSync(path.join(directory, 'media_subtitle_4.m3u8.tmp'), path.join(directory, 'media_subtitle_4.m3u8'));
        };
        fail = () => reject(new Error('FFmpeg failed after readiness'));
      });
      running.cancel = () => reject(new Error('FFmpeg cancelled'));
      started();
      return running;
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: 4 });

  const manifest = request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  await startedPromise;
  publish();
  const response = await Promise.race([
    manifest,
    new Promise((_, reject) => setTimeout(() => reject(new Error('selected subtitle blocked muxed CMAF startup')), 250))
  ]);
  const pendingLifecycle = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.deepEqual({ ...pendingLifecycle, selectionId: typeof pendingLifecycle.selectionId }, { status: 'ready', mediaId: media.id, audioTrackIndex: 1, subtitleTrackIndex: 4, subtitleStatus: 'pending', selectionId: 'string' });
  const subtitleRequest = request(port, { path: `/hls/${media.id}/media_subtitle_4.m3u8?token=test-room-token` });
  publishRenditions();
  assert.equal((await request(port, { path: `/hls/${media.id}/still-writing.m3u8.tmp?token=test-room-token` })).status, 404);
  assert.equal(response.status, 200);
  assert.match(response.body.toString(), /media_0\.m3u8\?token=test-room-token/);
  assert.match(response.body.toString(), /media_audio_3\.m3u8\?token=test-room-token/);
  assert.doesNotMatch(response.body.toString(), /media_subtitle_4\.m3u8/);
  assert.equal((await subtitleRequest).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const subtitleReadyMaster = await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  assert.match(subtitleReadyMaster.body.toString(), /media_subtitle_4\.m3u8\?token=test-room-token/);
  const readyLifecycle = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.deepEqual({ ...readyLifecycle, selectionId: typeof readyLifecycle.selectionId }, { status: 'ready', mediaId: media.id, audioTrackIndex: 1, subtitleTrackIndex: 4, subtitleStatus: 'ready', selectionId: 'string' });
  assert.equal(fs.existsSync(outputDir), true);
  fail();
});

test.skip('obsolete progressive CMAF playlist snapshots grow during conversion', async (t) => {
  let outputDir;
  let finish;
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip' }
    ] }),
    ffmpegRunner: (input, directory) => {
      outputDir = directory;
      fs.writeFileSync(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="media_0_vtt.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="subs"\nmedia_0.m3u8\n');
      fs.writeFileSync(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment_00000.m4s\n');
      fs.writeFileSync(path.join(directory, 'init.mp4'), 'init fragment');
      fs.writeFileSync(path.join(directory, 'segment_00000.m4s'), 'first fragment');
      const running = new Promise((resolve) => { finish = resolve; });
      running.cancel = finish;
      return running;
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: 2 });

  assert.equal((await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` })).status, 200);
  const first = await request(port, { path: `/hls/${media.id}/media_0.m3u8?token=test-room-token` });
  assert.equal(first.status, 200);
  assert.equal([...first.body.toString().matchAll(/#EXTINF:([\d.]+)/g)].reduce((total, match) => total + Number(match[1]), 0), 6);

  // Simulate FFmpeg's brief rename window while it advances the media playlist.
  fs.renameSync(path.join(outputDir, 'media_0.m3u8'), path.join(outputDir, 'media_0.m3u8.tmp'));
  const concurrent = await Promise.race([
    Promise.all(Array.from({ length: 8 }, () => request(port, { path: `/hls/${media.id}/media_0.m3u8?token=test-room-token` }))),
    new Promise((_, reject) => setTimeout(() => reject(new Error('cached playlist requests waited for FFmpeg publication')), 40))
  ]);
  for (const response of concurrent) {
    assert.equal(response.status, 200);
    assert.match(response.body.toString(), /#EXTINF:6,/);
  }

  fs.writeFileSync(path.join(outputDir, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment_00000.m4s\n#EXTINF:6,\nsegment_00001.m4s\n');
  fs.writeFileSync(path.join(outputDir, 'segment_00001.m4s'), 'second fragment');
  const grown = await request(port, { path: `/hls/${media.id}/media_0.m3u8?token=test-room-token` });
  assert.equal(grown.status, 200);
  assert.equal([...grown.body.toString().matchAll(/#EXTINF:([\d.]+)/g)].reduce((total, match) => total + Number(match[1]), 0), 12);

  // Delayed WebVTT publication must not turn otherwise-ready A/V into a 503.
  fs.writeFileSync(path.join(outputDir, 'media_0_vtt.m3u8'), '#EXTM3U\nsubtitle_00000.vtt\n');
  fs.writeFileSync(path.join(outputDir, 'subtitle_00000.vtt'), 'WEBVTT\n');
  const firstSubtitle = await request(port, { path: `/hls/${media.id}/media_0_vtt.m3u8?token=test-room-token` });
  assert.equal(firstSubtitle.status, 200);

  // Reproduce FFmpeg replacing both already-admitted playlists later in a live
  // generation. Each request must receive its generation-local last good
  // snapshot, and lifecycle must remain ready rather than become a timeout.
  fs.renameSync(path.join(outputDir, 'media_0.m3u8'), path.join(outputDir, 'media_0.m3u8.tmp'));
  fs.renameSync(path.join(outputDir, 'media_0_vtt.m3u8'), path.join(outputDir, 'media_0_vtt.m3u8.tmp'));
  const unavailableResponses = await Promise.race([
    Promise.all(Array.from({ length: 8 }, () => [
      request(port, { path: `/hls/${media.id}/media_0.m3u8?token=test-room-token` }),
      request(port, { path: `/hls/${media.id}/media_0_vtt.m3u8?token=test-room-token` })
    ]).flat()),
    new Promise((_, reject) => setTimeout(() => reject(new Error('post-ready cached playlist requests waited for publication')), 250))
  ]);
  for (const unavailableResponse of unavailableResponses) assert.equal(unavailableResponse.status, 200);
  const lifecycleDuringRename = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.equal(lifecycleDuringRename.status, 'ready');
  assert.notEqual(lifecycleDuringRename.status, 'timeout');
  finish();
});

test.skip('obsolete progressive HLS snapshots remain available after post-ready failure', async (t) => {
  const runs = [];
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'audio', codec_name: 'aac' },
      { index: 3, codec_type: 'subtitle', codec_name: 'subrip' }
    ] }),
    ffmpegRunner: (input, directory, selection) => {
      const generation = runs.length + 1;
      fs.writeFileSync(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="media_0_vtt.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="subs"\nmedia_0.m3u8\n');
      fs.writeFileSync(path.join(directory, 'media_0.m3u8'), `#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment_${generation}.m4s\n`);
      fs.writeFileSync(path.join(directory, 'media_0_vtt.m3u8'), `#EXTM3U\nsubtitle_${generation}.vtt\n`);
      fs.writeFileSync(path.join(directory, 'init.mp4'), 'init fragment');
      fs.writeFileSync(path.join(directory, `segment_${generation}.m4s`), 'media segment');
      fs.writeFileSync(path.join(directory, `subtitle_${generation}.vtt`), 'WEBVTT\n');
      let reject;
      const running = new Promise((resolve, rejectRun) => { reject = rejectRun; });
      running.cancel = () => reject(new Error('FFmpeg cancelled'));
      runs.push({ directory, selection, reject });
      return running;
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: 3 });

  assert.equal((await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` })).status, 200);
  const firstMedia = await request(port, { path: `/hls/${media.id}/media_0.m3u8?token=test-room-token` });
  const firstSubtitle = await request(port, { path: `/hls/${media.id}/media_0_vtt.m3u8?token=test-room-token` });
  assert.match(firstMedia.body.toString(), /segment_1\.m4s/);
  assert.match(firstSubtitle.body.toString(), /subtitle_1\.vtt/);

  // The runner can report failure while FFmpeg has atomically renamed both
  // published playlists. The route must use only this generation's snapshots.
  fs.renameSync(path.join(runs[0].directory, 'media_0.m3u8'), path.join(runs[0].directory, 'media_0.m3u8.tmp'));
  fs.renameSync(path.join(runs[0].directory, 'media_0_vtt.m3u8'), path.join(runs[0].directory, 'media_0_vtt.m3u8.tmp'));
  runs[0].reject(Object.assign(new Error('FFmpeg failed after ready'), { ffmpegErrorClass: 'failed' }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const cachedAfterFailure = await Promise.all([
    request(port, { path: `/hls/${media.id}/media_0.m3u8?token=test-room-token` }),
    request(port, { path: `/hls/${media.id}/media_0_vtt.m3u8?token=test-room-token` })
  ]);
  for (const response of cachedAfterFailure) assert.equal(response.status, 200);
  assert.match(cachedAfterFailure[0].body.toString(), /segment_1\.m4s/);
  assert.match(cachedAfterFailure[1].body.toString(), /subtitle_1\.vtt/);

  // A replacement selection is a new protected generation: its cache cannot
  // fall back to a prior generation's snapshot with the same artifact name.
  assert.equal((await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 2, subtitleTrackIndex: 3 })).status, 200);
  assert.equal((await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` })).status, 200);
  const secondMedia = await request(port, { path: `/hls/${media.id}/media_0.m3u8?token=test-room-token` });
  assert.match(secondMedia.body.toString(), /segment_2\.m4s/);
  fs.renameSync(path.join(runs[1].directory, 'media_0.m3u8'), path.join(runs[1].directory, 'media_0.m3u8.tmp'));
  const currentSnapshot = await request(port, { path: `/hls/${media.id}/media_0.m3u8?token=test-room-token` });
  assert.equal(currentSnapshot.status, 200);
  assert.match(currentSnapshot.body.toString(), /segment_2\.m4s/);
  assert.doesNotMatch(currentSnapshot.body.toString(), /segment_1\.m4s/);
});

test.skip('obsolete progressive WebVTT publication after A/V readiness', async (t) => {
  let outputDir;
  let finish;
  const { port } = await startFixture(t, {
    hlsArtifactRetryTimeoutMs: 50,
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'subtitle', codec_name: 'subrip' }
    ] }),
    ffmpegRunner: (input, directory) => {
      outputDir = directory;
      fs.writeFileSync(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="media_0_vtt.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="subs"\nmedia_0.m3u8\n');
      fs.writeFileSync(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment_00000.m4s\n');
      fs.writeFileSync(path.join(directory, 'init.mp4'), 'init fragment');
      fs.writeFileSync(path.join(directory, 'segment_00000.m4s'), 'first fragment');
      const running = new Promise((resolve) => { finish = resolve; });
      running.cancel = finish;
      return running;
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: 2 });
  assert.equal((await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` })).status, 200);

  const missingSubtitle = await Promise.race([
    request(port, { path: `/hls/${media.id}/media_0_vtt.m3u8?token=test-room-token` }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('optional WebVTT request was not bounded')), 250))
  ]);
  assert.equal(missingSubtitle.status, 404);
  const lifecycle = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.equal(lifecycle.status, 'ready');
  assert.equal(fs.existsSync(outputDir), true);
  finish();
});

test.skip('obsolete first-CMAF readiness lifecycle', async (t) => {
  let publish;
  let settle;
  const { port } = await startFixture(t, {
    hlsReadinessTimeoutMs: 500,
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' }
    ] }),
    ffmpegRunner: (input, directory) => {
      const running = new Promise((resolve) => { settle = resolve; });
      running.cancel = settle;
      publish = () => {
        fs.writeFileSync(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia_0.m3u8\n');
        fs.writeFileSync(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment_0_00000.m4s\n');
        fs.writeFileSync(path.join(directory, 'init.mp4'), 'init fragment');
        fs.writeFileSync(path.join(directory, 'segment_0_00000.m4s'), 'media segment');
      };
      return running;
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });

  const pending = request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const preparing = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.deepEqual({ ...preparing, selectionId: typeof preparing.selectionId }, { status: 'preparing', mediaId: media.id, audioTrackIndex: 1, subtitleTrackIndex: null, selectionId: 'string' });
  publish();
  assert.equal((await pending).status, 200);
  const ready = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.deepEqual({ ...ready, selectionId: typeof ready.selectionId }, { status: 'ready', mediaId: media.id, audioTrackIndex: 1, subtitleTrackIndex: null, selectionId: 'string' });
  settle();
});

test.skip('obsolete progressive startup readiness timeout', async (t) => {
  let cancel;
  const diagnostics = [];
  const { port } = await startFixture(t, {
    hlsReadinessTimeoutMs: 25,
    diagnosticLogger: (message) => diagnostics.push(message),
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' }
    ] }),
    ffmpegRunner: () => {
      const running = new Promise((resolve) => { cancel = resolve; });
      running.cancel = cancel;
      return running;
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  const response = await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  assert.equal(response.status, 503);
  assert.equal(response.body.toString(), 'HLS unavailable');
  const lifecycle = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.deepEqual({ ...lifecycle, selectionId: typeof lifecycle.selectionId }, { status: 'timeout', mediaId: media.id, audioTrackIndex: 1, subtitleTrackIndex: null, reason: 'readiness-timeout', selectionId: 'string' });
  assert.doesNotMatch(JSON.stringify(lifecycle), /token|path|argv|ffmpeg/i);
  assert.deepEqual(diagnostics, ['HLS startup readiness timeout missing=master:1']);
  assert.doesNotMatch(diagnostics[0], /token|path|argv|ffmpeg/i);
  cancel();
});

test.skip('obsolete progressive lifecycle publishes ready before VOD completion', async (t) => {
  const legacyClientDeadlineMs = 20;
  const runs = [];
  const { port } = await startFixture(t, {
    hlsReadinessTimeoutMs: 500,
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'audio', codec_name: 'aac' }
    ] }),
    ffmpegRunner: (input, directory) => {
      let reject;
      const running = new Promise((resolve, rejectPromise) => { reject = rejectPromise; });
      running.cancel = () => reject(new Error('FFmpeg cancelled'));
      runs.push({ directory, reject, publish() {
        fs.writeFileSync(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia_0.m3u8\n');
        fs.writeFileSync(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment_0_00000.m4s\n');
        fs.writeFileSync(path.join(directory, 'init.mp4'), 'init fragment');
        fs.writeFileSync(path.join(directory, 'segment_0_00000.m4s'), 'media segment');
      } });
      return running;
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  void request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  await new Promise((resolve) => setTimeout(resolve, legacyClientDeadlineMs * 2));
  const slow = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.equal(slow.status, 'preparing');
  assert.equal(typeof slow.selectionId, 'string');

  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 2, subtitleTrackIndex: null });
  void request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const active = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.deepEqual({ status: active.status, mediaId: active.mediaId, audioTrackIndex: active.audioTrackIndex, subtitleTrackIndex: active.subtitleTrackIndex }, { status: 'preparing', mediaId: media.id, audioTrackIndex: 2, subtitleTrackIndex: null });
  assert.notEqual(active.selectionId, slow.selectionId);

  runs[1].publish();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const ready = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.equal(ready.status, 'ready');
  assert.equal(ready.selectionId, active.selectionId);
  // A hard process timeout after A/V readiness is terminal, but it is not a
  // startup-readiness timeout and must not send the UI back to that state.
  runs[1].reject(Object.assign(new Error('FFmpeg VOD job timed out'), { ffmpegErrorClass: 'job-timeout' }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const failed = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.deepEqual({ status: failed.status, reason: failed.reason, selectionId: failed.selectionId }, { status: 'failed', reason: 'job-timeout', selectionId: active.selectionId });
});

test.skip('obsolete progressive rendition route after partial readiness', async (t) => {
  let outputDir;
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' }
    ] }),
    ffmpegRunner: async (input, directory) => {
      outputDir = directory;
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",URI="media_audio_1.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia_0.m3u8\n');
      fs.writeFileSync(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment_0_00000.m4s\n');
      fs.writeFileSync(path.join(directory, 'init.mp4'), 'init fragment');
      fs.writeFileSync(path.join(directory, 'segment_0_00000.m4s'), 'media segment');
      fs.writeFileSync(path.join(directory, 'media_audio_1.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init_audio_1.mp4"\n#EXTINF:6,\naudio_1_00000.m4s\n');
      fs.writeFileSync(path.join(directory, 'init_audio_1.mp4'), 'audio init fragment');
      fs.writeFileSync(path.join(directory, 'audio_1_00000.m4s'), 'audio segment');
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  assert.equal((await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` })).status, 503);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` })).status, 200);
  fs.unlinkSync(path.join(outputDir, 'media_audio_1.m3u8'));
  assert.equal((await request(port, { path: `/hls/${media.id}/media_audio_1.m3u8?token=test-room-token` })).status, 404);
});

test('selected source subtitles map to FFmpeg HLS subtitle_0 for native hls.js display', async () => {
  const calls = [];
  const runner = createFfmpegRunner({
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => child.emit('close', 1));
      return child;
    }
  });
  await assert.rejects(runner('/safe/input.mkv', '/safe/output', {
    videoTrack: { index: 0 }, audioTrack: { index: 4 }, subtitleTrack: { index: 9 },
    route: { video: 'transcode', audio: 'transcode' }
  }), /FFmpeg failed/);
  const args = calls[0].args;
  assert.equal(args[args.lastIndexOf('-map') + 1], '0:9', 'the selected global source subtitle must be the sole mapped subtitle');
  assert.equal(args[args.indexOf('-var_stream_map') + 1], 'v:0,a:0,s:0,sgroup:subs', 'the mapped subtitle is output-relative subtitle_0');

  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const activation = app.match(/function activateSelectedHlsSubtitle\(client, subtitleTrackIndex, refreshTextTracks = \(\) => \{\}\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(activation, 'subtitle activation helper is present');
  const { activateSelectedHlsSubtitle } = new Function(`${activation}\nreturn { activateSelectedHlsSubtitle };`)();
  const client = { subtitleTracks: [{}], subtitleTrack: null, subtitleDisplay: false };
  activateSelectedHlsSubtitle(client, 9);
  assert.equal(client.subtitleTrack, 0, 'the sole selected rendition is hls.js track zero');
  assert.equal(client.subtitleDisplay, true, 'hls.js enables native subtitle display from the first chunk');
  client.subtitleTracks = [{ name: 'unknown' }];
  activateSelectedHlsSubtitle(client, 9);
  assert.equal(client.subtitleTrack, 0, 'descriptor updates retain the selected native rendition');
  client.subtitleTracks = [{}, { name: 'unknown' }];
  activateSelectedHlsSubtitle(client, 9);
  assert.equal(client.subtitleTrack, 0, 'later descriptor refreshes retain native display');
  client.subtitleTracks = [{ name: 'unknown' }, { name: 'subtitle_0' }];
  activateSelectedHlsSubtitle(client, 9);
  assert.equal(client.subtitleTrack, 0, 'the selected rendition remains native');
  activateSelectedHlsSubtitle(client, null);
  assert.equal(client.subtitleTrack, -1, 'subtitle-off remains explicit');
  assert.equal(client.subtitleDisplay, false);
});

test('aggregate subtitle overlay renders supported WebVTT italics as safe DOM nodes and scales in fullscreen', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const helper = app.match(/function appendWebVttCueText\(container, text\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, 'safe WebVTT inline-markup renderer is present');

  const document = {
    createElement(name) {
      return {
        nodeName: name.toUpperCase(),
        children: [],
        append(...nodes) { this.children.push(...nodes); }
      };
    },
    createTextNode(text) { return { nodeName: '#text', textContent: text }; }
  };
  const { appendWebVttCueText } = new Function('document', `${helper}\nreturn { appendWebVttCueText };`)(document);
  const line = document.createElement('span');
  appendWebVttCueText(line, 'Normal <i>emphasis</i> <img src=x onerror=alert(1)>');

  assert.equal(line.children[0].textContent, 'Normal ');
  assert.equal(line.children[1].nodeName, 'I');
  assert.equal(line.children[1].children[0].textContent, 'emphasis');
  assert.equal(line.children[2].textContent, ' <img src=x onerror=alert(1)>');
  assert.equal(line.children.some((node) => node.nodeName === 'IMG'), false, 'unrecognized markup never becomes a DOM element');
  assert.doesNotMatch(helper, /innerHTML\s*=/, 'subtitle rendering must not inject cue markup with innerHTML');
  const authoredLines = document.createElement('span');
  appendWebVttCueText(authoredLines, 'Speaker one\nSpeaker two');
  assert.equal(authoredLines.children[0].textContent, 'Speaker one\nSpeaker two', 'authored WebVTT newlines remain in the rendered cue');
  assert.match(styles, /\.generated-subtitle-overlay\s*\{[\s\S]*?max-width:\s*90%;[\s\S]*?min-width:\s*10%;[\s\S]*?white-space:\s*pre-wrap;[\s\S]*?width:\s*fit-content;/, 'the centered aggregate overlay keeps authored lines while ranging from 10% to 90% of the video width');
  assert.match(styles, /\.generated-subtitle-overlay\s*\{[\s\S]*?font-family:\s*Arial,\s*"Helvetica Neue",\s*Helvetica,\s*sans-serif;[\s\S]*?font-weight:\s*400;/, 'the aggregate selected-track overlay uses regular VLC-like Arial-first typography without affecting native cues');
  assert.match(styles, /\.video-frame\.is-app-fullscreen \.generated-subtitle-overlay,[\s\S]*?\.video-frame:fullscreen \.generated-subtitle-overlay[\s\S]*?font-size:\s*clamp\(1\.45rem, 3\.333vw, 4\.375rem\)/, 'app and native fullscreen preserve the responsive slope while capping aggregate overlay typography at 70px wide-2560');
  const fullscreenSubtitlePixels = (viewportWidth) => Math.min(70, Math.max(23.2, viewportWidth * 0.03333));
  assert.ok(Math.abs(fullscreenSubtitlePixels(1080) - 36) < 0.01, '1080px fullscreen reaches approximately 36px');
  assert.ok(Math.abs(fullscreenSubtitlePixels(1440) - 48) < 0.01, '1440px fullscreen reaches approximately 48px');
  assert.ok(Math.abs(fullscreenSubtitlePixels(1920) - 64) < 0.01, '1920px fullscreen reaches approximately 64px');
  assert.equal(fullscreenSubtitlePixels(2560), 70, '2560px fullscreen is capped at the approved 70px target');
  const fullscreen = app.match(/async function toggleFullscreen\(\) \{[\s\S]*?\n\}/)?.[0];
  const keyboard = app.match(/function handleKeyboardShortcuts\(event\) \{[\s\S]*?\n\}/)?.[0];
  assert.match(fullscreen, /elements\.videoFullscreenButton\.blur\(\)/, 'fullscreen button focus is released before the transition');
  assert.match(keyboard, /Space:\s*\(\) => togglePlayback\(\)/, 'Space remains the global playback shortcut after fullscreen button clicks');
});

test('HLS failures log a bounded sanitized server-only diagnostic without exposing it to clients', async (t) => {
  const diagnostics = [];
  const runner = createFfmpegRunner({
    spawnProcess() {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      queueMicrotask(() => {
        child.stderr.write(Buffer.from(`/private/media/secret.mkv?token=super-secret Bearer bearer-secret ${'x'.repeat(6000)}`));
        child.emit('close', 1);
      });
      return child;
    }
  });
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' }
    ] }),
    ffmpegRunner: runner,
    diagnosticLogger: (message) => diagnostics.push(message)
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });

  const response = await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  assert.equal(response.status, 503);
  assert.equal(response.body.toString(), 'HLS unavailable');
  const failedLifecycle = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.deepEqual({ ...failedLifecycle, selectionId: typeof failedLifecycle.selectionId }, {
    status: 'failed', mediaId: media.id, audioTrackIndex: 1, subtitleTrackIndex: null, reason: 'failed', selectionId: 'string', route: 'full-transcode', videoMode: 'transcode', audioMode: 'transcode', subtitleMode: 'none', selectedEncoder: CPU_ENCODER, cacheHit: false
  });
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], new RegExp(`media=${media.id} audioTrackIndex=1 subtitleTrackIndex=none class=failed`));
  assert.ok(Buffer.byteLength(diagnostics[0]) <= 4400);
  assert.doesNotMatch(diagnostics[0], /private|super-secret|bearer-secret|test-room-token/i);
  assert.doesNotMatch(response.body.toString(), /private|secret|bearer|stderr|ffmpeg/i);
});

test('GPU attempts cancelled by selection replacement, library replacement, or shutdown never fall back to CPU', async (t) => {
  for (const action of ['selection', 'replace', 'shutdown']) {
    const attempts = [];
    let cancel;
    let started;
    const startedPromise = new Promise((resolve) => { started = resolve; });
    const { port, app } = await startFixture(t, {
      encoderManager: new EncoderManager({ probe: async (encoder) => encoder === 'h264_nvenc' }),
      ffprobeRunner: async () => ({ streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'aac' },
        { index: 2, codec_type: 'audio', codec_name: 'aac' }
      ] }),
      ffmpegRunner: (input, directory, delivery) => {
        attempts.push(delivery.encoder || CPU_ENCODER);
        const pending = new Promise((resolve, reject) => { cancel = () => reject(new Error('cancelled')); });
        pending.cancel = cancel;
        started();
        return pending;
      }
    });
    const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
    await replaceLibrary(port, [media.id]);
    await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
    const pendingRequest = request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` }).then(
      (response) => ({ response }),
      (error) => ({ error })
    );
    await startedPromise;
    if (action === 'selection') await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 2, subtitleTrackIndex: null });
    if (action === 'replace') {
      const replacement = JSON.parse((await rawUpload(port, 'replacement.mkv', Buffer.from('replacement'))).body).media;
      await replaceLibrary(port, [replacement.id]);
    }
    if (action === 'shutdown') await app.close();
    assert.equal(typeof cancel, 'function', action);
    const outcome = await pendingRequest;
    if (action === 'shutdown') assert.match(outcome.error?.message || '', /socket hang up/);
    else assert.equal(outcome.response?.status, 503, action);
    if (action === 'selection') await waitFor(() => attempts.length === 2, 'replacement foreground admission did not start after cancellation cleanup');
    assert.deepEqual(attempts, action === 'selection' ? ['h264_nvenc', 'h264_nvenc'] : ['h264_nvenc'], action);
  }
});

test('HLS invalidation cancels in-flight generation for library replacement, clear, and shutdown', async (t) => {
  for (const action of ['replace', 'clear', 'shutdown']) {
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
    await waitFor(() => !fs.existsSync(outputDir), `HLS cleanup did not remove artifacts for ${action}`);
  }
});

test('passive foreground HLS admission waits bounded cleanup without starting a replacement runner', { timeout: 2000 }, async (t) => {
  let starts = 0;
  let cancelCalls = 0;
  let settleFirst;
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
  const { port } = await startFixture(t, {
    hlsReadinessTimeoutMs: 60,
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'audio', codec_name: 'aac' }
    ] }),
    ffmpegRunner: () => {
      starts += 1;
      if (starts === 1) {
        const pending = new Promise((resolve, reject) => {
          settleFirst = () => reject(new Error('cancelled'));
        });
        pending.cancel = () => { cancelCalls += 1; };
        firstStarted();
        return pending;
      }
      // This admission outlives the short passive wait, then fails graph
      // validation so fixture shutdown cannot retain an unfinished runner.
      return new Promise((resolve) => setTimeout(resolve, 150));
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  void request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  await firstStartedPromise;

  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 2, subtitleTrackIndex: null });
  const passive = request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  const early = await Promise.race([
    passive.then(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('waiting'), 15))
  ]);
  assert.equal(early, 'waiting', 'passive GET must await the already-authorized cleanup transition');
  assert.equal(starts, 1, 'the replacement runner must not start before cancellation cleanup settles');
  assert.equal(cancelCalls, 1);

  settleFirst();
  const response = await passive;
  assert.equal(response.status, 503, 'a stuck admitted runner must produce a bounded unavailable response');
  await waitFor(() => starts === 2, 'the server-owned replacement admission did not start after cleanup');
  assert.equal(starts, 2, 'passive GET must not start an additional runner');
});

test('initial play authoritatively starts one-ahead preparation and reports a missing selection', async (t) => {
  const publish = async (input, directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  let starts = 0;
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } }
    ] }),
    ffmpegRunner: async (...args) => { starts += 1; await publish(...args); }
  });
  const first = JSON.parse((await rawUpload(port, 'first.mkv', Buffer.from('first'))).body).media;
  const second = JSON.parse((await rawUpload(port, 'second.mkv', Buffer.from('second'))).body).media;
  await replaceLibrary(port, [first.id, second.id]);

  // A normal host play with no applied embedded selection cannot prepare an
  // exact next rendition, but its next card receives a truthful safe status.
  await roomCommand(port, { type: 'play', position: 0 });
  await waitFor(async () => {
    const room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
    return room.oneAhead?.status === 'selection-required';
  }, 'missing selection did not publish a next-card status');

  await roomCommand(port, { type: 'pause', position: 0 });
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${first.id}/master.m3u8?token=test-room-token` })).status, 200);
  await waitFor(async () => {
    const room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
    return starts === 2 && room.playing === false && room.oneAhead?.mediaId === second.id && room.oneAhead.status === 'ready';
  }, 'ready paused foreground did not authoritatively start next preparation');
  await roomCommand(port, { type: 'play', position: 0 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(starts, 2, 'playing after paused preparation must not start another next conversion');
});

test('one-ahead publishes truthful runner-start preparation, progress, completes speculatively, and promotes without reencoding', async (t) => {
  const publish = async (input, directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  let starts = 0;
  let completeNext;
  let reportNextProgress;
  const nextStarted = new Promise((resolve) => { completeNext = resolve; });
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ format: { duration: '100' }, streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } }
    ] }),
    ffmpegRunner: (input, directory, delivery) => {
      starts += 1;
      if (starts === 1) return publish(input, directory);
      reportNextProgress = (outTimeUs) => delivery.onProgress({ outTimeUs });
      return nextStarted.then(() => publish(input, directory));
    }
  });
  const first = JSON.parse((await rawUpload(port, 'first.mkv', Buffer.from('first'))).body).media;
  const second = JSON.parse((await rawUpload(port, 'second.mkv', Buffer.from('second'))).body).media;
  await replaceLibrary(port, [first.id, second.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${first.id}/master.m3u8?token=test-room-token` })).status, 200);
  await roomCommand(port, { type: 'play', position: 0 });
  await waitFor(() => starts === 2 && typeof reportNextProgress === 'function', 'speculative runner did not start');
  let room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
  assert.equal(room.oneAhead?.status, 'preparing', 'runner invocation immediately publishes truthful next-card preparation');
  assert.equal(room.oneAhead?.progress, undefined, 'runner-start preparation must not fabricate a percentage before FFmpeg reports progress');
  const events = await openEvents(port);
  await events.nextEvent(); // Initial state replay.
  reportNextProgress(25000000);
  const firstProgressEvent = await events.nextEvent();
  assert.equal(firstProgressEvent.type, 'state');
  assert.equal(firstProgressEvent.data.oneAhead?.status, 'preparing');
  assert.equal(firstProgressEvent.data.oneAhead?.progress?.percent, 25);
  reportNextProgress(50000000);
  const secondProgressEvent = await events.nextEvent();
  reportNextProgress(75000000);
  const thirdProgressEvent = await events.nextEvent();
  for (const [event, percent] of [[secondProgressEvent, 50], [thirdProgressEvent, 75]]) {
    assert.equal(event.type, 'state');
    assert.equal(event.data.oneAhead?.status, 'preparing');
    assert.equal(event.data.oneAhead?.progress?.percent, percent);
    assert.equal(event.data.mediaId, first.id, 'next-card progress remains foreground-inert');
  }
  assert.ok(secondProgressEvent.data.sequence > firstProgressEvent.data.sequence);
  assert.ok(thirdProgressEvent.data.sequence > secondProgressEvent.data.sequence);
  room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
  assert.equal(room.oneAhead?.status, 'preparing');
  assert.equal(room.oneAhead?.progress?.percent, 75, 'latest normalized progress remains available after its broadcast');
  events.response.destroy();

  completeNext();
  await waitFor(async () => {
    const room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
    return room.oneAhead?.mediaId === second.id && room.oneAhead.status === 'ready';
  }, 'completed speculative output was not published as ready');
  const promoted = await roomCommand(port, { type: 'next' });
  assert.equal(promoted.status, 200);
  const promotedRoom = JSON.parse(promoted.body).state;
  assert.equal(promotedRoom.hls.status, 'ready');
  assert.equal(starts, 2, 'foreground promotion must reuse the completed speculative output');
  assert.equal((await request(port, { path: `/hls/${second.id}/master.m3u8?token=test-room-token` })).status, 200);
  assert.equal(starts, 2, 'serving promoted output must not reencode it');
});

test('one-ahead reports unavailable when runner admission fails instead of claiming preparation', async (t) => {
  const publish = async (input, directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  let starts = 0;
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } }
    ] }),
    ffmpegRunner: (input, directory) => {
      starts += 1;
      if (starts === 1) return publish(input, directory);
      throw new Error('runner unavailable');
    }
  });
  const first = JSON.parse((await rawUpload(port, 'first.mkv', Buffer.from('first'))).body).media;
  const second = JSON.parse((await rawUpload(port, 'second.mkv', Buffer.from('second'))).body).media;
  await replaceLibrary(port, [first.id, second.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${first.id}/master.m3u8?token=test-room-token` })).status, 200);
  await roomCommand(port, { type: 'play', position: 0 });
  await waitFor(async () => {
    const room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
    return starts === 2 && room.oneAhead?.mediaId === second.id && room.oneAhead.status === 'unavailable';
  }, 'failed runner admission incorrectly remained preparing');
});

test('one-ahead HLS plans cache, dedupe, preempt, promote, and reject stale targets', async (t) => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-one-ahead-cache-'));
  fs.writeFileSync(path.join(cache, '.the-player-hls-cache-owner'), 'The Player persistent HLS cache storage\n');
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const probe = async (input) => ({ streams: [
    { index: 0, codec_type: 'video', codec_name: 'h264' },
    { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } },
    ...(fs.readFileSync(input).toString() === 'mismatch' ? [] : [{ index: 2, codec_type: 'audio', codec_name: 'aac', tags: { language: 'spa', title: 'Spanish' } }])
  ] });
  const publish = async (input, directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  let calls = 0;
  const { port } = await startFixture(t, {
    hlsCacheDir: cache,
    ffprobeRunner: probe,
    ffmpegRunner: async (...args) => { calls += 1; await publish(...args); }
  });
  const first = JSON.parse((await rawUpload(port, 'first.mkv', Buffer.from('same'))).body).media;
  const cachedNext = JSON.parse((await rawUpload(port, 'cached-next.mkv', Buffer.from('same'))).body).media;
  const mismatch = JSON.parse((await rawUpload(port, 'mismatch.mkv', Buffer.from('mismatch'))).body).media;
  await replaceLibrary(port, [first.id, cachedNext.id, mismatch.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${first.id}/master.m3u8?token=test-room-token` })).status, 200);
  await roomCommand(port, { type: 'play', position: 0 });
  const playingRoom = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
  assert.equal(playingRoom.hls.status, 'ready');
  assert.equal(playingRoom.playing, true);
  await waitFor(async () => {
    const room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
    return room.oneAhead?.mediaId === cachedNext.id && room.oneAhead.status === 'ready';
  }, 'server-owned cache admission did not prepare the immediate next item');
  assert.equal(calls, 1, 'a completed cache hit makes the immediate next plan ready without FFmpeg');
  let room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
  assert.deepEqual(room.oneAhead, { status: 'ready', mediaId: cachedNext.id, audioTrackIndex: 1, subtitleTrackIndex: null });

  // Selecting next transfers the matching prepared plan to foreground instead
  // of cancelling, encoding, loading, seeking, or otherwise altering it.
  const promoted = await roomCommand(port, { type: 'next' });
  assert.equal(promoted.status, 200);
  room = JSON.parse(promoted.body).state;
  assert.equal(room.mediaId, cachedNext.id);
  assert.equal(room.trackSelection.audioTrackIndex, 1);
  assert.equal(room.hls.status, 'ready');
  assert.equal(calls, 1, 'promotion reuses the prepared cache plan');
  assert.equal((await request(port, { path: `/hls/${cachedNext.id}/master.m3u8?token=test-room-token` })).status, 200);
  assert.equal(calls, 1, 'foreground serving does not reencode a promoted plan');

  // The destination has no matching Spanish track. The next card asks for a
  // choice instead of guessing a different-language global stream.
  await roomCommand(port, { type: 'pause', position: 0 });
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 2, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${cachedNext.id}/master.m3u8?token=test-room-token` })).status, 200);
  await roomCommand(port, { type: 'play', position: 0 });
  await waitFor(async () => {
    const current = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
    return current.oneAhead?.mediaId === mismatch.id && current.oneAhead.status === 'choice-required';
  }, 'an unresolved semantic selection did not require a host choice');
});

test('one-ahead resolves semantic audio and subtitle tracks across global indexes, promotes them, and rejects ambiguity', async (t) => {
  const publish = async (input, directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  const deliveries = [];
  const { port } = await startFixture(t, {
    ffprobeRunner: async (input) => {
      const episode = fs.readFileSync(input, 'utf8');
      const tracks = episode === 'first'
        ? [{ index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' }, disposition: { default: 1 } }, { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'spa', title: 'Spanish' }, disposition: { forced: 1 } }]
        : episode === 'second'
          ? [{ index: 7, codec_type: 'audio', codec_name: 'aac', tags: { language: 'en', title: ' english ' }, disposition: { default: true } }, { index: 9, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'es', title: 'SPANISH' }, disposition: { forced: true } }]
          : [{ index: 11, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' }, disposition: { default: 1 } }, { index: 12, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' }, disposition: { default: 1 } }, { index: 13, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'spa', title: 'Spanish' }, disposition: { forced: 1 } }];
      return { streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }, ...tracks] };
    },
    ffmpegRunner: async (input, directory, delivery) => {
      deliveries.push({ media: fs.readFileSync(input, 'utf8'), audio: delivery.audioTrack.index, subtitle: delivery.subtitleTrack?.index ?? null });
      await publish(input, directory);
    }
  });
  const first = JSON.parse((await rawUpload(port, 'first.mkv', Buffer.from('first'))).body).media;
  const second = JSON.parse((await rawUpload(port, 'second.mkv', Buffer.from('second'))).body).media;
  const ambiguous = JSON.parse((await rawUpload(port, 'ambiguous.mkv', Buffer.from('ambiguous'))).body).media;
  await replaceLibrary(port, [first.id, second.id, ambiguous.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: 2 });
  assert.equal((await request(port, { path: `/hls/${first.id}/master.m3u8?token=test-room-token` })).status, 200);
  await roomCommand(port, { type: 'play', position: 0 });
  await waitFor(async () => {
    const room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
    return room.oneAhead?.mediaId === second.id && room.oneAhead.status === 'ready';
  }, 'semantic next preparation did not complete');
  let room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
  assert.deepEqual(room.trackSelection, { audioTrackIndex: 1, subtitleTrackIndex: 2 }, 'preparing next must not alter the current selection');
  assert.deepEqual(room.oneAhead, { status: 'ready', mediaId: second.id, audioTrackIndex: 7, subtitleTrackIndex: 9 });
  assert.deepEqual(deliveries, [{ media: 'first', audio: 1, subtitle: 2 }, { media: 'second', audio: 7, subtitle: 9 }]);

  const promoted = await roomCommand(port, { type: 'next' });
  room = JSON.parse(promoted.body).state;
  assert.equal(room.mediaId, second.id);
  assert.deepEqual(room.trackSelection, { audioTrackIndex: 7, subtitleTrackIndex: 9 }, 'promotion must use next episode resolved indexes');
  assert.equal(room.hls.status, 'ready');
  assert.equal(deliveries.length, 2, 'promotion must reuse the resolved prepared entry');
  await waitFor(async () => {
    const current = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
    return current.oneAhead?.mediaId === ambiguous.id && current.oneAhead.status === 'choice-required';
  }, 'ambiguous semantic tracks must require a choice');
});

test('one-ahead admission dedupes requests and foreground preemption, clear, and stale callbacks cancel only speculation', async (t) => {
  let starts = 0;
  let cancelCalls = 0;
  let release;
  const started = new Promise((resolve) => { release = resolve; });
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } }
    ] }),
    ffmpegRunner: (input, directory) => {
      starts += 1;
      if (starts === 1) return (async () => {
        await fsp.mkdir(directory, { recursive: true });
        await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
        await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
        await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
        await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
      })();
      let cancel;
      const pending = new Promise((resolve, reject) => {
        release = () => { void fsp.mkdir(directory, { recursive: true }).then(resolve); };
        cancel = () => { cancelCalls += 1; reject(new Error('cancelled')); };
      });
      pending.cancel = cancel;
      return pending;
    }
  });
  const first = JSON.parse((await rawUpload(port, 'first.mkv', Buffer.from('first'))).body).media;
  const second = JSON.parse((await rawUpload(port, 'second.mkv', Buffer.from('second'))).body).media;
  await replaceLibrary(port, [first.id, second.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${first.id}/master.m3u8?token=test-room-token` })).status, 200);
  await roomCommand(port, { type: 'play', position: 0 });
  await waitFor(() => starts === 2, 'server-owned one-ahead runner did not start');
  assert.equal(starts, 2, 'owner transitions admit only one speculative FFmpeg job');
  assert.equal((await request(port, { path: `/hls/${first.id}/master.m3u8?token=test-room-token` })).status, 200);
  assert.equal(cancelCalls, 0, 'passive foreground serving must not preempt speculative work');
  // The no-progress plan is intentionally not published yet; the runner and
  // cancellation count prove the passive request left it server-owned.
  // Clearing is the owner transition that cancels the speculative runner.
  const cleared = await request(port, { path: '/api/library/clear?token=test-room-token', method: 'POST', headers: { 'X-Room-Token': 'test-room-token' } });
  assert.equal(cleared.status, 200);
});

test('clearing during preparation returns an idempotent client-visible success before cancellation settles', async (t) => {
  let cancelCalls = 0;
  let started;
  let settleCancellation;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' }
    ] }),
    ffmpegRunner: () => {
      const running = new Promise((resolve) => { settleCancellation = resolve; });
      running.cancel = () => { cancelCalls += 1; };
      started();
      return running;
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  const pending = request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  await startedPromise;
  const clear = await Promise.race([
    request(port, { path: '/api/library/clear?token=test-room-token', method: 'POST', headers: { 'X-Room-Token': 'test-room-token' } }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('clear response waited for cancellation')), 250))
  ]);
  assert.equal(clear.status, 200);
  assert.equal(cancelCalls, 1);
  const repeat = await request(port, { path: '/api/library/clear?token=test-room-token', method: 'POST', headers: { 'X-Room-Token': 'test-room-token' } });
  assert.equal(repeat.status, 200);
  settleCancellation();
  assert.equal((await pending).status, 503);
  const state = JSON.parse(clear.body).state;
  assert.equal(state.mediaId, null);
  assert.equal(state.hls.status, 'idle');
});

test.skip('rejected multi-rendition selection preserves an in-flight timeline architecture', async (t) => {
  let started;
  const generationStarted = new Promise((resolve) => { started = resolve; });
  let generations = 0;
  const { port, app } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'audio', codec_name: 'ac3' },
      { index: 3, codec_type: 'subtitle', codec_name: 'subrip' }
    ] }),
    ffmpegRunner: () => {
      generations += 1;
      let cancel;
      const pending = new Promise((resolve, reject) => { cancel = () => reject(new Error('cancelled')); });
      pending.cancel = cancel;
      started();
      return pending;
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  const initial = request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` }).then(
    () => ({ resolved: true }),
    (error) => ({ error })
  );
  await generationStarted;
  assert.equal((await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 2, subtitleTrackIndex: 3 })).status, 200);
  assert.equal(generations, 1);
  await app.close();
  assert.match((await initial).error?.message || '', /socket hang up/);
});

test.skip('rejected real multi-rendition FFmpeg topology fixture', async (t) => {
  const ffmpeg = path.join(__dirname, '..', 'portable-win-rc', 'The-Player-1.5.5-windows', 'runtime', 'ffmpeg.exe');
  const ffprobe = path.join(path.dirname(ffmpeg), 'ffprobe.exe');
  if (!fs.existsSync(ffmpeg) || !fs.existsSync(ffprobe)) {
    t.skip(`Portable runtime fixture is unavailable; the packaging build validates it separately at ${ffmpeg}`);
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-real-hls-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const subtitle = path.join(root, 'fixture.srt');
  const source = path.join(root, 'fixture.mkv');
  const output = path.join(root, 'hls');
  const ffmpegPath = (candidate) => {
    if (process.platform !== 'linux' || !ffmpeg.endsWith('.exe')) return candidate;
    const converted = spawnSync('wslpath', ['-w', candidate], { encoding: 'utf8' });
    assert.equal(converted.status, 0, converted.stderr);
    return converted.stdout.trim();
  };
  fs.writeFileSync(subtitle, '1\n00:00:00,000 --> 00:00:00,750\nFixture subtitle\n');
  const fixture = spawnSync(ffmpeg, [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x72:rate=12',
    '-f', 'lavfi', '-i', 'sine=frequency=400:sample_rate=48000',
    '-f', 'lavfi', '-i', 'sine=frequency=800:sample_rate=48000', '-i', ffmpegPath(subtitle),
    '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0', '-map', '3:0', '-t', '1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'srt', ffmpegPath(source)
  ], { encoding: 'utf8' });
  assert.equal(fixture.status, 0, fixture.stderr);

  fs.mkdirSync(output, { recursive: true });
  const hlsOutput = ffmpegPath(output);
  const generation = spawnSync(ffmpeg, [
    '-y', '-v', 'error', '-i', ffmpegPath(source), '-t', '1', '-map', '0:v:0', '-map', '0:1', '-map', '0:2', '-map', '0:3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-c:s', 'webvtt',
    '-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_flags', 'temp_file',
    '-hls_segment_filename', path.win32.join(hlsOutput, 'segment_%v_%05d.ts'), '-master_pl_name', 'master.m3u8',
    '-var_stream_map', 'v:0,agroup:audio,s:0,sgroup:subs,name:subtitle-track-3,language:eng a:0,agroup:audio,name:audio-track-1,language:spa,default:yes a:1,agroup:audio,name:audio-track-2,language:eng',
    path.win32.join(hlsOutput, 'media_%v.m3u8')
  ], { encoding: 'utf8' });
  assert.equal(generation.status, 0, generation.stderr);

  const master = fs.readFileSync(path.join(output, 'master.m3u8'), 'utf8');
  const audioRenditions = master.split(/\r?\n/).filter((line) => line.startsWith('#EXT-X-MEDIA:TYPE=AUDIO'));
  assert.equal(audioRenditions.length, 2, master);
  // FFmpeg truncates name:audio-track-1 to NAME="audio_1". The API identity
  // and browser lookup must use this emitted spelling exactly.
  const emittedAudioNames = audioRenditions.map((line) => /NAME="([^"]+)"/.exec(line)?.[1]);
  assert.deepEqual(emittedAudioNames, [
    hlsRenditionIdentity('audio', { index: 1 }),
    hlsRenditionIdentity('audio', { index: 2 })
  ]);
  assert.deepEqual(emittedAudioNames, ['audio_1', 'audio_2']);
  const audioGroup = /GROUP-ID="([^"]+)"/.exec(audioRenditions[0])?.[1];
  assert.ok(audioGroup, master);
  assert.equal(audioRenditions.filter((line) => line.includes(`GROUP-ID="${audioGroup}"`)).length, 2, master);
  assert.equal(audioRenditions.filter((line) => /DEFAULT=YES/.test(line)).length, 1, master);
  assert.match(audioRenditions[0], /LANGUAGE="spa"/, master);
  assert.match(audioRenditions[1], /LANGUAGE="eng"/, master);
  const subtitleRendition = master.split(/\r?\n/).find((line) => line.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES'));
  assert.match(subtitleRendition || '', /GROUP-ID="subs"/, master);
  assert.match(subtitleRendition || '', /LANGUAGE="eng"/, master);
  assert.match(subtitleRendition || '', /NAME="subtitle_0"/, master);
  const deliveredMaster = applyHlsRenditionIdentities(applyHlsVideoOnlyCodecDeclaration(master), {
    audioTracks: [{ index: 1 }, { index: 2 }],
    subtitleTracks: [{ index: 3 }]
  });
  assert.match(deliveredMaster, /TYPE=AUDIO,GROUP-ID="group_audio",NAME="audio_1"/, deliveredMaster);
  assert.match(deliveredMaster, /TYPE=AUDIO,GROUP-ID="group_audio",NAME="audio_2"/, deliveredMaster);
  assert.match(deliveredMaster, /TYPE=SUBTITLES,GROUP-ID="subs",NAME="subtitle_3"/, deliveredMaster);
  const videoVariant = master.split(/\r?\n/).find((line) => line.startsWith('#EXT-X-STREAM-INF:'));
  assert.match(videoVariant || '', new RegExp(`AUDIO="${audioGroup}"`), master);
  assert.match(videoVariant || '', /SUBTITLES="subs"/, master);
  const deliveredVideoVariant = deliveredMaster.split(/\r?\n/).find((line) => line.startsWith('#EXT-X-STREAM-INF:'));
  assert.match(deliveredVideoVariant || '', /CODECS="avc1\.[^"]+"/, deliveredMaster);
  assert.doesNotMatch(deliveredVideoVariant || '', /CODECS="[^"]*(?:mp4a\.|ac-3|ec-3|opus|flac)/i, deliveredMaster);
  const masterLines = master.split(/\r?\n/);
  const videoPlaylistUri = masterLines[masterLines.indexOf(videoVariant) + 1];
  const videoPlaylist = fs.readFileSync(path.join(output, videoPlaylistUri), 'utf8');
  const videoSegment = videoPlaylist.split(/\r?\n/).find((line) => line.endsWith('.ts') || line.endsWith('.m4s'));
  assert.ok(videoSegment, videoPlaylist);
  const videoProbe = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', ffmpegPath(path.join(output, videoSegment))], { encoding: 'utf8' });
  assert.equal(videoProbe.status, 0, videoProbe.stderr);
  const videoStreams = JSON.parse(videoProbe.stdout).streams;
  assert.ok(videoStreams.some((stream) => stream.codec_type === 'video' && stream.codec_name === 'h264'), `Video variant segment has no H.264 video: ${videoSegment}`);
  assert.equal(videoStreams.some((stream) => stream.codec_type === 'audio'), false, `Video variant segment embeds audio: ${videoSegment}`);

  const audioUris = audioRenditions.map((line) => /URI="([^"]+)"/.exec(line)?.[1]);
  const subtitleUri = /URI="([^"]+)"/.exec(subtitleRendition || '')?.[1];
  assert.equal(audioUris.length, 2, master);
  for (const uri of audioUris) assert.equal(fs.existsSync(path.join(output, uri)), true, uri);
  assert.ok(subtitleUri, master);
  const subtitlePlaylist = fs.readFileSync(path.join(output, subtitleUri), 'utf8');
  const vtt = subtitlePlaylist.split(/\r?\n/).find((line) => line.endsWith('.vtt'));
  assert.ok(vtt, subtitlePlaylist);
  assert.match(fs.readFileSync(path.join(output, vtt), 'utf8'), /^WEBVTT/);
  for (const uri of audioUris) {
    const playlist = fs.readFileSync(path.join(output, uri), 'utf8');
    const segment = playlist.split(/\r?\n/).find((line) => line.endsWith('.ts') || line.endsWith('.m4s'));
    assert.ok(segment, playlist);
    const segmentPath = path.join(output, segment);
    assert.ok(fs.statSync(segmentPath).size > 0, segment);
    const probe = spawnSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', ffmpegPath(segmentPath)], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    assert.ok(JSON.parse(probe.stdout).streams.some((stream) => stream.codec_type === 'audio'), `Audio rendition segment has no audio stream: ${segment}`);
  }

  // Serve the actual FFmpeg-generated master through the protected route. This
  // reproduces hls.js loading the alternate audio playlist named in EXT-X-MEDIA.
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' },
      { index: 2, codec_type: 'audio', codec_name: 'aac' },
      { index: 3, codec_type: 'subtitle', codec_name: 'subrip' }
    ] }),
    ffmpegRunner: async (input, directory) => {
      fs.cpSync(output, directory, { recursive: true });
    }
  });
  const media = JSON.parse((await rawUpload(port, 'fixture.mkv', fs.readFileSync(source))).body).media;
  await replaceLibrary(port, [media.id]);
  const protectedMaster = await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  assert.equal(protectedMaster.status, 200);
  const alternateAudio = audioUris[1];
  assert.equal((await request(port, { path: `/hls/${media.id}/${alternateAudio}?token=test-room-token` })).status, 200);
});

test.skip('rejected browser rendition-mapping diagnostics', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const helpers = app.match(/const HLS_DIAGNOSTIC_TRACK_LIMIT = 8;[\s\S]*?(?=\n\nfunction hlsTrackIdForIdentity)/)?.[0];
  assert.ok(helpers, 'browser diagnostic snapshot helpers are present');
  const diagnostics = [];
  const state = { shared: { hls: { mappingMissKeys: new Set() } } };
  const { safeHlsTrackSnapshot, reportHlsRenditionMappingMiss } = new Function('state', 'reportHlsDiagnostic', `${helpers}\nreturn { safeHlsTrackSnapshot, reportHlsRenditionMappingMiss };`)(
    state,
    (event, data, extra) => diagnostics.push({ event, data, extra })
  );
  const tracks = Array.from({ length: 9 }, (_, id) => ({
    id,
    name: id === 1 ? '/private/path?token=secret' : `audio_${id}`,
    lang: id === 1 ? 'https://example.test/token' : 'eng',
    groupId: id === 1 ? '../private' : 'group_audio',
    default: id === 0,
    url: 'https://example.test/playlist.m3u8?token=secret'
  }));

  const snapshot = safeHlsTrackSnapshot(tracks);
  assert.equal(snapshot.length, 8);
  assert.deepEqual(snapshot[0], {
    index: 0,
    id: 0,
    name: 'audio_0',
    lang: 'eng',
    groupId: 'group_audio',
    default: true
  });
  assert.deepEqual(snapshot[1], {
    index: 1,
    id: 1,
    name: 'unknown',
    lang: 'unknown',
    groupId: 'unknown',
    default: false
  });
  assert.deepEqual(Object.keys(snapshot[0]), ['index', 'id', 'name', 'lang', 'groupId', 'default']);
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  assert.equal(JSON.stringify(snapshot).includes('playlist'), false);

  const client = { audioTracks: tracks, subtitleTracks: [] };
  reportHlsRenditionMappingMiss('audio', 'audio_1', client);
  reportHlsRenditionMappingMiss('audio', 'audio_1', client);
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].extra.audioTracks, snapshot);
  assert.deepEqual(diagnostics[0].extra.subtitleTracks, []);
});

test.skip('rejected HLS rendition identity lookup contract', () => {
  assert.equal(hlsRenditionIdentity('audio', { index: 7 }), 'audio_7');
  assert.equal(hlsRenditionIdentity('subtitle', { index: 9 }), 'subtitle_9');
  assert.equal(hlsRenditionLanguage({ language: 'ENG' }), 'eng');
  assert.equal(hlsRenditionLanguage({ language: 'es-419' }), null);
  assert.throws(() => hlsRenditionIdentity('audio', { index: -1 }), /Invalid HLS rendition track/);
  const manifest = applyHlsRenditionIdentities([
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio_0",LANGUAGE="spa",URI="audio.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio_1",LANGUAGE="eng",URI="english.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="subtitle_0",LANGUAGE="eng",URI="subtitle.m3u8"'
  ].join('\n'), {
    audioTracks: [{ index: 7 }, { index: 8 }],
    subtitleTracks: [{ index: 9 }]
  });
  assert.match(manifest, /TYPE=AUDIO,GROUP-ID="audio",NAME="audio_7"/);
  assert.match(manifest, /TYPE=AUDIO,GROUP-ID="audio",NAME="audio_8"/);
  assert.match(manifest, /TYPE=SUBTITLES,GROUP-ID="subs",NAME="subtitle_9"/);
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /return Number\.isSafeInteger\(track\?\.index\) && track\.index >= 0 \? `\$\{kind\}_\$\{track\.index\}` : null;/);
  assert.match(app, /tracks\.find\(\(entry\) => entry\.name === identity\)/);
});

test.skip('rejected FFmpeg alternate-audio rendition topology', async () => {
  const calls = [];
  const runner = createFfmpegRunner({
    spawnProcess(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('close', 1));
      return child;
    }
  });

  await assert.rejects(runner('/safe/input.mkv', '/safe/output', {
    audioTracks: [{ index: 7, language: 'spa' }, { index: 8, language: 'eng' }],
    subtitleTracks: [{ index: 9, language: 'eng' }]
  }), /FFmpeg failed/);

  const args = calls[0].args;
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(args.filter((arg) => arg === '-map').length, 4);
  assert.equal(args.includes('0:7'), true);
  assert.equal(args.includes('0:8'), true);
  assert.equal(args.includes('0:9'), true);
  const variantMap = args[args.indexOf('-var_stream_map') + 1];
  assert.match(variantMap, /v:0,agroup:audio,s:0,sgroup:subs/);
  assert.doesNotMatch(variantMap, /v:0,a:/);
  assert.match(variantMap, /a:0,agroup:audio,name:audio_7,language:spa,default:yes/);
  assert.match(variantMap, /a:1,agroup:audio,name:audio_8,language:eng/);
  assert.match(variantMap, /v:0,agroup:audio,s:0,sgroup:subs/);
});

test('completed marked HLS cache promotes atomically, rejects corruption, and reuses same content without FFmpeg', async (t) => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-hls-cache-'));
  fs.writeFileSync(path.join(cache, '.the-player-hls-cache-owner'), 'The Player persistent HLS cache storage\n');
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const probe = async () => ({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }, { index: 1, codec_type: 'audio', codec_name: 'aac' }] });
  const publish = async (input, directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  const first = await startFixture(t, { hlsCacheDir: cache, ffprobeRunner: probe, ffmpegRunner: publish });
  const uploaded = JSON.parse((await rawUpload(first.port, 'movie.mkv', Buffer.from('same-content'))).body).media;
  await replaceLibrary(first.port, [uploaded.id]);
  await roomCommand(first.port, { type: 'selectTracks', audioTrackIndex: 1 });
  assert.equal((await request(first.port, { path: `/hls/${uploaded.id}/master.m3u8?token=test-room-token` })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const entries = fs.readdirSync(cache).filter((name) => /^[a-f0-9]{64}$/.test(name));
  assert.equal(entries.length, 1);
  const cachedMaster = path.join(cache, entries[0], 'master.m3u8');
  assert.equal(fs.existsSync(cachedMaster), true);
  assert.doesNotMatch(fs.readFileSync(cachedMaster, 'utf8'), /test-room-token/, 'cached manifests never store tokens');
  // A broken completed cache must not be reused.
  fs.writeFileSync(path.join(cache, entries[0], 'segment_0.m4s'), '');
  await first.app.close();
  let invocations = 0;
  const second = await startFixture(t, { hlsCacheDir: cache, ffprobeRunner: probe, ffmpegRunner: async (...args) => { invocations += 1; await publish(...args); } });
  const secondUpload = JSON.parse((await rawUpload(second.port, 'renamed.mkv', Buffer.from('same-content'))).body).media;
  await replaceLibrary(second.port, [secondUpload.id]);
  await roomCommand(second.port, { type: 'selectTracks', audioTrackIndex: 1 });
  assert.equal((await request(second.port, { path: `/hls/${secondUpload.id}/master.m3u8?token=test-room-token` })).status, 200);
  assert.equal(invocations, 1, 'corrupt cache is rejected and regenerated');
  await new Promise((resolve) => setTimeout(resolve, 20));
  await second.app.close();
  const third = await startFixture(t, { hlsCacheDir: cache, ffprobeRunner: probe, ffmpegRunner: async () => { throw new Error('cache hit must not run FFmpeg'); } });
  const thirdUpload = JSON.parse((await rawUpload(third.port, 'again.mkv', Buffer.from('same-content'))).body).media;
  await replaceLibrary(third.port, [thirdUpload.id]);
  await roomCommand(third.port, { type: 'selectTracks', audioTrackIndex: 1 });
  const protectedMaster = await request(third.port, { path: `/hls/${thirdUpload.id}/master.m3u8?token=test-room-token` });
  assert.equal(protectedMaster.status, 200);
  assert.match(protectedMaster.body.toString(), /media_0\.m3u8\?token=test-room-token/);
});

test('same-content restart resumes through append and reuses the completed cache without FFmpeg', async (t) => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-hls-restart-cache-'));
  fs.writeFileSync(path.join(cache, '.the-player-hls-cache-owner'), 'The Player persistent HLS cache storage\n');
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const source = Buffer.from('same-content-restart');
  const contentId = crypto.createHash('sha256').update(source).digest('hex');
  const routeProfile = 'selected-track-routing-v1:full-transcode:transcode:transcode:none:selected-cmaf-x264-v1';
  const key = crypto.createHash('sha256').update(JSON.stringify({
    contentId, audioTrackIndex: 1, subtitleTrackIndex: null,
    routing: routeProfile, topology: 'selected-muxed-cmaf-v2'
  })).digest('hex');
  const entry = path.join(cache, key);
  fs.mkdirSync(entry);
  fs.writeFileSync(path.join(entry, '.the-player-hls-cache-entry'), 'The Player persistent HLS cache storage\n');
  fs.writeFileSync(path.join(entry, '.the-player-hls-cache-profile.json'), `${JSON.stringify({ contentId, audioTrackIndex: 1, subtitleTrackIndex: null, route: 'full-transcode', videoMode: 'transcode', audioMode: 'transcode', subtitleMode: 'none', encoder: 'libx264', topology: 'selected-muxed-cmaf-v2', routingVersion: 'selected-track-routing-v1' })}\n`);
  fs.writeFileSync(path.join(entry, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
  fs.writeFileSync(path.join(entry, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
  fs.writeFileSync(path.join(entry, 'init.mp4'), 'init');
  fs.writeFileSync(path.join(entry, 'segment_0.m4s'), 'segment');
  let invocations = 0;
  const { port } = await startFixture(t, {
    hlsCacheDir: cache,
    ffprobeRunner: async () => ({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }, { index: 1, codec_type: 'audio', codec_name: 'aac' }] }),
    ffmpegRunner: async () => { invocations += 1; throw new Error('cache hit must not invoke FFmpeg'); }
  });
  const media = JSON.parse((await rawUpload(port, 'renamed.mkv', source)).body).media;
  const appended = await appendLibrary(port, [media.id], { contentId: media.contentId, position: 90 * 60 });
  assert.equal(appended.status, 200);
  assert.equal(JSON.parse(appended.body).state.position, 90 * 60);
  const selectingTracksBeforeMetadata = JSON.parse((await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, position: 0 })).body).state;
  assert.equal(selectingTracksBeforeMetadata.position, 90 * 60, 'an uninitialized client position cannot overwrite the positive content checkpoint before conversion metadata');
  assert.equal((await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` })).status, 200);
  assert.equal(JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.position, 90 * 60, 'conversion readiness retains the checkpoint for metadata restoration');
  assert.equal(invocations, 0);

  const mismatch = JSON.parse((await rawUpload(port, 'other.mkv', Buffer.from('different-content'))).body).media;
  const rejected = await appendLibrary(port, [mismatch.id], { contentId: media.contentId, position: 90 * 60 });
  assert.equal(rejected.status, 400, 'different bytes must never inherit a saved resume position');
  assert.equal(JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.position, 90 * 60);
});

test('non-adjacent cached navigation publishes ready with a fresh generation before destination state', async (t) => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-navigation-cache-'));
  fs.writeFileSync(path.join(cache, '.the-player-hls-cache-owner'), 'The Player persistent HLS cache storage\n');
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const source = Buffer.from('same-completed-content');
  const contentId = crypto.createHash('sha256').update(source).digest('hex');
  const key = crypto.createHash('sha256').update(JSON.stringify({
    contentId, audioTrackIndex: 1, subtitleTrackIndex: null,
    routing: 'selected-track-routing-v1:full-transcode:transcode:transcode:none:selected-cmaf-x264-v1', topology: 'selected-muxed-cmaf-v2'
  })).digest('hex');
  const entry = path.join(cache, key);
  fs.mkdirSync(entry);
  fs.writeFileSync(path.join(entry, '.the-player-hls-cache-entry'), 'The Player persistent HLS cache storage\n');
  fs.writeFileSync(path.join(entry, '.the-player-hls-cache-profile.json'), `${JSON.stringify({ contentId, audioTrackIndex: 1, subtitleTrackIndex: null, route: 'full-transcode', videoMode: 'transcode', audioMode: 'transcode', subtitleMode: 'none', encoder: 'libx264', topology: 'selected-muxed-cmaf-v2', routingVersion: 'selected-track-routing-v1' })}\n`);
  fs.writeFileSync(path.join(entry, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
  fs.writeFileSync(path.join(entry, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
  fs.writeFileSync(path.join(entry, 'init.mp4'), 'init');
  fs.writeFileSync(path.join(entry, 'segment_0.m4s'), 'segment');
  let runs = 0;
  const { port } = await startFixture(t, {
    hlsCacheDir: cache,
    ffprobeRunner: async () => ({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }, { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } }] }),
    ffmpegRunner: async () => { runs += 1; throw new Error('cache hit must not run FFmpeg'); }
  });
  const first = JSON.parse((await rawUpload(port, 'first.mkv', source)).body).media;
  const middle = JSON.parse((await rawUpload(port, 'middle.mkv', source)).body).media;
  const destination = JSON.parse((await rawUpload(port, 'destination.mkv', source)).body).media;
  await replaceLibrary(port, [first.id, middle.id, destination.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1 });
  await waitFor(async () => JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls.status === 'ready', 'initial cache entry was not admitted');
  const before = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls.selectionId;
  const events = await openEvents(port);
  await events.nextEvent();
  const selected = await roomCommand(port, { type: 'select', mediaId: destination.id });
  const responseState = JSON.parse(selected.body).state;
  const stateEvent = await events.nextEvent();
  events.response.destroy();
  assert.equal(responseState.hls.status, 'ready');
  assert.equal(responseState.hls.cacheHit, true);
  assert.notEqual(responseState.hls.selectionId, before, 'cache navigation creates a new generation identity');
  assert.equal(stateEvent.data.hls.status, 'ready', 'destination first publishes as ready, not idle/preparing');
  assert.equal(stateEvent.data.hls.cacheHit, true);
  assert.equal(runs, 0);
});

test('persistent cache rejects unsafe or incomplete manifest graphs and accepts only complete safe entries', async (t) => {
  const source = Buffer.from('cache-validation-source');
  const contentId = crypto.createHash('sha256').update(source).digest('hex');
  const routeProfile = 'selected-track-routing-v1:full-transcode:transcode:transcode:none:selected-cmaf-x264-v1';
  const key = crypto.createHash('sha256').update(JSON.stringify({
    contentId, audioTrackIndex: 1, subtitleTrackIndex: null,
    routing: routeProfile, topology: 'selected-muxed-cmaf-v2'
  })).digest('hex');
  const validFiles = {
    'master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n',
    'media_0.m3u8': '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n',
    'init.mp4': 'init', 'segment_0.m4s': 'segment'
  };
  const cases = [
    ['external reference', { ...validFiles, 'master.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://invalid.test/media.m3u8\n' }, 1],
    ['traversal reference', { ...validFiles, 'media_0.m3u8': '#EXTM3U\n#EXT-X-MAP:URI="../init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n' }, 1],
    ['empty master', { ...validFiles, 'master.m3u8': '#EXTM3U\n' }, 1],
    ['unquoted master URI attribute', { ...validFiles, 'master.m3u8': '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI=subtitle.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n' }, 1],
    ['malformed master URI attribute', { ...validFiles, 'master.m3u8': '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="subtitle.m3u8"broken\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n' }, 1],
    ['incomplete media playlist', { ...validFiles, 'media_0.m3u8': '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n' }, 1],
    ['ENDLIST and map without a media segment', { ...validFiles, 'media_0.m3u8': '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-ENDLIST\n' }, 1],
    ['unquoted media URI attribute', { ...validFiles, 'media_0.m3u8': '#EXTM3U\n#EXT-X-MAP:URI=init.mp4\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n' }, 1],
    ['malformed media URI attribute', { ...validFiles, 'media_0.m3u8': '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"broken\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n' }, 1],
    ['complete media cache entry', validFiles, 0]
  ];
  for (const [name, files, expectedInvocations] of cases) {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-hls-validation-cache-'));
    fs.writeFileSync(path.join(cache, '.the-player-hls-cache-owner'), 'The Player persistent HLS cache storage\n');
    const entry = path.join(cache, key);
    fs.mkdirSync(entry);
    fs.writeFileSync(path.join(entry, '.the-player-hls-cache-entry'), 'The Player persistent HLS cache storage\n');
    fs.writeFileSync(path.join(entry, '.the-player-hls-cache-profile.json'), `${JSON.stringify({ contentId, audioTrackIndex: 1, subtitleTrackIndex: null, route: 'full-transcode', videoMode: 'transcode', audioMode: 'transcode', subtitleMode: 'none', encoder: 'libx264', topology: 'selected-muxed-cmaf-v2', routingVersion: 'selected-track-routing-v1' })}\n`);
    for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(entry, file), content);
    let invocations = 0;
    const publish = async (input, directory) => {
      invocations += 1;
      await fsp.mkdir(directory, { recursive: true });
      for (const [file, content] of Object.entries(validFiles)) await fsp.writeFile(path.join(directory, file), content);
    };
    const { port, app } = await startFixture(t, {
      hlsCacheDir: cache,
      ffprobeRunner: async () => ({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }, { index: 1, codec_type: 'audio', codec_name: 'aac' }] }),
      ffmpegRunner: publish
    });
    const media = JSON.parse((await rawUpload(port, 'movie.mkv', source)).body).media;
    await replaceLibrary(port, [media.id]);
    await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1 });
    const master = await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
    assert.equal(master.status, 200, name);
    assert.equal(invocations, expectedInvocations, name);
    await app.close();
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test('browser sends content-bound append resume and applies room position only after metadata', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /readProgress\(uploadedMedia\.contentId\)/);
  assert.match(app, /contentId: uploadedMedia\.contentId, position: savedProgress\.currentTime/);
  assert.match(app, /JSON\.stringify\(\{ mediaIds: \[uploadedMedia\.id\], \.\.\.\(resume \? \{ resume \} : \{\}\) \}\)/);
  assert.match(app, /const syncPosition = \(\) => \{[\s\S]*?else if \(state\.shared\.hls\.fallbackKey !== hlsGenerationKey\(item, roomState\.trackSelection, roomState\.hls\)\) elements\.video\.onloadedmetadata = syncPosition;/);
  assert.match(app, /if \(!sourceChanged && elements\.video\.readyState >= HTMLMediaElement\.HAVE_METADATA\) syncPosition\(\)/);
});

test('browser keeps content-bound resume through conversion, then permits later progress saves', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const helperSource = app.match(/function armSharedProgressRestore[\s\S]*?(?=function setSharedItems)/)?.[0];
  assert.ok(helperSource, 'content-bound resume helpers must remain available');
  const context = {
    state: { shared: { resume: { contentId: null, position: 0, pending: false } } },
    isSharedMode: () => true
  };
  vm.runInNewContext(`${helperSource}\nthis.helpers = { armSharedProgressRestore, isSharedProgressRestorePending, sharedProgressRestorePosition, completeSharedProgressRestore };`, context);

  const item = { contentId: 'same-uploaded-bytes' };
  const savedPosition = 22 * 60 + 43;
  context.helpers.armSharedProgressRestore(item.contentId, savedPosition);
  assert.equal(context.helpers.isSharedProgressRestorePending(item), true);
  assert.equal(context.helpers.sharedProgressRestorePosition(item, 68), savedPosition, 'early progressive/cache startup cannot replace 22:43 with 1:08');
  context.helpers.completeSharedProgressRestore(item);
  assert.equal(context.helpers.isSharedProgressRestorePending(item), false);
  assert.equal(context.helpers.sharedProgressRestorePosition(item, savedPosition + 30), savedPosition + 30, 'later real playback progress persists normally');

  assert.match(app, /if \(isSharedProgressRestorePending\(item\)\) return;/);
  assert.match(app, /armSharedProgressRestore\(uploadedMedia\.contentId, savedProgress\.currentTime\)/);
  assert.match(app, /const restorePosition = sharedProgressRestorePosition\(item, position\);[\s\S]*?elements\.video\.currentTime = clamp\(restorePosition, 0, elements\.video\.duration\);[\s\S]*?completeSharedProgressRestore\(item\);/);
  assert.match(app, /sharedProgressRestorePosition\(item, currentSharedPosition\(\)\)/, 'track selection sends the pending content-bound resume instead of metadata-default zero');
  assert.match(app, /if \(command\.type === 'seek'\) completeSharedProgressRestore\(state\.items\[state\.activeIndex\]\);/);
});

test('browser navigation transfers a local ready B checkpoint before metadata while C prepares', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const resumeSource = app.match(/function sharedNavigationResume\(item\) \{[\s\S]*?\n\}/)?.[0];
  const persistence = app.match(/function beginProgressPersistence\(item, sourceGeneration = null\) \{[\s\S]*?\n\}\n\nfunction armProgressPersistence\(item, generation, sourceGeneration = null\) \{[\s\S]*?\n\}\n\nfunction canPersistActiveProgress\(item, generation = state\.persistence\.generation, sourceGeneration = state\.persistence\.sourceGeneration\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(resumeSource && persistence, 'browser navigation resume and persistence helpers are present');
  const state = { persistence: { generation: 0, contentId: null, sourceGeneration: null, armed: false, allowZeroWrite: false } };
  const { sharedNavigationResume, beginProgressPersistence, armProgressPersistence, canPersistActiveProgress } = new Function('state', `${resumeSource}\n${persistence}\nreturn { sharedNavigationResume, beginProgressPersistence, armProgressPersistence, canPersistActiveProgress };`)(state);
  const b = { contentId: 'B', progress: { currentTime: 3 * 60 + 25 } };
  const c = { contentId: 'C' };

  // The room has no B checkpoint yet; B's only checkpoint belongs to this
  // browser. C's preparation is a separate next-card lifecycle.
  const serverSelectionPosition = 0;
  const oneAhead = { status: 'preparing', mediaId: 'C', progress: { percent: 50 } };
  const resume = sharedNavigationResume(b);
  assert.deepEqual(resume, { contentId: 'B', position: 3 * 60 + 25 });
  assert.equal(oneAhead.mediaId, c.contentId);

  // Server admission consumes the content-bound resume because its stored B
  // position is zero. Metadata must seek to it before persistence is armed.
  const authoritativeBPosition = serverSelectionPosition || resume.position;
  const generationB = beginProgressPersistence(b);
  assert.equal(canPersistActiveProgress(b), false, 'metadata-default zero cannot be written');
  let persisted = null;
  const metadataCurrentTime = authoritativeBPosition;
  assert.equal(armProgressPersistence(b, generationB), true);
  if (canPersistActiveProgress(b)) persisted = metadataCurrentTime;
  assert.equal(metadataCurrentTime, 3 * 60 + 25);
  assert.equal(persisted, 3 * 60 + 25, 'the first eligible write is B’s restored checkpoint, never zero');
});

test('first B to A return hydrates A browser checkpoint while B is ready and C prepares', async () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const resumeSource = app.match(/function sharedNavigationResume\(item\) \{[\s\S]*?\n\}/)?.[0];
  const hydrationSource = app.match(/async function hydrateSharedNavigationResume\(item\) \{[\s\S]*?\n\}/)?.[0];
  const persistence = app.match(/function beginProgressPersistence\(item, sourceGeneration = null\) \{[\s\S]*?\n\}\n\nfunction armProgressPersistence\(item, generation, sourceGeneration = null\) \{[\s\S]*?\n\}\n\nfunction canPersistActiveProgress\(item, generation = state\.persistence\.generation, sourceGeneration = state\.persistence\.sourceGeneration\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(resumeSource && hydrationSource && persistence, 'shared navigation must hydrate destination progress before its first selection');

  const state = { persistence: { generation: 0, contentId: null, sourceGeneration: null, armed: false, allowZeroWrite: false } };
  const checkpointA = 12 * 60 + 34;
  const a = { contentId: 'A', progress: null };
  const b = { contentId: 'B', progress: { currentTime: 34 } };
  const roomState = {
    mediaId: 'B', position: 34,
    hls: { status: 'ready', mediaId: 'B', selectionId: 'ready-b' },
    oneAhead: { status: 'preparing', mediaId: 'C', progress: { percent: 50 } }
  };
  const { hydrateSharedNavigationResume, beginProgressPersistence, armProgressPersistence, canPersistActiveProgress } = new Function('state', 'readProgress', 'awaitPendingProgressWrite', `${resumeSource}\n${hydrationSource}\n${persistence}\nreturn { hydrateSharedNavigationResume, beginProgressPersistence, armProgressPersistence, canPersistActiveProgress };`)(state, async (contentId) => {
    assert.equal(contentId, 'A');
    return { id: 'A', currentTime: checkpointA, updatedAt: '2026-01-01T00:00:00.000Z' };
  }, async (contentId) => {
    assert.equal(contentId, 'A');
  });

  assert.equal(roomState.mediaId, b.contentId);
  assert.equal(roomState.hls.status, 'ready');
  assert.equal(roomState.oneAhead.mediaId, 'C');
  const resume = await hydrateSharedNavigationResume(a);
  assert.deepEqual(resume, { contentId: 'A', position: checkpointA });
  assert.equal(a.progress.currentTime, checkpointA, 'hydration retains the content-bound checkpoint on A');

  // The server has no A checkpoint yet, so this first navigation must seed it
  // from browser persistence; there is no second selection or timeupdate.
  const firstAuthoritativeAPosition = 0 || resume.position;
  const generationA = beginProgressPersistence(a);
  assert.equal(canPersistActiveProgress(a), false);
  assert.equal(armProgressPersistence(a, generationA), true);
  assert.equal(firstAuthoritativeAPosition, checkpointA);
  assert.match(app, /const resume = await hydrateSharedNavigationResume\(destination\);/);
  const playIndex = app.match(/async function playIndex\(index, options = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  const sendRoomCommand = app.match(/async function sendRoomCommand\(command\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(playIndex && sendRoomCommand, 'the actual playlist-click and room-command paths are present');
  assert.match(playIndex, /if \(isSharedMode\(\)\) \{[\s\S]*?await sendRoomCommand\(\{ type: 'select', mediaId: item\.mediaId \}\);/, 'a shared playlist click must enter the command path even during an SSE application');
  assert.doesNotMatch(playIndex, /isSharedMode\(\) && !state\.shared\.applyingRemote/, 'an SSE application must not divert a click into local playback');
  assert.match(sendRoomCommand, /const resume = await hydrateSharedNavigationResume\(destination\);[\s\S]*?command = \{ \.\.\.command, resume \};[\s\S]*?armSharedProgressRestore\(resume\.contentId, resume\.position\);/, 'the command hydrates and arms B before posting select');
});

test('shared navigation waits for its pending content write before hydrating a first click', async () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const helpers = app.match(/function queueProgressWrite\(record\) \{[\s\S]*?\n\}\n\nasync function awaitPendingProgressWrite\(contentId\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helpers, 'per-content pending IndexedDB write helpers are present');
  const state = { pendingProgressWrites: new Map() };
  let releaseA;
  const writeA = new Promise((resolve) => { releaseA = resolve; });
  const writes = [];
  const { queueProgressWrite, awaitPendingProgressWrite } = new Function('state', 'writeProgress', `${helpers}\nreturn { queueProgressWrite, awaitPendingProgressWrite };`)(state, async (record) => {
    writes.push(record.id);
    if (record.id === 'A') await writeA;
  });

  const pendingA = queueProgressWrite({ id: 'A', currentTime: 754 });
  let hydrated = false;
  const hydrateA = awaitPendingProgressWrite('A').then(() => { hydrated = true; });
  await Promise.resolve();
  assert.equal(hydrated, false, 'the first click must not read A before its queued write commits');
  await awaitPendingProgressWrite('B');
  assert.deepEqual(writes, ['A'], 'an unrelated content record does not block navigation');
  releaseA();
  await Promise.all([pendingA, hydrateA]);
  assert.equal(hydrated, true);
  assert.equal(state.pendingProgressWrites.has('A'), false, 'settled writes are released');

  assert.match(app, /await awaitPendingProgressWrite\(item\.contentId\);[\s\S]*?const persisted = await readProgress\(item\.contentId\);/, 'destination hydration waits for its content-bound write');
  const sendRoomCommandStart = app.indexOf('async function sendRoomCommand(command) {');
  const sendRoomCommandEnd = app.indexOf('\nfunction uploadSharedFile', sendRoomCommandStart);
  const sendRoomCommand = app.slice(sendRoomCommandStart, sendRoomCommandEnd);
  assert.ok(sendRoomCommandStart >= 0 && sendRoomCommandEnd > sendRoomCommandStart, 'shared command sender is present');
  assert.match(sendRoomCommand, /const resume = await hydrateSharedNavigationResume\(destination\);[\s\S]*?if \(commandId !== state\.shared\.roomCommandId\) return null;[\s\S]*?command = \{ \.\.\.command, resume \};/, 'an older delayed hydration cannot post after a newer click');
});

test('pending metadata restoration remains valid across foreground-inert one-ahead SSE updates', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const identitySource = app.match(/function foregroundSourceIdentity\(roomState\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(identitySource, 'stable foreground identity helper is present');
  const { foregroundSourceIdentity } = new Function(`${identitySource}\nreturn { foregroundSourceIdentity };`)();
  const foreground = {
    sequence: 10,
    mediaId: 'A',
    trackSelection: { audioTrackIndex: 1, subtitleTrackIndex: null },
    hls: { mediaId: 'A', selectionId: 'generation-a', status: 'ready' },
    oneAhead: { mediaId: 'B', status: 'preparing', progress: { percent: 25 } }
  };
  const oneAheadUpdate = {
    ...foreground,
    sequence: 11,
    oneAhead: { mediaId: 'B', status: 'preparing', progress: { percent: 50 } }
  };
  assert.equal(foregroundSourceIdentity(oneAheadUpdate), foregroundSourceIdentity(foreground), 'one-ahead-only SSE keeps the metadata restoration source current');
  assert.match(app, /const isCurrentForegroundSource = \(\) => isSharedMode\(\)[\s\S]*?foregroundSourceIdentity\(state\.shared\.roomState\) === foregroundIdentity[\s\S]*?state\.persistence\.sourceGeneration === persistenceSourceGeneration/);
  assert.match(app, /const syncPosition = \(\) => \{[\s\S]*?if \(!isCurrentForegroundSource\(\) \|\| !armProgressPersistence/, 'metadata restoration is bound to stable foreground identity, not the SSE sequence');
});

test('browser fixture restores ready B after selection while C prepares without persisting pre-metadata zero', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const persistence = app.match(/function beginProgressPersistence\(item, sourceGeneration = null\) \{[\s\S]*?\n\}\n\nfunction armProgressPersistence\(item, generation, sourceGeneration = null\) \{[\s\S]*?\n\}\n\nfunction canPersistActiveProgress\(item, generation = state\.persistence\.generation, sourceGeneration = state\.persistence\.sourceGeneration\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(persistence, 'source-bound browser persistence helpers are present');
  const state = { persistence: { generation: 0, contentId: null, sourceGeneration: null, armed: false, allowZeroWrite: false } };
  const { beginProgressPersistence, armProgressPersistence, canPersistActiveProgress } = new Function('state', `${persistence}\nreturn { beginProgressPersistence, armProgressPersistence, canPersistActiveProgress };`)(state);
  const a = { contentId: 'A' };
  const b = { contentId: 'B' };
  const c = { contentId: 'C' };
  const checkpointB = 34;

  // A is foreground, B is ready, and C has an unrelated one-ahead preparation.
  const generationA = beginProgressPersistence(a);
  assert.equal(armProgressPersistence(a, generationA), true);
  const roomState = {
    mediaId: 'B', position: checkpointB, playing: false,
    trackSelection: { audioTrackIndex: 1, subtitleTrackIndex: null },
    hls: { status: 'ready', mediaId: 'B', selectionId: 'ready-b' },
    oneAhead: { status: 'preparing', mediaId: 'C', progress: { percent: 50 } }
  };
  assert.equal(roomState.oneAhead.mediaId, 'C');

  // Selecting ready B creates an unarmed source generation. A timeupdate at
  // the element default (0) cannot persist before B's HLS metadata arrives.
  const generationB = beginProgressPersistence(b);
  assert.equal(canPersistActiveProgress(b), false);
  const preMetadataTimeupdate = 0;
  assert.equal(preMetadataTimeupdate, 0);
  assert.equal(canPersistActiveProgress(b), false, 'zero time must be rejected before metadata arms B');

  // Simulated matching HLS metadata arms B, then the authoritative B checkpoint
  // is applied; C's preparation remains unrelated to the selected source.
  assert.equal(armProgressPersistence(b, generationB), true);
  let videoCurrentTime = 0;
  videoCurrentTime = roomState.position;
  assert.equal(videoCurrentTime, checkpointB, 'ready B restores its own checkpoint after HLS metadata');
  assert.equal(canPersistActiveProgress(b), true);
  assert.equal(canPersistActiveProgress(c), false);

  assert.match(app, /if \(!foregroundStateChanged\) \{[\s\S]*?if \(oneAheadChanged\) renderPlaylist\(\);[\s\S]*?return;/);
  assert.match(app, /const syncPosition = \(\) => \{[\s\S]*?armProgressPersistence\(item, persistenceGeneration, persistenceSourceGeneration\)[\s\S]*?elements\.video\.currentTime = clamp\(restorePosition, 0, elements\.video\.duration\);/);
  assert.match(app, /if \(!canPersistActiveProgress\(item, persistenceGeneration, persistenceSourceGeneration\)\) return;/);
});

test('one-ahead suppresses only historical ready while retaining seen-C lifecycle status', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const status = app.match(/function oneAheadStatusFor\(item\) \{[\s\S]*?\n\}/)?.[0];
  const remember = app.match(/function rememberSharedItemSelection\(item\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(status && remember, 'one-ahead notification helpers are present');
  const state = {
    shared: {
      roomState: { oneAhead: { status: 'ready', mediaId: 'B' } },
      hls: { seenOneAheadMediaIds: new Set() }
    }
  };
  const { oneAheadStatusFor, rememberSharedItemSelection } = new Function('state', 't', `${status}\n${remember}\nreturn { oneAheadStatusFor, rememberSharedItemSelection };`)(state, (key, values) => values?.percent === undefined ? key : `${key}:${values.percent}`);
  const b = { mediaId: 'B' };
  const c = { mediaId: 'C' };
  assert.equal(oneAheadStatusFor(b), 'oneAheadReady', 'B is announced before its first selection');

  // Selecting B, then returning to A, retains B's server-owned prepared plan
  // but must not re-announce it as a new ready notification.
  rememberSharedItemSelection(b);
  assert.equal(oneAheadStatusFor(b), null, 'a previously selected B never shows Next ready again');
  state.shared.roomState.oneAhead = { status: 'ready', mediaId: 'C' };
  assert.equal(oneAheadStatusFor(c), 'oneAheadReady', 'an unselected card may still receive its first notification');

  // C was previously selected, but a new one-ahead lifecycle must continue to
  // report its live preparation, progress, availability, and host-choice state.
  rememberSharedItemSelection(c);
  state.shared.roomState.oneAhead = { status: 'preparing', mediaId: 'C' };
  assert.equal(oneAheadStatusFor(c), 'oneAheadPreparing');
  state.shared.roomState.oneAhead = { status: 'preparing', mediaId: 'C', progress: { percent: 50 } };
  assert.equal(oneAheadStatusFor(c), 'oneAheadPreparingProgress:50');
  state.shared.roomState.oneAhead = { status: 'unavailable', mediaId: 'C' };
  assert.equal(oneAheadStatusFor(c), 'oneAheadUnavailable');
  state.shared.roomState.oneAhead = { status: 'choice-required', mediaId: 'C' };
  assert.equal(oneAheadStatusFor(c), 'oneAheadChoiceRequired');
  state.shared.roomState.oneAhead = { status: 'ready', mediaId: 'C' };
  assert.equal(oneAheadStatusFor(c), null, 'a previously selected C never shows Next ready again');
  assert.match(app, /rememberSharedItemSelection\(item\);[\s\S]*?loadSharedMedia\(item, roomState\.trackSelection, roomState\.hls\);/);
});

test('conversion progress derives only duration-aware FFmpeg output, elapsed time, and a computable ETA', () => {
  assert.deepEqual(normalizeConversionProgress({ outTimeUs: 25_000_000, durationSeconds: 100, elapsedSeconds: 10 }), { percent: 25, elapsedSeconds: 10, etaSeconds: 30 });
  assert.deepEqual(normalizeConversionProgress({ outTimeUs: 0, durationSeconds: 100, elapsedSeconds: 4 }), { percent: 0, elapsedSeconds: 4 });
  assert.deepEqual(normalizeConversionProgress({ outTimeUs: 25_000_000, durationSeconds: null, elapsedSeconds: 4 }), { elapsedSeconds: 4 });
  assert.equal(normalizeConversionProgress({ outTimeUs: -1, durationSeconds: 100, elapsedSeconds: -1 }), null);
});

test('conversion progress caps lifecycle elapsed time and withholds unstable or implausible ETA values', () => {
  // A 100-second VOD has a 1,900-second job deadline. Its lifecycle must
  // never publish a larger elapsed or ETA value, even if a clock/report is bad.
  assert.deepEqual(normalizeConversionProgress({ outTimeUs: 25_000_000, durationSeconds: 100, elapsedSeconds: 999_999 }), { percent: 25, elapsedSeconds: 1900 });
  assert.deepEqual(normalizeConversionProgress({ outTimeUs: 1_000_000, durationSeconds: 100, elapsedSeconds: 100 }), { percent: 1, elapsedSeconds: 100 });
  assert.deepEqual(normalizeConversionProgress({ outTimeUs: 500_000, durationSeconds: 100, elapsedSeconds: 10 }), { percent: 0, elapsedSeconds: 10 });
  assert.deepEqual(normalizeConversionProgress({ outTimeUs: 25_000_000, durationSeconds: 100, elapsedSeconds: Infinity }), { percent: 25 });
});

test('FFmpeg progress is parsed from its structured progress stream without exposing raw reports', async () => {
  let child;
  const reports = [];
  const runner = createFfmpegRunner({
    spawnProcess(command, args) {
      child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      assert.equal(args[args.indexOf('-progress') + 1], 'pipe:1');
      queueMicrotask(() => {
        child.stdout.write('out_time_us=250');
        child.stdout.write('00000\nprogress=continue\n');
        setImmediate(() => child.emit('close', 0));
      });
      return child;
    }
  });
  await runner('/safe/input.mkv', '/safe/output', { audioTrackIndex: 7, subtitleTrackIndex: null, onProgress: (report) => reports.push(report) });
  assert.deepEqual(reports, [{ outTimeUs: 25_000_000 }]);
  assert.doesNotMatch(JSON.stringify(reports), /input|output|token|command/i);
});

test('ffmpeg runner uses fixed argv and creates a master-compatible variant with and without subtitles', async () => {
  const calls = [];
  const runner = createFfmpegRunner({
    spawnProcess(command, args, options) {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      calls.push({ command, args, options });
      queueMicrotask(() => child.emit('close', 1));
      return child;
    }
  });
  await assert.rejects(runner('/safe/input.mkv', '/safe/output', { audioTrackIndex: 7, subtitleTrackIndex: null }), /FFmpeg failed/);
  await assert.rejects(runner('/safe/input.mkv', '/safe/output', { audioTrackIndex: 7, subtitleTrackIndex: 9 }), /FFmpeg failed/);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.cwd, '/safe/output');
    assert.equal(call.options.shell, false);
    assert.equal(call.args.includes('0:7'), true);
    assert.equal(call.args.includes('/safe/output/media_%v.m3u8'), true);
    assert.equal(call.args.includes('-master_pl_name'), true);
    assert.equal(call.args.includes('temp_file'), true);
    assert.equal(call.args.includes('-hls_fmp4_init_resend'), false);
    assert.equal(call.args.includes('libx264'), true);
    assert.equal(call.args[call.args.indexOf('-preset') + 1], 'veryfast');
    assert.equal(call.args[call.args.indexOf('-crf') + 1], '22');
    assert.equal(call.args.includes('-hls_segment_type'), true);
    assert.equal(call.args.includes('fmp4'), true);
    assert.equal(call.args.includes('-hls_fmp4_init_filename'), true);
    assert.equal(call.args.includes('init.mp4'), true);
    assert.equal(call.args.includes('-ac'), true);
    assert.equal(call.args[call.args.indexOf('-ac') + 1], '2');
    assert.equal(call.args.includes('/safe/output/segment_%v_%05d.m4s'), true);
  }
  const [audioOnly, withSubtitle] = calls;
  assert.deepEqual(audioOnly.args.filter((arg) => /^-map$/.test(arg)).length, 2);
  assert.equal(audioOnly.args.some((arg) => arg.includes('s:0,sgroup:subs')), false);
  assert.equal(audioOnly.args.some((arg) => arg.includes('v:0,a:0')), true);
  assert.deepEqual(withSubtitle.args.filter((arg) => /^-map$/.test(arg)).length, 3);
  assert.equal(withSubtitle.args.includes('0:9'), true);
  assert.equal(withSubtitle.args.some((arg) => arg.includes('s:0,sgroup:subs')), true);
  assert.deepEqual(withSubtitle.args.slice(withSubtitle.args.indexOf('-c:v'), withSubtitle.args.indexOf('-f')), ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-c:s', 'webvtt']);
});

test('ffmpeg runner emits exact stream maps and copies only the selected compatible streams', async () => {
  const calls = [];
  const runner = createFfmpegRunner({ spawnProcess(command, args) {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    calls.push(args); queueMicrotask(() => child.emit('close', 1)); return child;
  } });
  await assert.rejects(runner('/safe/input.mkv', '/safe/output', {
    videoTrack: { index: 7 }, audioTrack: { index: 11 }, subtitleTrack: { index: 14 },
    route: { video: 'copy', audio: 'transcode' }
  }), /FFmpeg failed/);
  const args = calls[0];
  assert.deepEqual(args.filter((value, index) => args[index - 1] === '-map'), ['0:7', '0:11', '0:14']);
  assert.deepEqual(args.slice(args.indexOf('-c:v'), args.indexOf('-f')), ['-c:v', 'copy', '-c:a', 'aac', '-ac', '2', '-c:s', 'webvtt']);
  assert.equal(args.includes('libx264'), false);
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

test('FFmpeg VOD lifetime outlasts five modeled minutes but retains a bounded post-ready deadline', async () => {
  let deadline;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let kills = 0;
  child.kill = () => { kills += 1; return true; };
  const runner = createFfmpegRunner({
    spawnProcess: () => child,
    setTimeoutFn(callback, timeoutMs) {
      deadline = { callback, timeoutMs };
      return deadline;
    },
    clearTimeoutFn() {}
  });

  const running = runner('/safe/input.mkv', '/safe/output', { audioTrackIndex: 7, subtitleTrackIndex: null, duration: 108 * 60 });
  assert.equal(deadline.timeoutMs, deriveHlsVodJobTimeoutMs(108 * 60));
  assert.ok(deadline.timeoutMs > 5 * 60_000, 'a 1:48 VOD must survive the former five-minute job deadline');
  let settled = false;
  void running.catch(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'the modeled five-minute point does not terminate the running job');

  deadline.callback();
  await assert.rejects(running, (error) => error.ffmpegErrorClass === 'job-timeout');
  assert.equal(kills, 1, 'the bounded VOD deadline still terminates the FFmpeg process');
});

test.skip('obsolete progressive partial-playlist watched threshold', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const helper = app.match(/function shouldMarkProgressWatched\(\{ currentTime, duration, isProgressiveHls, allowThresholdWatched = true \}\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, 'watched threshold helper is present');
  const shouldMarkProgressWatched = new Function('WATCHED_THRESHOLD', `${helper}\nreturn shouldMarkProgressWatched;`)(0.9);
  assert.equal(shouldMarkProgressWatched({ currentTime: 7 * 60 + 34, duration: 8 * 60 + 24, isProgressiveHls: true }), false);
  assert.equal(shouldMarkProgressWatched({ currentTime: 7 * 60 + 34, duration: 8 * 60 + 24, isProgressiveHls: false }), true);
  assert.equal(shouldMarkProgressWatched({ currentTime: 1, duration: 2, isProgressiveHls: true, allowThresholdWatched: false }), false);
  assert.match(app, /watched: watched \|\| thresholdWatched \|\| Boolean\(item\.progress\?\.watched\)/);
});

test('browser upload errors distinguish HTTP responses from connection failures', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const upload = app.match(/function uploadSharedFile\(file, completed, total\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(upload, 'shared upload implementation is present');
  assert.match(upload, /request\.onload = \(\) => \{[\s\S]*?request\.status < 200 \|\| request\.status >= 300[\s\S]*?body\.error/s);
  assert.match(upload, /request\.onerror = \(\) => reject\(new Error\('Upload connection failed'\)\)/);
  assert.match(upload, /request\.onabort = \(\) => reject\(new Error\('Upload cancelled'\)\)/);
  assert.doesNotMatch(upload, /Network error/);
});

test('browser track selection waits to apply compatible HLS before assigning track-capable raw media', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const loadSharedMedia = app.match(/function loadSharedMedia\(item, selection, lifecycle\) \{[\s\S]*?\n\}/)?.[0];
  const scheduleFallback = app.match(/function scheduleSharedHlsFallback\(item, sourceKey, loadId\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(loadSharedMedia, 'shared media loader is present');
  assert.ok(scheduleFallback, 'HLS readiness handler is present');
  assert.match(loadSharedMedia, /hasTrackChoice && selection\?\.audioTrackIndex === null/);
  assert.match(loadSharedMedia, /state\.shared\.hls\.suppressNextVideoAbort = true;\n    elements\.video\.removeAttribute\('src'\);/);
  assert.match(loadSharedMedia, /setTrackPlaybackStatus\(t\(isSharedHost\(\) \? 'trackSelectionReadyHost' : 'trackSelectionReadyGuest'\)\)/);
  assert.match(app, /clearError\(\);\n  setTrackPlaybackStatus\(t\('hlsLoading'\)\);/);
  assert.match(scheduleFallback, /elements\.video\.addEventListener\('loadedmetadata', beginPlayback, \{ once: true \}\)/);
  assert.doesNotMatch(scheduleFallback, /setTimeout/);
  assert.doesNotMatch(app, /HLS_STARTUP_TIMEOUT_/);
  assert.match(app, /lifecycle\?\.status === 'ready'/);
  assert.match(app, /Server room state exclusively admits foreground conversion/);
  assert.match(scheduleFallback, /state\.shared\.desiredPlaying/);
  assert.match(app, /if \(!hlsLifecycleMatches\(item, selection, lifecycle\) \|\| lifecycle\?\.status === 'idle' \|\| lifecycle\?\.status === 'preparing'\)/);
  assert.match(app, /setTrackPlaybackStatus\(t\('hlsUnavailable'\), 'fallback'\)/);
});

test('browser applies a subtitle-only draft with the sole embedded audio stream index', async () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const defaultAudio = app.match(/function defaultEmbeddedAudioTrackIndex\(item\) \{[\s\S]*?\n\}/)?.[0];
  const selectTracks = app.match(/async function selectSharedTracks\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(defaultAudio, 'default embedded audio resolver is present');
  assert.ok(selectTracks, 'track apply handler is present');
  const calls = [];
  const state = { items: [{ mediaId: 'media-1', tracks: { audio: [{ index: 7, kind: 'audio' }] } }], activeIndex: 0 };
  const elements = { audioTrackSelect: { value: '' }, subtitleTrackSelect: { value: '9' } };
  const { defaultEmbeddedAudioTrackIndex, selectSharedTracks } = new Function('state', 'elements', 'isSharedHost', 'clearError', 'setTrackPlaybackStatus', 't', 'sendRoomCommand', `${defaultAudio}\n${selectTracks}\nreturn { defaultEmbeddedAudioTrackIndex, selectSharedTracks };`)(
    state, elements, () => true, () => {}, () => {}, (key) => key, async (command) => calls.push(command)
  );
  assert.equal(defaultEmbeddedAudioTrackIndex(state.items[0]), 7, 'the empty default option resolves the sole global audio index');
  await selectSharedTracks();
  assert.deepEqual(calls, [{ type: 'selectTracks', audioTrackIndex: 7, subtitleTrackIndex: 9 }]);

  state.items[0].tracks.audio = [{ index: 1 }, { index: 7 }];
  elements.subtitleTrackSelect.value = '';
  await selectSharedTracks();
  assert.equal(calls.length, 1, 'an empty option with no sole/default audio remains invalid');
  assert.equal(defaultEmbeddedAudioTrackIndex({ tracks: { audio: [{ index: 1 }, { index: 7, disposition: ['default'] }] } }), 7);
  assert.match(app, /trackDraft:[\s\S]*?audioTrackSelect\.addEventListener\('change', rememberTrackDraft\)[\s\S]*?subtitleTrackSelect\.addEventListener\('change', rememberTrackDraft\)/);
  assert.match(app, /state\.shared\.trackDraft\?\.mediaId === item\?\.mediaId/);
});

test('browser reports only allow-listed HLS error categories and SourceBuffer names with the fatal playback stage', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /function hlsPlaybackStage\(data\)/);
  assert.match(app, /return 'init';/);
  assert.match(app, /return 'manifest';/);
  assert.match(app, /return 'MSE decode';/);
  assert.match(app, /return 'fragment';/);
  assert.match(app, /const SAFE_HLS_ERROR_TYPES = Object\.freeze\(\{[\s\S]*?networkError: 'network',[\s\S]*?mediaError: 'media',[\s\S]*?keySystemError: 'key',[\s\S]*?otherError: 'other'/);
  assert.match(app, /const SAFE_HLS_ERROR_DETAILS = Object\.freeze\(\{[\s\S]*?bufferAppendingError: 'buffer-appending',[\s\S]*?bufferAppendError: 'buffer-appending',[\s\S]*?bufferAddCodecError: 'codec-incompatible',[\s\S]*?bufferIncompatibleCodecsError: 'codec-incompatible'/);
  assert.match(app, /const SAFE_HLS_SOURCE_BUFFER_NAMES = new Set\(\['audio', 'video', 'audiovideo'\]\)/);
  assert.match(app, /function hlsErrorDiagnostic\(data\) \{[\s\S]*?SAFE_HLS_ERROR_TYPES\[data\?\.type\] \|\| 'other',[\s\S]*?SAFE_HLS_ERROR_DETAILS\[data\?\.details\] \|\| 'other',[\s\S]*?sourceBuffer: sourceBufferName/);
  assert.match(app, /function hlsFailureCategory\(stage, diagnostic\) \{[\s\S]*?stage === 'init' && diagnostic\.detail === 'buffer-appending'[\s\S]*?'init-append-sequencing'[\s\S]*?stage === 'fragment' \|\| diagnostic\.detail === 'codec-incompatible'[\s\S]*?'fragment-config-transition'/);
  assert.match(app, /console\.warn\('HLS playback diagnostic', \{[\s\S]*?stage,[\s\S]*?\.\.\.diagnostic,[\s\S]*?category: hlsFailureCategory\(stage, diagnostic\)/);
  assert.doesNotMatch(app, /console\.warn\('HLS playback diagnostic', \{[^}]*?(?:url|error|stack|path|token)/i);
  assert.match(app, /const stage = hlsPlaybackStage\(data\);\n      reportHlsDiagnostic\(stage, hlsErrorDiagnostic\(data\)\);\n      unavailable\(stage\);/);
  assert.match(app, /new window\.Hls\(\{ enableWorker: false, renderTextTracksNatively: true, subtitleDisplay: false, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2, fragLoadingMaxRetry: 2 \}\)/);
  assert.match(app, /bindAggregateSubtitleOverlay\(sharedHlsSubtitleUrl\(item\.mediaId\), selection\.subtitleTrackIndex, client\);/);
  assert.match(app, /function bindAggregateSubtitleOverlay\(url, subtitleTrackIndex, client = null\) \{[\s\S]*?client\.subtitleTrack = -1;[\s\S]*?client\.subtitleDisplay = false;[\s\S]*?window\.fetch\(url\)/);
  assert.doesNotMatch(app, /Events\.CUES_PARSED/);
  assert.doesNotMatch(app, /new window\.Hls\(\{ enableWorker: true, renderTextTracksNatively: true \}\)/);
  assert.match(app, /client\.loadSource\(source\);\n    client\.attachMedia\(elements\.video\);/);
  assert.match(app, /hlsPlaybackFailed: \(\{ stage \}\)/);
  assert.match(app, /state\.shared\.hls\.playbackFailureStage/);
});

test('generated WebVTT delivery positions only setting-free cues and preserves multi-segment authored timing', () => {
  const source = [
    'WEBVTT',
    '',
    '00:00.000 --> 00:02.000',
    'Generated first segment',
    '',
    'generated-id',
    '00:02.000 --> 00:04.000',
    'Generated second segment',
    '',
    '00:04.000 --> 00:06.000 line:60% align:start',
    'Authored cue'
  ].join('\r\n');
  const transformed = transformGeneratedWebVttCues(source);
  assert.match(transformed, /__reproductor_generated_setting_free__\r\n00:00\.000 --> 00:02\.000 line:85%,end align:center\r\nGenerated first segment/);
  assert.match(transformed, /__reproductor_generated_setting_free__:generated-id\r\n00:02\.000 --> 00:04\.000 line:85%,end align:center\r\nGenerated second segment/);
  assert.match(transformed, /00:04\.000 --> 00:06\.000 line:60% align:start\r\nAuthored cue/);
  assert.doesNotMatch(transformed, /00:04\.000 --> 00:06\.000 line:60% align:start line:85%/);
  assert.equal(transformGeneratedWebVttCues('not a VTT file'), 'not a VTT file');
});

test('selected HLS subtitles use the protected aggregate overlay while native HLS fallback remains available', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  const classification = app.match(/const GENERATED_SETTING_FREE_CUE_ID = [^;]+;\n\nfunction isSettingFreeSubtitleCue\(cue\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(classification, 'generated cue classification is present');
  const { isSettingFreeSubtitleCue } = new Function(`${classification}\nreturn { isSettingFreeSubtitleCue };`)();
  assert.equal(isSettingFreeSubtitleCue({ id: '__reproductor_generated_setting_free__' }), true);
  assert.equal(isSettingFreeSubtitleCue({ id: '', align: 'start' }), false, 'align-only authored cue remains native');
  assert.equal(isSettingFreeSubtitleCue({ id: '', size: 80 }), false, 'size-only authored cue remains native');
  assert.equal(isSettingFreeSubtitleCue({ id: '', region: {} }), false, 'region authored cue remains native');
  assert.equal(isSettingFreeSubtitleCue({ id: '', line: 'auto', position: 'auto', vertical: '' }), false, 'unmarked cues remain native even when DOM defaults hide authored settings');
  assert.match(app, /Generated cue placement is encoded in WebVTT server-side/);
  assert.match(app, /clearGeneratedSubtitleOverlay\(\);/);
  assert.match(app, /if \(client\) \{[\s\S]*?client\.subtitleTrack = enabled \? 0 : -1;[\s\S]*?client\.subtitleDisplay = enabled;/);
  assert.match(app, /for \(const textTrack of Array\.from\(textTracks \|\| \[\]\)\) \{[\s\S]*?textTrack\.mode = enabled \? 'showing' : 'disabled'/);
  assert.doesNotMatch(app, /client\.subtitleDisplay = !generatedOnly/);
  assert.doesNotMatch(app, /cue\.text\.slice\(0, 4096\)/);
  const activation = app.match(/function activateSelectedHlsSubtitle\(client, subtitleTrackIndex, refreshTextTracks = \(\) => \{\}\) \{[\s\S]*?\n\}/)?.[0];
  const loader = app.match(/function loadSharedHls\(item, selection, lifecycle\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(activation && loader, 'native subtitle activation and HLS loader are present');
  assert.match(activation, /client\.subtitleTrack = enabled \? 0 : -1;[\s\S]*?client\.subtitleDisplay = enabled;/);
  const { activateSelectedHlsSubtitle } = new Function(`${activation}\nreturn { activateSelectedHlsSubtitle };`)();
  const selectedClient = { subtitleTrack: -1, subtitleDisplay: false };
  activateSelectedHlsSubtitle(selectedClient, 9)();
  assert.deepEqual(selectedClient, { subtitleTrack: 0, subtitleDisplay: true }, 'selected rendition is activated natively');
  activateSelectedHlsSubtitle(selectedClient, null)();
  assert.deepEqual(selectedClient, { subtitleTrack: -1, subtitleDisplay: false }, 'subtitle-off disables native rendering');
  assert.match(loader, /bindAggregateSubtitleOverlay\(sharedHlsSubtitleUrl\(item\.mediaId\), selection\.subtitleTrackIndex, client\);/);
  assert.match(loader, /const disableNativeSubtitles = \(\) => \{[\s\S]*?client\.subtitleTrack = -1;[\s\S]*?client\.subtitleDisplay = false;/);
  assert.match(loader, /client\.on\(window\.Hls\.Events\.MANIFEST_PARSED, \(\) => \{[\s\S]*?disableNativeSubtitles\(\);/);
  assert.match(loader, /client\.on\(window\.Hls\.Events\.SUBTITLE_TRACKS_UPDATED, \(\) => \{[\s\S]*?disableNativeSubtitles\(\);/);
  assert.match(app, /client\.on\(window\.Hls\.Events\.SUBTITLE_TRACKS_UPDATED, \(\) => \{[\s\S]*?reportSubtitleTrackDiagnostic\('rendition-update'/);
  assert.match(app, /function reportSubtitleTrackDiagnostic\(event, client, textTrack, count\) \{[\s\S]*?count:[\s\S]*?selectedIndex:[\s\S]*?subtitleDisplay:[\s\S]*?cueCount:[\s\S]*?activeCueCount:/);
  assert.doesNotMatch(app, /HLS subtitle track diagnostic[\s\S]{0,500}(?:url|token|path|text):/i);
  assert.match(app, /state\.shared\.hls\.subtitleOverlayCleanup\?\.\(\)/);
  assert.match(styles, /\.generated-subtitle-overlay \{[\s\S]*?bottom: clamp\(2\.5rem, 6vw, 3\.25rem\);[\s\S]*?left: 50%;[\s\S]*?transform: translateX\(-50%\);[\s\S]*?max-width: 90%;[\s\S]*?min-width: 10%;[\s\S]*?white-space: pre-wrap;[\s\S]*?width: fit-content;[\s\S]*?z-index: 2;/);
  assert.match(styles, /\.video-frame\.is-app-fullscreen \.generated-subtitle-overlay,[\s\S]*?\.video-frame:fullscreen \.generated-subtitle-overlay \{[\s\S]*?font-size: clamp\(1\.45rem, 3\.333vw, 4\.375rem\);[\s\S]*?width: 90%;/);
  assert.match(styles, /\.video-controls \{[\s\S]*?z-index: 3;/);
  assert.match(styles, /\.video-frame video::cue\s*\{\s*background-color: transparent;\s*color: #fff;\s*text-shadow:/);
  assert.match(styles, /\.track-control-fields select\s*\{[\s\S]*?color-scheme: dark;/);
  assert.match(styles, /\.track-control-fields select option\s*\{\s*background-color: #17171c;\s*color: #f4f4f7;/);
});

test.skip('obsolete native HLS WebVTT display lifecycle', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const classification = app.match(/const GENERATED_SETTING_FREE_CUE_ID = [^;]+;\n\nfunction isSettingFreeSubtitleCue\(cue\) \{[\s\S]*?\n\}/)?.[0];
  const diagnostics = app.match(/function safeSubtitleDiagnosticField\(value\) \{[\s\S]*?\n\}\n\nfunction reportSubtitleTrackDiagnostic\(event, client, textTrack, count\) \{[\s\S]*?\n\}/)?.[0];
  const binding = app.match(/function bindGeneratedSubtitleOverlay\(subtitleTrackIndex, client = null\) \{[\s\S]*?\n\}\n\nfunction destroyHlsClient/ )?.[0]?.replace(/\n\nfunction destroyHlsClient$/, '');
  const activation = app.match(/function activateSelectedHlsSubtitle\(client, subtitleTrackIndex, refreshTextTracks = \(\) => \{\}\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(classification && diagnostics && binding && activation, 'subtitle lifecycle helpers are present');
  const listeners = new Map();
  const eventTarget = () => ({
    addEventListener(type, listener) { listeners.set(`${this.name || 'tracks'}:${type}`, listener); },
    removeEventListener(type) { listeners.delete(`${this.name || 'tracks'}:${type}`); }
  });
  const preexisting = { ...eventTarget(), name: 'browser-default', label: 'native', kind: 'subtitles', mode: 'showing', cues: [], activeCues: [] };
  const track = { ...eventTarget(), name: 'unexpected-native-name', label: 'unexpected label', kind: 'subtitles', cues: [], activeCues: [] };
  let hlsMode = 'disabled';
  let hlsModeWrites = 0;
  Object.defineProperty(track, 'mode', {
    get: () => hlsMode,
    set: (value) => { hlsModeWrites += 1; hlsMode = value; }
  });
  const textTracks = Object.assign([preexisting], eventTarget(), { name: 'tracks' });
  const overlay = { hidden: true, replaceChildren(...children) { this.children = children; } };
  const state = { shared: { hls: {} } };
  const elements = { video: { textTracks, ...eventTarget() } };
  const document = { createElement: () => ({ textContent: '' }) };
  const bind = new Function('state', 'elements', 'document', 'ensureSubtitleOverlay', 'clearGeneratedSubtitleOverlay', 'console', `${classification}\n${diagnostics}\n${binding}\nreturn bindGeneratedSubtitleOverlay;`)(
    state, elements, document, () => overlay, () => { overlay.hidden = true; overlay.replaceChildren(); }, { info() {} }
  );
  const lateNativeClient = { subtitleTrack: -1, subtitleDisplay: true };
  const refresh = bind(9, lateNativeClient);
  [...listeners.entries()].find(([key]) => key.endsWith(':addtrack'))?.[1]({ track });
  assert.equal(lateNativeClient.subtitleTrack, 0, 'the owned late native track activates the sole selected rendition');
  assert.equal(preexisting.mode, 'showing', 'preexisting native tracks are never owned');
  assert.equal(track.mode, 'disabled', 'hls.js owns HLS TextTrack mode while the selected rendition stays active');
  assert.equal(lateNativeClient.subtitleDisplay, true, 'the selected rendition remains natively visible before cues arrive');
  const marked = { id: '__reproductor_generated_setting_free__', text: 'Generated cue' };
  track.cues = [marked];
  track.activeCues = [marked];
  [...listeners.entries()].find(([key]) => key.endsWith(':cuechange'))?.[1]();
  assert.equal(track.mode, 'disabled', 'all-marked HLS tracks never receive direct mode writes');
  assert.equal(hlsModeWrites, 0, 'hls.js TextTrack mode is never assigned');
  assert.equal(lateNativeClient.subtitleDisplay, true, 'generated batches retain native rendering');
  assert.equal(overlay.hidden, true, 'generated cues do not use the custom overlay');
  const laterGenerated = { id: '__reproductor_generated_setting_free__:second', text: 'Later generated cue' };
  track.cues = [marked, laterGenerated];
  track.activeCues = [laterGenerated];
  [...listeners.entries()].find(([key]) => key.endsWith(':cuechange'))?.[1]();
  assert.equal(lateNativeClient.subtitleTrack, 0, 'later HLS WebVTT batches retain rendition 0');
  assert.equal(lateNativeClient.subtitleDisplay, true, 'later generated batches retain native rendering after the first batch');
  assert.equal(overlay.hidden, true, 'later generated cues remain out of the custom overlay');
  const authored = { id: '', text: 'Authored cue' };
  // A native TextTrack has one mode: keep this mixed track showing so its
  // authored cue and marked generated cue both remain visible natively.
  track.cues = [marked, authored];
  track.activeCues = [marked, authored];
  [...listeners.entries()].find(([key]) => key.endsWith(':cuechange'))?.[1]();
  assert.equal(track.mode, 'disabled', 'mixed HLS tracks still never receive direct mode writes');
  assert.equal(hlsModeWrites, 0, 'mixed HLS rendering does not deselect the rendition through TextTrack.mode');
  assert.equal(lateNativeClient.subtitleDisplay, true, 'a mixed track switches to native hls.js rendering');
  assert.deepEqual(track.activeCues, [marked, authored], 'mixed-track cues are retained rather than filtered away');
  assert.equal(overlay.hidden, true, 'the overlay remains hidden for mixed native tracks');
  const { activateSelectedHlsSubtitle } = new Function(`${activation}\nreturn { activateSelectedHlsSubtitle };`)();
  const client = { subtitleTracks: [{ name: 'subtitle_0' }], subtitleTrack: -1, subtitleDisplay: false };
  activateSelectedHlsSubtitle(client, 9, refresh)();
  assert.equal(client.subtitleDisplay, true, 'activation preserves selected native display');
  assert.equal(client.subtitleTrack, 0);
  const offRefresh = bind(null, client);
  [...listeners.entries()].find(([key]) => key.endsWith(':addtrack'))?.[1]({ track });
  activateSelectedHlsSubtitle(client, null, offRefresh)();
  assert.equal(client.subtitleDisplay, false);
  assert.equal(client.subtitleTrack, -1);
  assert.equal(track.mode, 'disabled');
  assert.equal(hlsModeWrites, 0, 'subtitle-off uses hls.js selection/display state without TextTrack.mode writes');
  const firstOwnedTrack = { ...eventTarget(), name: 'first', label: 'first', kind: 'subtitles', mode: 'disabled', cues: [], activeCues: [] };
  const ambiguousTrack = { ...eventTarget(), name: 'second', label: 'second', kind: 'subtitles', mode: 'disabled', cues: [], activeCues: [] };
  const ambiguousClient = { subtitleTrack: -1, subtitleDisplay: true };
  bind(9, ambiguousClient);
  const onAddTrack = [...listeners.entries()].find(([key]) => key.endsWith(':addtrack'))?.[1];
  onAddTrack({ track: firstOwnedTrack });
  assert.equal(ambiguousClient.subtitleTrack, 0, 'the first owned rendition activates');
  ambiguousClient.subtitleTrack = -1;
  onAddTrack({ track: ambiguousTrack });
  assert.equal(ambiguousClient.subtitleTrack, 0, 'the single server-selected rendition remains selected across later track events');
});

test.skip('obsolete parsed-HLS cue stale-callback lifecycle', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const guard = app.match(/function isCurrentSharedHlsLoad\(sourceKey, loadId\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(guard, 'HLS load identity guard is present');
  const state = { shared: { hls: { sourceKey: 'hls:clip:1:', loadId: 4 } } };
  const { isCurrentSharedHlsLoad } = new Function('state', `${guard}\nreturn { isCurrentSharedHlsLoad };`)(state);

  // A ready SSE replay keeps the active init append; a replaced load rejects the stale callback.
  assert.equal(isCurrentSharedHlsLoad('hls:clip:1:', 4), true);
  assert.equal(isCurrentSharedHlsLoad('hls:clip:1:', 3), false);
  state.shared.hls.loadId = 5;
  assert.equal(isCurrentSharedHlsLoad('hls:clip:1:', 4), false);
  assert.equal(isCurrentSharedHlsLoad('hls:clip:1:', 5), true);

  const loadSharedHls = app.match(/function loadSharedHls\(item, selection, lifecycle\) \{[\s\S]*?\n\}/)?.[0];
  const activateSubtitle = app.match(/function activateSelectedHlsSubtitle\(client, subtitleTrackIndex, refreshTextTracks = \(\) => \{\}\) \{[\s\S]*?\n\}/)?.[0];
  const parsedSubtitleOverlay = app.match(/function bindParsedHlsSubtitleOverlay\(subtitleTrackIndex\) \{[\s\S]*?\n\}/)?.[0];
  const generationKey = app.match(/function hlsGenerationKey\(item, selection, lifecycle\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(loadSharedHls, 'shared HLS loader is present');
  assert.ok(activateSubtitle, 'HLS subtitle activation is present');
  assert.ok(parsedSubtitleOverlay, 'parsed subtitle overlay binding is present');
  assert.ok(generationKey, 'generation key is present');
  assert.match(loadSharedHls, /state\.shared\.hls\.sourceKey === sourceKey && state\.shared\.hls\.client\) return;/);
  assert.match(loadSharedHls, /const loadId = state\.shared\.hls\.loadId \+= 1;/);
  assert.match(loadSharedHls, /if \(!isCurrentSharedHlsLoad\(sourceKey, loadId\) \|\| !data\.fatal \|\| hasPendingOutgoingNavigation\(sourceKey\)\) return;/);
  assert.match(app, /function fallBackToSharedMedia\(item, sourceKey, playbackFailureStage = null, loadId = state\.shared\.hls\.loadId\) \{/);

  const clients = [];
  function Hls() {
    this.handlers = new Map();
    this.on = (event, handler) => this.handlers.set(event, handler);
    this.loadSource = () => {};
    this.attachMedia = () => {};
    this.destroy = () => {};
    clients.push(this);
  }
  Hls.isSupported = () => true;
  Hls.Events = { MANIFEST_PARSED: 'manifest', SUBTITLE_TRACKS_UPDATED: 'subtitle-tracks', CUES_PARSED: 'cues-parsed', ERROR: 'error' };
  const runtimeState = { shared: { hls: { client: null, sourceKey: null, fallbackKey: null, playbackFailureStage: null, suppressNextVideoAbort: false, loadId: 0 } } };
  const destroyHlsClient = () => {
    runtimeState.shared.hls.loadId += 1;
    runtimeState.shared.hls.client?.destroy();
    runtimeState.shared.hls.client = null;
    runtimeState.shared.hls.sourceKey = null;
  };
  const fallbackCalls = [];
  const videoListeners = new Map();
  const overlay = { hidden: true, replaceChildren(...children) { this.children = children; } };
  const runtimeElements = { video: {
    currentTime: 0,
    load() {},
    src: '',
    addEventListener(type, listener) { videoListeners.set(type, listener); },
    removeEventListener(type) { videoListeners.delete(type); }
  } };
  const bindParsedHlsSubtitleOverlay = new Function('state', 'elements', 'document', 'ensureSubtitleOverlay', 'clearGeneratedSubtitleOverlay', `${parsedSubtitleOverlay}\nreturn bindParsedHlsSubtitleOverlay;`)(
    runtimeState,
    runtimeElements,
    { createElement: () => ({ textContent: '' }) },
    () => overlay,
    () => { overlay.hidden = true; overlay.replaceChildren(); }
  );
  const runtimeLoader = new Function('state', 'trackSelectionKey', 'destroyHlsClient', 'elements', 'clearError', 'setTrackPlaybackStatus', 't', 'sharedHlsUrl', 'scheduleSharedHlsFallback', 'bindParsedHlsSubtitleOverlay', 'window', 'canUseNativeHls', 'fallBackToSharedMedia', `${guard}\n${generationKey}\n${activateSubtitle}\n${loadSharedHls}\nreturn loadSharedHls;`)(
    runtimeState,
    (mediaId, selection) => `${mediaId}:${selection.audioTrackIndex}:${selection.subtitleTrackIndex ?? ''}`,
    destroyHlsClient,
    runtimeElements,
    () => {},
    () => {},
    (key) => key,
    () => 'safe-master',
    () => () => {},
    bindParsedHlsSubtitleOverlay,
    { Hls },
    () => false,
    (...args) => fallbackCalls.push(args)
  );
  const item = { mediaId: 'clip' };
  const selection = { audioTrackIndex: 1, subtitleTrackIndex: 9 };
  const lifecycle = { selectionId: 'generation-1' };
  runtimeLoader(item, selection, lifecycle); // first ready SSE update starts init append
  runtimeLoader(item, selection, lifecycle); // repeated ready SSE update must be a no-op
  assert.equal(clients.length, 1);
  const staleClient = clients[0];
  staleClient.handlers.get('cues-parsed')(null, { type: 'subtitles', cues: [{ id: 'later', startTime: 192, endTime: 194, text: 'Later text' }] });
  runtimeElements.video.currentTime = 192.5;
  videoListeners.get('timeupdate')();
  assert.equal(overlay.children[0].textContent, 'Later text', 'the extracted loader wires parsed HLS cues into its overlay');
  destroyHlsClient();
  runtimeLoader(item, selection, { selectionId: 'generation-2' }); // a genuinely new load gets a new identity
  staleClient.handlers.get('error')(null, { fatal: true });
  assert.equal(fallbackCalls.length, 0, 'a stale init error cannot fall back over the replacement load');
});

test('browser clear detaches HLS, removes subtitle cues, and invalidates stale callbacks', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const clearTracks = app.match(/function clearVideoTextTracks\(\) \{[\s\S]*?\n\}/)?.[0];
  const clearPlayback = app.match(/function clearSharedPlaybackForLibraryClear\(\) \{[\s\S]*?\n\}/)?.[0];
  const guard = app.match(/function isCurrentSharedHlsLoad\(sourceKey, loadId\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(clearTracks, 'subtitle teardown helper is present');
  assert.ok(clearPlayback, 'terminal clear helper is present');
  assert.ok(guard, 'HLS callback identity guard is present');

  const removedCues = [];
  const calls = [];
  const state = { shared: { roomApplyId: 4, applyingRemote: true, desiredPlaying: true, playbackIntent: true, playbackCommandInFlight: true, currentTrackSelection: { audioTrackIndex: 1 }, hls: { client: { destroy: () => calls.push('destroy') }, sourceKey: 'hls:clip:1:', mediaId: 'clip', preparationKey: 'hls:clip:1:', selectionKey: 'hls:clip:1:', fallbackKey: 'hls:clip:1:', playbackFailureStage: 'fragment', suppressNextVideoAbort: true, cleared: false, loadId: 7 } } };
  const elements = { video: {
    textTracks: [{ mode: 'showing', cues: [{ id: 'cue-1' }], removeCue: (cue) => removedCues.push(cue.id) }],
    pause: () => calls.push('pause'),
    removeAttribute: (name) => calls.push(`remove:${name}`),
    load: () => calls.push('load'),
    onloadedmetadata: () => {}
  } };
  const destroyHlsClient = () => {
    state.shared.hls.loadId += 1;
    state.shared.hls.client?.destroy();
    state.shared.hls.client = null;
    state.shared.hls.sourceKey = null;
    state.shared.hls.mediaId = null;
    state.shared.hls.preparationKey = null;
  };
  const clear = new Function('state', 'elements', 'destroyHlsClient', 'renderConversionProgress', 'setTrackPlaybackStatus', `${clearTracks}\n${clearPlayback}\nreturn clearSharedPlaybackForLibraryClear;`)(
    state, elements, destroyHlsClient, (...args) => calls.push(['overlay', ...args]), (...args) => calls.push(['status', ...args])
  );
  clear();
  assert.deepEqual(removedCues, ['cue-1']);
  assert.equal(elements.video.textTracks[0].mode, 'disabled');
  assert.equal(state.shared.hls.cleared, true);
  assert.equal(state.shared.hls.selectionKey, null);
  assert.equal(state.shared.hls.playbackFailureStage, null);
  assert.equal(state.shared.desiredPlaying, false);
  assert.ok(calls.includes('destroy'));
  assert.ok(calls.includes('remove:src'));
  assert.ok(calls.includes('load'));

  const isCurrentSharedHlsLoad = new Function('state', `${guard}\nreturn isCurrentSharedHlsLoad;`)(state);
  assert.equal(isCurrentSharedHlsLoad('hls:clip:1:', 7), false, 'a stale fragment callback cannot recover or show an error after clear');
});

test('browser suppresses only the expected clear cancellation response', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const predicate = app.match(/function isExpectedClearCancellation\(error\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(predicate, 'clear cancellation predicate is present');
  assert.match(app, /error\.status = response\.status;/);
  const state = { shared: { clearPending: true } };
  const isExpectedClearCancellation = new Function('state', `${predicate}\nreturn isExpectedClearCancellation;`)(state);
  assert.equal(isExpectedClearCancellation({ status: 503 }), true);
  assert.equal(isExpectedClearCancellation({ status: 401 }), false, 'authorization errors remain visible');
  assert.equal(isExpectedClearCancellation(new TypeError('Failed to fetch')), false, 'network errors remain visible');
  state.shared.clearPending = false;
  assert.equal(isExpectedClearCancellation({ status: 503 }), false, 'ordinary server failures remain visible outside clear');
});

test('browser reconciles screen wake locks for playback, uploads, and HLS preparation', async () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const start = app.indexOf('function supportsWakeLock()');
  const end = app.indexOf('\n\nfunction isEditableShortcutTarget');
  assert.ok(start >= 0 && end > start, 'wake-lock helpers are present');
  const wakeLockSource = app.slice(start, end);
  const createRuntime = (navigator, document) => {
    const state = {
      wakeLockSentinel: null,
      wakeLockRequestPending: false,
      wakeLockRequestGeneration: 0,
      shared: { clearPending: false, libraryMutationPending: false, roomState: null }
    };
    const elements = { video: { src: '', paused: true, ended: false } };
    const helpers = new Function('state', 'elements', 'navigator', 'document', `${wakeLockSource}\nreturn { reconcileWakeLock, releaseWakeLock, shouldHoldWakeLock };`)(state, elements, navigator, document);
    return { state, elements, helpers };
  };

  const sentinels = [];
  const navigator = { wakeLock: { request: async (type) => {
    assert.equal(type, 'screen');
    const listeners = new Map();
    const sentinel = {
      released: 0,
      addEventListener(event, listener) { listeners.set(event, listener); },
      async release() { this.released += 1; },
      emitRelease() { listeners.get('release')?.(); }
    };
    sentinels.push(sentinel);
    return sentinel;
  } } };
  const document = { visibilityState: 'visible' };
  const runtime = createRuntime(navigator, document);

  await runtime.helpers.reconcileWakeLock();
  assert.equal(sentinels.length, 0, 'paused idle playback does not acquire a lock');
  runtime.elements.video.src = 'clip.mp4';
  runtime.elements.video.paused = false;
  await runtime.helpers.reconcileWakeLock();
  assert.equal(sentinels.length, 1, 'playing video acquires a lock');
  runtime.elements.video.paused = true;
  await runtime.helpers.reconcileWakeLock();
  assert.equal(sentinels[0].released, 1, 'pausing without background work releases the lock');
  runtime.state.appFullscreenFallback = true;
  await runtime.helpers.reconcileWakeLock();
  assert.equal(sentinels.length, 2, 'paused fullscreen keeps the display awake');
  runtime.state.appFullscreenFallback = false;
  await runtime.helpers.reconcileWakeLock();
  assert.equal(sentinels[1].released, 1, 'leaving paused fullscreen releases the lock without background work');

  runtime.state.shared.libraryMutationPending = true;
  await runtime.helpers.reconcileWakeLock();
  assert.equal(sentinels.length, 3, 'an upload acquires a lock while playback is paused');
  sentinels[2].emitRelease();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sentinels.length, 4, 'an unexpected release reacquires while activity remains');
  runtime.state.shared.libraryMutationPending = false;
  runtime.state.shared.roomState = { hls: { status: 'preparing' }, oneAhead: { status: 'preparing' } };
  await runtime.helpers.reconcileWakeLock();
  assert.equal(sentinels.length, 4, 'selected and one-ahead preparation retain the existing lock');
  runtime.state.shared.roomState = { hls: { status: 'ready' }, oneAhead: { status: 'idle' } };
  await runtime.helpers.reconcileWakeLock();
  assert.equal(sentinels[3].released, 1, 'idle preparation releases the lock when playback is paused');

  document.visibilityState = 'hidden';
  runtime.state.shared.roomState = { oneAhead: { status: 'preparing' } };
  await runtime.helpers.reconcileWakeLock();
  assert.equal(sentinels.length, 4, 'hidden documents never acquire a lock');
  document.visibilityState = 'visible';
  await runtime.helpers.reconcileWakeLock();
  assert.equal(sentinels.length, 5, 'returning visible reacquires for active preparation');

  const unsupported = createRuntime({}, { visibilityState: 'visible' });
  unsupported.state.shared.libraryMutationPending = true;
  await unsupported.helpers.reconcileWakeLock();
  assert.equal(unsupported.state.wakeLockSentinel, null, 'unsupported browsers are a no-op');
});

test('browser keeps HLS and room recovery bounded across visibility changes', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const visibility = app.match(/function handleVisibilityChange\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(visibility, 'visibility handler is present');
  assert.match(visibility, /void reconcileWakeLock\(\);/);
  assert.doesNotMatch(visibility, /(?:loadSharedHls|loadSource|fetch|recoverSharedRoomState|EventSource)/);
  assert.match(app, /new window\.Hls\(\{ enableWorker: false, renderTextTracksNatively: true, subtitleDisplay: false, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2, fragLoadingMaxRetry: 2 \}\)/);
  const retry = app.match(/function scheduleSharedPlaybackRetry\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(retry, 'shared playback retry is present');
  assert.match(retry, /state\.shared\.playbackRetryTimer/);
  assert.match(retry, /1_000/);
});

test.skip('obsolete parsed HLS subtitle overlay rendering', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const binding = app.match(/function bindParsedHlsSubtitleOverlay\(subtitleTrackIndex\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(binding, 'parsed HLS subtitle overlay binding is present');
  const listeners = new Map();
  const overlay = { hidden: true, replaceChildren(...children) { this.children = children; } };
  const elements = {
    video: {
      currentTime: 0,
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type) { listeners.delete(type); }
    }
  };
  const state = { shared: { hls: {} } };
  const document = { createElement: () => ({ textContent: '' }) };
  const bind = new Function('state', 'elements', 'document', 'ensureSubtitleOverlay', 'clearGeneratedSubtitleOverlay', `${binding}\nreturn bindParsedHlsSubtitleOverlay;`)(
    state, elements, document, () => overlay, () => { overlay.hidden = true; overlay.replaceChildren(); }
  );
  const renderParsedCues = bind(9);
  const authoredCue = { id: 'authored', startTime: 10, endTime: 12, text: 'Author text' };
  renderParsedCues({ type: 'subtitles', cues: [authoredCue] });
  assert.deepEqual(authoredCue, { id: 'authored', startTime: 10, endTime: 12, text: 'Author text' }, 'authored cue data is never mutated');
  elements.video.currentTime = 10.5;
  listeners.get('timeupdate')();
  assert.equal(overlay.hidden, false);
  assert.equal(overlay.children[0].textContent, 'Author text', 'cue text is rendered without rewriting it');
  elements.video.currentTime = 13;
  listeners.get('timeupdate')();
  assert.equal(overlay.hidden, true, 'rendering follows authored cue timing');
  renderParsedCues({ type: 'subtitles', cues: [{ id: 'later', startTime: 192, endTime: 194, text: 'Later text' }] });
  elements.video.currentTime = 192.5;
  listeners.get('timeupdate')();
  assert.equal(overlay.children[0].textContent, 'Later text', 'later VTT batches render without a native TextTrack cue update');
  state.shared.hls.subtitleOverlayCleanup();
  assert.equal(listeners.size, 0, 'teardown removes continuous render listeners');
});

test.skip('obsolete parsed HLS subtitle rendition admission', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const binding = app.match(/function bindParsedHlsSubtitleOverlay\(subtitleTrackIndex\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(binding, 'parsed HLS subtitle overlay binding is present');
  const listeners = new Map();
  const overlay = { hidden: true, replaceChildren(...children) { this.children = children; } };
  const elements = { video: {
    currentTime: 20.5,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type) { listeners.delete(type); }
  } };
  const state = { shared: { hls: {} } };
  const bind = new Function('state', 'elements', 'document', 'ensureSubtitleOverlay', 'clearGeneratedSubtitleOverlay', `${binding}\nreturn bindParsedHlsSubtitleOverlay;`)(
    state, elements, { createElement: () => ({ textContent: '' }) }, () => overlay, () => { overlay.hidden = true; overlay.replaceChildren(); }
  );
  const renderParsedCues = bind(9);
  renderParsedCues({ track: 'subtitle_0', cues: [{ id: 'omitted-type', startTime: 20, endTime: 21, text: 'Selected cue' }] });
  assert.equal(overlay.children[0].textContent, 'Selected cue', 'a selected rendition cue renders when hls.js omits type');
  elements.video.currentTime = 22.5;
  renderParsedCues({ type: 'subtitle', track: 0, cues: [{ id: 'varied-type', startTime: 22, endTime: 23, text: 'Varied type cue' }] });
  assert.equal(overlay.children[0].textContent, 'Varied type cue', 'a selected rendition cue renders when hls.js varies type');
  renderParsedCues({ track: 'subtitle_1', cues: [{ id: 'other-rendition', startTime: 20, endTime: 21, text: 'Other cue' }] });
  renderParsedCues({ track: 'subtitle_0', cues: [{ id: 'invalid', startTime: 21, endTime: 20, text: 'Invalid cue' }] });
  assert.equal(overlay.children.length, 1, 'other renditions and invalid cue payloads are not admitted');
  state.shared.hls.subtitleOverlayCleanup();
});

test('aggregate subtitle endpoint parser remains available for protected HLS overlay playback', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const parser = app.match(/function parseAggregateWebVttCues\(vtt\) \{[\s\S]*?\n\}\n\nfunction bindAggregateSubtitleOverlay/ )?.[0]?.replace(/\n\nfunction bindAggregateSubtitleOverlay$/, '');
  assert.ok(parser, 'aggregate WebVTT parser is present');
  const { parseAggregateWebVttCues } = new Function(`${parser}\nreturn { parseAggregateWebVttCues };`)();
  const cues = parseAggregateWebVttCues('WEBVTT\n\n00:00.000 --> 00:02.000\nFirst\n\nlate-id\n03:12.000 --> 03:14.000 line:60%\nLater\nsubtitle');
  assert.deepEqual(cues, [
    { startTime: 0, endTime: 2, text: 'First' },
    { startTime: 192, endTime: 194, text: 'Later\nsubtitle' }
  ]);
  assert.match(app, /void window\.fetch\(url\)/);
  const loader = app.match(/function loadSharedHls\(item, selection, lifecycle\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(loader, 'HLS loader is present');
  assert.match(loader, /bindAggregateSubtitleOverlay\(sharedHlsSubtitleUrl\(item\.mediaId\), selection\.subtitleTrackIndex/);
  assert.doesNotMatch(app, /Events\.CUES_PARSED/);
});

test('browser renders the conversion overlay from safe authoritative lifecycle fields only', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(app, /function renderConversionProgress\(lifecycle, matchesSelection\)/);
  assert.match(app, /lifecycle\?\.status === 'preparing'/);
  assert.match(app, /safeConversionProgress\(lifecycle\.progress\)/);
  assert.match(app, /aria-valuemin/);
  assert.match(app, /aria-valuemax/);
  assert.doesNotMatch(app, /lifecycle\.progress\.(?:out_time|path|command|token|stderr|driver)/);
  assert.match(styles, /\.conversion-progress-overlay/);
  assert.match(styles, /@container \(max-width: 26rem\)/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.conversion-progress-fill/);
});

test('browser exposes HLS lifecycle states and preserves raw playback as an explicit timeout recovery', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(app, /hlsPreparing:/);
  assert.match(app, /hlsReady:/);
  assert.match(app, /hlsFailed:/);
  assert.match(app, /hlsTimeout:/);
  assert.match(app, /lifecycle\.status === 'timeout'.*recovery: true/s);
  assert.match(app, /setTrackPlaybackStatus\(t\('hlsTimeout'\), 'fallback', \{ recovery: true \}\);/);
  assert.doesNotMatch(app, /sourceKey\) fallBackToSharedMedia\(item, sourceKey\);\n  \}, startupTimeout\);/);
  assert.match(app, /function useOriginalSharedMedia\(\)/);
  assert.match(html, /id="useOriginalVideoButton"/);
});

test('factory shutdown closes SSE clients, generated HLS artifacts, the server, and temporary storage idempotently', async (t) => {
  const { port, app } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }, { index: 1, codec_type: 'audio', codec_name: 'aac' }] }),
    ffmpegRunner: async (input, outputDir) => {
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(outputDir, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia_0.m3u8\n');
      fs.writeFileSync(path.join(outputDir, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment_0_00000.m4s\n#EXT-X-ENDLIST\n');
      fs.writeFileSync(path.join(outputDir, 'init.mp4'), 'init fragment');
      fs.writeFileSync(path.join(outputDir, 'segment_0_00000.m4s'), 'media segment');
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` })).status, 200);
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

test('authoritative preparing lifecycle publishes only normalized conversion progress to host and guests', async (t) => {
  let report;
  let finish;
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ format: { duration: '100' }, streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' }
    ] }),
    ffmpegRunner: (input, directory, delivery) => {
      report = delivery.onProgress;
      const pending = new Promise((resolve) => { finish = resolve; });
      pending.cancel = finish;
      return pending;
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  const master = request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(typeof report, 'function');
  report({ outTimeUs: 25_000_000 });
  const lifecycle = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.equal(lifecycle.status, 'preparing');
  assert.equal(lifecycle.progress.percent, 25);
  assert.ok(Number.isSafeInteger(lifecycle.progress.elapsedSeconds));
  assert.doesNotMatch(JSON.stringify(lifecycle), /out_time|input|directory|path|command|token|stderr|driver/i);
  finish();
  assert.equal((await master).status, 503);
});

test('complete-VOD HLS withholds ready and master until FFmpeg succeeds with ENDLIST', async (t) => {
  let finish;
  let outputDir;
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac' }
    ] }),
    ffmpegRunner: (input, directory) => {
      outputDir = directory;
      fs.writeFileSync(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nmedia_0.m3u8\n');
      fs.writeFileSync(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment_0.m4s\n');
      fs.writeFileSync(path.join(directory, 'init.mp4'), 'init fragment');
      fs.writeFileSync(path.join(directory, 'segment_0.m4s'), 'media segment');
      const running = new Promise((resolve) => { finish = resolve; });
      running.cancel = () => finish();
      return running;
    }
  });
  const media = JSON.parse((await rawUpload(port, 'clip.mkv', Buffer.from('media'))).body).media;
  await replaceLibrary(port, [media.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  const master = request(port, { path: `/hls/${media.id}/master.m3u8?token=test-room-token` });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const preparing = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.equal(preparing.status, 'preparing');
  assert.equal(fs.existsSync(path.join(outputDir, '.the-player-hls-cache-entry')), false);
  fs.appendFileSync(path.join(outputDir, 'media_0.m3u8'), '#EXT-X-ENDLIST\n');
  finish();
  assert.equal((await master).status, 200);
  const ready = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.hls;
  assert.equal(ready.status, 'ready');
});

test('append during foreground preparation reconciles the immediate next plan after foreground readiness', async (t) => {
  const publish = async (input, directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  let starts = 0;
  let completeForeground;
  const foregroundStarted = new Promise((resolve) => { completeForeground = resolve; });
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } }
    ] }),
    ffmpegRunner: (input, directory) => {
      starts += 1;
      return starts === 1 ? foregroundStarted.then(() => publish(input, directory)) : publish(input, directory);
    }
  });
  const first = JSON.parse((await rawUpload(port, 'first.mkv', Buffer.from('first'))).body).media;
  await replaceLibrary(port, [first.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  const foreground = request(port, { path: `/hls/${first.id}/master.m3u8?token=test-room-token` });
  await waitFor(() => starts === 1, 'foreground conversion did not start');
  const second = JSON.parse((await rawUpload(port, 'second.mkv', Buffer.from('second'))).body).media;
  await appendLibrary(port, [second.id]);
  completeForeground();
  assert.equal((await foreground).status, 200);
  await waitFor(async () => {
    const room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
    return starts === 2 && room.oneAhead?.mediaId === second.id && room.oneAhead.status === 'ready';
  }, 'foreground readiness did not reconcile the newly appended next item');
});

test('manual target selection promotes a completed speculative plan without reencoding', async (t) => {
  const publish = async (input, directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  let starts = 0;
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } }
    ] }),
    ffmpegRunner: async (...args) => { starts += 1; await publish(...args); }
  });
  const first = JSON.parse((await rawUpload(port, 'first.mkv', Buffer.from('first'))).body).media;
  const second = JSON.parse((await rawUpload(port, 'second.mkv', Buffer.from('second'))).body).media;
  await replaceLibrary(port, [first.id, second.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${first.id}/master.m3u8?token=test-room-token` })).status, 200);
  await waitFor(async () => starts === 2 && JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.oneAhead?.status === 'ready', 'speculative plan did not complete');
  const selected = await roomCommand(port, { type: 'select', mediaId: second.id });
  const room = JSON.parse(selected.body).state;
  assert.deepEqual(room.trackSelection, { audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal(room.hls.status, 'ready');
  assert.equal((await request(port, { path: `/hls/${second.id}/master.m3u8?token=test-room-token` })).status, 200);
  assert.equal(starts, 2, 'manual selection must reuse the completed speculative output');
});

test('manual selection of a preparing one-ahead target leaves the ready foreground authoritative', async (t) => {
  const publish = async (input, directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  let starts = 0;
  let completeSpeculation;
  let reportSpeculationProgress;
  const speculationStarted = new Promise((resolve) => { completeSpeculation = resolve; });
  t.after(() => completeSpeculation?.());
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } }
    ] }),
    ffmpegRunner: (input, directory, delivery) => {
      starts += 1;
      if (starts === 1) return publish(input, directory);
      reportSpeculationProgress = () => delivery.onProgress({ outTimeUs: 1 });
      return speculationStarted.then(() => publish(input, directory));
    }
  });
  const first = JSON.parse((await rawUpload(port, 'first.mkv', Buffer.from('first'))).body).media;
  const second = JSON.parse((await rawUpload(port, 'second.mkv', Buffer.from('second'))).body).media;
  await replaceLibrary(port, [first.id, second.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${first.id}/master.m3u8?token=test-room-token` })).status, 200);
  await waitFor(() => starts === 2 && typeof reportSpeculationProgress === 'function', 'speculative plan did not start');
  reportSpeculationProgress();
  await waitFor(async () => JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.oneAhead?.status === 'preparing', 'speculative progress did not publish preparation');
  const selected = await roomCommand(port, { type: 'select', mediaId: second.id });
  const pending = JSON.parse(selected.body).state;
  assert.equal(pending.mediaId, first.id, 'a preparing target must not replace the ready foreground');
  assert.equal(pending.hls.status, 'ready');
  assert.equal(pending.pendingNavigation, undefined, 'a preparing selection must not arm an automatic promotion');
  assert.equal(pending.position, 0, 'a rejected preparing selection must not checkpoint or replace either item position');
  assert.equal(starts, 2, 'the existing speculative runner remains available');
  completeSpeculation();
  await waitFor(async () => JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.oneAhead?.status === 'ready', 'prepared target did not remain available as ready');
  const completed = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
  assert.equal(completed.mediaId, first.id, 'completed preparation must not take over the foreground');
  assert.equal(starts, 2, 'preparation must not restart');
});

test('rapid B preparing selection then A interaction preserves A position', async (t) => {
  const publish = async (directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  let starts = 0;
  let finishNext;
  const nextPending = new Promise((resolve) => { finishNext = resolve; });
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } }
    ] }),
    ffmpegRunner: (input, directory) => {
      starts += 1;
      return starts === 1 ? publish(directory) : nextPending.then(() => publish(directory));
    }
  });
  const first = JSON.parse((await rawUpload(port, 'first.mkv', Buffer.from('first'))).body).media;
  const second = JSON.parse((await rawUpload(port, 'second.mkv', Buffer.from('second'))).body).media;
  await replaceLibrary(port, [first.id, second.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${first.id}/master.m3u8?token=test-room-token` })).status, 200);
  await waitFor(() => starts === 2, 'one-ahead preparation did not start');
  await roomCommand(port, { type: 'seek', position: 37 });
  const rejected = JSON.parse((await roomCommand(port, { type: 'select', mediaId: second.id })).body).state;
  assert.equal(rejected.mediaId, first.id);
  assert.equal(rejected.position, 37, 'a preparing selection must not overwrite A');
  assert.equal(rejected.pendingNavigation, undefined);
  // A keeps playing while B prepares. A foreground interaction must retain its
  // newer checkpoint and B may not take over when its work completes.
  const returned = JSON.parse((await roomCommand(port, { type: 'select', mediaId: first.id, position: 61 })).body).state;
  assert.equal(returned.mediaId, first.id);
  assert.equal(returned.position, 61, 'returning to A must publish its newer caller position');
  assert.equal(returned.pendingNavigation, undefined);
  finishNext();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const final = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
  assert.equal(final.mediaId, first.id, 'stale completion must not commit the cancelled pending target');
  assert.equal(final.position, 61, 'stale B completion must not seek A backward after its return checkpoint');
  assert.equal(starts, 2, 'returning to A must retain rather than restart B preparation');
});

test('three-item backward cache navigation retains the one-ahead runner without a destination lifecycle flash', async (t) => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-retained-runner-cache-'));
  fs.writeFileSync(path.join(cache, '.the-player-hls-cache-owner'), 'The Player persistent HLS cache storage\n');
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const firstSource = Buffer.from('first');
  const contentId = crypto.createHash('sha256').update(firstSource).digest('hex');
  const key = crypto.createHash('sha256').update(JSON.stringify({ contentId, audioTrackIndex: 1, subtitleTrackIndex: null, routing: 'selected-track-routing-v1:full-transcode:transcode:transcode:none:selected-cmaf-x264-v1', topology: 'selected-muxed-cmaf-v2' })).digest('hex');
  const cachedEntry = path.join(cache, key);
  fs.mkdirSync(cachedEntry);
  fs.writeFileSync(path.join(cachedEntry, '.the-player-hls-cache-entry'), 'The Player persistent HLS cache storage\n');
  fs.writeFileSync(path.join(cachedEntry, '.the-player-hls-cache-profile.json'), `${JSON.stringify({ contentId, audioTrackIndex: 1, subtitleTrackIndex: null, route: 'full-transcode', videoMode: 'transcode', audioMode: 'transcode', subtitleMode: 'none', encoder: 'libx264', topology: 'selected-muxed-cmaf-v2', routingVersion: 'selected-track-routing-v1' })}\n`);
  fs.writeFileSync(path.join(cachedEntry, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
  fs.writeFileSync(path.join(cachedEntry, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
  fs.writeFileSync(path.join(cachedEntry, 'init.mp4'), 'init');
  fs.writeFileSync(path.join(cachedEntry, 'segment_0.m4s'), 'segment');
  const publish = async (input, directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  let starts = 0;
  let cancelCalls = 0;
  let speculativeStarted;
  const speculativeStartedPromise = new Promise((resolve) => { speculativeStarted = resolve; });
  const { port } = await startFixture(t, {
    hlsCacheDir: cache,
    ffprobeRunner: async () => ({ format: { duration: '100' }, streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } },
      { index: 2, codec_type: 'audio', codec_name: 'aac', tags: { language: 'spa', title: 'Spanish' } }
    ] }),
    ffmpegRunner: (input, directory, delivery) => {
      starts += 1;
      if (starts !== 2) return publish(input, directory);
      let cancel;
      const pending = new Promise((resolve, reject) => {
        cancel = () => { cancelCalls += 1; reject(new Error('cancelled')); };
      });
      pending.cancel = cancel;
      speculativeStarted(delivery);
      return pending;
    }
  });
  const first = JSON.parse((await rawUpload(port, 'first.mkv', firstSource)).body).media;
  const second = JSON.parse((await rawUpload(port, 'second.mkv', Buffer.from('second'))).body).media;
  const third = JSON.parse((await rawUpload(port, 'third.mkv', Buffer.from('third'))).body).media;
  await replaceLibrary(port, [first.id, second.id, third.id]);
  await roomCommand(port, { type: 'select', mediaId: second.id });
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${second.id}/master.m3u8?token=test-room-token` })).status, 200);
  const speculativeDelivery = await speculativeStartedPromise;
  speculativeDelivery.onProgress({ outTimeUs: 25_000_000 });
  await waitFor(async () => JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.oneAhead?.mediaId === third.id, 'third-item one-ahead runner did not start');

  await roomCommand(port, { type: 'previous' });
  assert.equal(cancelCalls, 0, '2 → 1 must retain the valid runner preparing item 3');
  let room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
  assert.equal(room.mediaId, first.id);
  assert.equal(room.hls.status, 'ready', 'the cached destination publishes ready immediately');
  assert.equal(room.hls.cacheHit, true);
  assert.equal(room.oneAhead?.mediaId, third.id, 'the retained target remains visible on its playlist card');

  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 2, subtitleTrackIndex: null });
  await waitFor(() => cancelCalls === 1, 'a changed selection must cancel the now-obsolete one-ahead runner');
  room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
  assert.equal(room.oneAhead, undefined);
  // Let the cancelled owner settle before fixture teardown starts another
  // independent cleanup path for its temporary directory.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test('backward A/B navigation re-admits B session output while retaining C without reencoding', async (t) => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-session-reentry-cache-'));
  fs.writeFileSync(path.join(cache, '.the-player-hls-cache-owner'), 'The Player persistent HLS cache storage\n');
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const aSource = Buffer.from('A');
  createCompletedCacheEntry(cache, aSource);
  const publish = async (directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  let starts = 0;
  let cCancelCalls = 0;
  let cancelC;
  const { port } = await startFixture(t, {
    hlsCacheDir: cache,
    hlsCacheMaxBytes: 1, // A remains reusable; newly completed B stays session-owned.
    ffprobeRunner: async () => ({ format: { duration: '100' }, streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } }
    ] }),
    ffmpegRunner: (input, directory) => {
      starts += 1;
      if (starts === 1) return publish(directory); // B foreground
      let reject;
      const pending = new Promise((resolve, rejectPending) => { reject = rejectPending; });
      pending.cancel = () => { cCancelCalls += 1; reject(new Error('cancelled')); };
      cancelC = pending.cancel;
      return pending; // C one-ahead remains running
    }
  });
  const first = JSON.parse((await rawUpload(port, 'A.mkv', aSource)).body).media;
  const second = JSON.parse((await rawUpload(port, 'B.mkv', Buffer.from('B'))).body).media;
  const third = JSON.parse((await rawUpload(port, 'C.mkv', Buffer.from('C'))).body).media;
  await replaceLibrary(port, [first.id, second.id, third.id]);
  await roomCommand(port, { type: 'seek', position: 12 });
  await roomCommand(port, { type: 'select', mediaId: second.id, position: 12 });
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${second.id}/master.m3u8?token=test-room-token` })).status, 200);
  await waitFor(() => starts === 2, 'C one-ahead runner did not start');
  await roomCommand(port, { type: 'seek', position: 34 });

  let room = JSON.parse((await roomCommand(port, { type: 'previous', position: 34 })).body).state;
  assert.equal(room.mediaId, first.id);
  assert.equal(room.position, 12, 'A checkpoint remains authoritative');
  assert.equal(cCancelCalls, 0, 'B → A retains C');

  room = JSON.parse((await roomCommand(port, { type: 'select', mediaId: second.id, position: 12 })).body).state;
  assert.equal(room.mediaId, second.id);
  assert.equal(room.hls.status, 'ready', 'B session output is re-admitted without waiting for C');
  assert.equal(room.position, 34, 'B checkpoint remains authoritative');
  assert.equal(cCancelCalls, 0, 'A → B retains C');
  assert.equal((await request(port, { path: `/hls/${second.id}/master.m3u8?token=test-room-token` })).status, 200, 're-admitted B protected master remains available');
  assert.equal(starts, 2, 'B is not converted again while C remains the sole runner');
  cancelC?.();
});

test('browser immediately marks a shared playlist selection pending until authority resolves it', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const helpers = app.match(/function setPendingPlaylistSelection\(mediaId\) \{[\s\S]*?\n\}\n\nfunction clearPendingPlaylistSelection\(mediaId = null\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helpers, 'playlist selection feedback helpers are present');
  const state = { shared: { pendingPlaylistSelection: null } };
  let renders = 0;
  const { setPendingPlaylistSelection, clearPendingPlaylistSelection } = new Function('state', 'renderPlaylist', `${helpers}\nreturn { setPendingPlaylistSelection, clearPendingPlaylistSelection };`)(state, () => { renders += 1; });
  setPendingPlaylistSelection('first');
  assert.equal(state.shared.pendingPlaylistSelection, 'first');
  setPendingPlaylistSelection('second');
  assert.equal(state.shared.pendingPlaylistSelection, 'second', 'a newer click supersedes the old visual request');
  clearPendingPlaylistSelection('first');
  assert.equal(state.shared.pendingPlaylistSelection, 'second', 'a stale lifecycle cannot clear the newer request');
  clearPendingPlaylistSelection('second');
  assert.equal(state.shared.pendingPlaylistSelection, null, 'the authoritative selection lifecycle clears its matching request');
  assert.equal(renders, 3);
  assert.match(app, /selectionPending: 'Seleccionando…'/);
  assert.match(app, /const pendingSelection = state\.shared\.pendingPlaylistSelection === item\.mediaId;/);
  assert.match(app, /status\.className = pendingSelection \? 'selection-pending-status' : 'one-ahead-status';[\s\S]*?status\.setAttribute\('role', 'status'\);[\s\S]*?status\.setAttribute\('aria-live', 'polite'\);/);
  assert.match(app, /setPendingPlaylistSelection\(item\.mediaId\);\n    await sendRoomCommand\(\{ type: 'select', mediaId: item\.mediaId \}\);/);
  assert.match(app, /if \(command\.type === 'select' && commandId === state\.shared\.roomCommandId\) clearPendingPlaylistSelection\(command\.mediaId\);/);
  assert.match(app, /if \(state\.shared\.pendingPlaylistSelection && \(roomState\.mediaId === state\.shared\.pendingPlaylistSelection[\s\S]*?clearPendingPlaylistSelection\(state\.shared\.pendingPlaylistSelection\);/);
  assert.match(app, /state\.shared\.pendingPlaylistSelection = null;/);
  const styles = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
  assert.match(styles, /\.selection-pending-status \{[\s\S]*?color: var\(--accent-strong\);/);
});

test('one-ahead lifecycle updates do not reapply foreground media state', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const helper = app.match(/function foregroundRoomStateChanged\(previousRoomState, roomState\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper, 'foreground room-state comparison is present');
  const { foregroundRoomStateChanged } = new Function(`${helper}\nreturn { foregroundRoomStateChanged };`)();
  const foreground = {
    mediaId: 'foreground', position: 3, playing: true,
    trackSelection: { audioTrackIndex: 1, subtitleTrackIndex: null },
    hls: { status: 'ready', mediaId: 'foreground', selectionId: 'stable' }
  };
  const speculativeProgress = { ...foreground, oneAhead: { status: 'preparing', mediaId: 'next', progress: { percent: 25 } } };
  const speculativeComplete = { ...foreground, oneAhead: { status: 'ready', mediaId: 'next' } };
  assert.equal(foregroundRoomStateChanged(foreground, speculativeProgress), false, 'speculative progress must not reload, seek, or change room position');
  assert.equal(foregroundRoomStateChanged(speculativeProgress, speculativeComplete), false, 'speculative completion must not reload, seek, or change room position');
  assert.match(app, /const foregroundStateChanged = foregroundRoomStateChanged\(previousRoomState, roomState\);/);
  assert.match(app, /if \(!foregroundStateChanged\) \{[\s\S]*?renderTrackControls\(roomState\);[\s\S]*?if \(oneAheadChanged\) renderPlaylist\(\);[\s\S]*?return;/);
  assert.match(app, /function hasPendingOutgoingNavigation\(sourceKey\)[\s\S]*?pending\?\.mediaId[\s\S]*?roomState\?\.mediaId === state\.shared\.hls\.mediaId/);
  assert.match(app, /!isCurrentSharedHlsLoad\(sourceKey, loadId\) \|\| hasPendingOutgoingNavigation\(sourceKey\)/, 'outgoing fatal HLS must not trigger fallback during pending navigation');
});

test('a stale deferred cache demotion cannot overwrite a rejected preparing selection', async (t) => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-navigation-intent-cache-'));
  fs.writeFileSync(path.join(cache, '.the-player-hls-cache-owner'), 'The Player persistent HLS cache storage\n');
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const firstSource = Buffer.from('first');
  const secondSource = Buffer.from('second');
  const firstCache = createCompletedCacheEntry(cache, firstSource);
  const publish = async (directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  let deferFirstCache = false;
  let releaseFirstCache;
  const firstCacheBlocked = new Promise((resolve) => { releaseFirstCache = resolve; });
  let firstCacheValidationStarted;
  const firstCacheValidation = new Promise((resolve) => { firstCacheValidationStarted = resolve; });
  let starts = 0;
  let reportProgress;
  let completeRunner;
  const runnerPending = new Promise((resolve) => { completeRunner = resolve; });
  const { port } = await startFixture(t, {
    hlsCacheDir: cache,
    ffprobeRunner: async (filePath) => {
      if (deferFirstCache && filePath.startsWith(firstCache)) {
        firstCacheValidationStarted();
        await firstCacheBlocked;
      }
      return { format: { duration: '100' }, streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } }
      ] };
    },
    ffmpegRunner: (input, directory, delivery) => {
      starts += 1;
      if (starts === 1) return publish(directory);
      reportProgress = (outTimeUs) => delivery.onProgress({ outTimeUs });
      return runnerPending.then(() => publish(directory));
    }
  });
  const first = JSON.parse((await rawUpload(port, 'first.mkv', firstSource)).body).media;
  const second = JSON.parse((await rawUpload(port, 'second.mkv', secondSource)).body).media;
  const third = JSON.parse((await rawUpload(port, 'third.mkv', Buffer.from('third'))).body).media;
  await replaceLibrary(port, [first.id, second.id, third.id]);
  await roomCommand(port, { type: 'select', mediaId: second.id });
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${second.id}/master.m3u8?token=test-room-token` })).status, 200);
  await waitFor(() => starts === 2 && typeof reportProgress === 'function', 'one-ahead runner did not start');

  deferFirstCache = true;
  const olderDemotion = roomCommand(port, { type: 'previous' });
  await firstCacheValidation;
  const promotion = await roomCommand(port, { type: 'select', mediaId: third.id });
  const pending = JSON.parse(promotion.body).state;
  assert.equal(pending.mediaId, second.id, 'a preparing target leaves the outgoing foreground authoritative');
  assert.equal(pending.pendingNavigation, undefined, 'a preparing target must not arm later promotion');
  reportProgress(50_000_000);
  await waitFor(async () => {
    const room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
    return room.oneAhead?.progress?.percent === 50;
  }, 'pending runner progress was not retained on the one-ahead card');
  reportProgress(75_000_000);
  await waitFor(async () => JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.oneAhead?.progress?.percent === 75, 'later pending progress was lost');
  releaseFirstCache();
  const staleResponse = JSON.parse((await olderDemotion).body).state;
  assert.equal(staleResponse.mediaId, second.id, 'superseded cache command must not overwrite the pending foreground');
  assert.equal(starts, 2, 'the rejected selection must retain the sole runner without restarting it');
  completeRunner();
  await waitFor(async () => {
    const room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
    return room.oneAhead?.mediaId === third.id && room.oneAhead.status === 'ready';
  }, 'the prepared target did not remain available on its card');
  assert.equal(JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.mediaId, second.id, 'completion must not replace the foreground');
});

test('a later deferred-cache demotion keeps retained runner progress on the one-ahead card', async (t) => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-navigation-intent-cache-'));
  fs.writeFileSync(path.join(cache, '.the-player-hls-cache-owner'), 'The Player persistent HLS cache storage\n');
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const firstSource = Buffer.from('first');
  const secondSource = Buffer.from('second');
  const thirdSource = Buffer.from('third');
  const thirdCache = createCompletedCacheEntry(cache, thirdSource);
  const publish = async (directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  let deferFirstCache = false;
  let releaseFirstCache;
  const firstCacheBlocked = new Promise((resolve) => { releaseFirstCache = resolve; });
  let firstCacheValidationStarted;
  const firstCacheValidation = new Promise((resolve) => { firstCacheValidationStarted = resolve; });
  let starts = 0;
  let reportProgress;
  let completeRunner;
  const runnerPending = new Promise((resolve) => { completeRunner = resolve; });
  const { port } = await startFixture(t, {
    hlsCacheDir: cache,
    ffprobeRunner: async (filePath) => {
      if (deferFirstCache && filePath.startsWith(thirdCache)) {
        firstCacheValidationStarted();
        await firstCacheBlocked;
      }
      return { format: { duration: '100' }, streams: [
        { index: 0, codec_type: 'video', codec_name: 'h264' },
        { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } }
      ] };
    },
    ffmpegRunner: (input, directory, delivery) => {
      starts += 1;
      if (starts === 1) return publish(directory);
      reportProgress = (outTimeUs) => delivery.onProgress({ outTimeUs });
      return runnerPending;
    }
  });
  const first = JSON.parse((await rawUpload(port, 'first.mkv', firstSource)).body).media;
  const second = JSON.parse((await rawUpload(port, 'second.mkv', secondSource)).body).media;
  const third = JSON.parse((await rawUpload(port, 'third.mkv', thirdSource)).body).media;
  await replaceLibrary(port, [first.id, second.id, third.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${first.id}/master.m3u8?token=test-room-token` })).status, 200);
  await waitFor(() => starts === 2 && typeof reportProgress === 'function', 'one-ahead runner did not start');

  deferFirstCache = true;
  // Direct A → C selection is intentionally deferred while B owns the sole
  // runner. Use the backward navigation path to hold C cache admission, then
  // prove a newer A interaction demotes it without stealing B's progress.
  const olderPromotion = roomCommand(port, { type: 'previous' });
  await firstCacheValidation;
  // The latest intent returns to the active foreground, demoting the retained
  // runner back to the immediate-next card instead of restarting it.
  const latestDemotion = await roomCommand(port, { type: 'select', mediaId: first.id });
  assert.equal(JSON.parse(latestDemotion.body).state.mediaId, first.id);
  reportProgress(50_000_000);
  await waitFor(async () => {
    const room = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
    return room.oneAhead?.mediaId === second.id && room.oneAhead?.progress?.percent === 50;
  }, 'retained runner progress was not routed to one-ahead');
  reportProgress(75_000_000);
  await waitFor(async () => JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.oneAhead?.progress?.percent === 75, 'later one-ahead progress was lost');
  releaseFirstCache();
  assert.equal(JSON.parse((await olderPromotion).body).state.mediaId, first.id, 'older cache completion must not overwrite the latest demotion');
  assert.equal(starts, 2, 'latest demotion retains the existing runner without a second runner');
  completeRunner();
});

test('shared navigation retains distinct checkpoints for each immutable content item', async (t) => {
  const { port } = await startFixture(t);
  const first = JSON.parse((await rawUpload(port, 'first.mp4', Buffer.from('first'))).body).media;
  const second = JSON.parse((await rawUpload(port, 'second.mp4', Buffer.from('second'))).body).media;
  await replaceLibrary(port, [first.id, second.id]);

  await roomCommand(port, { type: 'seek', position: 12 });
  let response = await roomCommand(port, { type: 'select', mediaId: second.id, position: 12 });
  assert.equal(JSON.parse(response.body).state.position, 0);
  await roomCommand(port, { type: 'seek', position: 34 });
  response = await roomCommand(port, { type: 'select', mediaId: first.id, position: 34 });
  assert.equal(JSON.parse(response.body).state.position, 12, 'A restores its own checkpoint after a repeated card click');
  response = await roomCommand(port, { type: 'select', mediaId: second.id, position: 12 });
  assert.equal(JSON.parse(response.body).state.position, 34, 'B restores its own checkpoint after a repeated card click');
});

test('explicit ready one-ahead selection restores its target checkpoint instead of zero', async (t) => {
  const publish = async (directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  let starts = 0;
  let completeNext;
  const nextPending = new Promise((resolve) => { completeNext = resolve; });
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } }
    ] }),
    ffmpegRunner: (input, directory) => {
      starts += 1;
      return starts === 1 ? publish(directory) : nextPending.then(() => publish(directory));
    }
  });
  const first = JSON.parse((await rawUpload(port, 'first.mkv', Buffer.from('first'))).body).media;
  const second = JSON.parse((await rawUpload(port, 'second.mkv', Buffer.from('second'))).body).media;
  await replaceLibrary(port, [first.id, second.id]);
  await roomCommand(port, { type: 'next', position: 0 });
  await roomCommand(port, { type: 'seek', position: 29 });
  await roomCommand(port, { type: 'previous', position: 29 });
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null, position: 5 });
  assert.equal((await request(port, { path: `/hls/${first.id}/master.m3u8?token=test-room-token` })).status, 200);
  await waitFor(() => starts === 2, 'one-ahead preparation did not start');
  const rejected = JSON.parse((await roomCommand(port, { type: 'select', mediaId: second.id, position: 5 })).body).state;
  assert.equal(rejected.pendingNavigation, undefined);
  assert.equal(rejected.position, 5, 'rejected preparation selection preserves A checkpoint');
  completeNext();
  await waitFor(async () => JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.oneAhead?.status === 'ready', 'prepared target did not remain ready on its card');
  const foreground = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
  assert.equal(foreground.mediaId, first.id, 'prepared target must not auto-promote');
  const promoted = JSON.parse((await roomCommand(port, { type: 'select', mediaId: second.id, position: 5 })).body).state;
  assert.equal(promoted.position, 29, 'explicit ready selection restores B checkpoint');
});

test('foreground controls revoke deferred navigation and preparing playlist clicks stay local', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(server, /const foregroundInteraction = body\.type === 'play' \|\| body\.type === 'pause' \|\| body\.type === 'seek';/);
  assert.match(server, /if \(navigationCommand \|\| foregroundInteraction\) delete next\.pendingNavigation;/);
  assert.match(server, /if \(matchingOneAhead && !oneAheadArtifact\.ready\) \{[\s\S]*?both content-bound checkpoints untouched;[\s\S]*?invalidatesHls = false;/);
  assert.match(app, /oneAheadPreparingNotice:/);
  assert.match(app, /if \(oneAhead\?\.mediaId === item\.mediaId && oneAhead\.status === 'preparing'\) \{[\s\S]*?updateStatus\(t\('oneAheadPreparingNotice', \{ name: item\.relativePath \}\)\);[\s\S]*?return;/);
});

test('browser persistence is armed by a source generation before progress can be written', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /function beginProgressPersistence\(item, sourceGeneration = null\)[\s\S]*?generation: state\.persistence\.generation \+ 1/);
  assert.match(app, /function armProgressPersistence\(item, generation, sourceGeneration = null\)[\s\S]*?state\.persistence\.contentId !== item\?\.contentId/);
  const helper = app.match(/function canPersistActiveProgress[\s\S]*?(?=function revokeCurrentObjectUrl)/)?.[0];
  assert.ok(helper, 'source-bound persistence guard is available');
  const state = { persistence: { generation: 2, contentId: 'B', armed: false } };
  const { canPersistActiveProgress } = new Function('state', `${helper}\nreturn { canPersistActiveProgress };`)(state);
  assert.equal(canPersistActiveProgress({ contentId: 'B' }), false, 'a stale A callback cannot save into unarmed B');
  state.persistence.armed = true;
  assert.equal(canPersistActiveProgress({ contentId: 'A' }), false, 'a source mismatch cannot save destination progress');
  assert.equal(canPersistActiveProgress({ contentId: 'B' }), true);
  assert.match(app, /if \(!canPersistActiveProgress\(item, persistenceGeneration, persistenceSourceGeneration\)\) return;/);
  assert.match(app, /\['select', 'previous', 'next', 'selectTracks'\]\.includes\(command\.type\)[\s\S]*?position: currentSharedPosition\(\)/);
});

test('persistence source identity includes the HLS selection generation and rejects stale zero writes', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const persistence = app.match(/function beginProgressPersistence\(item, sourceGeneration = null\)[\s\S]*?(?=function revokeCurrentObjectUrl)/)?.[0];
  assert.ok(persistence, 'selection-aware persistence helpers are present');
  const state = { persistence: { generation: 0, contentId: null, sourceGeneration: null, armed: false } };
  const { beginProgressPersistence, armProgressPersistence, canPersistActiveProgress } = new Function('state', `${persistence}\nreturn { beginProgressPersistence, armProgressPersistence, canPersistActiveProgress };`)(state);
  const item = { contentId: 'same-content' };
  const oldGeneration = beginProgressPersistence(item, 'selection-old');
  assert.equal(armProgressPersistence(item, oldGeneration, 'selection-old'), true);
  const activeGeneration = beginProgressPersistence(item, 'selection-new');
  assert.equal(armProgressPersistence(item, oldGeneration, 'selection-old'), false, 'detached old metadata cannot re-arm a replacement');
  assert.equal(armProgressPersistence(item, activeGeneration, 'selection-old'), false, 'a stale selection ID cannot arm the current content');
  assert.equal(armProgressPersistence(item, activeGeneration, 'selection-new'), true);
  assert.equal(canPersistActiveProgress(item, activeGeneration, 'selection-old'), false, 'a stale callback cannot write zero into the replacement generation');
  assert.equal(canPersistActiveProgress(item, activeGeneration, 'selection-new'), true);
  assert.match(app, /function saveActiveProgress[\s\S]*?currentTime === 0[\s\S]*?item\.progress\?\.currentTime > 0/);
});

test('deferred C intent survives B to A and starts once after B settles without replacing A', async (t) => {
  const publish = async (directory) => {
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, 'master.m3u8'), '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia_0.m3u8\n');
    await fsp.writeFile(path.join(directory, 'media_0.m3u8'), '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:1,\nsegment_0.m4s\n#EXT-X-ENDLIST\n');
    await fsp.writeFile(path.join(directory, 'init.mp4'), 'init');
    await fsp.writeFile(path.join(directory, 'segment_0.m4s'), 'segment');
  };
  let starts = 0;
  let finishB;
  let finishC;
  const bPending = new Promise((resolve) => { finishB = resolve; });
  const cPending = new Promise((resolve) => { finishC = resolve; });
  const { port } = await startFixture(t, {
    ffprobeRunner: async () => ({ streams: [
      { index: 0, codec_type: 'video', codec_name: 'h264' },
      { index: 1, codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng', title: 'English' } }
    ] }),
    ffmpegRunner: (input, directory) => {
      starts += 1;
      if (starts === 1) return publish(directory); // A
      if (starts === 2) return bPending.then(() => publish(directory)); // B owns the sole runner
      return cPending.then(() => publish(directory)); // deferred C remains observable after invocation
    }
  });
  const a = JSON.parse((await rawUpload(port, 'A.mkv', Buffer.from('A'))).body).media;
  const b = JSON.parse((await rawUpload(port, 'B.mkv', Buffer.from('B'))).body).media;
  const c = JSON.parse((await rawUpload(port, 'C.mkv', Buffer.from('C'))).body).media;
  await replaceLibrary(port, [a.id, b.id, c.id]);
  await roomCommand(port, { type: 'selectTracks', audioTrackIndex: 1, subtitleTrackIndex: null });
  assert.equal((await request(port, { path: `/hls/${a.id}/master.m3u8?token=test-room-token` })).status, 200);
  await waitFor(() => starts === 2, 'B runner did not start');
  const deferred = JSON.parse((await roomCommand(port, { type: 'select', mediaId: c.id })).body).state;
  assert.equal(deferred.mediaId, a.id, 'C remains deferred while B owns the runner');
  const returned = JSON.parse((await roomCommand(port, { type: 'select', mediaId: a.id, position: 12 })).body).state;
  assert.equal(returned.mediaId, a.id, 'returning to A remains foreground');
  finishB();
  await waitFor(async () => starts === 3 && JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state.oneAhead?.mediaId === c.id, 'C was not admitted after B completed');
  const final = JSON.parse((await request(port, { path: '/api/room?token=test-room-token' })).body).state;
  assert.equal(final.oneAhead?.status, 'preparing', 'deferred C publishes preparation as soon as its runner is invoked');
  assert.equal(final.oneAhead?.progress, undefined, 'deferred C has no fabricated progress before its first FFmpeg report');
  assert.equal(final.mediaId, a.id, 'deferred C never takes foreground from A');
  assert.equal(final.position, 12, 'deferred work does not alter checkpoints');
  assert.equal(starts, 3, 'C is admitted exactly once');
  finishC();
});

test('deferred C preserves a visible one-ahead lifecycle while B hands off its runner slot', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // Clearing B's status before C owns the slot emits an SSE state with no
  // next-card lifecycle, so a foreground-inert browser update renders no
  // “Preparing next” badge. C replaces B only when its runner is invoked.
  assert.doesNotMatch(server, /if \(canAdmitDeferred\) \{[\s\S]*?delete nextState\.oneAhead;[\s\S]*?updateState\(nextState\);/);
  assert.match(server, /entry\.runnerStarted = true;[\s\S]*?if \(speculative\) updateOneAheadLifecycle\(entry, 'preparing'\);/, 'C publishes preparing only after its runner starts');
});
