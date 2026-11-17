'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const SHARE_LAN = process.env.SHARE_LAN === '1';
const HOST = SHARE_LAN ? '0.0.0.0' : '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024 * 1024;
const MEDIA_TOOLS = new Set(['ffmpeg', 'ffprobe']);

function resolveMediaCommand(tool, { appDirectory = __dirname, exists = fs.existsSync } = {}) {
  if (!MEDIA_TOOLS.has(tool)) throw new RangeError('Unknown media tool');
  const packaged = path.resolve(appDirectory, '..', 'runtime', `${tool}.exe`);
  return exists(packaged) ? packaged : tool;
}

function parsePositiveWholeBytes(value, name, defaultValue = null) {
  if (value === undefined || value === '') return defaultValue;
  if (!/^\d+$/.test(value)) throw new RangeError(`${name} must be a positive whole number of bytes`);
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new RangeError(`${name} must be a positive whole number of bytes`);
  return bytes;
}

function parseUploadLimit(value) {
  return parsePositiveWholeBytes(value, 'MAX_UPLOAD_BYTES', DEFAULT_MAX_UPLOAD_BYTES);
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
const RUNTIME_MEDIA_DIR_ENV = 'REPRODUCTOR_MEDIA_DIR';
const HLS_CACHE_DIR_ENV = 'REPRODUCTOR_HLS_CACHE_DIR';
const HLS_CACHE_MAX_BYTES_ENV = 'REPRODUCTOR_HLS_CACHE_MAX_BYTES';
const HLS_CACHE_OWNER_FILE = '.the-player-hls-cache-owner';
const HLS_CACHE_OWNER_LINE = 'The Player persistent HLS cache storage';
const HLS_CACHE_ENTRY_MARKER = '.the-player-hls-cache-entry';
const HLS_CACHE_PROFILE_FILE = '.the-player-hls-cache-profile.json';
const HLS_TOPOLOGY_VERSION = 'selected-muxed-cmaf-v2';
const HLS_ROUTING_VERSION = 'selected-track-routing-v1';
// Subtitle placement is a browser-DOM delivery policy. Bump this revision so
// legacy caches whose generated cues were rewritten for native rendering are
// regenerated rather than being mistaken for authored cue settings.
const HLS_SUBTITLE_POSITIONING_VERSION = 6;
const CPU_ENCODER = 'libx264';
const SAFE_ROUTE_MODES = new Set(['copy', 'audio-transcode', 'video-transcode', 'full-transcode']);
const SAFE_STREAM_MODES = new Set(['copy', 'transcode']);
const GPU_ENCODERS = Object.freeze(['h264_nvenc', 'h264_qsv', 'h264_amf']);
const ENCODER_ORDER = Object.freeze([...GPU_ENCODERS, CPU_ENCODER]);
const SAFE_ENCODERS = new Set(ENCODER_ORDER);
const FORCE_CPU_ENCODER_ENV = 'REPRODUCTOR_FORCE_CPU_ENCODER';
const MAX_FFPROBE_OUTPUT_BYTES = 1024 * 1024;
const FFPROBE_TIMEOUT_MS = 10_000;
const MAX_FFMPEG_OUTPUT_BYTES = 1024 * 1024;
const MAX_FFMPEG_DIAGNOSTIC_TAIL_BYTES = 4096;
const SAFE_FFMPEG_ERROR_CLASSES = new Set(['unavailable', 'output-failed', 'job-timeout', 'output-limit', 'failed']);
const SAFE_HLS_FAILURE_REASONS = new Set(['unavailable', 'output-failed', 'job-timeout', 'output-limit', 'failed', 'readiness-failed', 'readiness-timeout']);
// Startup readiness remains short and independent from the full VOD encode.
// A duration-aware allowance tolerates slow software H.264 transcodes, while
// the 12-hour ceiling still terminates a hung encoder even without FFprobe data.
const HLS_VOD_JOB_MIN_TIMEOUT_MS = 30 * 60_000;
const HLS_VOD_JOB_DURATION_MULTIPLIER = 10;
const HLS_VOD_JOB_SLACK_MS = 15 * 60_000;
const HLS_VOD_JOB_MAX_TIMEOUT_MS = 12 * 60 * 60_000;
const HLS_READINESS_TIMEOUT_MS = 120_000;
const HLS_READINESS_POLL_MS = 100;
const HLS_ARTIFACT_RETRY_TIMEOUT_MS = 2_000;
const HLS_ARTIFACT_RETRY_POLL_MS = 50;
// A completed selected VOD gets one protected, same-origin subtitle document.
// Refuse oversize input rather than truncating cues or exposing partial output.
const MAX_AGGREGATE_SUBTITLE_BYTES = 32 * 1024 * 1024;
const TEXT_SUBTITLE_CODECS = new Set(['ass', 'ssa', 'subrip', 'srt', 'webvtt', 'mov_text', 'text', 'ttml']);
const TRACK_DISPOSITION_FLAGS = Object.freeze(['default', 'forced', 'hearing_impaired', 'visual_impaired']);
const NORMALIZED_TRACK_LANGUAGES = new Map([['eng', 'en'], ['en', 'en'], ['spa', 'es'], ['es', 'es']]);

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

function uploadFailure(error, req) {
  if (error?.statusCode === 413) return { category: 'payload-too-large', statusCode: 413, message: 'Payload Too Large' };
  if (error?.statusCode === 415) return { category: 'unsupported-media', statusCode: 415, message: 'Unsupported media type' };
  if (error?.statusCode === 400) return { category: 'invalid-upload', statusCode: 400, message: 'Invalid upload' };
  if (req.aborted || ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR'].includes(error?.code)) {
    return { category: 'client-disconnected', statusCode: 499, message: 'Upload interrupted' };
  }
  if (['ENOSPC', 'EACCES', 'EIO', 'EPERM'].includes(error?.code)) {
    return { category: 'storage-failed', statusCode: 507, message: 'Upload storage unavailable' };
  }
  return { category: 'stream-failed', statusCode: 500, message: 'Upload failed' };
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
  const virtualAdapter = /docker|veth|\bbr[-\d]|virbr|vmnet|vbox|virtual|hyper-v|vethernet|wsl|vpn|logmein|hamachi|\btun\d*\b|\btap\d*\b|\bppp\d*\b|tailscale|zerotier|wireguard|\bwg\d*\b/i;
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

function normalizeTrackText(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 128) : undefined;
}

function normalizeTrackFingerprintText(value) {
  const text = normalizeTrackText(value);
  return text
    ? text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
    : null;
}

function normalizedTrackLanguage(value) {
  const language = normalizeTrackFingerprintText(value);
  return language ? (NORMALIZED_TRACK_LANGUAGES.get(language) || language) : null;
}

function normalizedTrackDisposition(value) {
  if (typeof value === 'string') {
    const flags = value.split(',').filter((flag) => TRACK_DISPOSITION_FLAGS.includes(flag));
    return flags.length ? flags.join(',') : null;
  }
  if (!value || typeof value !== 'object') return null;
  const flags = TRACK_DISPOSITION_FLAGS.filter((flag) => value[flag] === 1 || value[flag] === true);
  return flags.length ? flags.join(',') : null;
}

function trackSemanticFingerprint(track) {
  const language = normalizedTrackLanguage(track?.language);
  if (!language) return null;
  return { language, title: normalizeTrackFingerprintText(track.title), disposition: normalizedTrackDisposition(track.disposition) };
}

function resolveSemanticTrack(sourceTrack, targetTracks) {
  const fingerprint = trackSemanticFingerprint(sourceTrack);
  if (!fingerprint || !Array.isArray(targetTracks)) return null;
  const candidates = targetTracks.filter((track) => normalizedTrackLanguage(track?.language) === fingerprint.language);
  const exact = candidates.filter((track) => (fingerprint.title || fingerprint.disposition)
    && (!fingerprint.title || normalizeTrackFingerprintText(track.title) === fingerprint.title)
    && (!fingerprint.disposition || normalizedTrackDisposition(track.disposition) === fingerprint.disposition));
  if (exact.length === 1) return exact[0];
  return candidates.length === 1 ? candidates[0] : null;
}

function resolveSemanticTrackSelection(sourceMedia, targetMedia, selection) {
  if (sourceMedia?.tracks?.status !== 'available' || targetMedia?.tracks?.status !== 'available' || !Number.isSafeInteger(selection?.audioTrackIndex)) return null;
  const sourceAudio = sourceMedia.tracks.audio.find((track) => track.index === selection.audioTrackIndex);
  const audio = resolveSemanticTrack(sourceAudio, targetMedia.tracks.audio);
  if (!audio) return null;
  if (selection.subtitleTrackIndex === null) return { audioTrackIndex: audio.index, subtitleTrackIndex: null };
  const sourceSubtitle = sourceMedia.tracks.subtitles.find((track) => track.index === selection.subtitleTrackIndex && TEXT_SUBTITLE_CODECS.has(track.codec));
  const subtitle = resolveSemanticTrack(sourceSubtitle, targetMedia.tracks.subtitles);
  return subtitle && TEXT_SUBTITLE_CODECS.has(subtitle.codec)
    ? { audioTrackIndex: audio.index, subtitleTrackIndex: subtitle.index }
    : null;
}

function normalizeMediaDuration(output) {
  const duration = Number(output?.format?.duration);
  return Number.isFinite(duration) && duration > 0 && duration <= MAX_POSITION_SECONDS ? duration : null;
}

function normalizeMediaTracks(output) {
  if (typeof output === 'string') {
    try {
      output = JSON.parse(output);
    } catch {
      throw new Error('FFprobe returned invalid JSON');
    }
  }
  if (!output || typeof output !== 'object' || !Array.isArray(output.streams)) {
    throw new Error('FFprobe returned invalid JSON');
  }
  const tracks = { status: 'available', audio: [], subtitles: [] };
  for (const stream of output.streams) {
    if (!stream || typeof stream !== 'object') continue;
    const index = stream.index;
    const kind = stream.codec_type;
    const codec = normalizeTrackText(stream.codec_name);
    if (!Number.isSafeInteger(index) || index < 0 || (kind !== 'audio' && kind !== 'subtitle') || !codec) continue;
    const track = { index, kind, codec };
    const language = normalizeTrackText(stream.tags?.language);
    const title = normalizeTrackText(stream.tags?.title);
    const disposition = normalizedTrackDisposition(stream.disposition);
    if (language) track.language = language;
    if (title) track.title = title;
    if (disposition) track.disposition = disposition;
    if (kind === 'audio') {
      if (Number.isSafeInteger(stream.channels) && stream.channels > 0) track.channels = stream.channels;
      tracks.audio.push(track);
    } else {
      tracks.subtitles.push(track);
    }
  }
  return tracks;
}

// Keep routing metadata private to the server. The browser receives only the
// normalized track labels above; this bounded subset is enough to decide
// whether a selected stream can be copied into the CMAF delivery contract.
function normalizeMediaRouting(output) {
  if (!output || typeof output !== 'object' || !Array.isArray(output.streams)) return null;
  const streams = output.streams.filter((stream) => stream && typeof stream === 'object' && Number.isSafeInteger(stream.index) && stream.index >= 0);
  const video = streams.find((stream) => stream.codec_type === 'video');
  if (!video) return null;
  const audio = new Map(streams.filter((stream) => stream.codec_type === 'audio').map((stream) => [stream.index, {
    index: stream.index, codec: normalizeTrackText(stream.codec_name), profile: normalizeTrackText(stream.profile), channels: Number.isSafeInteger(stream.channels) ? stream.channels : null
  }]));
  return {
    video: {
      index: video.index,
      codec: normalizeTrackText(video.codec_name),
      pixFmt: normalizeTrackText(video.pix_fmt),
      fieldOrder: normalizeTrackText(video.field_order)
    },
    audio
  };
}

function createFfprobeRunner({
  command = resolveMediaCommand('ffprobe'),
  spawnProcess = spawn,
  timeoutMs = FFPROBE_TIMEOUT_MS,
  maximumOutputBytes = MAX_FFPROBE_OUTPUT_BYTES
} = {}) {
  return (filePath) => new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, [
        '-v', 'error',
        '-show_streams',
        '-show_entries', 'format=duration:stream=index,codec_type,codec_name,profile,pix_fmt,field_order,channels:stream_tags=language,title:stream_disposition=default,forced,hearing_impaired,visual_impaired',
        '-of', 'json',
        filePath
      ], { shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      reject(error);
      return;
    }
    let outputSize = 0;
    const output = [];
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const stop = (message) => {
      child.kill();
      finish(new Error(message));
    };
    const timeout = setTimeout(() => stop('FFprobe timed out'), timeoutMs);
    child.once('error', () => finish(new Error('FFprobe unavailable')));
    child.stdout.on('error', () => finish(new Error('FFprobe output failed')));
    child.stdout.on('data', (chunk) => {
      outputSize += chunk.length;
      if (outputSize > maximumOutputBytes) return stop('FFprobe output exceeded limit');
      output.push(chunk);
    });
    child.once('close', (code) => {
      if (code !== 0) return finish(new Error('FFprobe failed'));
      try {
        finish(null, JSON.parse(Buffer.concat(output).toString('utf8')));
      } catch {
        finish(new Error('FFprobe returned invalid JSON'));
      }
    });
  });
}

function sanitizeFfmpegDiagnostic(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:token|access_token|authorization)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, '[path]')
    .replace(/\/(?:[^\s"']+\/)*[^\s"']+/g, '[path]')
    .replace(/[^\x20-\x7e\r\n\t]/g, '?')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function deriveHlsVodJobTimeoutMs(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return HLS_VOD_JOB_MAX_TIMEOUT_MS;
  const estimated = Math.ceil(durationSeconds * 1000 * HLS_VOD_JOB_DURATION_MULTIPLIER) + HLS_VOD_JOB_SLACK_MS;
  return Math.min(HLS_VOD_JOB_MAX_TIMEOUT_MS, Math.max(HLS_VOD_JOB_MIN_TIMEOUT_MS, estimated));
}

function normalizeConversionProgress({ outTimeUs, durationSeconds, elapsedSeconds } = {}) {
  const progress = {};
  // The conversion deadline bounds the only time values that cross the room
  // boundary. It prevents a bad clock or malformed progress report from
  // publishing unsafe integers while still allowing an unknown duration's
  // maximum job allowance.
  const deadlineSeconds = Math.floor(deriveHlsVodJobTimeoutMs(durationSeconds) / 1000);
  const normalizedElapsed = Number.isFinite(elapsedSeconds) && elapsedSeconds >= 0
    ? Math.min(deadlineSeconds, Math.floor(elapsedSeconds))
    : null;
  if (normalizedElapsed !== null) progress.elapsedSeconds = normalizedElapsed;
  if (!Number.isFinite(outTimeUs) || outTimeUs < 0 || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return Object.keys(progress).length ? progress : null;
  }
  const completedSeconds = Math.min(outTimeUs / 1_000_000, durationSeconds);
  const percent = Math.min(100, Math.max(0, Math.floor((completedSeconds / durationSeconds) * 100)));
  progress.percent = percent;
  // ETA is a rate estimate, not a promise. It stays unavailable until at least
  // one whole percent is complete, and is withheld rather than capped when it
  // exceeds the known conversion deadline.
  if (percent >= 1 && normalizedElapsed !== null && normalizedElapsed > 0) {
    const etaSeconds = Math.ceil(normalizedElapsed * ((durationSeconds - completedSeconds) / completedSeconds));
    if (Number.isSafeInteger(etaSeconds) && etaSeconds >= 0 && etaSeconds <= deadlineSeconds) progress.etaSeconds = etaSeconds;
  }
  return progress;
}

function encoderVideoArgs(encoder) {
  switch (encoder) {
    case 'h264_nvenc': return ['-c:v', encoder, '-preset', 'p4', '-cq', '22'];
    case 'h264_qsv': return ['-c:v', encoder, '-preset', 'veryfast', '-global_quality', '22'];
    case 'h264_amf': return ['-c:v', encoder, '-quality', 'speed', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '22'];
    default: return ['-c:v', CPU_ENCODER, '-preset', 'veryfast', '-crf', '22'];
  }
}

function createFfmpegRunner({
  command = resolveMediaCommand('ffmpeg'),
  spawnProcess = spawn,
  timeoutMs,
  maximumOutputBytes = MAX_FFMPEG_OUTPUT_BYTES,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  return (inputPath, outputDir, delivery) => {
    const jobTimeoutMs = timeoutMs ?? deriveHlsVodJobTimeoutMs(delivery?.duration);
    let cancel = () => {};
    const result = new Promise((resolve, reject) => {
      // Map exact global stream indexes. Container-relative selectors such as
      // 0:v:0 silently pick the wrong stream for files with attachments or
      // multiple video tracks.
      const videoTrack = delivery.videoTrack || { index: 0 };
      const audioTrack = delivery.audioTrack || (Number.isSafeInteger(delivery.audioTrackIndex) ? { index: delivery.audioTrackIndex } : null);
      const subtitleTrack = delivery.subtitleTrack || (Number.isSafeInteger(delivery.subtitleTrackIndex) ? { index: delivery.subtitleTrackIndex } : null);
      // The default retains the standalone runner's conservative historic
      // behavior; server delivery always supplies an explicit route.
      const route = delivery.route || { video: 'transcode', audio: 'transcode' };
      if (!Number.isSafeInteger(videoTrack?.index) || videoTrack.index < 0 || !Number.isSafeInteger(audioTrack?.index) || audioTrack.index < 0
        || !SAFE_STREAM_MODES.has(route.video) || !SAFE_STREAM_MODES.has(route.audio)) throw new Error('HLS requires selected video and audio tracks');
      const args = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', '-i', inputPath, '-map', `0:${videoTrack.index}`, '-map', `0:${audioTrack.index}`];
      if (subtitleTrack) args.push('-map', `0:${subtitleTrack.index}`);
      if (route.video === 'copy') args.push('-c:v', 'copy');
      else {
        const encoder = SAFE_ENCODERS.has(delivery?.encoder) ? delivery.encoder : CPU_ENCODER;
        // Decode remains software-only. Only the H.264 encoder is selectable.
        args.push(...encoderVideoArgs(encoder), '-pix_fmt', 'yuv420p');
      }
      // Preserve compatible AAC-LC mono/stereo exactly. Incompatible audio is
      // downmixed for Chromium only when audio conversion is necessary.
      if (route.audio === 'copy') args.push('-c:a', 'copy');
      else args.push('-c:a', 'aac', '-ac', '2');
      // Subtitle conversion is intentionally independent from A/V routing.
      if (subtitleTrack) args.push('-c:s', 'webvtt');
      const variantMap = `v:0,a:0${subtitleTrack ? ',s:0,sgroup:subs' : ''}`;
      // Keep init.mp4 relative, but run FFmpeg inside this protected generation
      // directory: the HLS muxer resolves its fMP4 init filename from cwd.
      // Publish complete playlists and CMAF artifacts by rename. They remain
      // private until FFmpeg exits successfully and the complete VOD graph is
      // structurally validated.
      args.push('-f', 'hls', '-hls_time', '6', '-hls_list_size', '0', '-hls_flags', 'temp_file', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', '-hls_segment_filename', path.join(outputDir, 'segment_%v_%05d.m4s'), '-master_pl_name', 'master.m3u8', '-var_stream_map', variantMap);
      args.push(path.join(outputDir, 'media_%v.m3u8'));
      let child;
      try {
        child = spawnProcess(command, args, { cwd: outputDir, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        reject(error);
        return;
      }
      let outputSize = 0;
      let stderrTail = '';
      let progressBuffer = '';
      let progressReport = {};
      let settled = false;
      let timeout;
      const failure = (errorClass, message) => {
        const error = new Error(message);
        error.ffmpegErrorClass = errorClass;
        error.ffmpegStderrTail = stderrTail;
        return error;
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeoutFn(timeout);
        if (error) reject(error); else resolve();
      };
      const stop = (errorClass, message) => {
        if (settled) return;
        try { child.kill(); } catch {}
        finish(failure(errorClass, message));
      };
      cancel = () => stop('cancelled', 'FFmpeg cancelled');
      timeout = setTimeoutFn(() => stop('job-timeout', 'FFmpeg VOD job timed out'), jobTimeoutMs);
      child.once('error', () => stop('unavailable', 'FFmpeg unavailable'));
      const observeOutput = (stream, isStderr = false) => {
        stream.on('error', () => stop('output-failed', 'FFmpeg output failed'));
        stream.on('data', (chunk) => {
          outputSize += chunk.length;
          if (isStderr) stderrTail = `${stderrTail}${sanitizeFfmpegDiagnostic(chunk)}`.slice(-MAX_FFMPEG_DIAGNOSTIC_TAIL_BYTES);
          if (!isStderr && typeof delivery?.onProgress === 'function') {
            progressBuffer += chunk.toString('utf8');
            let newline;
            while ((newline = progressBuffer.indexOf('\n')) >= 0) {
              const line = progressBuffer.slice(0, newline).replace(/\r$/, '');
              progressBuffer = progressBuffer.slice(newline + 1);
              const separator = line.indexOf('=');
              if (separator < 1) continue;
              const key = line.slice(0, separator);
              const value = line.slice(separator + 1);
              if (key === 'progress') {
                const outTimeUs = Number(progressReport.out_time_us);
                if (Number.isFinite(outTimeUs) && outTimeUs >= 0) delivery.onProgress({ outTimeUs });
                progressReport = {};
              } else if (key === 'out_time_us') progressReport.out_time_us = value;
            }
          }
          if (outputSize > maximumOutputBytes) stop('output-limit', 'FFmpeg output exceeded limit');
        });
      };
      observeOutput(child.stdout);
      observeOutput(child.stderr, true);
      child.once('close', (code) => finish(code === 0 ? null : failure('failed', 'FFmpeg failed')));
    });
    result.cancel = () => cancel();
    return result;
  };
}

function encoderProfile(encoder) {
  if (!SAFE_ENCODERS.has(encoder)) throw new RangeError('Unknown H.264 encoder');
  // Preserve the existing CPU identity so completed caches remain usable.
  return encoder === CPU_ENCODER ? 'selected-cmaf-x264-v1' : `selected-cmaf-${encoder}-v1`;
}

function createFfmpegEncoderProbe({ command = resolveMediaCommand('ffmpeg'), spawnProcess = spawn, timeoutMs = 10_000 } = {}) {
  const run = (args, options = {}) => new Promise((resolve, reject) => {
    let child;
    try { child = spawnProcess(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...options }); } catch (error) { reject(error); return; }
    const output = [];
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve(value);
    };
    const timeout = setTimeout(() => { try { child.kill(); } catch {} finish(new Error('FFmpeg encoder probe timed out')); }, timeoutMs);
    child.once('error', () => finish(new Error('FFmpeg unavailable')));
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('error', () => finish(new Error('FFmpeg encoder probe output failed')));
      stream.on('data', (chunk) => output.push(chunk));
    }
    child.once('close', (code) => code === 0 ? finish(null, Buffer.concat(output).toString('utf8')) : finish(new Error('FFmpeg encoder probe failed')));
  });
  return async (encoder) => {
    const encoders = await run(['-hide_banner', '-encoders']);
    if (!new RegExp(`^\\s*[A-Z.]+\\s+${encoder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'm').test(encoders)) return false;
    // A compile-list entry alone is insufficient: drivers/devices may be absent.
    // Smoke only encoder initialization and frame output. HLS publication is not
    // a hardware capability: coupling it here can reject a working NVENC device
    // because of an unrelated muxer or filesystem failure. The actual CMAF job
    // still has its existing one-time CPU retry on a real runtime failure.
    try {
      await run(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=10', '-t', '0.2', '-an', ...encoderVideoArgs(encoder), '-pix_fmt', 'yuv420p', '-f', 'null', '-']);
      return true;
    } catch { return false; }
  };
}

class EncoderManager {
  constructor({ probe = createFfmpegEncoderProbe(), forceCpu = process.env[FORCE_CPU_ENCODER_ENV] === '1' } = {}) {
    this.probe = probe;
    this.forceCpu = forceCpu;
    this.quarantined = new Set();
    this.resolved = null;
  }
  async resolve() {
    if (this.resolved) return this.resolved;
    if (this.forceCpu) return (this.resolved = { encoder: CPU_ENCODER });
    for (const encoder of ENCODER_ORDER) {
      if (this.quarantined.has(encoder)) continue;
      try { if (await this.probe(encoder)) return (this.resolved = { encoder }); } catch {}
    }
    return (this.resolved = { encoder: CPU_ENCODER });
  }
  quarantine(encoder) {
    if (!GPU_ENCODERS.includes(encoder)) return;
    this.quarantined.add(encoder);
    if (this.resolved?.encoder === encoder) this.resolved = null;
  }
}

const GENERATED_SETTING_FREE_CUE_ID = '__reproductor_generated_setting_free__';

function transformGeneratedWebVttCues(vtt) {
  // The DOM exposes defaults for several authored WebVTT settings (for example
  // `align:center` and `size:100%`), so it cannot reliably distinguish them
  // from omitted settings. Rewrite only source-setting-free generated cues.
  // Their legal WebVTT line percentage and end anchor place native captions
  // just above the player dock; authored timing settings and cue text are left
  // byte-for-byte intact.
  if (typeof vtt !== 'string' || !vtt.startsWith('WEBVTT')) return vtt;
  const lineEnding = vtt.includes('\r\n') ? '\r\n' : '\n';
  const timing = /^(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}\.\d{3}\s*$/;
  return vtt.split(/(\r?\n\r?\n)/).map((block) => {
    const lines = block.split(/\r?\n/);
    const timingIndex = lines.findIndex((line, index) => index < 2 && timing.test(line));
    if (timingIndex < 0) return block;
    lines[timingIndex] += ' line:85%,end align:center';
    if (timingIndex === 0) lines.unshift(GENERATED_SETTING_FREE_CUE_ID);
    else lines[0] = `${GENERATED_SETTING_FREE_CUE_ID}:${lines[0]}`;
    return lines.join(lineEnding);
  }).join('');
}

function parseWebVttTimestamp(value) {
  const match = /^(?:(\d{2,}):)?(\d{2}):(\d{2}\.\d{3})$/.exec(value.trim());
  return match ? (Number(match[1] || 0) * 3600) + (Number(match[2]) * 60) + Number(match[3]) : null;
}

function formatWebVttTimestamp(value) {
  const milliseconds = Math.max(0, Math.round(value * 1000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor(milliseconds / 60_000) % 60;
  const seconds = Math.floor(milliseconds / 1000) % 60;
  const fraction = String(milliseconds % 1000).padStart(3, '0');
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${fraction}`;
}

function subtitlePlaylistSegments(playlist) {
  const segments = [];
  let duration = 0;
  let discontinuity = false;
  for (const line of playlist.split(/\r?\n/).map((value) => value.trim())) {
    if (line.startsWith('#EXTINF:')) {
      const parsed = Number(line.slice('#EXTINF:'.length).split(',', 1)[0]);
      duration = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line && !line.startsWith('#')) {
      if (line.endsWith('.vtt')) segments.push({ name: line, duration, discontinuity });
      duration = 0;
      discontinuity = false;
    }
  }
  return segments;
}

function webVttTimestampMap(segment) {
  const header = segment.slice(0, segment.search(/\r?\n\r?\n/));
  const line = header.split(/\r?\n/).find((value) => /^X-TIMESTAMP-MAP\s*=/.test(value));
  if (!line) return null;
  const attributes = line.slice(line.indexOf('=') + 1);
  const local = /(?:^|,)\s*LOCAL:([^,]+)/.exec(attributes)?.[1];
  const mpegTs = /(?:^|,)\s*MPEGTS:(\d+)/.exec(attributes)?.[1];
  const localSeconds = local === undefined ? null : parseWebVttTimestamp(local);
  const mpegTsValue = mpegTs === undefined ? null : Number(mpegTs);
  return Number.isFinite(localSeconds) && Number.isSafeInteger(mpegTsValue) ? { localSeconds, mpegTs: mpegTsValue } : null;
}

function normalizeWebVttCueTimes(body, offset) {
  return body.split(/\r?\n/).map((line) => {
    const match = /^(\s*)((?:(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}))\s+-->\s+((?:(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}))(.*)$/.exec(line);
    if (!match) return line;
    const start = parseWebVttTimestamp(match[2]);
    const end = parseWebVttTimestamp(match[3]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return line;
    return `${match[1]}${formatWebVttTimestamp(start + offset)} --> ${formatWebVttTimestamp(end + offset)}${match[4]}`;
  }).join('\n');
}

async function aggregateSelectedSubtitleWebVtt(entry) {
  if (!Number.isSafeInteger(entry?.selection?.subtitleTrackIndex)) throw new Error('No selected subtitles');
  const master = await readStableHlsFile(path.join(entry.directory, 'master.m3u8'));
  const { subtitles } = hlsMasterRenditions(master);
  if (subtitles.length !== 1) throw new Error('Selected subtitle rendition is unavailable');
  const playlist = await readStableHlsFile(path.join(entry.directory, subtitles[0]));
  // Retain the normal protected-artifact validation before interpreting the
  // playlist's timing metadata; aggregate assembly must never widen its reads.
  hlsManifestArtifacts(playlist);
  const segments = subtitlePlaylistSegments(playlist);
  if (!segments.length) throw new Error('Selected subtitle cues are unavailable');
  let totalBytes = 0;
  let timelineEnd = 0;
  let previousMpegTs = null;
  let previousUnwrappedMpegTs = null;
  let mpegTsBase = null;
  const cueBlocks = [];
  for (const segmentInfo of segments) {
    const segment = await readStableHlsFile(path.join(entry.directory, segmentInfo.name));
    if (!segment.startsWith('WEBVTT')) throw new Error('Invalid selected subtitle segment');
    totalBytes += Buffer.byteLength(segment);
    if (totalBytes > MAX_AGGREGATE_SUBTITLE_BYTES) throw new Error('Selected subtitles exceed aggregate limit');
    const separator = segment.search(/\r?\n\r?\n/);
    if (separator < 0) {
      // FFmpeg emits empty VOD subtitle intervals as just a WebVTT header and
      // terminal line ending. They have no cue body to aggregate, but their
      // EXTINF duration remains part of the shared presentation timeline.
      if (/^WEBVTT(?:\r\n|\n)$/.test(segment)) {
        timelineEnd += segmentInfo.duration;
        continue;
      }
      throw new Error('Invalid selected subtitle segment');
    }
    const timestampMap = webVttTimestampMap(segment);
    let offset = 0;
    if (timestampMap) {
      const ticksPerSecond = 90_000;
      const wrap = 2 ** 33;
      const fallbackStart = timelineEnd;
      let segmentStart;
      if (previousMpegTs === null || segmentInfo.discontinuity) {
        // A discontinuity may reset the 33-bit MPEG-TS clock. Its playlist
        // duration is the only shared timeline anchor across that boundary.
        segmentStart = fallbackStart;
        mpegTsBase = timestampMap.mpegTs - (segmentStart * ticksPerSecond);
        previousUnwrappedMpegTs = timestampMap.mpegTs;
      } else {
        let delta = timestampMap.mpegTs - previousMpegTs;
        if (delta > wrap / 2) delta -= wrap;
        if (delta < -wrap / 2) delta += wrap;
        previousUnwrappedMpegTs += delta;
        const mappedStart = (previousUnwrappedMpegTs - mpegTsBase) / ticksPerSecond;
        // Broken/reset clocks without a discontinuity must not move aggregate
        // cues backwards; retain the playlist's monotonically accumulated VOD time.
        segmentStart = mappedStart >= fallbackStart - 0.001 ? mappedStart : fallbackStart;
        if (segmentStart === fallbackStart && mappedStart < fallbackStart - 0.001) {
          mpegTsBase = previousUnwrappedMpegTs - (segmentStart * ticksPerSecond);
        }
      }
      previousMpegTs = timestampMap.mpegTs;
      offset = segmentStart - timestampMap.localSeconds;
    }
    const body = segment.slice(separator).replace(/^\r?\n\r?\n/, '');
    cueBlocks.push(normalizeWebVttCueTimes(body, offset));
    timelineEnd += segmentInfo.duration;
  }
  return `WEBVTT\n\n${cueBlocks.join('\n\n')}`;
}

function selectedSubtitleRenditionMetadata(manifest) {
  // This delivery has exactly one selected subtitle rendition. Declare it as
  // selected/default so hls.js exposes and activates it consistently instead
  // of depending on browser-specific implicit rendition defaults.
  return manifest.split(/(\r?\n)/).map((part) => {
    if (!/^#EXT-X-MEDIA:TYPE=SUBTITLES\b/.test(part)) return part;
    return part
      .replace(/,?DEFAULT=(?:YES|NO)/g, '')
      .replace(/,?AUTOSELECT=(?:YES|NO)/g, '')
      .replace(/,?FORCED=(?:YES|NO)/g, '')
      + ',DEFAULT=YES,AUTOSELECT=YES,FORCED=NO';
  }).join('');
}

function tokenizeHlsManifest(manifest, token) {
  const addToken = (uri) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(uri)
    ? `${uri}?token=${encodeURIComponent(token)}`
    : uri;
  return manifest.split(/(\r?\n)/).map((part) => {
    if (!part || /^\r?\n$/.test(part)) return part;
    if (!part.startsWith('#')) return addToken(part);
    return part.replace(/URI="([^"]+)"/g, (match, uri) => `URI="${addToken(uri)}"`);
  }).join('');
}

function isSafeHlsArtifactName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && !name.endsWith('.tmp');
}

async function readStableHlsFile(filePath) {
  const before = await fsp.stat(filePath);
  if (!before.isFile() || before.size === 0) throw new Error('HLS artifact is not published');
  const content = await fsp.readFile(filePath, 'utf8');
  const after = await fsp.stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('HLS artifact changed while reading');
  return content;
}

function hlsManifestUriAttributes(line) {
  const uriAttribute = /(?:^|[,:])\s*URI\s*=/g;
  const quotedUriAttribute = /(?:^|[,:])\s*URI\s*=\s*"([^"]+)"(?=\s*(?:,|$))/g;
  const attributes = [...line.matchAll(uriAttribute)];
  const quoted = [...line.matchAll(quotedUriAttribute)];
  // URI attributes are references, not optional metadata. Reject the complete
  // graph when any URI attribute is unquoted or has trailing malformed text.
  if (attributes.length !== quoted.length) throw new Error('Malformed HLS manifest URI attribute');
  return quoted.map((match) => match[1]);
}

function hlsManifestArtifacts(manifest) {
  if (!manifest.startsWith('#EXTM3U')) throw new Error('Invalid HLS manifest');
  const artifacts = new Set();
  for (const line of manifest.split(/\r?\n/).map((value) => value.trim())) {
    if (!line) continue;
    if (!line.startsWith('#')) {
      if (!isSafeHlsArtifactName(line)) throw new Error('Unsafe HLS manifest reference');
      artifacts.add(line);
    }
    for (const uri of hlsManifestUriAttributes(line)) {
      if (!isSafeHlsArtifactName(uri)) throw new Error('Unsafe HLS manifest reference');
      artifacts.add(uri);
    }
  }
  return [...artifacts];
}

function hlsMasterHasVariant(master) {
  const lines = master.split(/\r?\n/).map((line) => line.trim());
  return lines.some((line, index) => line.startsWith('#EXT-X-STREAM-INF:')
    && isSafeHlsArtifactName(lines.slice(index + 1).find((candidate) => candidate && !candidate.startsWith('#'))));
}

async function readStableHlsArtifact(filePath) {
  const before = await fsp.stat(filePath);
  if (!before.isFile() || before.size === 0) throw new Error('HLS segment is not published');
  const handle = await fsp.open(filePath, 'r');
  try {
    const sample = Buffer.alloc(1);
    if ((await handle.read(sample, 0, 1, 0)).bytesRead !== 1) throw new Error('HLS segment is not readable');
  } finally {
    await handle.close();
  }
  const after = await fsp.stat(filePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('HLS segment changed while reading');
}

function hlsMasterRenditions(master) {
  const muxed = [];
  const subtitles = [];
  const lines = master.split(/\r?\n/).map((line) => line.trim());
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^#EXT-X-MEDIA:TYPE=SUBTITLES\b/.test(line)) {
      const match = /\bURI="([^"]+)"/.exec(line);
      if (match && isSafeHlsArtifactName(match[1])) subtitles.push(match[1]);
    }
    if (!line.startsWith('#EXT-X-STREAM-INF:')) continue;
    const uri = lines.slice(index + 1).find((candidate) => candidate && !candidate.startsWith('#'));
    if (uri && isSafeHlsArtifactName(uri)) muxed.push(uri);
  }
  return { muxed, subtitles };
}

function hlsMasterWithoutPendingSubtitles(master) {
  return master.split(/\r?\n/)
    .filter((line) => !/^#EXT-X-MEDIA:TYPE=SUBTITLES\b/.test(line))
    .map((line) => line.startsWith('#EXT-X-STREAM-INF:')
      ? line.replace(/,?SUBTITLES="[^"]*"/g, '')
      : line)
    .join('\n');
}

function hlsReadinessError(missing) {
  const error = new Error('HLS startup artifact is not published');
  error.hlsMissingArtifacts = missing;
  return error;
}

async function initialHlsArtifactsReady(entry) {
  const { directory, playlistCache } = entry;
  const artifactNames = new Set(['master.m3u8']);
  let master;
  try {
    master = await readStableHlsFile(path.join(directory, 'master.m3u8'));
  } catch {
    throw hlsReadinessError({ master: 1 });
  }
  playlistCache.set('master.m3u8', master);
  const { muxed, subtitles } = hlsMasterRenditions(master);
  if (!muxed.length) throw hlsReadinessError({ 'muxed-playlist': 1 });
  // A selected subtitle is intentionally not a startup requirement. FFmpeg can
  // publish its playlist/VTT after the CMAF video+audio pair is playable.
  for (const subtitle of subtitles) artifactNames.add(subtitle);
  for (const renditionName of muxed) {
    artifactNames.add(renditionName);
    let rendition;
    try {
      rendition = await readStableHlsFile(path.join(directory, renditionName));
    } catch {
      throw hlsReadinessError({ 'muxed-playlist': 1 });
    }
    playlistCache.set(renditionName, rendition);
    const renditionArtifacts = hlsManifestArtifacts(rendition);
    const initName = renditionArtifacts.find((name) => name.endsWith('.mp4'));
    const segmentName = renditionArtifacts.find((name) => name.endsWith('.m4s'));
    if (!initName) throw hlsReadinessError({ 'init.mp4': 1 });
    if (!segmentName) throw hlsReadinessError({ 'first.m4s': 1 });
    artifactNames.add(initName);
    artifactNames.add(segmentName);
    try {
      await readStableHlsArtifact(path.join(directory, initName));
    } catch {
      throw hlsReadinessError({ 'init.mp4': 1 });
    }
    try {
      await readStableHlsArtifact(path.join(directory, segmentName));
    } catch {
      throw hlsReadinessError({ 'first.m4s': 1 });
    }
  }
  return { artifactNames, subtitleArtifacts: new Set(subtitles) };
}

async function subtitleHlsArtifactsReady(entry) {
  const { directory, playlistCache } = entry;
  const master = await readStableHlsFile(path.join(directory, 'master.m3u8'));
  playlistCache.set('master.m3u8', master);
  const { subtitles } = hlsMasterRenditions(master);
  if (!subtitles.length) throw new Error('HLS master has no subtitle rendition');
  for (const subtitleName of subtitles) {
    const playlist = await readStableHlsFile(path.join(directory, subtitleName));
    playlistCache.set(subtitleName, playlist);
    const vttName = hlsManifestArtifacts(playlist).find((name) => name.endsWith('.vtt'));
    if (!vttName) throw new Error('HLS subtitle rendition has no WebVTT segment');
    await readStableHlsArtifact(path.join(directory, vttName));
  }
}

async function waitForInitialHlsReadiness(entry, timeoutMs = HLS_READINESS_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (entry.failure) throw entry.failure;
    try {
      const readiness = await initialHlsArtifactsReady(entry);
      entry.manifestArtifacts = readiness.artifactNames;
      entry.subtitleArtifacts = readiness.subtitleArtifacts;
      return;
    } catch (error) {
      lastError = error;
      if (entry.failure) throw entry.failure;
      if (entry.finished) throw new Error('FFmpeg finished before HLS was ready');
    }
    await new Promise((resolve) => setTimeout(resolve, HLS_READINESS_POLL_MS));
  }
  const error = new Error('FFmpeg HLS readiness timed out');
  error.hlsLifecycleStatus = 'timeout';
  error.hlsFailureReason = 'readiness-timeout';
  error.hlsMissingArtifacts = lastError?.hlsMissingArtifacts || { master: 1 };
  throw error;
}

async function waitForSubtitleHlsReadiness(entry, timeoutMs = HLS_READINESS_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (entry.failure || entry.cancelled) throw entry.failure || new Error('HLS cancelled');
    try {
      await subtitleHlsArtifactsReady(entry);
      return;
    } catch {
      if (entry.finished) throw new Error('FFmpeg finished before subtitle HLS was ready');
    }
    await new Promise((resolve) => setTimeout(resolve, HLS_READINESS_POLL_MS));
  }
  throw new Error('HLS subtitle readiness timed out');
}

async function readActiveHlsArtifact(entry, artifactName, read) {
  // A subtitle rendition is optional after A/V readiness. Do not turn a missing
  // WebVTT playlist into a startup-length request pile-up while its producer is
  // still publishing; a later complete playlist is admitted independently.
  const deadline = Date.now() + entry.hlsArtifactRetryTimeoutMs;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      const canRetry = entry.manifestArtifacts.has(artifactName)
        && !entry.failure && !entry.finished && !entry.cancelled
        && Date.now() < deadline;
      if (!canRetry) throw error;
      await new Promise((resolve) => setTimeout(resolve, HLS_ARTIFACT_RETRY_POLL_MS));
    }
  }
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

function resolveRuntimeMediaDirectory(environment = process.env) {
  const configured = environment[RUNTIME_MEDIA_DIR_ENV];
  return typeof configured === 'string' && configured.trim()
    ? path.resolve(configured)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'reproductor-media-'));
}

function resolveHlsCacheDirectory(environment = process.env) {
  const configured = environment[HLS_CACHE_DIR_ENV];
  return typeof configured === 'string' && configured.trim() ? path.resolve(configured) : null;
}

function cacheOwnerIsValid(directory) {
  try {
    return fs.readFileSync(path.join(directory, HLS_CACHE_OWNER_FILE), 'utf8').trim() === HLS_CACHE_OWNER_LINE;
  } catch { return false; }
}

function deliveryRoute(media, selection) {
  const video = media?.routing?.video;
  const audio = media?.routing?.audio?.get(selection.audioTrackIndex);
  if (!Number.isSafeInteger(video?.index) || !audio) return null;
  // Copy only the deliberately narrow browser contract. Missing FFprobe fields
  // are incompatible by design, never optimistic.
  const videoCopy = video.codec === 'h264' && video.pixFmt === 'yuv420p' && video.fieldOrder === 'progressive';
  const audioCopy = audio.codec === 'aac' && audio.profile === 'LC' && (audio.channels === 1 || audio.channels === 2);
  const videoMode = videoCopy ? 'copy' : 'transcode';
  const audioMode = audioCopy ? 'copy' : 'transcode';
  const mode = videoCopy && audioCopy ? 'copy' : videoCopy ? 'audio-transcode' : audioCopy ? 'video-transcode' : 'full-transcode';
  return { mode, video: videoMode, audio: audioMode, subtitle: selection.subtitleTrackIndex === null ? 'none' : 'webvtt', videoTrack: { index: video.index }, audioTrack: { index: audio.index } };
}

function routingProfile(route, encoder) {
  return `${HLS_ROUTING_VERSION}:${route.mode}:${route.video}:${route.audio}:${route.subtitle}:${route.video === 'transcode' ? encoderProfile(encoder) : 'none'}`;
}

function hlsCacheKey(media, selection, route, encoder) {
  return crypto.createHash('sha256').update(JSON.stringify({
    contentId: media.contentId,
    audioTrackIndex: selection.audioTrackIndex,
    subtitleTrackIndex: selection.subtitleTrackIndex,
    routing: routingProfile(route, encoder),
    topology: HLS_TOPOLOGY_VERSION,
    subtitlePositioningVersion: selection.subtitleTrackIndex === null ? null : HLS_SUBTITLE_POSITIONING_VERSION
  })).digest('hex');
}

function cacheProfileRecord(media, selection, route, encoder) {
  return { contentId: media.contentId, audioTrackIndex: selection.audioTrackIndex, subtitleTrackIndex: selection.subtitleTrackIndex, route: route.mode, videoMode: route.video, audioMode: route.audio, subtitleMode: route.subtitle, encoder: route.video === 'transcode' ? encoder : null, topology: HLS_TOPOLOGY_VERSION, routingVersion: HLS_ROUTING_VERSION, subtitlePositioningVersion: selection.subtitleTrackIndex === null ? null : HLS_SUBTITLE_POSITIONING_VERSION };
}

function validCacheProfile(profile) {
  return profile && typeof profile === 'object'
    && typeof profile.contentId === 'string' && /^[a-f0-9]{64}$/.test(profile.contentId)
    && Number.isSafeInteger(profile.audioTrackIndex) && profile.audioTrackIndex >= 0
    && (profile.subtitleTrackIndex === null || (Number.isSafeInteger(profile.subtitleTrackIndex) && profile.subtitleTrackIndex >= 0))
    && SAFE_ROUTE_MODES.has(profile.route) && SAFE_STREAM_MODES.has(profile.videoMode) && SAFE_STREAM_MODES.has(profile.audioMode)
    && (profile.subtitleMode === 'none' || profile.subtitleMode === 'webvtt')
    && ((profile.videoMode === 'transcode' && SAFE_ENCODERS.has(profile.encoder)) || (profile.videoMode === 'copy' && profile.encoder === null))
    && profile.topology === HLS_TOPOLOGY_VERSION && profile.routingVersion === HLS_ROUTING_VERSION
    // Rewritten native-positioning entries cannot safely be distinguished from
    // authored settings. A/V-only entries remain reusable across this visual
    // policy; subtitle entries require the current DOM-overlay revision.
    && (profile.subtitleTrackIndex === null
      ? (profile.subtitlePositioningVersion === undefined || profile.subtitlePositioningVersion === null || profile.subtitlePositioningVersion === HLS_SUBTITLE_POSITIONING_VERSION)
      : profile.subtitlePositioningVersion === HLS_SUBTITLE_POSITIONING_VERSION);
}

async function directorySize(directory) {
  let total = 0;
  for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isFile()) total += (await fsp.stat(candidate)).size;
    else if (entry.isDirectory()) total += await directorySize(candidate);
  }
  return total;
}

async function validateCompletedHlsCacheEntry(directory, validateOutput = null) {
  try {
    if ((await fsp.readFile(path.join(directory, HLS_CACHE_ENTRY_MARKER), 'utf8')).trim() !== HLS_CACHE_OWNER_LINE) return null;
    const pending = [{ name: 'master.m3u8', media: false }];
    const seen = new Set();
    const mediaRenditions = new Set();
    const artifacts = new Set();
    while (pending.length) {
      const { name, media: queuedMedia } = pending.pop();
      const media = queuedMedia || mediaRenditions.has(name);
      if (seen.has(name) || !isSafeHlsArtifactName(name)) return null;
      seen.add(name);
      const filePath = path.join(directory, name);
      if (!filePath.startsWith(directory + path.sep)) return null;
      const manifest = await readStableHlsFile(filePath);
      // Unlike live output, a persistent entry is admitted only as a complete
      // VOD graph. Never ignore a bad URI: any external, traversal, temporary,
      // missing, or incomplete reference invalidates the entire cache entry.
      const refs = hlsManifestArtifacts(manifest);
      if (name === 'master.m3u8') {
        if (!hlsMasterHasVariant(manifest)) return null;
        for (const rendition of hlsMasterRenditions(manifest).muxed) mediaRenditions.add(rendition);
      } else {
        const lines = manifest.split(/\r?\n/).map((line) => line.trim());
        const segments = lines.filter((line) => line && !line.startsWith('#'));
        if (!lines.includes('#EXT-X-ENDLIST') || !refs.length) return null;
        if (media) {
          const mapUris = lines
            .filter((line) => line.startsWith('#EXT-X-MAP:'))
            .flatMap((line) => hlsManifestUriAttributes(line));
          if (!mapUris.length || !segments.length) return null;
        }
      }
      for (const ref of refs) {
        artifacts.add(ref);
        if (ref.endsWith('.m3u8')) pending.push({ name: ref, media: false });
      }
    }
    for (const name of artifacts) {
      const filePath = path.join(directory, name);
      if (name.endsWith('.m3u8')) continue;
      await readStableHlsArtifact(filePath);
    }
    if (validateOutput && !(await validateOutput(directory, artifacts))) return null;
    let profile = null;
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(directory, HLS_CACHE_PROFILE_FILE), 'utf8'));
      if (!validCacheProfile(parsed)) return null;
      profile = parsed;
    } catch (error) {
      // Legacy CPU entries are eligible only at their exact old cache key.
      if (error?.code !== 'ENOENT') return null;
    }
    return { artifacts: new Set([...artifacts, 'master.m3u8']), size: await directorySize(directory), profile };
  } catch { return null; }
}

function createMediaServer({
  storageDir = resolveRuntimeMediaDirectory(),
  token = crypto.randomBytes(32).toString('base64url'),
  maxUploadBytes = MAX_UPLOAD_BYTES,
  hostAuthority = isHostRequest,
  lanAddresses = () => selectLanAddresses(os.networkInterfaces()),
  ffprobeRunner = createFfprobeRunner(),
  ffmpegRunner = createFfmpegRunner(),
  encoderManager = new EncoderManager(),
  diagnosticLogger = console.warn,
  hlsCacheDir = resolveHlsCacheDirectory(),
  hlsCacheMaxBytes = parsePositiveWholeBytes(process.env[HLS_CACHE_MAX_BYTES_ENV], HLS_CACHE_MAX_BYTES_ENV),
  hlsReadinessTimeoutMs = HLS_READINESS_TIMEOUT_MS,
  hlsArtifactRetryTimeoutMs = HLS_ARTIFACT_RETRY_TIMEOUT_MS,
  sessionMode = process.env.REPRODUCTOR_MANAGED_LOCAL_SESSION === '1' ? 'managed-local' : 'shared'
} = {}) {
  if (!['shared', 'managed-local'].includes(sessionMode)) {
    throw new RangeError('sessionMode must be shared or managed-local');
  }
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes <= 0) {
    throw new RangeError('maxUploadBytes must be a positive whole number of bytes');
  }
  if (!Number.isSafeInteger(hlsReadinessTimeoutMs) || hlsReadinessTimeoutMs <= 0) {
    throw new RangeError('hlsReadinessTimeoutMs must be a positive whole number of milliseconds');
  }
  if (!Number.isSafeInteger(hlsArtifactRetryTimeoutMs) || hlsArtifactRetryTimeoutMs <= 0) {
    throw new RangeError('hlsArtifactRetryTimeoutMs must be a positive whole number of milliseconds');
  }
  if (hlsCacheMaxBytes !== null && (!Number.isSafeInteger(hlsCacheMaxBytes) || hlsCacheMaxBytes <= 0)) {
    throw new RangeError(`${HLS_CACHE_MAX_BYTES_ENV} must be a positive whole number of bytes`);
  }
  fs.mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  // A local launcher starts direct and has no browser-visible bearer token.
  // Its explicit embedded-track action activates this pipeline on loopback.
  let managedLocalActive = sessionMode !== 'managed-local';
  const library = new Map();
  const stagedMedia = new Map();
  const clients = new Set();
  const hlsRoot = path.join(storageDir, 'hls');
  // The launcher creates and marks this sibling directory. An unmarked path is
  // deliberately treated as unavailable; this server never clears cache roots.
  const cacheDirectory = hlsCacheDir && cacheOwnerIsValid(hlsCacheDir) ? hlsCacheDir : null;
  const hlsArtifacts = new Map();
  // Foreground artifacts remain keyed by media ID. The speculative plan has
  // separate ownership so cancelling/replanning it can never tear down the
  // currently attached HLS source.
  let oneAheadArtifact = null;
  // A single user-selected destination may wait behind the sole active runner.
  // It is deliberately server-owned and is cleared by track/list replacement.
  let deferredOneAheadIntent = null;
  const oneAheadAdmissions = new Map();
  let oneAheadPlanningQueued = false;
  let foregroundPlanningQueued = false;
  const foregroundAdmissions = new Map();
  // Navigation commands can await cache validation. Increment this intent before
  // such an await so an older command can never publish its cached admission
  // after a newer promotion/demotion has become authoritative.
  let navigationGeneration = 0;
  // A replacement requests cancellation synchronously but its worker may still
  // be unwinding. Admissions wait here, preserving the one-worker invariant
  // without making a room-navigation response wait for FFmpeg cleanup.
  // Cleanup is asynchronous: replacement state is published immediately, but
  // new FFmpeg admission must remain behind every prior cancellation. This
  // chained barrier is separate from passive-request admission so a stuck
  // child can yield a bounded 503 without allowing a second runner to start.
  let hlsCleanupBarrier = Promise.resolve();
  const pinnedCacheKeys = new Set();
  // Room state exposes only the active position. Keep the remaining checkpoints
  // private and bind them to immutable content bytes, never playlist indexes.
  const savedPositionsByContentId = new Map();
  let state = { mediaId: null, playing: false, position: 0, trackSelection: { audioTrackIndex: null, subtitleTrackIndex: null }, hls: { status: 'idle' }, sequence: 0, updatedAt: Date.now() };

  function savedPositionFor(mediaId) {
    const contentId = library.get(mediaId)?.contentId;
    return contentId ? savedPositionsByContentId.get(contentId) || 0 : 0;
  }
  function effectiveRoomPosition() {
    const elapsed = state.playing ? Math.max(0, (Date.now() - state.updatedAt) / 1000) : 0;
    return Math.min(MAX_POSITION_SECONDS, Math.max(0, state.position + elapsed));
  }
  function savePositionFor(mediaId, position = effectiveRoomPosition(), { allowZero = false } = {}) {
    const contentId = library.get(mediaId)?.contentId;
    if (!contentId || !Number.isFinite(position)) return;
    const normalized = Math.min(MAX_POSITION_SECONDS, Math.max(0, position));
    // Detached/pre-metadata clients report the media default (0). Preserve a
    // real positive checkpoint unless this is an explicit seek-to-zero.
    if (normalized === 0 && savedPositionsByContentId.get(contentId) > 0 && !allowZero) return;
    savedPositionsByContentId.set(contentId, normalized);
  }
  function navigationPosition(outgoingMediaId, incomingMediaId, suppliedPosition, incomingResumePosition) {
    if (suppliedPosition !== undefined && (!Number.isFinite(suppliedPosition) || suppliedPosition < 0 || suppliedPosition > MAX_POSITION_SECONDS)) {
      throw Object.assign(new Error('Invalid navigation position'), { statusCode: 422 });
    }
    savePositionFor(outgoingMediaId, suppliedPosition === undefined ? effectiveRoomPosition() : suppliedPosition);
    // A browser-local checkpoint may be the only record after a room restart.
    // Seed an empty destination only; a nonzero server checkpoint remains
    // authoritative and is never replaced by a client-provided older value.
    if (savedPositionFor(incomingMediaId) === 0 && incomingResumePosition !== undefined) {
      savePositionFor(incomingMediaId, incomingResumePosition);
    }
    return savedPositionFor(incomingMediaId);
  }

  async function validateCompletedHlsOutput(directory, artifacts) {
    const initName = [...artifacts].find((name) => name.endsWith('.mp4'));
    if (!initName) return false;
    try {
      const probe = await ffprobeRunner(path.join(directory, initName));
      const streams = Array.isArray(probe?.streams) ? probe.streams : [];
      return streams.some((stream) => stream?.codec_type === 'video' && stream.codec_name === 'h264')
        && streams.some((stream) => stream?.codec_type === 'audio' && stream.codec_name === 'aac');
    } catch { return false; }
  }
  async function validateCompletedEntry(directory) {
    return validateCompletedHlsCacheEntry(directory, validateCompletedHlsOutput);
  }
  async function upgradeCachedSubtitlePositioning(directory, cached) {
    // Kept as a narrow compatibility seam for cache lookup. Entries validated
    // under the current revision are byte-preserving and need no rewrite.
    return cached?.profile?.subtitlePositioningVersion === HLS_SUBTITLE_POSITIONING_VERSION || cached?.profile?.subtitleTrackIndex === null
      ? cached
      : null;
  }

  async function findCachedHls(media, selection, route, preferredEncoder) {
    if (!cacheDirectory) return null;
    const exactKey = hlsCacheKey(media, selection, route, preferredEncoder);
    const candidates = [exactKey, ...(await fsp.readdir(cacheDirectory, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name) && entry.name !== exactKey)
      .map((entry) => entry.name).sort()];
    for (const key of candidates) {
      const directory = path.join(cacheDirectory, key);
      let valid = await validateCompletedEntry(directory);
      if (!valid) continue;
      valid = await upgradeCachedSubtitlePositioning(directory, valid);
      if (!valid) continue;
      const expected = cacheProfileRecord(media, selection, route, preferredEncoder);
      const matchingProfile = valid.profile && valid.profile.contentId === expected.contentId
        && valid.profile.audioTrackIndex === expected.audioTrackIndex
        && valid.profile.subtitleTrackIndex === expected.subtitleTrackIndex
        && valid.profile.route === expected.route && valid.profile.videoMode === expected.videoMode
        && valid.profile.audioMode === expected.audioMode && valid.profile.subtitleMode === expected.subtitleMode
        && valid.profile.topology === expected.topology && valid.profile.routingVersion === expected.routingVersion;
      // Subtitle placement is delivery-only: upgrade its VTT/profile above,
      // but never reject validated CMAF A/V merely for that policy revision.
      if (!matchingProfile) continue;
      await fsp.utimes(directory, new Date(), new Date()).catch(() => {});
      return { key, directory, ...valid, encoder: valid.profile?.encoder || CPU_ENCODER };
    }
    return null;
  }
  async function evictHlsCache(excludeKey) {
    if (!cacheDirectory || hlsCacheMaxBytes === null) return;
    const candidates = [];
    for (const entry of await fsp.readdir(cacheDirectory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name) || entry.name === excludeKey || pinnedCacheKeys.has(entry.name)) continue;
      const directory = path.join(cacheDirectory, entry.name);
      const valid = await validateCompletedEntry(directory);
      if (!valid || valid.size > hlsCacheMaxBytes) continue;
      const stat = await fsp.stat(directory).catch(() => null);
      if (stat) candidates.push({ key: entry.name, directory, size: valid.size, mtimeMs: stat.mtimeMs });
    }
    let total = candidates.reduce((sum, item) => sum + item.size, 0);
    // Account for the promoted entry, which is pinned and omitted above.
    if (excludeKey) {
      const promoted = await validateCompletedEntry(path.join(cacheDirectory, excludeKey));
      total += promoted?.size || 0;
    }
    for (const candidate of candidates.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= hlsCacheMaxBytes) break;
      // The marker is checked again immediately before deletion. Never remove
      // arbitrary or newly replaced directories in the portable cache root.
      if ((await validateCompletedEntry(candidate.directory))) {
        await fsp.rm(candidate.directory, { recursive: true, force: true });
        total -= candidate.size;
      }
    }
  }
  async function promoteHlsCache(entry) {
    if (!cacheDirectory || entry.cacheKey || entry.cancelled || entry.failure) return;
    const key = hlsCacheKey(entry.media, entry.selection, entry.route, entry.encoder);
    const destination = path.join(cacheDirectory, key);
    const staging = path.join(cacheDirectory, `.promote-${crypto.randomBytes(12).toString('hex')}`);
    try {
      await fsp.writeFile(path.join(entry.directory, HLS_CACHE_ENTRY_MARKER), `${HLS_CACHE_OWNER_LINE}\n`, { mode: 0o600 });
      await fsp.writeFile(path.join(entry.directory, HLS_CACHE_PROFILE_FILE), `${JSON.stringify(cacheProfileRecord(entry.media, entry.selection, entry.route, entry.encoder))}\n`, { mode: 0o600 });
      // The marker and safe profile record are created before validation and move; neither is served.
      const marked = await validateCompletedEntry(entry.directory);
      if (!marked || (hlsCacheMaxBytes !== null && marked.size > hlsCacheMaxBytes)) return;
      if (!marked) return;
      await fsp.rename(entry.directory, staging);
      try { await fsp.rename(staging, destination); } catch (error) {
        if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
        // A same-key entry can only be replaced when it bears our exact marker;
        // unmarked/unrelated paths are never removed by cache maintenance.
        const owned = await fsp.readFile(path.join(destination, HLS_CACHE_ENTRY_MARKER), 'utf8').then((value) => value.trim() === HLS_CACHE_OWNER_LINE).catch(() => false);
        if (!owned) {
          await fsp.rename(staging, entry.directory);
          return;
        }
        await fsp.rm(destination, { recursive: true, force: true });
        await fsp.rename(staging, destination);
      }
      const cached = await validateCompletedEntry(destination);
      if (!cached) return;
      entry.directory = destination;
      entry.cacheKey = key;
      entry.cached = true;
      pinnedCacheKeys.add(key);
      await evictHlsCache(key);
    } catch {
      // A cache failure must never fail already completed session playback.
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  function publicMedia(media) {
    return { id: media.id, contentId: media.contentId, name: media.name, size: media.size, mime: media.mime, uploadedAt: media.uploadedAt, duration: media.duration, tracks: media.tracks };
  }
  function roomState() { return { ...state, serverTime: Date.now() }; }
  function sessionMetadata() {
    return sessionMode === 'managed-local'
      ? { mode: 'managed-local', shareable: false, scope: 'loopback' }
      : { mode: 'shared', shareable: true, scope: 'lan' };
  }
  function getRoomUrl() {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : null;
    if (!Number.isSafeInteger(port) || port <= 0) return null;
    const preferredLanAddress = sessionMode === 'managed-local' ? null : lanAddresses()[0];
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
    queueForegroundPlanning();
    queueOneAheadPlanning();
    return roomState();
  }
  function setOneAheadStatus(mediaId, status, selection = state.trackSelection) {
    const current = state.oneAhead;
    const next = { status, mediaId, audioTrackIndex: selection.audioTrackIndex, subtitleTrackIndex: selection.subtitleTrackIndex };
    if (JSON.stringify(current || null) === JSON.stringify(next)) return;
    updateState({ ...state, oneAhead: next });
  }
  function queueForegroundPlanning() {
    if (foregroundPlanningQueued) return;
    const mediaId = state.mediaId;
    const media = library.get(mediaId);
    if (!mediaId || !media || state.hls?.status !== 'idle' || !hlsDelivery(media, state.trackSelection) || foregroundAdmissions.has(mediaId)) return;
    foregroundPlanningQueued = true;
    // Install the admission promise synchronously so a browser GET can only
    // observe/wait for this server decision, never race in to make one itself.
    let resolveAdmission;
    const admission = new Promise((resolve) => { resolveAdmission = resolve; });
    foregroundAdmissions.set(mediaId, admission);
    queueMicrotask(() => {
      foregroundPlanningQueued = false;
      void planForegroundHls().catch(() => {}).finally(() => {
        resolveAdmission();
        if (foregroundAdmissions.get(mediaId) === admission) foregroundAdmissions.delete(mediaId);
        // A replacement can arrive while this admission owns the media-ID
        // slot. Re-evaluate only after it releases that slot so the current
        // server state, not a passive request, authorizes the next plan.
        queueForegroundPlanning();
      });
    });
  }
  async function planForegroundHls() {
    const media = library.get(state.mediaId);
    const selection = state.trackSelection;
    if (!media || !hlsDelivery(media, selection) || state.hls?.status !== 'idle') return;
    // Admission is server-owned. A protected browser GET/HEAD only reads an
    // already admitted generation and can never preempt one-ahead work.
    const cleanupBarrier = hlsCleanupBarrier;
    await cleanupBarrier;
    // A retained promoted one-ahead worker owns the sole conversion slot. Let
    // it finish before admitting a new foreground conversion rather than
    // starting a second FFmpeg runner during navigation.
    const retainedWorker = oneAheadArtifact;
    if (retainedWorker?.runnerStarted && !retainedWorker.ready) {
      await Promise.allSettled([retainedWorker.readiness].filter(Boolean));
    }
    if (media !== library.get(state.mediaId) || state.hls?.status !== 'idle') return;
    const sink = { destroyed: false, writableEnded: false, writeHead() {}, end() { this.writableEnded = true; } };
    const url = new URL(`/hls/${encodeURIComponent(media.id)}/master.m3u8`, 'http://localhost');
    await serveHls({ method: 'INTERNAL' }, sink, url, media.id, 'master.m3u8');
  }
  function queueOneAheadPlanning() {
    if (oneAheadPlanningQueued) return;
    oneAheadPlanningQueued = true;
    queueMicrotask(() => {
      oneAheadPlanningQueued = false;
      void planImmediateOneAhead();
    });
  }
  function retainedOneAheadFor(nextState, candidate = oneAheadArtifact) {
    const entry = candidate;
    const current = library.get(nextState.mediaId);
    const target = entry && library.get(entry.mediaId);
    if (!entry || entry.cancelled || !current || !target || entry.mediaId === current.id) return null;
    const selection = resolveSemanticTrackSelection(current, target, nextState.trackSelection);
    return selection
      && selection.audioTrackIndex === entry.selection.audioTrackIndex
      && selection.subtitleTrackIndex === entry.selection.subtitleTrackIndex
      ? entry
      : null;
  }
  async function planImmediateOneAhead() {
    const items = [...library.values()];
    const currentIndex = items.findIndex((item) => item.id === state.mediaId);
    const current = items[currentIndex];
    let next = currentIndex >= 0 ? items[currentIndex + 1] : null;
    const selection = state.trackSelection;
    const deferred = deferredOneAheadIntent;
    const canAdmitDeferred = deferred && deferred.afterMediaId !== state.mediaId
      && library.has(deferred.mediaId) && oneAheadArtifact?.mediaId === deferred.afterMediaId
      && oneAheadArtifact.ready;
    // Backward navigation can make a different item immediate-next while an
    // already-started plan still targets a retained playlist item. Keep that
    // runner when the new foreground resolves to its exact semantic tracks;
    // only removal or selection invalidation makes it obsolete.
    if (oneAheadArtifact) {
      if (canAdmitDeferred) {
        // B is complete and remains session-owned, freeing the only runner for
        // the one bounded C intent without foreground promotion. Keep B's
        // visible next-card lifecycle until C has actually invoked its runner;
        // publishing a bare state here lets foreground-inert clients render a
        // transiently empty card and races a duplicate B admission.
        oneAheadArtifact = null;
        next = library.get(deferred.mediaId);
      } else if (retainedOneAheadFor(state)) return;
      else await cancelOneAheadArtifact();
    }
    if (!next) return;
    // A raw/current item can be playing before the host has selected embedded
    // tracks. Make the next-card state explicit instead of silently skipping
    // preparation; this is informational and does not interrupt playback.
    if (state.playing && !Number.isSafeInteger(selection.audioTrackIndex)) {
      setOneAheadStatus(next.id, 'selection-required');
      return;
    }
    const foreground = hlsArtifacts.get(state.mediaId);
    // Preparation belongs to a ready selected foreground rendition, not to its
    // play state. This keeps a paused host from delaying the only next item.
    if (state.hls?.status !== 'ready' || !foreground?.ready || !selectedTracks(current, selection)) return;
    const resolvedSelection = canAdmitDeferred
      ? deferred.selection
      : resolveSemanticTrackSelection(current, next, selection);
    if (!resolvedSelection) {
      await cancelOneAheadArtifact();
      setOneAheadStatus(next.id, 'choice-required', selection);
      return;
    }
    const plan = state.oneAhead;
    if (plan?.mediaId === next.id && plan.audioTrackIndex === resolvedSelection.audioTrackIndex
      && plan.subtitleTrackIndex === resolvedSelection.subtitleTrackIndex) return;
    // Reuse the protected route admission path with an internal HEAD sink. It
    // preserves the same token-free validation, cache, cancellation, and stale
    // generation guards as an external speculative request, without relying on
    // a browser play event to start the plan.
    const sink = { destroyed: false, writableEnded: false, writeHead() {}, end() { this.writableEnded = true; } };
    const prepare = canAdmitDeferred ? 'deferred-one-ahead' : 'one-ahead';
    const url = new URL(`/hls/${encodeURIComponent(next.id)}/master.m3u8?prepare=${prepare}`, 'http://localhost');
    const admit = () => serveHls({ method: 'INTERNAL' }, sink, url, next.id, 'master.m3u8');
    const cleanupBarrier = hlsCleanupBarrier;
    void cleanupBarrier.then(admit).catch(() => {});
  }
  function resetRoomState() {
    return { mediaId: null, playing: false, position: 0, trackSelection: { audioTrackIndex: null, subtitleTrackIndex: null }, hls: { status: 'idle' } };
  }
  function hlsLifecycle(entry, status, reason) {
    const lifecycle = { status, mediaId: entry.mediaId, audioTrackIndex: entry.selection.audioTrackIndex, subtitleTrackIndex: entry.selection.subtitleTrackIndex, selectionId: entry.selectionId, route: entry.route.mode, videoMode: entry.route.video, audioMode: entry.route.audio, subtitleMode: entry.route.subtitle, cacheHit: Boolean(entry.cached) };
    // Only normalized numeric progress crosses the room boundary. Never expose
    // FFmpeg output, paths, commands, tokens, or host/driver details.
    if (status === 'preparing' && entry.progress) lifecycle.progress = entry.progress;
    if (entry.route.video === 'transcode') lifecycle.selectedEncoder = entry.encoder;
    if (entry.fallbackFrom) lifecycle.fallbackFrom = entry.fallbackFrom;
    if (entry.selection.subtitleTrackIndex !== null) lifecycle.subtitleStatus = entry.subtitleStatus || 'pending';
    if (reason && SAFE_HLS_FAILURE_REASONS.has(reason)) lifecycle.reason = reason;
    return lifecycle;
  }
  function isActiveHlsEntry(entry) {
    return state.mediaId === entry.mediaId
      && hlsArtifacts.get(entry.mediaId) === entry
      && state.trackSelection.audioTrackIndex === entry.selection.audioTrackIndex
      && state.trackSelection.subtitleTrackIndex === entry.selection.subtitleTrackIndex;
  }
  function updateHlsLifecycle(entry, status, reason) {
    // A replaced selection may finish or fail later. It must never overwrite
    // the lifecycle that the room currently authorizes.
    if (!isActiveHlsEntry(entry)) return;
    updateState({ ...state, hls: hlsLifecycle(entry, status, reason) });
  }
  function oneAheadLifecycle(entry, status) {
    const lifecycle = { status, mediaId: entry.mediaId, audioTrackIndex: entry.selection.audioTrackIndex, subtitleTrackIndex: entry.selection.subtitleTrackIndex };
    // A next-card preparation claim is valid only after a runner has been
    // invoked. Cache hits skip that state and are admitted directly as ready.
    if (status === 'preparing' && entry.runnerStarted && entry.progress) lifecycle.progress = entry.progress;
    return lifecycle;
  }
  function commitPendingNavigation(entry) {
    const pending = state.pendingNavigation;
    // A preparing next item remains speculative until this exact completed
    // artifact still matches the latest navigation intent. Only this commit
    // transfers foreground ownership or replaces the outgoing source.
    if (!pending || pending.mediaId !== entry.mediaId || pending.selectionId !== entry.selectionId
      || oneAheadArtifact !== entry || entry.cancelled || !entry.ready) return false;
    oneAheadArtifact = null;
    entry.oneAheadProvenance = true;
    // The foreground may have continued while B prepared. Checkpoint it again
    // at the actual ownership boundary, then use the target armed at selection.
    savePositionFor(state.mediaId);
    const next = {
      ...state,
      mediaId: entry.mediaId,
      position: Number.isFinite(pending.position) ? pending.position : savedPositionFor(entry.mediaId),
      trackSelection: entry.selection,
      hls: hlsLifecycle(entry, 'ready')
    };
    delete next.oneAhead;
    delete next.pendingNavigation;
    // Cancellation starts only after the exact prepared artifact is ready and
    // this pending command is still current. Preserve that artifact while the
    // outgoing owner unwinds behind the admission barrier.
    scheduleHlsCleanup({ preserve: new Set([entry]) }).catch((error) => {
      console.warn(`HLS cleanup failed: ${error.message}`);
    });
    updateState(next);
    return true;
  }
  function updateOneAheadLifecycle(entry, status) {
    // The plan identity guard prevents late FFmpeg/cache callbacks from a
    // cancelled target changing the next-card status for a newer target.
    if (oneAheadArtifact !== entry || entry.cancelled) return;
    if (status === 'preparing' && !entry.runnerStarted) return;
    const lifecycle = oneAheadLifecycle(entry, status);
    if (status === 'preparing' && state.oneAhead?.status === 'preparing'
      && state.oneAhead.mediaId === entry.mediaId
      && state.oneAhead.audioTrackIndex === entry.selection.audioTrackIndex
      && state.oneAhead.subtitleTrackIndex === entry.selection.subtitleTrackIndex) {
      // Progress belongs to the list card, never foreground playback. Publish
      // only a changed bounded percent (or a later bounded timing sample), so
      // observers can render a durable status without polling/play toggles.
      const previous = state.oneAhead.progress || {};
      const changedPercent = previous.percent !== lifecycle.progress?.percent;
      const changedTiming = previous.elapsedSeconds !== lifecycle.progress?.elapsedSeconds
        || previous.etaSeconds !== lifecycle.progress?.etaSeconds;
      if (!changedPercent && !changedTiming) return;
      // Every changed bounded progress sample is sequenced and broadcast. The
      // browser treats a next-card-only state update as foreground-inert.
      updateState({ ...state, oneAhead: lifecycle });
      return;
    }
    updateState({ ...state, oneAhead: lifecycle });
  }
  async function cancelOneAheadArtifact({ except = null } = {}) {
    const entry = oneAheadArtifact;
    if (!entry || entry === except) return;
    oneAheadArtifact = null;
    entry.cancelled = true;
    entry.cancel?.();
    if (state.oneAhead?.mediaId === entry.mediaId) {
      const next = { ...state };
      delete next.oneAhead;
      updateState(next);
    }
    // Readiness performs final graph validation/promotion after the FFmpeg
    // process settles, so cancellation must wait for both before removing its
    // owned directory.
    await Promise.allSettled([entry.running || entry.promise, entry.readiness].filter(Boolean));
    if (!entry.cacheKey) await fsp.rm(entry.directory, { recursive: true, force: true }).catch(() => {});
  }
  function hlsFailureLifecycle(error, entry) {
    const reason = SAFE_HLS_FAILURE_REASONS.has(error?.hlsFailureReason)
      ? error.hlsFailureReason
      : SAFE_FFMPEG_ERROR_CLASSES.has(error?.ffmpegErrorClass) ? error.ffmpegErrorClass : 'readiness-failed';
    // `timeout` is exclusively a startup-readiness state. Once a complete A/V
    // snapshot has made this generation ready, a later FFmpeg termination is a
    // terminal failure, never a regression to the startup UI.
    return { status: !entry?.ready && (error?.hlsLifecycleStatus === 'timeout' || reason === 'timed-out') ? 'timeout' : 'failed', reason };
  }
  async function clearHlsArtifacts({ preserve = [] } = {}) {
    // Navigation may retain a one-ahead runner while adopting an independently
    // ready cached destination. Preserve every owner in that transition.
    const preserved = new Set(((preserve instanceof Set || Array.isArray(preserve)) ? [...preserve] : [preserve]).filter(Boolean));
    const speculative = oneAheadArtifact;
    if (!preserved.has(speculative)) oneAheadArtifact = null;
    const artifacts = [...new Set([...hlsArtifacts.values(), speculative].filter((entry) => entry && !preserved.has(entry)))];
    hlsArtifacts.clear();
    for (const entry of preserved) hlsArtifacts.set(entry.mediaId, entry);
    try {
      for (const artifact of artifacts) {
        artifact.cancelled = true;
        artifact.cancel?.();
      }
      // A completed runner can still have a validation/promotion continuation
      // writing the owned directory. Wait for it as well before root cleanup.
      await Promise.allSettled(artifacts.flatMap((artifact) => [artifact.running || artifact.promise, artifact.readiness]).filter(Boolean));
      for (const artifact of artifacts) if (artifact.cacheKey) pinnedCacheKeys.delete(artifact.cacheKey);
      // A queued authoritative one-ahead admission may be crossing an async
      // filesystem boundary when replacement/close cancels it. Retry removal
      // of this owned temporary root rather than letting that benign race make
      // teardown fail or leave a speculative artifact behind.
      if (!preserved.size) await fsp.rm(hlsRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 });
    } finally {
      // Cancellation and removal errors are reported by the owning command;
      // this function always completes its local ownership transition.
    }
  }
  function scheduleHlsCleanup(options) {
    // Begin cancellation now, then chain settlement behind prior cleanup. The
    // immediate cancel keeps obsolete work from running, while the chain keeps
    // every new admission behind all still-unwinding runners.
    const cleanup = clearHlsArtifacts(options);
    const previous = hlsCleanupBarrier;
    const barrier = Promise.allSettled([previous, cleanup]).then(() => {});
    hlsCleanupBarrier = barrier;
    return barrier;
  }
  async function waitForForegroundAdmission(admission) {
    // A passive GET/HEAD may observe a server-authorized replacement across
    // cleanup, but it never owns that transition and never waits forever if a
    // cancelled runner fails to settle.
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), hlsReadinessTimeoutMs);
    });
    try {
      return await Promise.race([
        Promise.allSettled([hlsCleanupBarrier, admission]).then(() => true),
        timedOut
      ]);
    } finally {
      clearTimeout(timer);
    }
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
      // Snapshot and cancel the old ownership before publishing the replacement
      // state; otherwise a queued new foreground admission can be swept up by
      // the old root cleanup.
      deferredOneAheadIntent = null;
      const cleanup = scheduleHlsCleanup();
      library.clear();
      stagedMedia.clear();
      for (const media of replacement) library.set(media.id, media);
      updateState({ mediaId: replacement[0].id, playing: false, position, trackSelection: { audioTrackIndex: null, subtitleTrackIndex: null }, hls: { status: 'idle' } }, { libraryChanged: true });
      await cleanup;
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
      const resume = body?.resume;
      let resumePosition = 0;
      if (resume !== undefined) {
        if (!resume || typeof resume.contentId !== 'string' || !Number.isFinite(resume.position)
          || resume.position < 0 || resume.position > MAX_POSITION_SECONDS
          || additions[0].contentId !== resume.contentId) {
          throw Object.assign(new Error('Invalid append resume position'), { statusCode: 400 });
        }
        resumePosition = resume.position;
      }
      for (const media of additions) {
        stagedMedia.delete(media.id);
        library.set(media.id, media);
      }
      // A browser may survive a portable restart while the room does not. It
      // may restore only its IndexedDB record for these exact source bytes; a
      // different upload must never inherit that position.
      const next = state.mediaId ? state : { ...state, mediaId: additions[0].id, playing: false, position: resumePosition };
      if (!state.mediaId) savePositionFor(additions[0].id, resumePosition);
      updateState(next, { libraryChanged: true });
      sendJson(res, 200, { media: [...library.values()].map(publicMedia), state: roomState() });
    } catch (error) {
      sendJson(res, error.statusCode || 400, { error: error.statusCode ? error.message : 'Invalid library append' });
    }
  }
  function clearLibrary(res) {
    deferredOneAheadIntent = null;
    const obsolete = [...library.values(), ...stagedMedia.values()];
    library.clear();
    stagedMedia.clear();
    updateState(resetRoomState(), { libraryChanged: true });
    // Clearing the authoritative room state is complete once cancellation is
    // requested. Do not hold the client response behind an FFmpeg process that
    // is still unwinding its cancellation callback.
    const cleanup = clearHlsArtifacts().then(() => Promise.all(obsolete.map(removeMedia)));
    cleanup.catch(() => console.warn('Library clear cleanup failed'));
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
  function requireManagedLocalSession(req, res) {
    if (sessionMode !== 'managed-local') return true;
    if (!hostAuthority(req)) {
      sendJson(res, 403, { error: 'Managed local sessions accept loopback requests only' });
      return false;
    }
    if (managedLocalActive) return true;
    sendJson(res, 403, { error: 'Managed local session has not been activated' });
    return false;
  }
  function activateManagedLocalSession(req, res) {
    if (sessionMode !== 'managed-local') return send(res, 404, 'Not Found');
    if (!requireHost(req, res)) return;
    managedLocalActive = true;
    sendJson(res, 200, { token, roomUrl: getRoomUrl(), session: sessionMetadata() });
  }
  async function upload(req, res) {
    let filePath;
    try {
      const file = uploadMetadata(req, maxUploadBytes);
      const id = crypto.randomBytes(18).toString('base64url');
      const diskName = `${id}${file.extension}`;
      filePath = path.join(storageDir, diskName);
      const { size, contentId } = await streamUpload(req, filePath, maxUploadBytes);
      let tracks = { status: 'unavailable' };
      let duration = null;
      let routing = null;
      try {
        const probe = await ffprobeRunner(filePath);
        tracks = normalizeMediaTracks(probe);
        duration = normalizeMediaDuration(probe);
        routing = normalizeMediaRouting(probe);
      } catch {
        // A probe failure must not make successfully uploaded media unavailable.
      }
      const media = { id, contentId, diskName, name: file.filename, size, mime: file.mime, uploadedAt: Date.now(), duration, tracks, routing };
      stagedMedia.set(id, media);
      sendJson(res, 201, { media: publicMedia(media) });
    } catch (error) {
      if (filePath) await fsp.rm(filePath, { force: true });
      const failure = uploadFailure(error, req);
      try { diagnosticLogger(`Upload failure category=${failure.category}`); } catch {}
      if (!res.destroyed && !res.writableEnded) sendJson(res, failure.statusCode, { error: failure.message, code: failure.category });
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
  function logHlsFailure(mediaId, selection, error) {
    if (error?.hlsFailureReason === 'readiness-timeout') {
      const missing = error.hlsMissingArtifacts && typeof error.hlsMissingArtifacts === 'object'
        ? Object.entries(error.hlsMissingArtifacts).filter(([name, count]) => /^[a-z0-9.:-]+$/i.test(name) && Number.isSafeInteger(count) && count > 0)
        : [];
      const summary = missing.length ? missing.map(([name, count]) => `${name}:${count}`).join(',') : 'unknown:1';
      try { diagnosticLogger(`HLS startup readiness timeout missing=${summary}`); } catch {}
      return;
    }
    if (!SAFE_FFMPEG_ERROR_CLASSES.has(error?.ffmpegErrorClass)) return;
    const subtitleTrackIndex = selection.subtitleTrackIndex === null ? 'none' : selection.subtitleTrackIndex;
    const stderrTail = sanitizeFfmpegDiagnostic(error.ffmpegStderrTail || '').slice(-MAX_FFMPEG_DIAGNOSTIC_TAIL_BYTES) || '<empty>';
    try {
      diagnosticLogger(`FFmpeg HLS failure media=${mediaId} audioTrackIndex=${selection.audioTrackIndex} subtitleTrackIndex=${subtitleTrackIndex} class=${error.ffmpegErrorClass} stderr=${stderrTail}`);
    } catch {}
  }
  function hlsDelivery(media, selection) {
    if (!media || !selection || !selectedTracks(media, selection) || !Number.isSafeInteger(selection.audioTrackIndex)) return null;
    const audioTrack = media.tracks.audio.find((track) => track.index === selection.audioTrackIndex);
    const subtitleTrack = selection.subtitleTrackIndex === null
      ? null
      : media.tracks.subtitles.find((track) => track.index === selection.subtitleTrackIndex && TEXT_SUBTITLE_CODECS.has(track.codec));
    const route = deliveryRoute(media, selection);
    if (!audioTrack || !route) return null;
    const delivery = { videoTrack: route.videoTrack, audioTrack, subtitleTrack: subtitleTrack || null, route };
    if (Number.isFinite(media.duration) && media.duration > 0) delivery.duration = media.duration;
    return delivery;
  }
  function selectedTracks(media, selection) {
    if (!media || media.tracks?.status !== 'available') return false;
    if (selection.audioTrackIndex !== null && !media.tracks.audio.some((track) => track.index === selection.audioTrackIndex)) return false;
    if (selection.subtitleTrackIndex === null) return true;
    return media.tracks.subtitles.some((track) => track.index === selection.subtitleTrackIndex && TEXT_SUBTITLE_CODECS.has(track.codec));
  }
  function admitCompletedSessionHls(media, selection, isCurrentIntent = () => true) {
    // A ready session artifact can outlive foreground ownership while an exact
    // one-ahead runner holds the sole conversion slot. Re-admit it directly:
    // it has already passed complete-VOD validation and must not wait for or
    // duplicate that retained runner.
    const entry = media && hlsArtifacts.get(media.id);
    if (!entry || !entry.ready || entry.cancelled || entry.failure || !isCurrentIntent()
      || entry.selection.audioTrackIndex !== selection.audioTrackIndex
      || entry.selection.subtitleTrackIndex !== selection.subtitleTrackIndex) return null;
    return entry;
  }
  async function admitCachedHls(media, selection, isCurrentIntent = () => true) {
    const delivery = hlsDelivery(media, selection);
    if (!delivery || !isCurrentIntent()) return null;
    try {
      const resolvedEncoder = delivery.route.video === 'transcode' ? await encoderManager.resolve() : { encoder: null };
      if (!isCurrentIntent()) return null;
      const cacheHit = await findCachedHls(media, selection, delivery.route, resolvedEncoder.encoder || CPU_ENCODER);
      // Cache validation crosses several filesystem awaits. Do not install an
      // entry unless this exact navigation intent is still authoritative.
      if (!cacheHit || !isCurrentIntent()) return null;
      const entry = {
        mediaId: media.id, media, selectionId: crypto.randomBytes(12).toString('base64url'),
        directory: cacheHit.directory, selection, delivery, route: delivery.route,
        encoder: cacheHit.encoder ?? resolvedEncoder.encoder, fallbackFrom: null,
        running: null, readiness: null, subtitleReadiness: null,
        subtitleStatus: selection.subtitleTrackIndex === null ? null : 'ready',
        subtitleArtifacts: new Set(), playlistCache: new Map(), cancel: null,
        cancelled: false, finished: true, failure: null, cleanup: null,
        manifestArtifacts: cacheHit.artifacts, ready: true, progress: null,
        startedAt: null, runnerStarted: false, hlsArtifactRetryTimeoutMs,
        cacheKey: cacheHit.key, cached: true
      };
      if (!isCurrentIntent()) return null;
      hlsArtifacts.set(media.id, entry);
      pinnedCacheKeys.add(cacheHit.key);
      return entry;
    } catch {
      // A corrupt, missing, or otherwise invalid cache entry is never admitted.
      return null;
    }
  }
  async function serveHls(req, res, url, mediaId, artifactName) {
    const internalAdmission = req.method === 'INTERNAL';
    const media = library.get(mediaId);
    const foreground = state.mediaId === mediaId;
    const orderedMedia = [...library.values()];
    const currentIndex = orderedMedia.findIndex((item) => item.id === state.mediaId);
    const currentMedia = orderedMedia[currentIndex];
    const immediateNext = currentIndex >= 0 ? orderedMedia[currentIndex + 1] : null;
    const foregroundArtifact = hlsArtifacts.get(state.mediaId);
    const deferred = deferredOneAheadIntent;
    const deferredSpeculative = internalAdmission && !foreground && url.searchParams.get('prepare') === 'deferred-one-ahead'
      && deferred?.mediaId === mediaId && deferred.afterMediaId !== state.mediaId
      && deferred.selection?.audioTrackIndex !== undefined;
    const speculative = (internalAdmission && !foreground && url.searchParams.get('prepare') === 'one-ahead'
      && state.hls?.status === 'ready' && foregroundArtifact?.ready
      && immediateNext?.id === mediaId) || deferredSpeculative;
    const selection = foreground ? state.trackSelection
      : deferredSpeculative ? deferred.selection : resolveSemanticTrackSelection(currentMedia, media, state.trackSelection);
    const delivery = hlsDelivery(media, selection);
    if (!media || !delivery || (!foreground && !speculative)) return send(res, 503, 'HLS unavailable');
    let artifact = hlsArtifacts.get(mediaId);
    // HLS GET/HEAD is strictly read-only. It may wait for an already queued
    // authoritative admission, but never creates, cancels, or replans work.
    if (!internalAdmission && (!artifact || !artifact.ready)) {
      const admission = foreground ? foregroundAdmissions.get(mediaId) : null;
      if (admission && !await waitForForegroundAdmission(admission)) return send(res, 503, 'HLS unavailable');
      // Admission may have crossed an async cancellation boundary before its
      // entry was installed. Reads remain passive, but briefly observe that
      // server-owned transition instead of manufacturing a replacement plan.
      for (let attempt = 0; attempt < 20; attempt += 1) {
        artifact = hlsArtifacts.get(mediaId);
        if (artifact?.ready) break;
        if (artifact?.failure) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (!artifact || !artifact.ready) return send(res, 503, 'HLS unavailable');
    }
    // Only authoritative server admission may preempt a different speculative
    // plan. Matching plans are promoted below without changing their identity.
    if (internalAdmission && foreground && oneAheadArtifact && oneAheadArtifact.mediaId !== mediaId && !retainedOneAheadFor(state)) await cancelOneAheadArtifact();
    let releaseOneAheadAdmission = null;
    if (speculative && !artifact) {
      const pendingAdmission = oneAheadAdmissions.get(mediaId);
      if (pendingAdmission) {
        await pendingAdmission;
        artifact = hlsArtifacts.get(mediaId);
      } else {
        let release;
        oneAheadAdmissions.set(mediaId, new Promise((resolve) => { release = resolve; }));
        releaseOneAheadAdmission = () => {
          oneAheadAdmissions.delete(mediaId);
          release();
        };
      }
    }
    if (foreground && artifact && oneAheadArtifact === artifact) {
      // Promotion transfers ownership only; the directory, cache key, and
      // running/completed promise are reused exactly as prepared. Preserve its
      // origin so a later navigation can demote this same entry back to the
      // one-ahead owner without losing its runner or generation identity.
      artifact.oneAheadProvenance = true;
      oneAheadArtifact = null;
      const next = { ...state };
      delete next.oneAhead;
      updateState(next);
      if (artifact.ready) updateHlsLifecycle(artifact, 'ready');
    }
    if (!artifact) {
      if (!internalAdmission) return send(res, 503, 'HLS unavailable');
      try {
      const route = delivery.route;
      // Copy and audio-only conversions never touch GPU detection. Capability
      // probing is meaningful only when this route must encode video.
      const resolvedEncoder = route.video === 'transcode' ? await encoderManager.resolve() : { encoder: null };
      const cacheHit = await findCachedHls(media, selection, route, resolvedEncoder.encoder || CPU_ENCODER);
      const directory = cacheHit?.directory || path.join(hlsRoot, crypto.randomBytes(18).toString('hex'));
      const entry = { mediaId, media, selectionId: crypto.randomBytes(12).toString('base64url'), directory, selection, delivery, route, encoder: cacheHit?.encoder ?? resolvedEncoder.encoder, fallbackFrom: null, running: null, readiness: null, subtitleReadiness: null, subtitleStatus: selection.subtitleTrackIndex === null ? null : 'pending', subtitleArtifacts: new Set(), playlistCache: new Map(), cancel: null, cancelled: false, finished: false, failure: null, cleanup: null, manifestArtifacts: new Set(), ready: false, progress: null, startedAt: null, runnerStarted: false, oneAheadProvenance: false, hlsArtifactRetryTimeoutMs, cacheKey: cacheHit?.key || null, cached: Boolean(cacheHit) };
      hlsArtifacts.set(mediaId, entry);
      if (speculative) {
        oneAheadArtifact = entry;
        if (deferredSpeculative) deferredOneAheadIntent = null;
      }
      if (cacheHit) {
        // A completed cache entry has already passed the full VOD graph check.
        // It is immediately safe to serve, without starting FFmpeg.
        pinnedCacheKeys.add(cacheHit.key);
        entry.manifestArtifacts = cacheHit.artifacts;
        entry.ready = true;
        entry.finished = true;
        entry.subtitleStatus = selection.subtitleTrackIndex === null ? null : 'ready';
        if (speculative) updateOneAheadLifecycle(entry, 'ready');
        else {
          updateHlsLifecycle(entry, 'preparing');
          updateHlsLifecycle(entry, 'ready');
        }
      } else try {
        await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
        if (hlsArtifacts.get(mediaId) !== entry) throw new Error('HLS selection replaced');
        const onProgress = ({ outTimeUs }) => {
          const progress = normalizeConversionProgress({ outTimeUs, durationSeconds: entry.delivery.duration, elapsedSeconds: (Date.now() - entry.startedAt) / 1000 });
          if (!progress || JSON.stringify(progress) === JSON.stringify(entry.progress)) return;
          entry.progress = progress;
          if (oneAheadArtifact === entry) updateOneAheadLifecycle(entry, 'preparing');
          else updateHlsLifecycle(entry, 'preparing');
        };
        const run = (encoder) => ffmpegRunner(path.join(storageDir, media.diskName), entry.directory, { ...delivery, ...(encoder ? { encoder } : {}), onProgress });
        entry.startedAt = Date.now();
        // Mark admission before invocation: an injected/fast runner may emit
        // its first bounded progress synchronously from inside `run`.
        entry.runnerStarted = true;
        let running = run(entry.encoder);
        entry.cancel = typeof running?.cancel === 'function' ? () => running.cancel() : null;
        entry.running = Promise.resolve(running).catch(async (error) => {
          if (!GPU_ENCODERS.includes(entry.encoder) || entry.cancelled || hlsArtifacts.get(mediaId) !== entry) throw error;
          const failedEncoder = entry.encoder;
          // A failed GPU attempt must not leave partial artifacts for the CPU
          // retry. Replacement, cancellation, and shutdown forbid fallback.
          await fsp.rm(entry.directory, { recursive: true, force: true });
          if (entry.cancelled || hlsArtifacts.get(mediaId) !== entry) throw error;
          entry.directory = path.join(hlsRoot, crypto.randomBytes(18).toString('hex'));
          await fsp.mkdir(entry.directory, { recursive: true, mode: 0o700 });
          if (entry.cancelled || hlsArtifacts.get(mediaId) !== entry) throw error;
          entry.fallbackFrom = failedEncoder;
          entry.encoder = CPU_ENCODER;
          entry.runnerStarted = true;
          running = run(CPU_ENCODER);
          entry.cancel = typeof running?.cancel === 'function' ? () => running.cancel() : null;
          await running;
          // Quarantine only after a clean CPU retry, avoiding a transient
          // process error permanently disabling a usable accelerator.
          encoderManager.quarantine(failedEncoder);
        });
        // Foreground preparation is visible on admission. A speculative plan
        // becomes truthfully preparing once its runner has actually been
        // invoked; no progress is published until FFmpeg reports one.
        if (speculative) updateOneAheadLifecycle(entry, 'preparing');
        else updateHlsLifecycle(entry, 'preparing');
        // Complete-VOD mode: no manifest, segment, duration, or browser HLS
        // attachment is admitted until FFmpeg exits and every referenced
        // artifact belongs to a complete ENDLIST graph. A valid session
        // directory remains usable if persistent cache promotion is unavailable.
        entry.readiness = entry.running.then(async () => {
          entry.finished = true;
          if (entry.cancelled || hlsArtifacts.get(mediaId) !== entry) throw new Error('HLS generation cancelled');
          await fsp.writeFile(path.join(entry.directory, HLS_CACHE_ENTRY_MARKER), `${HLS_CACHE_OWNER_LINE}\n`, { mode: 0o600 });
          await fsp.writeFile(path.join(entry.directory, HLS_CACHE_PROFILE_FILE), `${JSON.stringify(cacheProfileRecord(entry.media, entry.selection, entry.route, entry.encoder))}\n`, { mode: 0o600 });
          const completed = await validateCompletedEntry(entry.directory);
          if (!completed) {
            const error = new Error('FFmpeg did not produce a complete HLS VOD');
            error.hlsFailureReason = 'readiness-failed';
            throw error;
          }
          entry.manifestArtifacts = completed.artifacts;
          entry.subtitleStatus = selection.subtitleTrackIndex === null ? null : 'ready';
          await promoteHlsCache(entry);
          if (entry.cancelled || hlsArtifacts.get(mediaId) !== entry) throw new Error('HLS generation cancelled');
          entry.ready = true;
          if (oneAheadArtifact === entry) {
            if (!commitPendingNavigation(entry)) updateOneAheadLifecycle(entry, 'ready');
          } else updateHlsLifecycle(entry, 'ready');
        });
        entry.readiness.catch((error) => {
          if (entry.failure) return;
          entry.failure = error;
          const lifecycle = hlsFailureLifecycle(error, entry);
          if (oneAheadArtifact === entry) updateOneAheadLifecycle(entry, 'unavailable');
          else updateHlsLifecycle(entry, lifecycle.status, lifecycle.reason);
          if (!entry.cancelled) logHlsFailure(mediaId, selection, error);
          entry.cleanup = fsp.rm(entry.directory, { recursive: true, force: true });
          entry.cleanup.catch(() => {});
        });
      } catch (error) {
        entry.failure = error;
        const lifecycle = hlsFailureLifecycle(error, entry);
        if (oneAheadArtifact === entry) updateOneAheadLifecycle(entry, 'unavailable');
        else updateHlsLifecycle(entry, lifecycle.status, lifecycle.reason);
        entry.cleanup = fsp.rm(directory, { recursive: true, force: true });
        entry.cleanup.catch(() => {});
      }
      artifact = entry;
      } finally {
        releaseOneAheadAdmission?.();
      }
    }
    if (artifact.readiness) {
      try { await artifact.readiness; } catch { return send(res, 503, 'HLS unavailable'); }
    }
    if (hlsArtifacts.get(mediaId) !== artifact
      || artifact.selection.audioTrackIndex !== selection.audioTrackIndex
      || artifact.selection.subtitleTrackIndex !== selection.subtitleTrackIndex
      || (foreground
        ? state.mediaId !== mediaId
        : !(oneAheadArtifact === artifact || (state.oneAhead?.mediaId === mediaId
          && state.oneAhead.audioTrackIndex === artifact.selection.audioTrackIndex
          && state.oneAhead.subtitleTrackIndex === artifact.selection.subtitleTrackIndex)))) return send(res, 503, 'HLS unavailable');
    if (!isSafeHlsArtifactName(artifactName)) return send(res, 404, 'Not Found');
    const filePath = path.join(artifact.directory, artifactName);
    if (!filePath.startsWith(artifact.directory + path.sep)) return send(res, 404, 'Not Found');
    try {
      const isPlaylist = artifactName.endsWith('.m3u8');
      const contentType = isPlaylist ? 'application/vnd.apple.mpegurl' : artifactName.endsWith('.mp4') ? 'video/mp4' : artifactName.endsWith('.m4s') ? 'video/iso.segment' : artifactName.endsWith('.vtt') ? 'text/vtt; charset=utf-8' : 'application/octet-stream';
      if (artifactName === 'subtitles.vtt') {
        if (artifact.selection.subtitleTrackIndex === null) return send(res, 404, 'Not Found');
        const body = Buffer.from(await aggregateSelectedSubtitleWebVtt(artifact));
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return req.method === 'HEAD' ? res.end() : res.end(body);
      }
      if (isPlaylist) {
        let manifest;
        let servedCachedSnapshot = false;
        try {
          manifest = await readStableHlsFile(filePath);
          artifact.playlistCache.set(artifactName, manifest);
        } catch (error) {
          // FFmpeg may replace a playlist between requests even after initial
          // readiness. Serve only this generation's last complete snapshot,
          // never a partial file or an unprotected path. This lookup must run
          // before a post-ready runner failure is reported: cleanup can race
          // the atomic rename window after the snapshot was safely admitted.
          manifest = artifact.playlistCache.get(artifactName);
          servedCachedSnapshot = manifest !== undefined;
          if (!servedCachedSnapshot) manifest = await readActiveHlsArtifact(artifact, artifactName, () => readStableHlsFile(filePath));
        }
        for (const name of hlsManifestArtifacts(manifest)) artifact.manifestArtifacts.add(name);
        if (hlsArtifacts.get(mediaId) !== artifact
          || (foreground ? state.mediaId !== mediaId : state.oneAhead?.mediaId !== mediaId)
          || (artifact.failure && !servedCachedSnapshot)) return send(res, 503, 'HLS unavailable');
        // Do not advertise a selected WebVTT rendition until its playlist and
        // first cue are complete. A browser must not treat late subtitle
        // publication as an A/V startup dependency.
        const deliveredManifest = artifactName === 'master.m3u8' && artifact.subtitleStatus === 'pending'
          ? hlsMasterWithoutPendingSubtitles(manifest)
          : artifactName === 'master.m3u8' && artifact.selection.subtitleTrackIndex !== null
            ? selectedSubtitleRenditionMetadata(manifest)
            : manifest;
        const body = Buffer.from(tokenizeHlsManifest(deliveredManifest, token));
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return req.method === 'HEAD' ? res.end() : res.end(body);
      }
      const stat = await readActiveHlsArtifact(artifact, artifactName, async () => {
        const candidate = await fsp.stat(filePath);
        if (!candidate.isFile() || candidate.size === 0) throw new Error('HLS artifact is not published');
        return candidate;
      });
      if (artifact.failure || hlsArtifacts.get(mediaId) !== artifact
        || (foreground ? state.mediaId !== mediaId : state.oneAhead?.mediaId !== mediaId)) return send(res, 503, 'HLS unavailable');
      if (artifactName.endsWith('.vtt')) {
        const body = Buffer.from(transformGeneratedWebVttCues(await fsp.readFile(filePath, 'utf8')));
        res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return req.method === 'HEAD' ? res.end() : res.end(body);
      }
      res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': stat.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
    } catch { return send(res, artifact.failure ? 503 : 404, artifact.failure ? 'HLS unavailable' : 'Not Found'); }
  }
  async function command(req, res) {
    try {
      const body = JSON.parse((await readRequestBody(req, MAX_COMMAND_BYTES)).toString('utf8'));
      if (!body || typeof body !== 'object' || typeof body.type !== 'string') throw Object.assign(new Error('Invalid room command'), { statusCode: 400 });
      const navigationCommand = body.type === 'select' || body.type === 'selectTracks'
        || body.type === 'previous' || body.type === 'next';
      const foregroundInteraction = body.type === 'play' || body.type === 'pause' || body.type === 'seek';
      // Establish intent before any cache-admission await. Foreground controls
      // do not replace an HLS owner, but they explicitly reject any deferred
      // destination so it cannot take over after the user resumes/interacts.
      const commandNavigationGeneration = navigationCommand ? ++navigationGeneration : navigationGeneration;
      const isCurrentNavigation = () => commandNavigationGeneration === navigationGeneration;
      const supersededResponse = () => sendJson(res, 200, { state: roomState() });
      const next = { ...state };
      let incomingResumePosition;
      if (body.resume !== undefined) {
        const destination = body.type === 'select' && typeof body.mediaId === 'string'
          ? library.get(body.mediaId)
          : null;
        if (!destination || !body.resume || typeof body.resume.contentId !== 'string'
          || body.resume.contentId !== destination.contentId || !Number.isFinite(body.resume.position)
          || body.resume.position <= 0 || body.resume.position > MAX_POSITION_SECONDS) {
          throw Object.assign(new Error('Invalid navigation resume position'), { statusCode: 422 });
        }
        incomingResumePosition = body.resume.position;
      }
      // A same-item selection may carry a newer caller position for the ready
      // foreground. Checkpoint it before superseding a deferred target, so a
      // late prepared-target completion cannot republish the older position.
      if (body.type === 'select' && body.mediaId === state.mediaId && body.position !== undefined) {
        next.position = navigationPosition(state.mediaId, state.mediaId, body.position, incomingResumePosition);
      }
      if (navigationCommand || foregroundInteraction) delete next.pendingNavigation;
      let invalidatesHls = false;
      let promotedOneAhead = null;
      let retainedOneAhead = null;
      let retainedSessionArtifact = null;
      let admittedSessionEntry = null;
      let admittedCacheEntry = null;
      if (body.type === 'select') {
        if (typeof body.mediaId !== 'string' || !library.has(body.mediaId)) throw Object.assign(new Error('Unknown media ID'), { statusCode: 422 });
        invalidatesHls = body.mediaId !== state.mediaId;
        const activeArtifact = hlsArtifacts.get(state.mediaId);
        const soleRunner = activeArtifact && !activeArtifact.ready && !activeArtifact.cancelled
          ? activeArtifact
          : oneAheadArtifact && !oneAheadArtifact.ready && !oneAheadArtifact.cancelled ? oneAheadArtifact : null;
        const requestedIndex = [...library.keys()].indexOf(body.mediaId);
        const runnerIndex = soleRunner ? [...library.keys()].indexOf(soleRunner.mediaId) : -1;
        // This special intent is only C-after-B. Existing selection/promotion
        // semantics for B itself, or navigation back toward A, remain intact.
        const deferredSelection = invalidatesHls && !deferredOneAheadIntent && soleRunner
          && requestedIndex > runnerIndex
          ? resolveSemanticTrackSelection(library.get(state.mediaId), library.get(body.mediaId), state.trackSelection)
          : null;
        if (deferredSelection) {
          // B owns the only runner. Preserve the current foreground and remember
          // only this latest C request until B completes.
          deferredOneAheadIntent = { mediaId: body.mediaId, selection: deferredSelection, afterMediaId: soleRunner.mediaId };
          invalidatesHls = false;
        }
        // Selecting the current ready item only cancels a deferred next target.
        // Keep its source, lifecycle, and runner ownership, but honor a valid
        // caller checkpoint before the deferred target is cleared.
        if (!invalidatesHls) {
          // The supplied checkpoint was accepted before pending navigation was
          // cleared above; do not replace it with the stale room position.
        } else {
          const resolvedSelection = resolveSemanticTrackSelection(library.get(state.mediaId), library.get(body.mediaId), state.trackSelection);
          const matchingOneAhead = oneAheadArtifact && oneAheadArtifact.mediaId === body.mediaId
            && resolvedSelection
            && oneAheadArtifact.selection.audioTrackIndex === resolvedSelection.audioTrackIndex
            && oneAheadArtifact.selection.subtitleTrackIndex === resolvedSelection.subtitleTrackIndex;
          if (matchingOneAhead && !oneAheadArtifact.ready) {
            // A partial target is informational only. Leave the ready foreground
            // and both content-bound checkpoints untouched; the browser reports
            // preparation rather than arming an automatic later promotion.
            invalidatesHls = false;
          } else {
            const incomingPosition = navigationPosition(state.mediaId, body.mediaId, body.position, incomingResumePosition);
            next.position = incomingPosition;
            next.mediaId = body.mediaId;
            // A ready plan may promote immediately because its complete graph
            // has already validated.
            if (matchingOneAhead) {
              promotedOneAhead = oneAheadArtifact;
              promotedOneAhead.oneAheadProvenance = true;
              oneAheadArtifact = null;
              next.trackSelection = resolvedSelection;
              next.hls = hlsLifecycle(promotedOneAhead, 'ready');
            } else {
          // Keep a reusable semantic intent per destination rather than
          // blindly carrying global stream indexes. An unresolved target stays
          // navigable and asks for a choice; a resolvable one starts as soon as
          // obsolete worker cancellation has been requested.
              next.trackSelection = resolvedSelection || { audioTrackIndex: null, subtitleTrackIndex: null };
              next.hls = { status: 'idle' };
            }
            delete next.oneAhead;
          }
        }
      } else if (body.type === 'selectTracks') {
        if (!hostAuthority(req)) throw Object.assign(new Error('Only the localhost host may select embedded tracks'), { statusCode: 403 });
        const selection = { audioTrackIndex: body.audioTrackIndex, subtitleTrackIndex: body.subtitleTrackIndex === undefined ? null : body.subtitleTrackIndex };
        if (!Number.isSafeInteger(selection.audioTrackIndex) || selection.audioTrackIndex < 0 || (selection.subtitleTrackIndex !== null && (!Number.isSafeInteger(selection.subtitleTrackIndex) || selection.subtitleTrackIndex < 0)) || !selectedTracks(library.get(state.mediaId), selection)) {
          throw Object.assign(new Error('Invalid embedded track selection'), { statusCode: 422 });
        }
        invalidatesHls = selection.audioTrackIndex !== state.trackSelection.audioTrackIndex
          || selection.subtitleTrackIndex !== state.trackSelection.subtitleTrackIndex;
        // Track application replaces the source for this same immutable content.
        // A pre-metadata client can only report the element's default zero; do
        // not let that placeholder replace an existing content checkpoint.
        const suppliedPosition = body.position === 0 && savedPositionFor(state.mediaId) > 0
          ? undefined
          : body.position;
        next.position = navigationPosition(state.mediaId, state.mediaId, suppliedPosition);
        next.trackSelection = selection;
        if (invalidatesHls) {
          deferredOneAheadIntent = null;
          next.hls = { status: 'idle' };
          delete next.oneAhead;
        }
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
        invalidatesHls = items[index].id !== state.mediaId;
        next.position = navigationPosition(state.mediaId, items[index].id, body.position);
        next.mediaId = items[index].id;
        // Resolve the current semantic fingerprint against the destination.
        // Never carry global FFprobe indexes across episodes: ambiguous or
        // metadata-free matches require a new host choice instead of guessing.
        next.trackSelection = resolveSemanticTrackSelection(library.get(state.mediaId), items[index], state.trackSelection)
          || { audioTrackIndex: null, subtitleTrackIndex: null };
        next.hls = { status: 'idle' }; delete next.oneAhead;
        if (oneAheadArtifact && oneAheadArtifact.mediaId === next.mediaId
          && oneAheadArtifact.selection.audioTrackIndex === next.trackSelection.audioTrackIndex
          && oneAheadArtifact.selection.subtitleTrackIndex === next.trackSelection.subtitleTrackIndex) {
          promotedOneAhead = oneAheadArtifact;
          promotedOneAhead.oneAheadProvenance = true;
          oneAheadArtifact = null;
          next.hls = hlsLifecycle(promotedOneAhead, promotedOneAhead.ready ? 'ready' : 'preparing');
        }
      } else throw Object.assign(new Error('Unsupported room command'), { statusCode: 400 });
      // A backward move can retain an already-started plan for a later
      // playlist item, provided the destination resolves to that plan's exact
      // semantic tracks. Keep its existing card lifecycle too; foreground
      // planning will leave it inert until it is genuinely obsolete.
      if (invalidatesHls && !promotedOneAhead) {
        retainedOneAhead = retainedOneAheadFor(next);
        // A plan that was promoted to foreground retains its one-ahead
        // provenance. If navigation moves away while its target remains
        // semantically valid, transfer that exact entry back to one-ahead;
        // do not recreate its runner, directory, selection ID, or progress.
        if (!retainedOneAhead) {
          const promotedForeground = hlsArtifacts.get(state.mediaId);
          if (promotedForeground?.oneAheadProvenance) {
            retainedOneAhead = retainedOneAheadFor(next, promotedForeground);
            if (retainedOneAhead) oneAheadArtifact = retainedOneAhead;
          } else if (deferredOneAheadIntent?.afterMediaId === state.mediaId
            && promotedForeground && !promotedForeground.ready && !promotedForeground.cancelled) {
            // Demote the still-running B owner while A becomes foreground; C's
            // bounded intent remains queued until this sole runner settles.
            retainedOneAhead = promotedForeground;
            oneAheadArtifact = retainedOneAhead;
          }
        }
        if (retainedOneAhead) {
          next.oneAhead = oneAheadLifecycle(retainedOneAhead, retainedOneAhead.ready ? 'ready' : 'preparing');
          // Keep a completed outgoing session rendition only while the retained
          // runner occupies the one-worker slot. It may be the destination of
          // an immediate A → B return before that runner completes.
          const outgoing = hlsArtifacts.get(state.mediaId);
          if (outgoing?.ready && !outgoing.cancelled && !outgoing.failure) retainedSessionArtifact = outgoing;
        }
      }
      // Re-admit a valid completed session rendition before consulting the
      // persistent cache. This prevents A → B from publishing idle and waiting
      // for retained C only to re-encode B after B → A cleanup.
      if (invalidatesHls && !promotedOneAhead && retainedOneAhead && Number.isSafeInteger(next.trackSelection?.audioTrackIndex)) {
        admittedSessionEntry = admitCompletedSessionHls(library.get(next.mediaId), next.trackSelection, isCurrentNavigation);
        if (admittedSessionEntry) next.hls = hlsLifecycle(admittedSessionEntry, 'ready');
      }
      // A completed cache destination is admitted before its navigation state
      // is published. This gives it a fresh generation identity and a first
      // visible lifecycle of ready, never an idle/preparing flash or FFmpeg job.
      if (invalidatesHls && !promotedOneAhead && !admittedSessionEntry && Number.isSafeInteger(next.trackSelection?.audioTrackIndex)) {
        admittedCacheEntry = await admitCachedHls(library.get(next.mediaId), next.trackSelection, isCurrentNavigation);
        // A later navigation won while cache validation was pending. Its state,
        // retained runner, and selectionId are already authoritative; this
        // command may only return that state and must not clean it up.
        if (!isCurrentNavigation()) return supersededResponse();
        if (admittedCacheEntry) next.hls = hlsLifecycle(admittedCacheEntry, 'ready');
      }
      if (!isCurrentNavigation()) return supersededResponse();
      if (body.type === 'play' || body.type === 'pause' || body.type === 'seek') {
        savePositionFor(next.mediaId, next.position, { allowZero: body.type === 'seek' && body.position === 0 });
      }
      // Cancellation begins before the new state can schedule its foreground
      // admission, but is deliberately not awaited: ready-item navigation must
      // remain responsive while an obsolete worker exits.
      if (invalidatesHls) {
        scheduleHlsCleanup({ preserve: new Set([promotedOneAhead, admittedSessionEntry, admittedCacheEntry, retainedOneAhead, retainedSessionArtifact].filter(Boolean)) }).catch((error) => {
          console.warn(`HLS cleanup failed: ${error.message}`);
        });
      }
      if (!isCurrentNavigation()) return supersededResponse();
      const room = updateState(next);
      sendJson(res, 200, { state: room });
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
    const protectedRoute = url.pathname === '/api/session' || url.pathname === '/api/upload' || url.pathname === '/api/library' || url.pathname === '/api/library/replace' || url.pathname === '/api/library/append' || url.pathname === '/api/library/clear' || url.pathname === '/api/room' || url.pathname === '/api/room/commands' || url.pathname === '/api/events' || url.pathname.startsWith('/media/') || url.pathname.startsWith('/hls/');
    if (url.pathname === '/api/local-session') return req.method === 'POST' ? activateManagedLocalSession(req, res) : send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
    if (protectedRoute && !requireToken(req, res, url)) return;
    if (protectedRoute && !requireManagedLocalSession(req, res)) return;
    if (url.pathname === '/api/session') return req.method === 'GET' ? sendJson(res, 200, { role: hostAuthority(req) ? 'host' : 'guest', roomUrl: getRoomUrl(), session: sessionMetadata() }) : send(res, 405, 'Method Not Allowed', { Allow: 'GET' });
    if (url.pathname === '/api/upload') return req.method === 'POST' ? (requireHost(req, res) ? upload(req, res) : undefined) : send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
    if (url.pathname === '/api/library/replace') return req.method === 'POST' ? (requireHost(req, res) ? replaceLibrary(req, res) : undefined) : send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
    if (url.pathname === '/api/library/append') return req.method === 'POST' ? (requireHost(req, res) ? appendLibrary(req, res) : undefined) : send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
    if (url.pathname === '/api/library/clear') return req.method === 'POST' ? (requireHost(req, res) ? clearLibrary(res) : undefined) : send(res, 405, 'Method Not Allowed', { Allow: 'POST' });
    if (url.pathname === '/api/library') return req.method === 'GET' ? sendJson(res, 200, { media: [...library.values()].map(publicMedia) }) : send(res, 405, 'Method Not Allowed', { Allow: 'GET' });
    if (url.pathname.startsWith('/media/')) return (req.method === 'GET' || req.method === 'HEAD') ? streamMedia(req, res, url.pathname.slice('/media/'.length)) : send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    if (url.pathname.startsWith('/hls/')) {
      const parts = url.pathname.slice('/hls/'.length).split('/');
      return (req.method === 'GET' || req.method === 'HEAD') && parts.length === 2 ? serveHls(req, res, url, parts[0], parts[1]) : send(res, 404, 'Not Found');
    }
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
  // Large local/LAN media uploads can legitimately exceed Node's 5-minute
  // whole-request default; size and streaming limits are enforced by the upload handler.
  server.requestTimeout = 0;
  let closePromise;
  async function cleanup() {
    await clearHlsArtifacts();
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

module.exports = { CPU_ENCODER, ENCODER_ORDER, EncoderManager, createFfmpegEncoderProbe, createFfmpegRunner, createFfprobeRunner, createMediaServer, deriveHlsVodJobTimeoutMs, isHostRequest, isLoopbackRemoteAddress, normalizeConversionProgress, normalizeMediaTracks, parseRange, parseUploadLimit, resolveMediaCommand, resolveRuntimeMediaDirectory, selectLanAddresses, transformGeneratedWebVttCues, UPLOAD_PROTOCOL };
