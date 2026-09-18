'use strict';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.m4v', '.mov']);
const DB_NAME = 'local-video-player';
const DB_VERSION = 3;
const STORE_NAME = 'progress';
const SESSION_STORE_NAME = 'sessions';
const RECENT_ACTIVE_STORE_NAME = 'recentActive';
const SAVE_INTERVAL_MS = 5000;
const WATCHED_THRESHOLD = 0.9;

const COPY = {
  en: {
    appTitle: 'Local Video Player',
    phaseLabel: 'Phase 1',
    heroDescription: 'Select a folder or several video files, then play them as an ordered local playlist.',
    chooseVideos: 'Choose videos',
    selectFolder: 'Select folder',
    selectFiles: 'Select files',
    supportedHint: 'Supported extensions: .mp4, .webm, .m4v, .mov, and .mkv where your browser can play it.',
    statusNoVideos: 'No videos selected.',
    statusNoSupported: 'No supported video files found in the selection.',
    statusLoaded: ({ count, rejected }) => `Loaded ${count} ${count === 1 ? 'video' : 'videos'}${rejected ? `; ignored ${rejected} unsupported ${rejected === 1 ? 'file' : 'files'}` : ''}.`,
    statusRestored: ({ name, time }) => `Restored ${name} at ${time}.`,
    statusSelected: ({ name }) => `Selected ${name}.`,
    statusMarkedWatched: ({ name }) => `Marked ${name} as watched.`,
    statusPlaylistFinished: 'Playlist finished.',
    playerHeading: 'Player',
    nothingPlaying: 'Nothing playing',
    previousButton: 'Previous',
    skipNextButton: 'Skip next',
    markWatchedButton: 'Mark watched & next',
    playlistHeading: 'Playlist',
    playlistCount: ({ count }) => `${count} ${count === 1 ? 'video' : 'videos'}`,
    savedAt: ({ time }) => `saved ${time}`,
    watchedLabel: 'watched',
    autoplayBlocked: ({ message }) => `Playback did not start automatically. Press play to continue.${message ? ` ${message}` : ''}`,
    progressSaveFailed: 'Progress could not be saved in this browser session.',
    defaultPlaybackError: 'The browser could not play this file.',
    playbackAborted: 'Playback was aborted.',
    playbackReadError: 'A network or local file read error interrupted playback.',
    playbackCorrupt: 'The video appears to be corrupt or unsupported by this browser.',
    playbackUnsupported: 'This file type or codec is not supported by this browser.',
    thisFile: 'this file'
  },
  es: {
    appTitle: 'Reproductor de video local',
    phaseLabel: 'Fase 1',
    heroDescription: 'Elegí una carpeta o varios videos, y reproducilos como una playlist local ordenada.',
    chooseVideos: 'Elegir videos',
    selectFolder: 'Seleccionar carpeta',
    selectFiles: 'Seleccionar archivos',
    supportedHint: 'Extensiones admitidas: .mp4, .webm, .m4v, .mov y .mkv cuando el navegador pueda reproducirlo.',
    statusNoVideos: 'No hay videos seleccionados.',
    statusNoSupported: 'No se encontraron videos compatibles en la selección.',
    statusLoaded: ({ count, rejected }) => `Se cargaron ${count} ${count === 1 ? 'video' : 'videos'}${rejected ? `; se ignoraron ${rejected} ${rejected === 1 ? 'archivo no compatible' : 'archivos no compatibles'}` : ''}.`,
    statusRestored: ({ name, time }) => `Se restauró ${name} en ${time}.`,
    statusSelected: ({ name }) => `Seleccionado: ${name}.`,
    statusMarkedWatched: ({ name }) => `Marcado como visto: ${name}.`,
    statusPlaylistFinished: 'Playlist terminada.',
    playerHeading: 'Reproductor',
    nothingPlaying: 'Nada en reproducción',
    previousButton: 'Anterior',
    skipNextButton: 'Saltar al siguiente',
    markWatchedButton: 'Marcar visto y seguir',
    playlistHeading: 'Playlist',
    playlistCount: ({ count }) => `${count} ${count === 1 ? 'video' : 'videos'}`,
    savedAt: ({ time }) => `guardado ${time}`,
    watchedLabel: 'visto',
    autoplayBlocked: ({ message }) => `La reproducción automática no empezó. Presioná reproducir para continuar.${message ? ` ${message}` : ''}`,
    progressSaveFailed: 'No se pudo guardar el progreso en esta sesión del navegador.',
    defaultPlaybackError: 'El navegador no pudo reproducir este archivo.',
    playbackAborted: 'La reproducción fue cancelada.',
    playbackReadError: 'Un error de red o lectura local interrumpió la reproducción.',
    playbackCorrupt: 'El video parece estar dañado o no es compatible con este navegador.',
    playbackUnsupported: 'Este tipo de archivo o codec no es compatible con este navegador.',
    thisFile: 'este archivo'
  }
};

function detectLocale() {
  const languages = Array.isArray(navigator.languages) && navigator.languages.length > 0
    ? navigator.languages
    : [navigator.language];
  return languages.some((language) => /^es(?:-|$)/i.test(language || '')) ? 'es' : 'en';
}

const locale = detectLocale();
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const state = {
  items: [],
  activeIndex: -1,
  currentObjectUrl: null,
  selectionId: null,
  dbPromise: null,
  lastSaveAt: 0
};

const elements = {
  folderInput: document.querySelector('#folderInput'),
  fileInput: document.querySelector('#fileInput'),
  status: document.querySelector('#status'),
  playlist: document.querySelector('#playlist'),
  playlistCount: document.querySelector('#playlistCount'),
  nowPlaying: document.querySelector('#nowPlaying'),
  video: document.querySelector('#videoPlayer'),
  error: document.querySelector('#errorMessage'),
  prevButton: document.querySelector('#prevButton'),
  nextButton: document.querySelector('#nextButton'),
  markWatchedButton: document.querySelector('#markWatchedButton')
};

function t(key, params = {}) {
  const value = COPY[locale][key] || COPY.en[key] || key;
  return typeof value === 'function' ? value(params) : value;
}

function applyStaticCopy() {
  document.documentElement.lang = locale;
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
}

function getRelativePath(file) {
  return file.webkitRelativePath || file.name;
}

function getExtension(fileName) {
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
}

function isVideoFile(file) {
  return VIDEO_EXTENSIONS.has(getExtension(file.name));
}

function createItemId(file) {
  return `${getRelativePath(file)}::${file.size}::${file.lastModified}`;
}

function createSelectionId(items) {
  return items.map((item) => item.id).join('\n');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function getVideoErrorMessage(mediaError) {
  if (!mediaError) return t('defaultPlaybackError');
  const messages = {
    1: t('playbackAborted'),
    2: t('playbackReadError'),
    3: t('playbackCorrupt'),
    4: t('playbackUnsupported')
  };
  return messages[mediaError.code] || t('defaultPlaybackError');
}

function openDatabase() {
  if (state.dbPromise) return state.dbPromise;

  state.dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) {
        db.createObjectStore(SESSION_STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(RECENT_ACTIVE_STORE_NAME)) {
        db.createObjectStore(RECENT_ACTIVE_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return state.dbPromise;
}

async function readProgress(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeProgress(record) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const request = transaction.objectStore(STORE_NAME).put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function readSession(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SESSION_STORE_NAME, 'readonly');
    const request = transaction.objectStore(SESSION_STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeSession(record) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(SESSION_STORE_NAME, 'readwrite');
    const request = transaction.objectStore(SESSION_STORE_NAME).put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function readRecentActive(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECENT_ACTIVE_STORE_NAME, 'readonly');
    const request = transaction.objectStore(RECENT_ACTIVE_STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function writeRecentActive(record) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(RECENT_ACTIVE_STORE_NAME, 'readwrite');
    const request = transaction.objectStore(RECENT_ACTIVE_STORE_NAME).put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

async function readRecentActiveRecords(items) {
  const records = await Promise.all(items.map((item) => readRecentActive(item.id)));
  return records.filter(Boolean);
}

function getTimestamp(record) {
  const timestamp = Date.parse(record?.updatedAt || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function hasMeaningfulProgress(progress) {
  return Boolean(progress?.watched) || Number(progress?.currentTime || 0) > 0;
}

function addRestoreCandidate(candidates, candidate) {
  const updatedAt = getTimestamp(candidate.record);
  if (updatedAt === null || !candidate.itemId) return;
  candidates.push({
    itemId: candidate.itemId,
    updatedAt,
    priority: candidate.priority
  });
}

function getLatestRestoreItemId(items, { exactSession = null, recentActiveRecords = [] } = {}) {
  const selectedItemIds = new Set(items.map((item) => item.id));
  const candidates = [];

  if (selectedItemIds.has(exactSession?.activeItemId)) {
    addRestoreCandidate(candidates, {
      itemId: exactSession.activeItemId,
      record: exactSession,
      priority: 2
    });
  }

  recentActiveRecords.forEach((recentActive) => {
    if (!selectedItemIds.has(recentActive?.id)) return;
    addRestoreCandidate(candidates, {
      itemId: recentActive.id,
      record: recentActive,
      priority: 1
    });
  });

  items.forEach((item) => {
    if (!hasMeaningfulProgress(item.progress)) return;
    addRestoreCandidate(candidates, {
      itemId: item.id,
      record: item.progress,
      priority: 0
    });
  });

  return candidates
    .sort((a, b) => (b.updatedAt - a.updatedAt) || (b.priority - a.priority))[0]?.itemId || null;
}

async function rememberActiveItem(item, source) {
  if (!item || !source) return;
  const updatedAt = new Date().toISOString();
  try {
    const writes = [writeRecentActive({
      id: item.id,
      relativePath: item.relativePath,
      source,
      updatedAt
    })];
    if (state.selectionId) {
      writes.push(writeSession({
        id: state.selectionId,
        activeItemId: item.id,
        source,
        updatedAt
      }));
    }
    await Promise.all(writes);
  } catch (error) {
    console.warn('Could not save active video', error);
  }
}

function updateStatus(message) {
  elements.status.textContent = message;
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
}

function clearError() {
  elements.error.textContent = '';
  elements.error.hidden = true;
}

function updateControls() {
  const hasActiveItem = state.activeIndex >= 0 && state.activeIndex < state.items.length;
  elements.prevButton.disabled = !hasActiveItem || state.activeIndex <= 0;
  elements.nextButton.disabled = !hasActiveItem || state.activeIndex >= state.items.length - 1;
  elements.markWatchedButton.disabled = !hasActiveItem;
  elements.playlistCount.textContent = t('playlistCount', { count: state.items.length });
}

function renderPlaylist() {
  elements.playlist.innerHTML = '';

  state.items.forEach((item, index) => {
    const listItem = document.createElement('li');
    listItem.className = 'playlist-item';
    if (index === state.activeIndex) listItem.classList.add('active');
    if (item.progress?.watched) listItem.classList.add('watched');

    const number = document.createElement('span');
    number.className = 'index';
    number.textContent = String(index + 1).padStart(2, '0');

    const content = document.createElement('div');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'title';
    button.textContent = item.relativePath;
    button.addEventListener('click', () => playIndex(index, { source: 'playlist-click' }));

    if (item.progress?.watched) {
      const watched = document.createElement('span');
      watched.className = 'watched-label';
      watched.textContent = t('watchedLabel');
      button.append(' ', watched);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    const savedTime = item.progress?.currentTime ? ` · ${t('savedAt', { time: formatTime(item.progress.currentTime) })}` : '';
    meta.textContent = `${formatBytes(item.file.size)}${savedTime}`;

    content.append(button, meta);
    listItem.append(number, content);
    elements.playlist.append(listItem);
  });

  updateControls();
}

function formatTime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
  }
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

function findItemIndexById(items, itemId) {
  return itemId ? items.findIndex((item) => item.id === itemId) : -1;
}

function getInitialIndex(items, restoreItemId = null) {
  const restoreIndex = findItemIndexById(items, restoreItemId);
  if (restoreIndex >= 0) return restoreIndex;

  const firstUnwatched = items.findIndex((item) => !item.progress?.watched);
  return firstUnwatched >= 0 ? firstUnwatched : 0;
}

async function handleFiles(fileList) {
  clearError();
  await saveActiveProgress();
  revokeCurrentObjectUrl();

  const allFiles = Array.from(fileList || []);
  const videoFiles = allFiles.filter(isVideoFile);
  const rejected = allFiles.length - videoFiles.length;

  const items = videoFiles
    .map((file) => ({
      id: createItemId(file),
      file,
      relativePath: getRelativePath(file),
      progress: null
    }))
    .sort((a, b) => collator.compare(a.relativePath, b.relativePath));

  await Promise.all(items.map(async (item) => {
    try {
      item.progress = await readProgress(item.id);
    } catch (error) {
      console.warn('Could not read progress', error);
    }
  }));

  const selectionId = createSelectionId(items);
  let exactSession = null;
  let recentActiveRecords = [];
  if (selectionId) {
    try {
      exactSession = await readSession(selectionId);
    } catch (error) {
      console.warn('Could not read selected-set active video', error);
    }
    try {
      recentActiveRecords = await readRecentActiveRecords(items);
    } catch (error) {
      console.warn('Could not read recent active videos', error);
    }
  }

  state.items = items;
  state.activeIndex = -1;
  state.selectionId = selectionId;
  elements.video.removeAttribute('src');
  elements.video.load();
  elements.nowPlaying.textContent = t('nothingPlaying');

  renderPlaylist();
  if (items.length === 0) {
    updateStatus(rejected > 0 ? t('statusNoSupported') : t('statusNoVideos'));
    return;
  }

  updateStatus(t('statusLoaded', { count: items.length, rejected }));
  const restoreItemId = getLatestRestoreItemId(items, { exactSession, recentActiveRecords });
  await playIndex(getInitialIndex(items, restoreItemId), {
    autoplay: false,
    saveCurrent: false
  });
}

function revokeCurrentObjectUrl() {
  if (state.currentObjectUrl) {
    URL.revokeObjectURL(state.currentObjectUrl);
    state.currentObjectUrl = null;
  }
}

async function playIndex(index, options = {}) {
  const { autoplay = true, saveCurrent = true, source = null } = options;
  if (index < 0 || index >= state.items.length) return;

  clearError();
  if (saveCurrent) await saveActiveProgress();
  revokeCurrentObjectUrl();

  state.activeIndex = index;
  const item = state.items[index];
  await rememberActiveItem(item, source);
  state.currentObjectUrl = URL.createObjectURL(item.file);
  elements.video.onloadedmetadata = () => {
    const savedTime = item.progress?.currentTime || 0;
    const duration = Number.isFinite(elements.video.duration) ? elements.video.duration : 0;
    if (savedTime > 5 && (!duration || savedTime < duration - 5)) {
      elements.video.currentTime = savedTime;
      updateStatus(t('statusRestored', { name: item.relativePath, time: formatTime(savedTime) }));
    }
  };
  elements.video.src = state.currentObjectUrl;
  elements.video.load();
  elements.nowPlaying.textContent = item.relativePath;
  updateStatus(t('statusSelected', { name: item.relativePath }));
  renderPlaylist();

  if (autoplay) {
    try {
      await elements.video.play();
    } catch (error) {
      showError(t('autoplayBlocked', { message: error.message || '' }));
    }
  }
}

async function saveActiveProgress({ watched = false, allowThresholdWatched = true } = {}) {
  const item = state.items[state.activeIndex];
  if (!item || !elements.video.src) return;

  const duration = Number.isFinite(elements.video.duration) ? elements.video.duration : 0;
  const currentTime = Number.isFinite(elements.video.currentTime) ? elements.video.currentTime : 0;
  const thresholdWatched = allowThresholdWatched && duration > 0 && currentTime / duration >= WATCHED_THRESHOLD;
  const record = {
    id: item.id,
    relativePath: item.relativePath,
    size: item.file.size,
    lastModified: item.file.lastModified,
    currentTime,
    duration,
    watched: watched || thresholdWatched || Boolean(item.progress?.watched),
    updatedAt: new Date().toISOString()
  };

  try {
    await writeProgress(record);
    item.progress = record;
    renderPlaylist();
  } catch (error) {
    console.warn('Could not save progress', error);
    showError(t('progressSaveFailed'));
  }
}

async function playRelative(offset, options = {}) {
  const nextIndex = state.activeIndex + offset;
  if (nextIndex >= 0 && nextIndex < state.items.length) {
    await playIndex(nextIndex, options);
  }
}

async function skipToNext() {
  await saveActiveProgress({ allowThresholdWatched: false });
  await playRelative(1, { saveCurrent: false, source: 'skip-next' });
}

async function markCurrentWatchedAndNext() {
  const item = state.items[state.activeIndex];
  if (!item) return;
  await saveActiveProgress({ watched: true });
  updateStatus(t('statusMarkedWatched', { name: item.relativePath }));
  if (state.activeIndex < state.items.length - 1) {
    await playIndex(state.activeIndex + 1, { saveCurrent: false, source: 'mark-watched-next' });
  } else {
    updateStatus(t('statusPlaylistFinished'));
  }
}

async function handleEnded() {
  await saveActiveProgress({ watched: true });
  if (state.activeIndex < state.items.length - 1) {
    await playIndex(state.activeIndex + 1, { saveCurrent: false, source: 'ended-auto-next' });
  } else {
    updateStatus(t('statusPlaylistFinished'));
  }
}

elements.folderInput.addEventListener('change', (event) => handleFiles(event.target.files));
elements.fileInput.addEventListener('change', (event) => handleFiles(event.target.files));
elements.prevButton.addEventListener('click', () => playRelative(-1, { source: 'previous' }));
elements.nextButton.addEventListener('click', skipToNext);
elements.markWatchedButton.addEventListener('click', markCurrentWatchedAndNext);
elements.video.addEventListener('pause', () => saveActiveProgress());
elements.video.addEventListener('ended', handleEnded);
elements.video.addEventListener('error', () => {
  const item = state.items[state.activeIndex];
  const name = item?.relativePath || t('thisFile');
  showError(`${name}: ${getVideoErrorMessage(elements.video.error)}`);
});
elements.video.addEventListener('timeupdate', () => {
  const now = Date.now();
  if (now - state.lastSaveAt >= SAVE_INTERVAL_MS) {
    state.lastSaveAt = now;
    saveActiveProgress();
  }
});
window.addEventListener('beforeunload', () => {
  saveActiveProgress();
  revokeCurrentObjectUrl();
});

applyStaticCopy();
updateControls();
