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
    selectFolder: 'Folder',
    selectFiles: 'File',
    clearPlaylistButton: 'Clear',
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
    selectFolder: 'Carpeta',
    selectFiles: 'Archivo',
    clearPlaylistButton: 'Vaciar',
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
  lastSaveAt: 0,
  clearTransitionTimer: null
};

const elements = {
  folderInput: document.querySelector('#folderInput'),
  fileInput: document.querySelector('#fileInput'),
  status: document.querySelector('#status'),
  playlistPanel: document.querySelector('#playlistPanel'),
  playlist: document.querySelector('#playlist'),
  playlistCount: document.querySelector('#playlistCount'),
  nowPlaying: document.querySelector('#nowPlaying'),
  video: document.querySelector('#videoPlayer'),
  error: document.querySelector('#errorMessage'),
  prevButton: document.querySelector('#prevButton'),
  nextButton: document.querySelector('#nextButton'),
  markWatchedButton: document.querySelector('#markWatchedButton'),
  clearPlaylistButton: document.querySelector('#clearPlaylistButton')
};

const particleCanvas = document.querySelector('#particleCanvas');

function initParticleBackground() {
  if (!particleCanvas) return;

  const context = particleCanvas.getContext('2d');
  if (!context) return;

  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = { x: 0, y: 0, active: false };
  let particles = [];
  let animationFrameId = null;
  let width = 0;
  let height = 0;
  let lastFrameTime = 0;

  function getParticleCount() {
    const area = window.innerWidth * window.innerHeight;
    return Math.max(170, Math.min(360, Math.round(area / 4600)));
  }

  function createParticle() {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 7;
    const dormant = Math.random() < 0.38;
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: dormant ? 0.45 + Math.random() * 0.85 : 0.55 + Math.random() * 1.25,
      alpha: dormant ? 0.02 + Math.random() * 0.04 : 0.24 + Math.random() * 0.48,
      dormant
    };
  }

  function resizeCanvas() {
    const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    particleCanvas.width = Math.floor(width * devicePixelRatio);
    particleCanvas.height = Math.floor(height * devicePixelRatio);
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    particles = Array.from({ length: getParticleCount() }, createParticle);
    drawFrame(0);
  }

  function getPointerInfluence(particle) {
    if (!pointer.active || reducedMotionQuery.matches) {
      return { x: particle.x, y: particle.y, amount: 0 };
    }

    const maxDistance = 215;
    const dx = particle.x - pointer.x;
    const dy = particle.y - pointer.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= 0 || distance >= maxDistance) {
      return { x: particle.x, y: particle.y, amount: 0 };
    }

    const amount = 1 - distance / maxDistance;
    const offset = amount * 8;
    return {
      x: particle.x + (dx / distance) * offset,
      y: particle.y + (dy / distance) * offset,
      amount
    };
  }

  function updateParticles(deltaSeconds) {
    particles.forEach((particle) => {
      particle.x += particle.vx * deltaSeconds;
      particle.y += particle.vy * deltaSeconds;

      if (particle.x < -10) particle.x = width + 10;
      if (particle.x > width + 10) particle.x = -10;
      if (particle.y < -10) particle.y = height + 10;
      if (particle.y > height + 10) particle.y = -10;
    });
  }

  function drawFrame(timestamp) {
    const deltaSeconds = lastFrameTime ? Math.min((timestamp - lastFrameTime) / 1000, 0.05) : 0;
    lastFrameTime = timestamp;

    if (!reducedMotionQuery.matches) {
      updateParticles(deltaSeconds);
    }

    context.clearRect(0, 0, width, height);
    context.fillStyle = '#000';
    context.fillRect(0, 0, width, height);

    const drawPoints = particles.map((particle) => ({
      particle,
      ...getPointerInfluence(particle)
    }));
    const visiblePoints = drawPoints.filter(({ particle, amount }) => !particle.dormant || amount > 0.08);

    context.lineWidth = 0.42;
    const passivePoints = visiblePoints.filter(({ particle }) => !particle.dormant);
    passivePoints.forEach((point, index) => {
      const nearest = passivePoints
        .map((candidate, candidateIndex) => ({
          candidate,
          candidateIndex,
          distance: candidateIndex === index ? Number.POSITIVE_INFINITY : Math.hypot(point.x - candidate.x, point.y - candidate.y)
        }))
        .filter(({ distance }) => distance < 220)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 2);

      nearest.forEach(({ candidate, distance }) => {
        const proximity = 1 - distance / 220;
        context.strokeStyle = `rgba(255, 255, 255, ${0.018 + proximity * 0.047})`;
        context.beginPath();
        context.moveTo(point.x, point.y);
        context.lineTo(candidate.x, candidate.y);
        context.stroke();
      });
    });

    context.lineWidth = 0.62;
    for (let i = 0; i < visiblePoints.length; i += 1) {
      for (let j = i + 1; j < visiblePoints.length; j += 1) {
        const a = visiblePoints[i];
        const b = visiblePoints[j];
        const activity = Math.max(a.amount, b.amount);
        if (activity <= 0.04) continue;

        const maxDistance = 118 + activity * 108;
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance >= maxDistance) continue;

        const proximity = 1 - distance / maxDistance;
        const dormantLift = (a.particle.dormant || b.particle.dormant) ? activity * 0.07 : 0;
        const alpha = 0.02 + proximity * 0.075 + activity * 0.18 + dormantLift;
        context.strokeStyle = `rgba(255, 255, 255, ${Math.min(0.34, alpha)})`;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }
    }

    if (pointer.active && !reducedMotionQuery.matches) {
      const cursorLinkDistance = 260;
      visiblePoints.forEach(({ x, y, amount }) => {
        if (amount <= 0.05) return;
        const distance = Math.hypot(x - pointer.x, y - pointer.y);
        if (distance >= cursorLinkDistance) return;

        const proximity = 1 - distance / cursorLinkDistance;
        context.strokeStyle = `rgba(255, 255, 255, ${0.07 + proximity * 0.24})`;
        context.beginPath();
        context.moveTo(pointer.x, pointer.y);
        context.lineTo(x, y);
        context.stroke();
      });
    }

    visiblePoints.forEach(({ particle, x, y, amount }) => {
      const alpha = particle.dormant
        ? Math.min(0.86, amount * 0.88)
        : Math.min(0.98, particle.alpha + amount * 0.32);
      if (alpha <= 0.01) return;
      context.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      context.beginPath();
      context.arc(x, y, particle.radius, 0, Math.PI * 2);
      context.fill();
    });
  }

  function animate(timestamp) {
    drawFrame(timestamp);
    if (!reducedMotionQuery.matches) {
      animationFrameId = window.requestAnimationFrame(animate);
    }
  }

  function startAnimation() {
    if (animationFrameId !== null) {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
    lastFrameTime = 0;
    if (reducedMotionQuery.matches) {
      drawFrame(0);
      return;
    }
    animationFrameId = window.requestAnimationFrame(animate);
  }

  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('pointermove', (event) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    pointer.active = true;
  });
  window.addEventListener('pointerleave', () => {
    pointer.active = false;
  });

  if (typeof reducedMotionQuery.addEventListener === 'function') {
    reducedMotionQuery.addEventListener('change', startAnimation);
  } else if (typeof reducedMotionQuery.addListener === 'function') {
    reducedMotionQuery.addListener(startAnimation);
  }

  resizeCanvas();
  startAnimation();
}

function t(key, params = {}) {
  const value = COPY[locale][key] || COPY.en[key] || key;
  return typeof value === 'function' ? value(params) : value;
}

function applyStaticCopy() {
  document.documentElement.lang = locale;
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((node) => {
    node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
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
  const hasItems = state.items.length > 0;
  const hasActiveItem = state.activeIndex >= 0 && state.activeIndex < state.items.length;
  elements.prevButton.disabled = !hasActiveItem || state.activeIndex <= 0;
  elements.nextButton.disabled = !hasActiveItem || state.activeIndex >= state.items.length - 1;
  elements.markWatchedButton.disabled = !hasActiveItem;
  elements.clearPlaylistButton.hidden = !hasItems;
  elements.clearPlaylistButton.disabled = !hasItems;
  elements.playlistPanel.classList.toggle('is-empty', !hasItems);
  elements.playlistPanel.classList.toggle('has-items', hasItems);
  elements.playlistCount.textContent = t('playlistCount', { count: state.items.length });
}

function stagePlaylistClearTransition() {
  if (state.clearTransitionTimer) {
    window.clearTimeout(state.clearTransitionTimer);
    state.clearTransitionTimer = null;
  }

  elements.playlistPanel.classList.remove('is-clearing');
  void elements.playlistPanel.offsetWidth;
  elements.playlistPanel.classList.add('is-clearing');
  state.clearTransitionTimer = window.setTimeout(() => {
    elements.playlistPanel.classList.remove('is-clearing');
    state.clearTransitionTimer = null;
  }, 280);
}

function renderPlaylist() {
  elements.playlist.innerHTML = '';

  state.items.forEach((item, index) => {
    const listItem = document.createElement('li');
    listItem.className = 'playlist-item';
    if (index === state.activeIndex) listItem.classList.add('active');
    if (item.progress?.watched) listItem.classList.add('watched');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'playlist-card-button';
    button.addEventListener('click', () => playIndex(index, { source: 'playlist-click' }));

    const number = document.createElement('span');
    number.className = 'index';
    number.textContent = String(index + 1).padStart(2, '0');

    const content = document.createElement('span');
    content.className = 'playlist-item-content';

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = item.relativePath;

    if (item.progress?.watched) {
      const watched = document.createElement('span');
      watched.className = 'watched-label';
      watched.textContent = t('watchedLabel');
      title.append(' ', watched);
    }

    const meta = document.createElement('span');
    meta.className = 'meta';
    const savedTime = item.progress?.currentTime ? ` · ${t('savedAt', { time: formatTime(item.progress.currentTime) })}` : '';
    meta.textContent = `${formatBytes(item.file.size)}${savedTime}`;

    content.append(title, meta);
    button.append(number, content);
    listItem.append(button);
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

async function clearPlaylist() {
  await saveActiveProgress();
  revokeCurrentObjectUrl();
  state.items = [];
  state.activeIndex = -1;
  state.selectionId = null;
  state.lastSaveAt = 0;
  elements.folderInput.value = '';
  elements.fileInput.value = '';
  elements.video.removeAttribute('src');
  elements.video.load();
  elements.nowPlaying.textContent = t('nothingPlaying');
  clearError();
  stagePlaylistClearTransition();
  renderPlaylist();
  updateStatus(t('statusNoVideos'));
}

elements.folderInput.addEventListener('change', (event) => handleFiles(event.target.files));
elements.fileInput.addEventListener('change', (event) => handleFiles(event.target.files));
elements.prevButton.addEventListener('click', () => playRelative(-1, { source: 'previous' }));
elements.nextButton.addEventListener('click', skipToNext);
elements.markWatchedButton.addEventListener('click', markCurrentWatchedAndNext);
elements.clearPlaylistButton.addEventListener('click', clearPlaylist);
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
initParticleBackground();
