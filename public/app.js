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
    appTitle: 'The Player',
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
    playlistSearchLabel: 'Search playlist',
    playlistSearchEmpty: 'No playlist items match the search.',
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
    appTitle: 'El Reproductor',
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
    playlistSearchLabel: 'Buscar playlist',
    playlistSearchEmpty: 'No hay elementos que coincidan con la búsqueda.',
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
  clearTransitionTimer: null,
  playlistSearchQuery: '',
  wakeLockSentinel: null,
  videoControlsTimer: null,
  volumeIndicatorTimer: null,
  volumeIndicatorHandoffTimer: null,
  volumeIndicatorConcealTimer: null,
  playbackTogglePending: false,
  userMuted: false,
  userVolume: 1
};

const elements = {
  folderInput: document.querySelector('#folderInput'),
  fileInput: document.querySelector('#fileInput'),
  status: document.querySelector('#status'),
  playlistPanel: document.querySelector('#playlistPanel'),
  playlist: document.querySelector('#playlist'),
  playlistSearchWrap: document.querySelector('#playlistSearchWrap'),
  playlistSearch: document.querySelector('#playlistSearch'),
  playlistEmptyState: document.querySelector('#playlistEmptyState'),
  playlistCount: document.querySelector('#playlistCount'),
  nowPlaying: document.querySelector('#nowPlaying'),
  videoFrame: document.querySelector('#videoFrame'),
  volumeIndicator: document.querySelector('#volumeIndicator'),
  volumeIndicatorValue: document.querySelector('#volumeIndicator .volume-indicator-value'),
  volumeIndicatorPlate: document.querySelector('#volumeIndicator .volume-indicator-plate'),
  volumeIndicatorBlocks: document.querySelector('#volumeIndicator .volume-indicator-blocks'),
  video: document.querySelector('#videoPlayer'),
  videoPlayPauseButton: document.querySelector('#videoPlayPauseButton'),
  videoTimeDisplay: document.querySelector('#videoTimeDisplay'),
  videoSeekRange: document.querySelector('#videoSeekRange'),
  videoMuteButton: document.querySelector('#videoMuteButton'),
  videoVolumeRange: document.querySelector('#videoVolumeRange'),
  videoFullscreenButton: document.querySelector('#videoFullscreenButton'),
  error: document.querySelector('#errorMessage'),
  layout: document.querySelector('.layout'),
  playerPanel: document.querySelector('.player-panel'),
  prevButton: document.querySelector('#prevButton'),
  nextButton: document.querySelector('#nextButton'),
  markWatchedButton: document.querySelector('#markWatchedButton'),
  clearPlaylistButton: document.querySelector('#clearPlaylistButton')
};

const particleCanvas = document.querySelector('#particleCanvas');

function initDesktopPlaylistHeightSync() {
  if (!elements.layout || !elements.playerPanel) return;

  const desktopQuery = window.matchMedia('(min-width: 861px)');
  let animationFrameId = null;

  function syncHeight() {
    animationFrameId = null;
    if (!desktopQuery.matches) {
      elements.layout.style.removeProperty('--player-panel-height');
      return;
    }

    const height = elements.playerPanel.getBoundingClientRect().height;
    if (height > 0) {
      elements.layout.style.setProperty('--player-panel-height', `${height}px`);
    }
  }

  function scheduleSync() {
    if (animationFrameId !== null) return;
    animationFrameId = window.requestAnimationFrame(syncHeight);
  }

  if ('ResizeObserver' in window) {
    const resizeObserver = new ResizeObserver(scheduleSync);
    resizeObserver.observe(elements.playerPanel);
    resizeObserver.observe(elements.layout);
  }
  window.addEventListener('resize', scheduleSync);
  if (typeof desktopQuery.addEventListener === 'function') {
    desktopQuery.addEventListener('change', scheduleSync);
  } else {
    desktopQuery.addListener(scheduleSync);
  }
  scheduleSync();
}

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

  function createParticle(x, y) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2 + Math.random() * 7;
    const dormant = Math.random() < 0.38;
    return {
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: dormant ? 0.45 + Math.random() * 0.85 : 0.55 + Math.random() * 1.25,
      alpha: dormant ? 0.02 + Math.random() * 0.04 : 0.24 + Math.random() * 0.48,
      dormant
    };
  }

  function createParticles() {
    const particleCount = getParticleCount();
    const viewportRatio = width / Math.max(height, 1);
    const rows = Math.max(1, Math.round(Math.sqrt(particleCount / Math.max(viewportRatio, 0.1))));
    const columns = Math.max(1, Math.ceil(particleCount / rows));
    const cellWidth = width / columns;
    const cellHeight = height / rows;

    return Array.from({ length: particleCount }, (_, index) => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const jitterX = 0.16 + Math.random() * 0.68;
      const jitterY = 0.16 + Math.random() * 0.68;
      return createParticle(
        Math.min(width, (column + jitterX) * cellWidth),
        Math.min(height, (row + jitterY) * cellHeight)
      );
    });
  }

  function resizeCanvas() {
    const devicePixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    particleCanvas.width = Math.floor(width * devicePixelRatio);
    particleCanvas.height = Math.floor(height * devicePixelRatio);
    context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    particles = createParticles();
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
  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    node.setAttribute('placeholder', t(node.dataset.i18nPlaceholder));
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
  elements.playlistSearchWrap.hidden = !hasItems;
  elements.playlistSearch.disabled = !hasItems;
  elements.playlistPanel.classList.toggle('is-empty', !hasItems);
  elements.playlistPanel.classList.toggle('has-items', hasItems);
  elements.playlistCount.textContent = t('playlistCount', { count: state.items.length });
  updateVideoControls();
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

function normalizePlaylistSearchValue(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase(locale);
}

function itemMatchesPlaylistSearch(item) {
  const query = normalizePlaylistSearchValue(state.playlistSearchQuery.trim());
  if (!query) return true;
  return normalizePlaylistSearchValue(item.relativePath).includes(query);
}

function renderPlaylist() {
  elements.playlist.innerHTML = '';

  const visibleItems = state.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => itemMatchesPlaylistSearch(item));

  visibleItems.forEach(({ item, index }) => {
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

  elements.playlistEmptyState.hidden = state.items.length === 0 || visibleItems.length > 0;
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

function getVideoDuration() {
  return Number.isFinite(elements.video.duration) ? elements.video.duration : 0;
}

function showVideoControls({ temporary = false } = {}) {
  if (!elements.videoFrame) return;
  elements.videoFrame.classList.add('controls-visible');
  if (state.videoControlsTimer) {
    window.clearTimeout(state.videoControlsTimer);
    state.videoControlsTimer = null;
  }
  if (temporary && elements.video.src && !elements.video.paused && !elements.video.ended) {
    state.videoControlsTimer = window.setTimeout(hideVideoControlsIfPlaying, 1700);
  }
}

function hideVideoControlsIfPlaying() {
  if (!elements.videoFrame) return;
  if (!elements.video.src || elements.video.paused || elements.video.ended) return;
  if (elements.videoFrame.contains(document.activeElement)) return;
  elements.videoFrame.classList.remove('controls-visible');
}

function updateVideoProgress() {
  const duration = getVideoDuration();
  const currentTime = Number.isFinite(elements.video.currentTime) ? elements.video.currentTime : 0;
  const seekMax = duration > 0 ? duration : 100;
  const seekValue = duration > 0 ? clamp(currentTime, 0, duration) : 0;

  const seekProgress = duration > 0 ? (seekValue / duration) * 100 : 0;

  elements.videoSeekRange.max = String(seekMax);
  elements.videoSeekRange.value = String(seekValue);
  elements.videoSeekRange.style.setProperty('--seek-progress', `${seekProgress}%`);
  elements.videoSeekRange.setAttribute('aria-valuetext', `${formatTime(seekValue)} of ${formatTime(duration)}`);
  elements.videoTimeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
}

function updateVideoControls() {
  const hasVideo = Boolean(elements.video.src);
  elements.videoFrame?.classList.toggle('has-video', hasVideo);
  elements.videoFrame?.classList.toggle('is-playing', hasVideo && !elements.video.paused && !elements.video.ended);
  const duration = getVideoDuration();
  const paused = elements.video.paused || elements.video.ended;
  const muted = elements.video.muted || elements.video.volume === 0;

  elements.videoPlayPauseButton.disabled = !hasVideo;
  elements.videoPlayPauseButton.setAttribute('aria-label', paused ? 'Play' : 'Pause');
  elements.videoPlayPauseButton.classList.toggle('is-playing', hasVideo && !paused);

  elements.videoSeekRange.disabled = !hasVideo || duration <= 0;
  updateVideoProgress();

  elements.videoMuteButton.disabled = !hasVideo;
  elements.videoMuteButton.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  elements.videoMuteButton.classList.toggle('is-muted', muted);

  const volumeValue = elements.video.muted ? 0 : elements.video.volume;
  elements.videoVolumeRange.disabled = !hasVideo;
  elements.videoVolumeRange.value = String(volumeValue);
  elements.videoVolumeRange.style.setProperty('--volume-progress', `${volumeValue * 100}%`);

  elements.videoFullscreenButton.disabled = !hasVideo || !elements.videoFrame;

  if (!hasVideo || elements.video.paused || elements.video.ended) {
    showVideoControls();
  }
}

function handleSeekInput(event) {
  if (!elements.video.src) return;
  const nextTime = Number.parseFloat(event.target.value);
  if (!Number.isFinite(nextTime)) return;
  elements.video.currentTime = clamp(nextTime, 0, getVideoDuration() || nextTime);
  updateVideoControls();
}

// These modules tessellate the full numeric field; the surrounding modules retain the irregular silhouette.
const VOLUME_BLOCK_BLUEPRINTS = [
  { x: -2.6, y: -1.78, width: 1.6, height: 1.2 },
  { x: -0.75, y: -1.78, width: 2.1, height: 1.2 },
  { x: 1.85, y: -1.78, width: 3.1, height: 1.2 },
  { x: -2.425, y: -0.43, width: 1.95, height: 1.5 },
  { x: -0.35, y: -0.43, width: 2.2, height: 1.5 },
  { x: 2.075, y: -0.43, width: 2.65, height: 1.5 },
  { x: -2.7, y: 1.35, width: 1.4, height: 2.06 },
  { x: -0.9, y: 1.35, width: 2.2, height: 2.06 },
  { x: 1.05, y: 1.35, width: 1.7, height: 2.06 },
  { x: 2.65, y: 1.35, width: 1.5, height: 2.06 },
  { x: 0, y: -2.58, width: 7, height: 0.6 },
  { x: 0, y: 2.58, width: 7, height: 0.6 },
  { x: -3.58, y: 0, width: 0.6, height: 4.96 },
  { x: 3.58, y: 0, width: 0.6, height: 4.96 },
  { x: -2.35, y: -3.4, width: 2.3, height: 1.2 },
  { x: 0, y: -3.38, width: 2.4, height: 1.2 },
  { x: 2.6, y: -3.31, width: 1.8, height: 1.2 },
  { x: -2.8, y: 3.28, width: 1.4, height: 1.4 },
  { x: -0.7, y: 3.23, width: 2.8, height: 1.3 },
  { x: 2.35, y: 3.38, width: 2, height: 1.6 },
  { x: -4.43, y: -1.45, width: 1.5, height: 1.9 },
  { x: -4.23, y: 0.65, width: 1.1, height: 2.3 },
  { x: -4.58, y: 2, width: 1.8, height: 0.8 },
  { x: 4.43, y: -1.5, width: 1.5, height: 1.8 },
  { x: 4.28, y: 0.45, width: 1.2, height: 2.1 },
  { x: 4.53, y: 2.1, width: 1.7, height: 0.6 }
];

function createVolumeIndicatorPlate() {
  if (!elements.volumeIndicatorPlate) return;

  const bounds = VOLUME_BLOCK_BLUEPRINTS.reduce((result, { x, y, width, height }) => ({
    left: Math.min(result.left, x - width / 2),
    right: Math.max(result.right, x + width / 2),
    top: Math.min(result.top, y - height / 2),
    bottom: Math.max(result.bottom, y + height / 2)
  }), { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });
  const scale = 100;
  const width = (bounds.right - bounds.left) * scale;
  const height = (bounds.bottom - bounds.top) * scale;
  const xEdges = [...new Set(VOLUME_BLOCK_BLUEPRINTS.flatMap(({ x, width: blockWidth }) => [x - blockWidth / 2, x + blockWidth / 2]))].sort((a, b) => a - b);
  const yEdges = [...new Set(VOLUME_BLOCK_BLUEPRINTS.flatMap(({ y, height: blockHeight }) => [y - blockHeight / 2, y + blockHeight / 2]))].sort((a, b) => a - b);
  const filled = new Set();
  const cellKey = (column, row) => `${column}:${row}`;
  const isFilled = (column, row) => filled.has(cellKey(column, row));

  for (let row = 0; row < yEdges.length - 1; row += 1) {
    for (let column = 0; column < xEdges.length - 1; column += 1) {
      const centerX = (xEdges[column] + xEdges[column + 1]) / 2;
      const centerY = (yEdges[row] + yEdges[row + 1]) / 2;
      if (VOLUME_BLOCK_BLUEPRINTS.some(({ x, y, width: blockWidth, height: blockHeight }) => (
        centerX >= x - blockWidth / 2 && centerX <= x + blockWidth / 2
        && centerY >= y - blockHeight / 2 && centerY <= y + blockHeight / 2
      ))) {
        filled.add(cellKey(column, row));
      }
    }
  }

  const edges = [];
  const pointKey = (x, y) => `${x}:${y}`;
  const addEdge = (fromX, fromY, toX, toY) => edges.push({
    fromX,
    fromY,
    toX,
    toY,
    used: false
  });
  for (let row = 0; row < yEdges.length - 1; row += 1) {
    for (let column = 0; column < xEdges.length - 1; column += 1) {
      if (!isFilled(column, row)) continue;
      const left = xEdges[column];
      const right = xEdges[column + 1];
      const top = yEdges[row];
      const bottom = yEdges[row + 1];
      if (!isFilled(column, row - 1)) addEdge(left, top, right, top);
      if (!isFilled(column + 1, row)) addEdge(right, top, right, bottom);
      if (!isFilled(column, row + 1)) addEdge(right, bottom, left, bottom);
      if (!isFilled(column - 1, row)) addEdge(left, bottom, left, top);
    }
  }

  const edgesByStart = new Map();
  edges.forEach((edge) => {
    const key = pointKey(edge.fromX, edge.fromY);
    const list = edgesByStart.get(key) || [];
    list.push(edge);
    edgesByStart.set(key, list);
  });
  const toSvgPoint = (x, y) => `${(x - bounds.left) * scale} ${(y - bounds.top) * scale}`;
  const paths = [];
  edges.forEach((firstEdge) => {
    if (firstEdge.used) return;
    const commands = [`M${toSvgPoint(firstEdge.fromX, firstEdge.fromY)}`];
    let edge = firstEdge;
    while (edge && !edge.used) {
      edge.used = true;
      commands.push(`L${toSvgPoint(edge.toX, edge.toY)}`);
      edge = (edgesByStart.get(pointKey(edge.toX, edge.toY)) || []).find((candidate) => !candidate.used);
    }
    paths.push(`${commands.join('')}Z`);
  });

  // Trace the union's exposed edges into one path, then tint its source modules without adding seams or a second silhouette.
  const platePath = paths.join('');
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const plate = elements.volumeIndicatorPlate;
  let defs = plate.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS(svgNamespace, 'defs');
    plate.prepend(defs);
  }
  let clipPath = defs.querySelector('#volume-indicator-plate-clip');
  if (!clipPath) {
    clipPath = document.createElementNS(svgNamespace, 'clipPath');
    clipPath.id = 'volume-indicator-plate-clip';
    defs.append(clipPath);
  }
  let clipOutline = clipPath.querySelector('path');
  if (!clipOutline) {
    clipOutline = document.createElementNS(svgNamespace, 'path');
    clipPath.append(clipOutline);
  }
  let texture = plate.querySelector('.volume-indicator-plate-texture');
  if (!texture) {
    texture = document.createElementNS(svgNamespace, 'g');
    texture.classList.add('volume-indicator-plate-texture');
    texture.setAttribute('clip-path', 'url(#volume-indicator-plate-clip)');
    plate.append(texture);
  }

  plate.setAttribute('viewBox', `0 0 ${width} ${height}`);
  plate.style.setProperty('--plate-width', `${(bounds.right - bounds.left).toFixed(2)}rem`);
  plate.style.setProperty('--plate-height', `${(bounds.bottom - bounds.top).toFixed(2)}rem`);
  plate.querySelector(':scope > path').setAttribute('d', platePath);
  clipOutline.setAttribute('d', platePath);
  texture.replaceChildren(...VOLUME_BLOCK_BLUEPRINTS.map(({ x, y, width: blockWidth, height: blockHeight }, index) => {
    const patch = document.createElementNS(svgNamespace, 'rect');
    patch.setAttribute('x', `${(x - blockWidth / 2 - bounds.left) * scale}`);
    patch.setAttribute('y', `${(y - blockHeight / 2 - bounds.top) * scale}`);
    patch.setAttribute('width', `${blockWidth * scale}`);
    patch.setAttribute('height', `${blockHeight * scale}`);
    patch.setAttribute('fill', index % 3 === 0 ? '#67676b' : index % 3 === 1 ? '#252529' : '#b0b0b4');
    patch.setAttribute('fill-opacity', index % 3 === 2 ? '0.055' : '0.045');
    return patch;
  }));
}

function createVolumeIndicatorBlocks() {
  if (!elements.volumeIndicatorBlocks || elements.volumeIndicatorBlocks.childElementCount > 0) return;

  createVolumeIndicatorPlate();
  VOLUME_BLOCK_BLUEPRINTS.forEach(({ x, y, width, height, core }, index) => {
    const scatterX = (((index * 37) % 53) - 26) / 10;
    const scatterY = (((index * 29) % 47) - 23) / 10;
    const startScale = 0.22 + ((index * 17) % 43) / 100;
    const delay = (index * 47) % 173;
    const duration = 520 + (index * 83) % 311;
    const block = document.createElement('span');
    block.className = `volume-indicator-block${core ? ' volume-indicator-core' : ''}`;
    block.style.left = '50%';
    block.style.top = '50%';
    block.style.width = `${width}rem`;
    block.style.height = `${height}rem`;
    block.style.setProperty('--final-x', `${x}rem`);
    block.style.setProperty('--final-y', `${y}rem`);
    block.style.setProperty('--scatter-x', `${scatterX}rem`);
    block.style.setProperty('--scatter-y', `${scatterY}rem`);
    block.style.setProperty('--start-scale', startScale);
    block.style.setProperty('--block-delay', `${delay}ms`);
    block.style.setProperty('--block-duration', `${duration}ms`);
    elements.volumeIndicatorBlocks.append(block);
  });
}

const VOLUME_BLOCK_ASSEMBLY_MS = 1020;
// The slowest module settles at 982ms; begin the brief seam-covering handoff only once its motion is nearly complete.
const VOLUME_PLATE_HANDOFF_MS = 840;
const VOLUME_INDICATOR_PHASES = [
  'phase-blocks-in',
  'phase-blocks-assembling',
  'phase-plate-handoff',
  'phase-value-visible',
  'phase-value-hidden',
  'phase-blocks-collapsing',
  'phase-blocks-dispersing'
];

function setVolumeIndicatorPhase(phase) {
  elements.volumeIndicator.classList.remove(...VOLUME_INDICATOR_PHASES);
  if (phase) elements.volumeIndicator.classList.add(phase);
}

function clearVolumeIndicatorTimers() {
  if (state.volumeIndicatorTimer) window.clearTimeout(state.volumeIndicatorTimer);
  if (state.volumeIndicatorHandoffTimer) window.clearTimeout(state.volumeIndicatorHandoffTimer);
  if (state.volumeIndicatorConcealTimer) window.clearTimeout(state.volumeIndicatorConcealTimer);
  state.volumeIndicatorTimer = null;
  state.volumeIndicatorHandoffTimer = null;
  state.volumeIndicatorConcealTimer = null;
}

function hideVolumeIndicator() {
  if (!elements.volumeIndicator) return;
  clearVolumeIndicatorTimers();
  setVolumeIndicatorPhase();
  elements.volumeIndicator.hidden = true;
}

function beginVolumeIndicatorExit() {
  state.volumeIndicatorTimer = null;
  setVolumeIndicatorPhase('phase-value-hidden');
  state.volumeIndicatorConcealTimer = window.setTimeout(() => {
    setVolumeIndicatorPhase('phase-blocks-collapsing');
    state.volumeIndicatorTimer = window.setTimeout(() => {
      setVolumeIndicatorPhase('phase-blocks-dispersing');
      state.volumeIndicatorConcealTimer = window.setTimeout(hideVolumeIndicator, 330);
    }, 230);
  }, 260);
}

function scheduleVolumeIndicatorExit() {
  if (state.volumeIndicatorTimer) window.clearTimeout(state.volumeIndicatorTimer);
  if (state.volumeIndicatorConcealTimer) window.clearTimeout(state.volumeIndicatorConcealTimer);
  state.volumeIndicatorConcealTimer = null;
  state.volumeIndicatorTimer = window.setTimeout(beginVolumeIndicatorExit, 1150);
}

function showVolumeIndicator() {
  if (!elements.volumeIndicator || !getFullscreenElement()) return;
  createVolumeIndicatorBlocks();

  const volume = elements.video.muted ? 0 : Math.round(elements.video.volume * 100);
  elements.volumeIndicator.value = String(volume);
  elements.volumeIndicatorValue.textContent = String(volume);

  if (!elements.volumeIndicator.hidden && elements.volumeIndicator.classList.contains('phase-value-visible')) {
    scheduleVolumeIndicatorExit();
    return;
  }

  hideVolumeIndicator();
  elements.volumeIndicator.hidden = false;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    setVolumeIndicatorPhase('phase-value-visible');
    scheduleVolumeIndicatorExit();
    return;
  }

  void elements.volumeIndicator.offsetWidth;
  window.requestAnimationFrame(() => {
    if (elements.volumeIndicator.hidden) return;
    setVolumeIndicatorPhase('phase-blocks-in');
    window.requestAnimationFrame(() => {
      if (elements.volumeIndicator.hidden) return;
      setVolumeIndicatorPhase('phase-blocks-assembling');
      state.volumeIndicatorHandoffTimer = window.setTimeout(() => {
        setVolumeIndicatorPhase('phase-plate-handoff');
        state.volumeIndicatorHandoffTimer = null;
      }, VOLUME_PLATE_HANDOFF_MS);
      state.volumeIndicatorTimer = window.setTimeout(() => {
        setVolumeIndicatorPhase('phase-value-visible');
        scheduleVolumeIndicatorExit();
      }, VOLUME_BLOCK_ASSEMBLY_MS);
    });
  });
}

function handleVolumeInput(event) {
  const nextVolume = Number.parseFloat(event.target.value);
  if (!Number.isFinite(nextVolume)) return;
  state.userMuted = false;
  state.userVolume = clamp(nextVolume, 0, 1);
  elements.video.volume = state.userVolume;
  elements.video.muted = false;
  updateVideoControls();
  showVolumeIndicator();
}

function toggleMute() {
  if (!elements.video.src) return;
  if (state.userMuted || state.userVolume === 0) {
    state.userMuted = false;
    if (state.userVolume === 0) state.userVolume = 0.5;
  } else {
    state.userMuted = true;
  }
  elements.video.volume = state.userVolume;
  elements.video.muted = state.userMuted;
  updateVideoControls();
  showVolumeIndicator();
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

function resetPlaylistSearch() {
  state.playlistSearchQuery = '';
  elements.playlistSearch.value = '';
}

async function handleFiles(fileList) {
  clearError();
  resetPlaylistSearch();
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
  elements.video.volume = state.userVolume;
  elements.video.muted = state.userMuted;
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
  await releaseWakeLock();
  await saveActiveProgress({ watched: true });
  if (state.activeIndex < state.items.length - 1) {
    await playIndex(state.activeIndex + 1, { saveCurrent: false, source: 'ended-auto-next' });
  } else {
    updateStatus(t('statusPlaylistFinished'));
  }
}

function supportsWakeLock() {
  return 'wakeLock' in navigator && typeof navigator.wakeLock?.request === 'function';
}

function shouldHoldWakeLock() {
  return document.visibilityState === 'visible'
    && Boolean(elements.video.src)
    && !elements.video.paused
    && !elements.video.ended;
}

async function requestWakeLock() {
  if (!supportsWakeLock() || state.wakeLockSentinel || !shouldHoldWakeLock()) return;

  try {
    state.wakeLockSentinel = await navigator.wakeLock.request('screen');
    state.wakeLockSentinel.addEventListener('release', () => {
      state.wakeLockSentinel = null;
    }, { once: true });
  } catch (error) {
    console.warn('Could not acquire screen wake lock', error);
  }
}

async function releaseWakeLock() {
  const sentinel = state.wakeLockSentinel;
  if (!sentinel) return;

  state.wakeLockSentinel = null;
  try {
    await sentinel.release();
  } catch (error) {
    console.warn('Could not release screen wake lock', error);
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    void releaseWakeLock();
    return;
  }
  void requestWakeLock();
}


function isEditableShortcutTarget(target) {
  if (!(target instanceof Element)) return false;
  const tagName = target.tagName.toLowerCase();
  return target.isContentEditable
    || ['input', 'textarea', 'select', 'button'].includes(tagName)
    || target.closest('[contenteditable="true"], [contenteditable=""]') !== null
    || target.closest('label, button') !== null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function togglePlayback() {
  if (!elements.video.src || state.playbackTogglePending) return;

  if (!elements.video.paused && !elements.video.ended) {
    elements.video.pause();
    return;
  }

  state.playbackTogglePending = true;
  try {
    await elements.video.play();
    clearError();
  } catch (error) {
    showError(t('autoplayBlocked', { message: error.message || '' }));
  } finally {
    state.playbackTogglePending = false;
  }
}

function seekBy(seconds) {
  if (!elements.video.src) return;
  const currentTime = Number.isFinite(elements.video.currentTime) ? elements.video.currentTime : 0;
  const duration = Number.isFinite(elements.video.duration) ? elements.video.duration : Number.POSITIVE_INFINITY;
  elements.video.currentTime = clamp(currentTime + seconds, 0, duration);
}

function changeVolumeBy(delta) {
  if (!elements.video.src) return;
  state.userMuted = false;
  state.userVolume = clamp(state.userVolume + delta, 0, 1);
  elements.video.volume = state.userVolume;
  elements.video.muted = false;
  updateVideoControls();
  showVolumeIndicator();
}

function getFullscreenElement() {
  return document.fullscreenElement
    || document.webkitFullscreenElement
    || document.mozFullScreenElement
    || document.msFullscreenElement
    || null;
}

function requestFullscreen(element) {
  const request = element.requestFullscreen
    || element.webkitRequestFullscreen
    || element.mozRequestFullScreen
    || element.msRequestFullscreen;
  return request ? request.call(element) : Promise.resolve();
}

function exitFullscreen() {
  const exit = document.exitFullscreen
    || document.webkitExitFullscreen
    || document.mozCancelFullScreen
    || document.msExitFullscreen;
  return exit ? exit.call(document) : Promise.resolve();
}

async function toggleFullscreen() {
  if (!elements.video.src) return;

  try {
    if (getFullscreenElement()) {
      await exitFullscreen();
      return;
    }
    await requestFullscreen(elements.videoFrame || elements.video);
  } catch (error) {
    console.warn('Could not toggle fullscreen', error);
  }
}

function handleKeyboardShortcuts(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (isEditableShortcutTarget(event.target)) return;

  const repeatLockedCodes = new Set(['Space', 'KeyA', 'KeyD', 'KeyW', 'KeyF']);
  const shortcutActions = {
    Space: () => togglePlayback(),
    ArrowLeft: () => seekBy(-5),
    ArrowRight: () => seekBy(5),
    KeyA: () => playRelative(-1, { source: 'previous' }),
    KeyD: () => skipToNext(),
    KeyW: () => markCurrentWatchedAndNext(),
    KeyF: () => toggleFullscreen(),
    ArrowUp: () => changeVolumeBy(0.05),
    ArrowDown: () => changeVolumeBy(-0.05)
  };
  const action = shortcutActions[event.code];
  if (!action) return;

  event.preventDefault();
  if (event.repeat && repeatLockedCodes.has(event.code)) return;
  void action();
}

async function clearPlaylist() {
  await saveActiveProgress();
  await releaseWakeLock();
  revokeCurrentObjectUrl();
  state.items = [];
  state.activeIndex = -1;
  state.selectionId = null;
  state.lastSaveAt = 0;
  resetPlaylistSearch();
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
elements.videoPlayPauseButton.addEventListener('click', togglePlayback);
elements.videoSeekRange.addEventListener('input', handleSeekInput);
elements.videoMuteButton.addEventListener('click', toggleMute);
elements.videoVolumeRange.addEventListener('input', handleVolumeInput);
elements.videoFullscreenButton.addEventListener('click', toggleFullscreen);
elements.videoFrame.addEventListener('pointermove', () => showVideoControls({ temporary: true }));
elements.videoFrame.addEventListener('pointerleave', hideVideoControlsIfPlaying);
elements.videoFrame.addEventListener('focusin', () => showVideoControls());
elements.videoFrame.addEventListener('focusout', () => showVideoControls({ temporary: true }));
elements.playlistSearch.addEventListener('input', (event) => {
  state.playlistSearchQuery = event.target.value;
  renderPlaylist();
});
window.addEventListener('keydown', handleKeyboardShortcuts);
document.addEventListener('visibilitychange', handleVisibilityChange);
elements.video.addEventListener('play', () => {
  updateVideoControls();
  window.requestAnimationFrame(hideVideoControlsIfPlaying);
  void requestWakeLock();
});
elements.video.addEventListener('pause', () => {
  updateVideoControls();
  void saveActiveProgress();
  void releaseWakeLock();
});
elements.video.addEventListener('ended', handleEnded);
elements.video.addEventListener('error', () => {
  const item = state.items[state.activeIndex];
  const name = item?.relativePath || t('thisFile');
  showError(`${name}: ${getVideoErrorMessage(elements.video.error)}`);
});
elements.video.addEventListener('loadedmetadata', updateVideoControls);
elements.video.addEventListener('durationchange', updateVideoControls);
elements.video.addEventListener('volumechange', updateVideoControls);
document.addEventListener('fullscreenchange', () => {
  updateVideoControls();
  if (!getFullscreenElement()) hideVolumeIndicator();
});
elements.video.addEventListener('timeupdate', () => {
  updateVideoProgress();
  const now = Date.now();
  if (now - state.lastSaveAt >= SAVE_INTERVAL_MS) {
    state.lastSaveAt = now;
    saveActiveProgress();
  }
});
window.addEventListener('pagehide', () => {
  void releaseWakeLock();
});
window.addEventListener('beforeunload', () => {
  saveActiveProgress();
  void releaseWakeLock();
  revokeCurrentObjectUrl();
});

applyStaticCopy();
createVolumeIndicatorBlocks();
updateControls();
initDesktopPlaylistHeightSync();
initParticleBackground();
