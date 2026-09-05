import { parseBlob } from './vendor/music-metadata.js';

/* =========================================================================
   Mixdeck — an Apple Music–shaped player for your own local files.
   ========================================================================= */

const DB_NAME = 'mixdeck-library';
const DB_VERSION = 3;
const DB_TRACKS = 'tracks';
const DB_PLAYLISTS = 'playlists';
const DB_SETTINGS = 'settings';
const DB_ARTWORK_CACHE = 'artwork-cache'; // covers for shared-library tracks, stored locally
const PLAYBACK_STORAGE_KEY = 'mixdeck-playback-state';
const UPLOAD_TOKEN_KEY = 'mixdeck-upload-token';

const audio = document.querySelector('#audioElement');
const contentEl = document.querySelector('#content');
const miniPlayer = document.querySelector('#miniPlayer');
const nowPlayingEl = document.querySelector('#nowPlaying');
const toastEl = document.querySelector('#toast');

/* ------------------------------ state ---------------------------------- */
const state = {
  tracks: [],
  publicTracks: [],
  playlists: [],
  settings: { shuffle: false, repeat: 'off', volume: 1, eq: null },
  route: { name: 'listennow', param: null },
  libraryTab: 'songs',
  searchQuery: '',
  searchHistory: [],
  queue: [],        // ordered track ids (the "up next" order)
  baseQueue: [],    // natural order before shuffling
  queueIndex: -1,
  currentTrackId: null,
  history: [],      // most-recent-first track ids
  objectUrls: new Map(),
  artworkUrls: new Map(),
  artworkBlobs: new Map(),   // id → fresh Blob rebuilt from stored artworkBytes
  renderContexts: {},
  station: null,    // { kind, label, pool, order }
  lyricIndex: -1,
  panels: { upnext: true, lyrics: false, history: false },
  sort: { librarySongs: 'newest', albums: 'title' },
  playback: { currentTrackId: null, queue: [], baseQueue: [], queueIndex: -1, position: 0, station: null },
  lyricLookup: new Set(),
  artworkLookup: new Set(),
  serverAvailable: false, // the optional Node server is detected at startup
};

/* --------------------------- utilities ---------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* Every icon is an inline SVG referencing the #ic-* sprite in index.html. */
const ICONS = {
  play: '<svg class="ic" aria-hidden="true"><use href="#ic-play"/></svg>',
  pause: '<svg class="ic" aria-hidden="true"><use href="#ic-pause"/></svg>',
  prev: '<svg class="ic" aria-hidden="true"><use href="#ic-prev"/></svg>',
  next: '<svg class="ic" aria-hidden="true"><use href="#ic-next"/></svg>',
  shuffle: '<svg class="ic" aria-hidden="true"><use href="#ic-shuffle"/></svg>',
  repeat: '<svg class="ic" aria-hidden="true"><use href="#ic-repeat"/></svg>',
  repeatOne: '<svg class="ic" aria-hidden="true"><use href="#ic-repeat-one"/></svg>',
  heart: '<svg class="ic" aria-hidden="true"><use href="#ic-heart"/></svg>',
  heartFill: '<svg class="ic" aria-hidden="true"><use href="#ic-heart-fill"/></svg>',
  listen: '<svg class="ic" aria-hidden="true"><use href="#ic-listen"/></svg>',
  browse: '<svg class="ic" aria-hidden="true"><use href="#ic-browse"/></svg>',
  radio: '<svg class="ic" aria-hidden="true"><use href="#ic-radio"/></svg>',
  library: '<svg class="ic" aria-hidden="true"><use href="#ic-library"/></svg>',
  search: '<svg class="ic" aria-hidden="true"><use href="#ic-search"/></svg>',
  settings: '<svg class="ic" aria-hidden="true"><use href="#ic-settings"/></svg>',
  music: '<svg class="ic" aria-hidden="true"><use href="#ic-music"/></svg>',
  lyrics: '<svg class="ic" aria-hidden="true"><use href="#ic-lyrics"/></svg>',
  share: '<svg class="ic" aria-hidden="true"><use href="#ic-share"/></svg>',
  import: '<svg class="ic" aria-hidden="true"><use href="#ic-import"/></svg>',
  sparkle: '<svg class="ic" aria-hidden="true"><use href="#ic-sparkle"/></svg>',
  more: '<svg class="ic" aria-hidden="true"><use href="#ic-more"/></svg>',
  close: '<svg class="ic" aria-hidden="true"><use href="#ic-close"/></svg>',
  chevronD: '<svg class="ic" aria-hidden="true"><use href="#ic-chevron-d"/></svg>',
  add: '<svg class="ic" aria-hidden="true"><use href="#ic-add"/></svg>',
  list: '<svg class="ic" aria-hidden="true"><use href="#ic-list"/></svg>',
  up: '<svg class="ic" aria-hidden="true"><use href="#ic-up"/></svg>',
  down: '<svg class="ic" aria-hidden="true"><use href="#ic-down"/></svg>',
  playNext: '<svg class="ic" aria-hidden="true"><use href="#ic-playnext"/></svg>',
  artist: '<svg class="ic" aria-hidden="true"><use href="#ic-artist"/></svg>',
  volume: '<svg class="ic" aria-hidden="true"><use href="#ic-volume"/></svg>',
};

function esc(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[c]));
}
function fmtTime(value) {
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const m = Math.floor(value / 60);
  const s = Math.floor(value % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
function fileTitle(name) { return (name.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled track'); }
function filenameMetadata(name) {
  const stem = name.replace(/\.[^/.]+$/, '').trim();
  const match = stem.match(/^(.+?)\s+-\s+(.+)$/);
  return match ? { artist: match[1].trim(), title: match[2].trim() } : { artist: '', title: fileTitle(name) };
}
function guessArtist(title) { return title.includes(' - ') ? title.split(' - ')[0].trim() : 'Unknown artist'; }
function uid(prefix = 'id') { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toastEl.classList.remove('show'), 2800);
}
let appUpdateAvailable = false;
// When the toast says an update is waiting, tapping it applies the new version.
toastEl.addEventListener('click', () => { if (appUpdateAvailable) location.reload(); });

function isPublicTrack(track) { return Boolean(track?.isPublic || track?.publicUrl); }
function allAvailableTracks() { return [...state.tracks, ...state.publicTracks]; }
function getTrack(id) { return allAvailableTracks().find(t => t.id === id); }
function persistTrack(track) { return isPublicTrack(track) ? Promise.resolve() : dbPut(DB_TRACKS, track); }
function normalizeTrack(track) {
  const title = track.title || fileTitle(track.name || 'Untitled track');
  const artist = track.artist || guessArtist(title);
  return {
    ...track,
    id: track.id || uid('track'),
    name: track.name || `${title}.audio`,
    blob: track.blob && !(track.blob instanceof Blob) ? new Blob([track.blob], { type: track.mimeType || 'audio/mpeg' }) : (track.blob || null),
    mimeType: track.mimeType || '',
    size: Number(track.size) || 0,
    addedAt: Number(track.addedAt) || Date.now(),
    duration: Number(track.duration) || 0,
    title,
    artist,
    albumArtist: track.albumArtist || artist,
    album: track.album || '',
    genre: track.genre || '',
    year: Number(track.year) || 0,
    composer: track.composer || '',
    trackNumber: Number(track.trackNumber) || 0,
    discNumber: Number(track.discNumber) || 0,
    bpm: Number(track.bpm) || 0,
    artworkBytes: track.artworkBytes ? new Uint8Array(track.artworkBytes) : null,
    artworkType: track.artworkType || (track.artwork ? track.artwork.type : '') || '',
    artwork: track.artwork || null, // legacy Blob form — migrated to bytes on hydrate
    lyrics: track.lyrics || '',
    syncedLyrics: Array.isArray(track.syncedLyrics) ? track.syncedLyrics : null,
    lyricsSource: track.lyricsSource || (track.lyrics || track.syncedLyrics ? 'embedded' : ''),
    lyricsFetchedAt: Number(track.lyricsFetchedAt) || 0,
    lyricsLookupFailed: Boolean(track.lyricsLookupFailed),
    artworkSource: track.artworkSource || (track.artworkBytes || track.artwork ? 'embedded' : ''),
    artworkFetchedAt: Number(track.artworkFetchedAt) || 0,
    artworkLookupFailed: Boolean(track.artworkLookupFailed),
    playCount: Number(track.playCount) || 0,
    lastPlayedAt: Number(track.lastPlayedAt) || 0,
    loved: Boolean(track.loved),
    downloaded: track.downloaded !== false,
  };
}
function trackUrl(track) {
  if (!track) return '';
  if (isPublicTrack(track)) return new URL(track.publicUrl, location.href).href;
  if (!track.blob) return '';
  if (!state.objectUrls.has(track.id)) {
    try { state.objectUrls.set(track.id, URL.createObjectURL(track.blob)); } catch { return ''; }
  }
  return state.objectUrls.get(track.id) || '';
}
async function hydrateLocalTrack(track) {
  const normalized = normalizeTrack(track);
  if (isPublicTrack(normalized)) return normalized;
  // Legacy migration: older versions stored covers as IDB Blobs, which can come
  // back with a stale backing reference after a cold start / new tab. Convert
  // to plain bytes here so artworkUrl() can rebuild a fresh Blob on demand.
  if (!hasArtwork(normalized) && track.artwork) {
    try {
      const artBytes = typeof track.artwork.arrayBuffer === 'function' ? await track.artwork.arrayBuffer() : null;
      if (artBytes && artBytes.byteLength) {
        normalized.artworkBytes = new Uint8Array(artBytes);
        normalized.artworkType = normalized.artworkType || track.artwork.type || 'image/jpeg';
      }
    } catch (e) { /* treat as no artwork */ }
  }
  normalized.artwork = null; // never re-persist the legacy Blob form
  if (!normalized.blob) return normalized;
  try {
    // Safari can return an IDB Blob with a stale backing reference after a PWA relaunch.
    // Copy its bytes into a fresh Blob before creating an object URL.
    const source = normalized.blob;
    const bytes = typeof source.arrayBuffer === 'function' ? await source.arrayBuffer() : source;
    normalized.blob = new Blob([bytes], { type: normalized.mimeType || source.type || 'audio/mpeg' });
    normalized.size = normalized.blob.size;
  } catch {
    normalized.blob = null;
  }
  return normalized;
}
function refreshTrackUrl(track) {
  if (isPublicTrack(track)) return trackUrl(track);
  if (!track?.blob) return '';
  const oldUrl = state.objectUrls.get(track.id);
  if (oldUrl) URL.revokeObjectURL(oldUrl);
  const freshUrl = URL.createObjectURL(track.blob);
  state.objectUrls.set(track.id, freshUrl);
  return freshUrl;
}
function albumKey(track) {
  return `${(track.album || '').toLowerCase()}|${(track.albumArtist || track.artist || '').toLowerCase()}`;
}

/* --------------------------- IndexedDB ---------------------------------- */
let db;
let loadedAudioTrackId = null;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(DB_TRACKS)) d.createObjectStore(DB_TRACKS, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(DB_PLAYLISTS)) d.createObjectStore(DB_PLAYLISTS, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(DB_SETTINGS)) d.createObjectStore(DB_SETTINGS, { keyPath: 'key' });
      if (!d.objectStoreNames.contains(DB_ARTWORK_CACHE)) d.createObjectStore(DB_ARTWORK_CACHE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function store(name, mode = 'readonly') { return db.transaction(name, mode).objectStore(name); }
function dbGetAll(name) { return new Promise((res, rej) => { const r = store(name).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function dbPut(name, value) { return new Promise((res, rej) => { const r = store(name, 'readwrite').put(value); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
function dbDelete(name, key) { return new Promise((res, rej) => { const r = store(name, 'readwrite').delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
function dbClear(name) { return new Promise((res, rej) => { const r = store(name, 'readwrite').clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }

async function saveSettings() {
  for (const [key, value] of Object.entries(state.settings)) await dbPut(DB_SETTINGS, { key, value });
}
async function loadPublicTracks() {
  // Probing the server also sets state.serverAvailable, so features can prefer
  // direct public APIs and only use the optional Node server when it is there.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('/api/public-tracks', { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return;
    const tracks = await response.json();
    state.publicTracks = Array.isArray(tracks) ? tracks.map(normalizeTrack) : [];
    state.serverAvailable = true;
    // Hydrate covers cached locally for shared-library tracks.
    const cache = await dbGetAll(DB_ARTWORK_CACHE).catch(() => []);
    const byId = new Map(cache.map(c => [c.id, c]));
    state.publicTracks.forEach(t => {
      const c = byId.get(t.id);
      if (c && c.artworkBytes && c.artworkBytes.length) {
        t.artworkBytes = new Uint8Array(c.artworkBytes);
        t.artworkType = c.artworkType || t.artworkType || 'image/jpeg';
        t.artworkSource = 'Online artwork';
        t.artworkFetchedAt = Number(c.artworkFetchedAt) || 0;
      }
    });
  } catch (e) { state.publicTracks = []; }
}

async function loadSettings() {
  try {
    const localPlayback = localStorage.getItem(PLAYBACK_STORAGE_KEY);
    if (localPlayback) state.playback = { ...state.playback, ...JSON.parse(localPlayback) };
  } catch (e) { /* ignore unavailable local storage */ }
  try {
    const rows = await dbGetAll(DB_SETTINGS);
    rows.forEach(r => {
      if (r.key === 'searchHistory') state.searchHistory = Array.isArray(r.value) ? r.value : [];
      else if (r.key === 'history') state.history = Array.isArray(r.value) ? r.value : [];
      else if (r.key === 'playback' && r.value && Number(r.value.savedAt || 0) >= Number(state.playback.savedAt || 0)) state.playback = { ...state.playback, ...r.value };
      else state.settings[r.key] = r.value;
    });
  } catch (e) { /* ignore */ }
}

function savePlaybackState() {
  if (!db) return;
  state.playback = {
    savedAt: Date.now(),
    currentTrackId: state.currentTrackId,
    queue: state.queue.slice(),
    baseQueue: state.baseQueue.slice(),
    queueIndex: state.queueIndex,
    position: loadedAudioTrackId === state.currentTrackId && Number.isFinite(audio.currentTime)
      ? audio.currentTime
      : (state.playback.currentTrackId === state.currentTrackId ? Number(state.playback.position) || 0 : 0),
    station: state.station ? { label: state.station.label, pool: state.station.pool.slice(), orderIndex: state.station.orderIndex } : null,
  };
  try { localStorage.setItem(PLAYBACK_STORAGE_KEY, JSON.stringify(state.playback)); } catch (e) { /* optional fallback */ }
  dbPut(DB_SETTINGS, { key: 'playback', value: state.playback }).catch(() => {});
}

function restorePlaybackState() {
  const saved = state.playback;
  const valid = id => Boolean(getTrack(id));
  const queue = Array.isArray(saved.queue) ? saved.queue.filter(valid) : [];
  const baseQueue = Array.isArray(saved.baseQueue) ? saved.baseQueue.filter(valid) : [];
  const current = valid(saved.currentTrackId) ? saved.currentTrackId : null;
  if (!current) return;
  state.queue = queue.length ? queue : [current];
  state.baseQueue = baseQueue.length ? baseQueue : state.queue.slice();
  state.currentTrackId = current;
  state.queueIndex = state.queue.includes(current) ? state.queue.indexOf(current) : 0;
  state.station = saved.station && Array.isArray(saved.station.pool)
    ? { ...saved.station, pool: saved.station.pool.filter(valid) }
    : null;
  // Do not attach a media source during startup. iOS may reject a restored
  // source before a user gesture and leave the element in a permanent error state.
  state.restorePosition = Math.max(0, Number(saved.position) || 0);
}

/* ----------------------- metadata extraction ---------------------------- */
async function extractMetadata(file) {
  const guessed = filenameMetadata(file.name);
  const track = {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    name: file.name,
    blob: file,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    addedAt: Date.now(),
    duration: 0,
    title: guessed.title,
    artist: guessed.artist,
    albumArtist: '',
    album: '',
    genre: '',
    year: 0,
    composer: '',
    trackNumber: 0,
    discNumber: 0,
    bpm: 0,
    artwork: null,
    artworkBytes: null,
    artworkType: '',
    lyrics: '',
    syncedLyrics: null,
    playCount: 0,
    lastPlayedAt: 0,
    loved: false,
    downloaded: true,
    lyricsSource: '',
    lyricsFetchedAt: 0,
    lyricsLookupFailed: false,
  };
  try {
    const meta = await parseBlob(file, { duration: true });
    const c = meta.common;
    if (c.title) track.title = c.title;
    if (c.artist) track.artist = c.artist;
    track.artist = track.artist || guessArtist(track.title);
    track.albumArtist = c.albumartist || track.artist;
    track.album = c.album || '';
    track.genre = (c.genre && c.genre[0]) || '';
    track.year = c.year || 0;
    track.composer = (c.composer && c.composer[0]) || '';
    track.trackNumber = (c.track && c.track.no) || 0;
    track.discNumber = (c.disk && c.disk.no) || 0;
    track.bpm = c.bpm || 0;
    track.duration = meta.format.duration || track.duration;
    if (c.picture && c.picture[0]) {
      const p = c.picture[0];
      track.artworkBytes = p.data instanceof Uint8Array ? p.data : new Uint8Array(p.data);
      track.artworkType = p.format || 'image/jpeg';
      track.artwork = null;
    }
    const lrc = extractLyrics(meta);
    track.lyrics = lrc.plain;
    track.syncedLyrics = lrc.synced;
  } catch (e) {
    track.artist = track.artist || guessArtist(track.title);
  }
  if (!track.duration) {
    track.duration = await readDuration(file);
  }
  return track;
}

function extractLyrics(meta) {
  let plain = '';
  const c = meta.common;
  if (Array.isArray(c.lyrics)) {
    plain = c.lyrics.map(l => (typeof l === 'string' ? l : l.text || '')).filter(Boolean).join('\n');
  }
  const native = meta.native || {};
  const frames = [];
  for (const tag in native) native[tag].forEach(f => frames.push({ tag, ...f }));
  const sylt = frames.find(f => f.id === 'SYLT' && f.value);
  if (sylt && Array.isArray(sylt.value)) {
    const synced = sylt.value.map(item => ({ time: Number(item.timestamp) || 0, text: item.text || '' })).filter(i => i.text);
    if (synced.length) return { plain, synced };
  }
  if (plain) {
    const parsed = parseLRC(plain);
    if (parsed) return { plain, synced: parsed };
  }
  return { plain, synced: null };
}
function parseLRC(text) {
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\](.*)/);
    if (m) {
      const fraction = m[3] ? (m[3].length === 3 ? Number(m[3]) / 1000 : Number(m[3]) / 100) : 0;
      const time = Number(m[1]) * 60 + Number(m[2]) + fraction;
      const content = m[4].trim();
      if (content) lines.push({ time, text: content });
    }
  }
  return lines.length ? lines.sort((a, b) => a.time - b.time) : null;
}

async function fetchLyricsJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`Lyrics request failed (${response.status})`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}
function cleanTitle(track) {
  // Strip trailing "[remaster]" / "(Official Audio)" style clutter before
  // querying lyric or artwork services.
  return track.title.replace(/\s*\[[^\]]+\]\s*$/g, '').replace(/\s*\([^)]*(?:official|lyrics|audio|video)[^)]*\)$/ig, '').trim();
}
function lyricResultItems(data) {
  return Array.isArray(data) ? data : data ? [data] : [];
}
function chooseLyricResult(data, title, artist) {
  const normalizedTitle = title.toLowerCase();
  const normalizedArtist = artist.toLowerCase();
  return lyricResultItems(data)
    .filter(item => item && (item.syncedLyrics || item.plainLyrics || item.lyrics))
    .sort((a, b) => {
      const score = item => {
        const itemTitle = String(item.trackName || item.name || '').toLowerCase();
        const itemArtist = String(item.artistName || item.artist || '').toLowerCase();
        return (itemTitle === normalizedTitle ? 4 : itemTitle.includes(normalizedTitle) ? 2 : 0)
          + (normalizedArtist && itemArtist === normalizedArtist ? 3 : itemArtist.includes(normalizedArtist) ? 1 : 0)
          + (item.syncedLyrics ? 1 : 0);
      };
      return score(b) - score(a);
    })[0] || null;
}
async function lookupLyrics(track, force = false) {
  if (!track || (!force && (track.lyrics || track.syncedLyrics || track.lyricsLookupFailed || state.lyricLookup.has(track.id)))) return;
  if (!navigator.onLine) {
    if (force) toast('Connect to the internet to find lyrics');
    return;
  }
  state.lyricLookup.add(track.id);
  if (!nowPlayingEl.hidden && state.currentTrackId === track.id && state.panels.lyrics) renderNpPanel();
  try {
    const title = cleanTitle(track);
    const artist = track.artist && track.artist !== 'Unknown artist' ? track.artist : '';
    const getParams = new URLSearchParams({ track_name: title });
    if (artist) getParams.set('artist_name', artist);
    if (track.album) getParams.set('album_name', track.album);
    const searchParams = new URLSearchParams({ q: artist ? `${title} ${artist}` : title });
    if (artist) searchParams.set('artist_name', artist);
    const requests = [
      // Use the local proxy first: it avoids CORS failures in Safari and keeps
      // the provider details out of the client when running the Node server.
      `/api/lyrics?${getParams.toString()}`,
      `https://lrclib.net/api/get?${getParams.toString()}`,
      `https://lrclib.net/api/search?${searchParams.toString()}`,
      `https://lrclib.net/api/search?track_name=${encodeURIComponent(title)}${artist ? `&artist_name=${encodeURIComponent(artist)}` : ''}`,
    ];
    let result = null;
    let lastError = null;
    for (const url of requests) {
      try {
        const data = await fetchLyricsJson(url);
        result = chooseLyricResult(data, title, artist);
        if (result) break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!result && artist) {
      try {
        const data = await fetchLyricsJson(`/api/lyrics?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`);
        if (data?.lyrics) result = { plainLyrics: data.lyrics, syncedLyrics: '' };
      } catch (error) {
        lastError = error;
      }
    }
    if (!result) throw lastError || new Error('No lyrics in result');
    const syncedText = result.syncedLyrics || '';
    const plainText = result.plainLyrics || result.lyrics || syncedText;
    if (!plainText.trim()) throw new Error('No lyrics in result');
    track.lyrics = plainText;
    track.syncedLyrics = parseLRC(syncedText) || null;
    track.lyricsSource = 'Online lyrics';
    track.lyricsFetchedAt = Date.now();
    track.lyricsLookupFailed = false;
    await dbPut(DB_TRACKS, track);
    toast(`Lyrics found for ${track.title}`);
  } catch (error) {
    track.lyricsLookupFailed = true;
    track.lyricsFetchedAt = Date.now();
    dbPut(DB_TRACKS, track).catch(() => {});
    if (force) toast(navigator.onLine ? 'Lyrics could not be found for this track' : 'Connect to the internet to find lyrics');
  } finally {
    state.lyricLookup.delete(track.id);
    if (!nowPlayingEl.hidden && state.currentTrackId === track.id) updateNowPlaying();
  }
}
function lyricsEmptyHtml(track) {
  const offline = !navigator.onLine;
  if (track?.lyricsLookupFailed && offline) return '<div class="np-empty">No cached lyrics — connect once to find them.</div>';
  return `<div class="np-empty"><p>${track?.lyricsLookupFailed ? 'Lyrics not found yet.' : 'No lyrics in this file.'}</p><button class="ghost-button lyrics-find" data-action="find-lyrics" data-id="${esc(track?.id || '')}">${offline ? 'Connect to find lyrics' : 'Find lyrics'}</button></div>`;
}
/* ----------------------- artwork lookup (album covers) -------------------- */
/* Architecture
   1. Persistence — a cover is stored ONLY as plain bytes (artworkBytes +
      artworkType). Bytes are immune to the stale-IDB-Blob behavior that can
      make covers vanish after a cold start or in a new tab.
   2. Rendering — artworkUrl() rebuilds a fresh Blob from those bytes on
      demand (cached per session) and hands out an object URL. A cover that is
      in storage therefore always renders.
   3. Finding — lookupArtwork() is the single entry point:
      search (iTunes direct — keyless + CORS-open, no server needed) → rank →
      download → persist bytes → refresh UI. Idempotent, safe to call anywhere.
   4. Migration — tracks saved by older versions with artwork as a Blob are
      converted to bytes by hydrateLocalTrack() on load. */
const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const ARTWORK_RETRY_MS = 30 * 60 * 1000; // a failed lookup retries on the next play within 30 minutes

function hasArtwork(track) {
  return Boolean(track && track.artworkBytes && track.artworkBytes.length);
}
function artworkUrl(track) {
  if (!track || !hasArtwork(track)) return null;
  if (!state.artworkUrls.has(track.id)) {
    let blob = state.artworkBlobs.get(track.id);
    if (!blob) {
      try {
        blob = new Blob([track.artworkBytes], { type: track.artworkType || 'image/jpeg' });
      } catch (e) { return null; }
      state.artworkBlobs.set(track.id, blob);
    }
    try { state.artworkUrls.set(track.id, URL.createObjectURL(blob)); }
    catch (e) { return null; }
  }
  return state.artworkUrls.get(track.id);
}

async function fetchArtworkCandidates(track) {
  const title = cleanTitle(track);
  const artist = track.artist && track.artist !== 'Unknown artist' ? track.artist : '';
  const album = track.album || '';
  const proxyParams = new URLSearchParams({ title });
  if (artist) proxyParams.set('artist', artist);
  if (album) proxyParams.set('album', album);
  const term = [title, artist, album].filter(Boolean).join(' ');
  const itunesParams = new URLSearchParams({ term, media: 'music', entity: 'song', limit: '25' });
  // iTunes is the primary source: free, keyless, CORS-open, and reachable from
  // any static host with no PC server running. The local proxy is only used as
  // a fallback when the optional Node server was detected at startup.
  const requests = [
    `${ITUNES_SEARCH_URL}?${itunesParams.toString()}`,
    ...(state.serverAvailable ? [`/api/artwork?${proxyParams.toString()}`] : []),
  ];
  for (const url of requests) {
    try {
      const data = await fetchLyricsJson(url);
      const items = Array.isArray(data) ? data : (data && Array.isArray(data.results) ? data.results : null);
      if (Array.isArray(items) && items.length) return items;
    } catch (e) { /* try the next source */ }
  }
  return [];
}
function artworkScore(item, title, artist, album) {
  const nTitle = title.toLowerCase();
  const nArtist = artist.toLowerCase();
  const nAlbum = (album || '').toLowerCase();
  const t = String(item.trackName || item.name || '').toLowerCase();
  const a = String(item.artistName || item.artist || '').toLowerCase();
  const al = String(item.collectionName || item.album || '').toLowerCase();
  let score = 0;
  if (t === nTitle) score += 4;
  else if (nTitle && (t.includes(nTitle) || nTitle.includes(t))) score += 2;
  if (nArtist && a === nArtist) score += 3;
  else if (nArtist && (a.includes(nArtist) || nArtist.includes(a))) score += 1;
  if (nAlbum && al === nAlbum) score += 2;
  else if (nAlbum && (al.includes(nAlbum) || nAlbum.includes(al))) score += 1;
  return score;
}
function chooseArtworkResult(items, title, artist, album) {
  return items
    .filter(item => item && (item.artworkUrl || item.artworkUrl100))
    .sort((a, b) => artworkScore(b, title, artist, album) - artworkScore(a, title, artist, album))[0] || null;
}
function artworkImageUrl(item) {
  const base = String(item.artworkUrl || item.artworkUrl100 || '');
  // Apple serves the small preview art; swap the size token for a hires image.
  return base.replace(/\/60x60bb\./, '/600x600bb.').replace(/\/100x100bb\./, '/600x600bb.');
}
async function fetchImageBlob(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Artwork request failed (${response.status})`);
    const blob = await response.blob();
    if (!blob || !blob.size) throw new Error('Artwork image is empty');
    return blob;
  } finally {
    clearTimeout(timer);
  }
}
let coverRefreshQueued = false;
function refreshCoverView() {
  // Re-render just enough to pick up freshly found covers, without scrolling
  // the page or stealing focus from an input the user is typing in.
  if (coverRefreshQueued) return;
  coverRefreshQueued = true;
  requestAnimationFrame(() => {
    coverRefreshQueued = false;
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    const y = window.scrollY;
    renderView();
    window.scrollTo(0, y);
  });
}
async function lookupArtwork(track, force = false, quiet = false) {
  if (!track) return;
  const staleFailure = track.artworkLookupFailed && Date.now() - (track.artworkFetchedAt || 0) > ARTWORK_RETRY_MS;
  const alreadyHandled = hasArtwork(track) || (track.artworkLookupFailed && !staleFailure) || state.artworkLookup.has(track.id);
  if (!force && alreadyHandled) return;
  if (!navigator.onLine) {
    if (force) toast('Connect to the internet to find artwork');
    return;
  }
  state.artworkLookup.add(track.id);
  try {
    const title = cleanTitle(track);
    const artist = track.artist && track.artist !== 'Unknown artist' ? track.artist : '';
    const album = track.album || '';
    const candidates = await fetchArtworkCandidates(track);
    let result = chooseArtworkResult(candidates, title, artist, album);
    if (!result && artist) {
      // Second pass scoped to the artist only — catches remasters and
      // compilation singles whose title alone is too generic.
      const scoped = await fetchArtworkCandidates({ ...track, title: `${artist} ${title}`, artist: '' });
      result = chooseArtworkResult(scoped, title, artist, album);
    }
    if (!result) throw new Error('No artwork found');
    const blob = await fetchImageBlob(artworkImageUrl(result));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.length) throw new Error('Artwork image is empty');
    // Invalidate the session caches so the new cover renders immediately.
    if (state.artworkUrls.has(track.id)) {
      URL.revokeObjectURL(state.artworkUrls.get(track.id));
      state.artworkUrls.delete(track.id);
    }
    state.artworkBlobs.delete(track.id);
    track.artworkBytes = bytes;
    track.artworkType = blob.type || track.artworkType || 'image/jpeg';
    track.artwork = null;
    track.artworkSource = 'Online artwork';
    track.artworkFetchedAt = Date.now();
    track.artworkLookupFailed = false;
    if (isPublicTrack(track)) {
      // Shared-library tracks keep covers in a local cache, not the server.
      await dbPut(DB_ARTWORK_CACHE, { id: track.id, artworkBytes: bytes, artworkType: track.artworkType, artworkFetchedAt: track.artworkFetchedAt });
    } else {
      await dbPut(DB_TRACKS, track);
    }
    if (!quiet) toast(`Artwork found for ${track.title}`);
    updateMiniPlayer();
    if (!nowPlayingEl.hidden) updateNowPlaying();
    refreshCoverView();
  } catch (error) {
    track.artworkLookupFailed = true;
    track.artworkFetchedAt = Date.now();
    if (!isPublicTrack(track)) dbPut(DB_TRACKS, track).catch(() => {});
    if (force && !quiet) toast(navigator.onLine ? 'Artwork could not be found for this track' : 'Connect to the internet to find artwork');
  } finally {
    state.artworkLookup.delete(track.id);
  }
}
function queueArtworkLookups(tracks) {
  // Background, sequential lookups with a small worker pool so importing a big
  // folder doesn't hammer the network with dozens of parallel requests.
  // lookupArtwork() itself skips tracks that already have art or failed recently,
  // so queuing every coverless track is safe and lets a launch sweep retry the
  // ones that were imported before the artwork feature existed.
  const pending = tracks.filter(t => !hasArtwork(t));
  let cursor = 0;
  const workers = Array.from({ length: 2 }, async () => {
    while (cursor < pending.length) {
      const track = pending[cursor++];
      await lookupArtwork(track, false, true);
    }
  });
  Promise.all(workers);
}
function readDuration(file) {
  return new Promise(resolve => {
    const probe = document.createElement('audio');
    const url = URL.createObjectURL(file);
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(probe.duration || 0); };
    probe.onerror = () => { URL.revokeObjectURL(url); resolve(0); };
    probe.src = url;
  });
}

/* --------------------------- audio / EQ --------------------------------- */
let audioCtx = null;
let mediaSource = null;
let gainNode = null;
let eqFilters = [];
let eqEnabled = false;

const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  flat: { name: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bassboost: { name: 'Bass Boost', gains: [7, 6, 4, 2, 0, 0, 0, 0, 0, 0] },
  treble: { name: 'Treble', gains: [0, 0, 0, 0, 0, 1, 2, 4, 6, 7] },
  vocal: { name: 'Vocal', gains: [-1, -1, 1, 3, 4, 3, 2, 1, 0, -1] },
  rock: { name: 'Rock', gains: [4, 3, 1, 0, 1, 2, 3, 4, 4, 4] },
  pop: { name: 'Pop', gains: [-1, 0, 2, 3, 1, 0, 1, 2, 3, 2] },
  dance: { name: 'Dance', gains: [5, 4, 2, 0, -1, 0, 1, 2, 3, 4] },
  acoustic: { name: 'Acoustic', gains: [3, 3, 2, 1, 0, 0, 1, 2, 3, 3] },
  classical: { name: 'Classical', gains: [3, 2, 1, 0, 0, 0, 1, 2, 2, 3] },
};

function ensureAudioGraph() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  if (!audioCtx) audioCtx = new AC();
  if (!mediaSource) {
    mediaSource = audioCtx.createMediaElementSource(audio);
    gainNode = audioCtx.createGain();
    gainNode.gain.value = state.settings.volume;
    eqFilters = EQ_FREQS.map(freq => {
      const f = audioCtx.createBiquadFilter();
      f.type = 'peaking';
      f.frequency.value = freq;
      f.Q.value = 1.1;
      f.gain.value = 0;
      return f;
    });
  }
  return true;
}
function applyEqGraph() {
  if (!mediaSource) return;
  mediaSource.disconnect();
  gainNode.disconnect();
  eqFilters.forEach(f => f.disconnect());
  if (eqEnabled) {
    let prev = mediaSource;
    for (const f of eqFilters) { prev.connect(f); prev = f; }
    prev.connect(gainNode);
  } else {
    mediaSource.connect(gainNode);
  }
  gainNode.connect(audioCtx.destination);
  eqFilters.forEach((f, i) => {
    const gains = (state.settings.eq && state.settings.eq.gains) || EQ_PRESETS.flat.gains;
    f.gain.value = eqEnabled ? (gains[i] || 0) : 0;
  });
}
function setEq(preset) {
  if (!preset) { eqEnabled = false; state.settings.eq = null; }
  else {
    eqEnabled = ensureAudioGraph();
    state.settings.eq = { name: preset, gains: EQ_PRESETS[preset].gains.slice() };
  }
  applyEqGraph();
  if (audioCtx && audioCtx.state === 'suspended' && eqEnabled) audioCtx.resume();
  saveSettings();
  renderView();
}
function setVolume(v) {
  v = clamp(v, 0, 1);
  state.settings.volume = v;
  if (gainNode) gainNode.gain.value = v;
  audio.volume = v;
  saveSettings();
}

/* ----------------------------- playback --------------------------------- */
function playTrackList(list, startIndex = 0) {
  if (!list.length) return;
  const safeIndex = clamp(Number(startIndex) || 0, 0, list.length - 1);
  state.baseQueue = list.map(t => t.id);
  state.queue = state.settings.shuffle
    ? shuffleKeepFirst([...state.baseQueue], list[safeIndex].id)
    : [...state.baseQueue];
  state.queueIndex = state.queue.indexOf(list[safeIndex].id);
  if (state.queueIndex === -1) state.queueIndex = 0;
  state.station = null;
  state.lyricIndex = -1;
  playCurrent();
}
function playSingle(track) { playTrackList([track], 0); }
function shuffleKeepFirst(order, first) {
  const rest = order.filter(id => id !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [first, ...rest];
}
function startCurrentAudio() {
  const track = getTrack(state.currentTrackId);
  if (!track || (!track.blob && !isPublicTrack(track))) { toast('This file is no longer available on the device'); return; }
  let url = trackUrl(track);
  if (!url) { toast('This song is unavailable on this device'); return; }
  const resumeAt = Number.isFinite(audio.currentTime) && audio.currentTime > 0
    ? audio.currentTime
    : (state.playback.currentTrackId === track.id ? Number(state.playback.position) || 0 : 0);
  const needsReload = audio.src !== url || audio.networkState === HTMLMediaElement.NETWORK_EMPTY || audio.error || audio.readyState === HTMLMediaElement.HAVE_NOTHING;
  if (needsReload) {
    url = isPublicTrack(track) ? trackUrl(track) : refreshTrackUrl(track);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    audio.src = url;
    loadedAudioTrackId = track.id;
    state.restorePosition = resumeAt;
    audio.load();
  }
  const promise = audio.play();
  if (!promise?.then) return;
  promise.then(() => {
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  }).catch(error => {
    if (!isPublicTrack(track) && error?.name !== 'NotAllowedError') {
      const retryUrl = refreshTrackUrl(track);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      audio.src = retryUrl;
      state.restorePosition = resumeAt;
      audio.load();
      audio.play().then(() => audioCtx?.state === 'suspended' && audioCtx.resume()).catch(() => {
        toast('This audio file could not be played — tap Play to retry');
      });
    } else {
      toast(error?.name === 'NotAllowedError' ? 'Tap Play to start this track' : 'This audio file could not be played');
    }
  });
}
function playCurrent() {
  const track = getTrack(state.queue[state.queueIndex]);
  if (!track) return;
  // Fully detach the old source before changing currentTrackId. Otherwise a
  // pause event or stale currentTime can be attributed to the next track.
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  loadedAudioTrackId = null;
  state.currentTrackId = track.id;
  state.restorePosition = null;
  // Mark this as a new media element session so the previous track's saved
  // position is never reused when selecting another song.
  state.playback.currentTrackId = null;
  state.playback.position = 0;
  savePlaybackState();
  if (!track.lyrics && !track.syncedLyrics) lookupLyrics(track);
  lookupArtwork(track);
  startCurrentAudio();  track.playCount = (track.playCount || 0) + 1;
  track.lastPlayedAt = Date.now();  state.history = [track.id, ...state.history.filter(id => id !== track.id)].slice(0, 50);
  persistTrack(track);
  dbPut(DB_SETTINGS, { key: 'history', value: state.history });
  savePlaybackState();
  updateMediaSession(track);
  updateMiniPlayer();
  updateNowPlaying();
  renderView();
}
function togglePlay() {
  if (!state.currentTrackId) {
    const all = allAvailableTracks();
    if (all.length) return playTrackList(all, 0);
    return;
  }
  if (audio.paused) startCurrentAudio(); else audio.pause();
  updateMiniPlayer(); updateNowPlaying();
}
function nextTrack() {
  if (!state.queue.length) return;
  if (state.settings.repeat === 'one') { audio.currentTime = 0; audio.play().catch(() => {}); return; }
  if (state.station) return stationNext();
  if (state.queueIndex < state.queue.length - 1) state.queueIndex++;
  else if (state.settings.repeat === 'all' && state.queue.length) state.queueIndex = 0;
  else {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    state.queueIndex = state.queue.length;
    state.currentTrackId = null;
    savePlaybackState();
    updateMiniPlayer(); updateNowPlaying(); renderView();
    return;
  }
  playCurrent();
}
function previousTrack() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (state.queueIndex > 0) state.queueIndex--; else state.queueIndex = 0;
  playCurrent();
}
function toggleShuffle() {
  state.settings.shuffle = !state.settings.shuffle;
  if (state.settings.shuffle) {
    if (state.baseQueue.length) {
      const cur = state.queue[state.queueIndex];
      state.queue = shuffleKeepFirst([...state.baseQueue], cur);
      state.queueIndex = state.queue.indexOf(cur);
    }
  } else {
    state.queue = [...state.baseQueue];
    const cur = state.currentTrackId;
    if (cur && state.queue.includes(cur)) state.queueIndex = state.queue.indexOf(cur);
  }
  saveSettings(); updateNowPlaying(); renderView();
}
function toggleRepeat() {
  const modes = ['off', 'all', 'one'];
  state.settings.repeat = modes[(modes.indexOf(state.settings.repeat) + 1) % modes.length];
  saveSettings(); updateNowPlaying(); renderView();
}

/* --------------------------- Media Session ------------------------------ */
function updateMediaSession(track) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  const art = artworkUrl(track);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: track.album || '',
    artwork: art ? [{ src: art, sizes: '512x512', type: track.artworkType || 'image/jpeg' }] : [],
  });
  updateMediaSessionPosition();
}
function updateMediaSessionPosition() {
  if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
  const duration = Number(audio.duration);
  if (!Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      playbackRate: audio.playbackRate || 1,
      position: clamp(audio.currentTime || 0, 0, duration),
    });
  } catch (e) { /* optional */ }
}
function bindMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const setHandler = (action, handler) => { try { ms.setActionHandler(action, handler); } catch (e) { /* optional */ } };
  setHandler('play', () => audio.play().catch(() => {}));
  setHandler('pause', () => audio.pause());
  setHandler('previoustrack', previousTrack);
  setHandler('nexttrack', nextTrack);
  setHandler('seekbackward', (d) => { audio.currentTime = clamp(audio.currentTime - (d.seekOffset || 15), 0, audio.duration || Infinity); });
  setHandler('seekforward', (d) => { audio.currentTime = clamp(audio.currentTime + (d.seekOffset || 15), 0, audio.duration || Infinity); });
  setHandler('seekto', (d) => { if (audio.duration && d.seekTime != null) audio.currentTime = clamp(d.seekTime, 0, audio.duration); });
}

/* --------------------------- radio / mixes ------------------------------ */
function seedStation(poolTracks, label) {
  if (!poolTracks.length) return;
  const order = [...poolTracks];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  state.station = { label, pool: order.map(t => t.id), orderIndex: 0 };
  state.baseQueue = [...state.station.pool];
  state.queue = [...state.station.pool];
  state.queueIndex = 0;
  state.lyricIndex = -1;
  playCurrent();
}
function stationNext() {
  if (!state.station || !state.station.pool.length) return nextTrack();
  state.station.orderIndex++;
  if (state.station.orderIndex >= state.station.pool.length) state.station.orderIndex = 0;
  state.queue = [...state.station.pool];
  state.baseQueue = [...state.station.pool];
  state.queueIndex = state.station.orderIndex;
  state.lyricIndex = -1;
  playCurrent();
}
function makeAutoMix(poolTracks) {
  if (poolTracks.length < 2) return poolTracks.map(t => t.id);
  const start = poolTracks[Math.floor(Math.random() * poolTracks.length)];
  const remaining = poolTracks.filter(t => t.id !== start.id);
  const order = [start.id];
  let current = start;
  while (remaining.length) {
    let best = null, bestScore = -Infinity;
    for (const cand of remaining) {
      let score = Math.random() * 0.8;
      if (cand.genre && current.genre && cand.genre === current.genre) score += 1.6;
      if (cand.artist === current.artist) score += 0.4;
      if (cand.bpm && current.bpm) score += 1.4 * (1 - Math.abs(cand.bpm - current.bpm) / 60);
      if (cand.album && current.album && cand.album === current.album) score -= 2;
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    order.push(best.id);
    remaining.splice(remaining.indexOf(best), 1);
    current = best;
  }
  return order;
}
function playAutoMix(poolTracks, label) {
  if (poolTracks.length < 2) { toast('Add at least two tracks to make a mix'); return; }
  const order = makeAutoMix(poolTracks);
  state.station = { label, pool: order, orderIndex: 0 };
  state.baseQueue = [...order];
  state.queue = state.settings.shuffle ? shuffleKeepFirst([...order], order[0]) : [...order];
  state.queueIndex = 0;
  state.lyricIndex = -1;
  playCurrent();
  toast('A fresh mix is ready');
}

/* ------------------------- context menus / sheets ------------------------ */
let contextItems = [];
function openMenu(items, anchor) {
  contextItems = items;
  const menu = $('#contextMenu');
  menu.innerHTML = items.map((it, i) =>
    `<button class="ctx-item ${it.danger ? 'danger' : ''}" data-menu="${i}">${it.icon || ''} ${esc(it.label)}${it.badge ? `<b>${esc(it.badge)}</b>` : ''}</button>`
  ).join('');
  $('#menuBackdrop').hidden = false;
  menu.style.top = '0';
}
$('#menuBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'menuBackdrop') closeMenu();
  else {
    const idx = e.target.closest('[data-menu]')?.dataset.menu;
    if (idx != null) { const item = contextItems[Number(idx)]; closeMenu(); if (item) item.action(); }
  }
});
function closeMenu() { $('#menuBackdrop').hidden = true; contextItems = []; }

function openPlaylistSheet(trackIds, title = 'Add to Playlist') {
  $('#sheetTitle').textContent = title;
  const body = $('#sheetBody');
  const playlists = state.playlists;
  if (!playlists.length) {
    body.innerHTML = '<p class="sheet-empty">No playlists yet — create one to get started.</p><button class="primary-button" data-sheet-action="new">New Playlist +</button>';
  } else {
    body.innerHTML = playlists.map(p =>
      `<button class="sheet-playlist" data-sheet-action="add" data-playlist="${esc(p.id)}"><span class="pl-chip" style="background:${p.color}">${ICONS.music}</span><span class="sheet-pl-name">${esc(p.name)}</span><span class="sheet-pl-count">${p.trackIds.length}</span></button>`
    ).join('') + `<button class="sheet-playlist new" data-sheet-action="new"><span class="pl-chip">${ICONS.add}</span><span class="sheet-pl-name">New Playlist</span></button>`;
  }
  body._trackIds = trackIds;
  $('#sheetBackdrop').hidden = false;
}
$('#sheetBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'sheetBackdrop') { $('#sheetBackdrop').hidden = true; return; }
  const el = e.target.closest('[data-sheet-action]');
  if (!el) return;
  const action = el.dataset.sheetAction;
  const ids = $('#sheetBody')._trackIds || [];
  if (action === 'new') { $('#sheetBackdrop').hidden = true; openPlaylistEditor(null, ids); }
  if (action === 'add') {
    const pl = state.playlists.find(p => p.id === el.dataset.playlist);
    if (pl) {
      const before = pl.trackIds.length;
      ids.forEach(id => { if (!pl.trackIds.includes(id)) pl.trackIds.push(id); });
      dbPut(DB_PLAYLISTS, pl);
      $('#sheetBackdrop').hidden = true;
      if (before === pl.trackIds.length) toast('Already in ' + pl.name);
      else toast(`Added to ${pl.name}`);
      renderView();
    }
  }
});

function openPlaylistEditor(existing, trackIds = []) {
  const editTitle = $('#playlistEditTitle');
  const body = $('#playlistEditBody');
  const colors = ['#ff6b6b', '#f59f00', '#37b24d', '#3bc9db', '#4c6ef5', '#a395ff', '#f06595'];
  editTitle.textContent = existing ? 'Edit Playlist' : 'New Playlist';
  body.innerHTML = `
    <input id="plName" class="sheet-input" placeholder="Playlist name" maxlength="60" value="${esc(existing ? existing.name : '')}" />
    <div class="pl-colors">${colors.map((c, i) => `<button class="pl-color ${existing && existing.color === c ? 'active' : ''} ${i === 0 ? 'sel' : ''}" data-color="${c}" style="background:${c}"></button>`).join('')}</div>
    <div class="sheet-actions">
      <button class="ghost-button" data-editor="cancel">Cancel</button>
      <button class="primary-button" data-editor="save">${existing ? 'Save' : 'Create'}</button>
    </div>`;
  body._existing = existing;
  body._trackIds = trackIds;
  body._color = existing ? existing.color : colors[0];
  $('#playlistEditBackdrop').hidden = false;
}
$('#playlistEditBackdrop').addEventListener('click', (e) => {
  if (e.target.id === 'playlistEditBackdrop') { $('#playlistEditBackdrop').hidden = true; return; }
  const body = $('#playlistEditBody');
  if (e.target.matches('.pl-color')) {
    body._color = e.target.dataset.color;
    $$('.pl-color', body).forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    return;
  }
  const btn = e.target.closest('[data-editor]');
  if (!btn) return;
  if (btn.dataset.editor === 'cancel') { $('#playlistEditBackdrop').hidden = true; return; }
  const name = ($('#plName', body).value || '').trim();
  if (!name) { toast('Give your playlist a name'); return; }
  const existing = body._existing;
  if (existing) {
    existing.name = name;
    existing.color = body._color;
    dbPut(DB_PLAYLISTS, existing);
    toast('Playlist updated');
  } else {
    const pl = { id: uid('pl'), name, color: body._color, trackIds: body._trackIds, createdAt: Date.now() };
    dbPut(DB_PLAYLISTS, pl);
    state.playlists.push(pl);
    toast('Playlist created');
  }
  $('#playlistEditBackdrop').hidden = true;
  renderView();
});

/* ------------------------- render helpers -------------------------------- */
function coverHtml(track, className = '') {
  const url = artworkUrl(track);
  return url
    ? `<span class="cover ${className}" style="background-image:url('${url}')"></span>`
    : `<span class="cover ${className}"><span class="cover-glyph">${ICONS.music}</span></span>`;
}
function sectionHead(title, actionLabel = '') {
  return `<div class="sec-head"><h2>${esc(title)}</h2>${actionLabel ? `<button class="sec-more" data-action="more">${esc(actionLabel)}</button>` : ''}</div>`;
}
function playlistColor(pl) {
  return `style="background:${esc(pl.color)}"`;
}

/* --------------------------- navigation ---------------------------------- */
function navigate(name, param) {
  state.route = { name, param };
  renderView();
}
function activeNav() {
  const map = { listennow: 'listennow', browse: 'browse', radio: 'radio', library: 'library', search: 'search', settings: 'settings', genre: 'browse' };
  return map[state.route.name] || (state.route.name === 'album' || state.route.name === 'artist' || state.route.name === 'playlist' ? state.route.name === 'playlist' ? 'library' : 'browse' : 'listennow');
}
function setNavActive() {
  $$('.nav-item, .mobile-tab').forEach(b => {
    const name = b.dataset.nav;
    b.classList.toggle('active', name === activeNav());
  });
}

/* =========================================================================
   VIEWS
   ========================================================================= */
let contentRenderedOnce = false;
function renderView() {
  setNavActive();
  state.renderContexts = {};
  const fn = VIEWS[state.route.name];
  const animating = contentRenderedOnce;
  if (animating) contentEl.classList.remove('view-in');
  contentEl.innerHTML = fn ? fn(state.route.param) : '';
  bindDynamic();
  window.scrollTo(0, 0);
  updateMiniPlayer();
  if (animating) {
    // Restart the entrance animation even if two renders happen in the same frame.
    contentEl.classList.remove('view-in');
    void contentEl.offsetWidth;
    contentEl.classList.add('view-in');
  } else {
    contentRenderedOnce = true;
  }
}

const VIEWS = {
  listennow: renderHome,
  browse: renderBrowse,
  radio: renderRadio,
  library: renderLibrary,
  search: renderSearch,
  settings: renderSettings,
  album: renderAlbum,
  artist: renderArtist,
  playlist: renderPlaylist,
  genre: renderGenreFilter,
};

/* ------------------------- Library helpers ------------------------------- */
function groupedAlbums() {
  const map = new Map();
  allAvailableTracks().forEach(t => {
    const key = albumKey(t);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  });
  return [...map.values()].sort((a, b) => (a[0].album || '').localeCompare(b[0].album || ''));
}
function artistStats() {
  const map = new Map();
  allAvailableTracks().forEach(t => {
    if (!map.has(t.artist)) map.set(t.artist, []);
    map.get(t.artist).push(t);
  });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}
function genreStats() {
  const map = new Map();
  allAvailableTracks().forEach(t => { if (t.genre) { if (!map.has(t.genre)) map.set(t.genre, []); map.get(t.genre).push(t); } });
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/* ------------------------- Listen Now ------------------------------------ */
function renderHome() {
  const tracks = allAvailableTracks();
  if (!tracks.length) return emptyLibrary();
  const recentlyPlayed = [...tracks].filter(t => t.lastPlayedAt).sort((a, b) => b.lastPlayedAt - a.lastPlayedAt).slice(0, 12);
  const recentlyAdded = [...tracks].sort((a, b) => b.addedAt - a.addedAt).slice(0, 12);
  const mostPlayed = [...tracks].filter(t => t.playCount).sort((a, b) => b.playCount - a.playCount).slice(0, 12);
  const loved = [...tracks].filter(t => t.loved);

  let html = `<header class="hero minimal"><p class="eyebrow accent">LISTEN NOW</p><div class="hero-row"><h1>Listen Now</h1><div class="toolbar"><label class="tool-btn" for="fileInput"><span class="tool-ic">${ICONS.import}</span>Import</label><input id="fileInput" type="file" accept="audio/*,.mp3,.m4a,.wav,.aac,.flac,.ogg" multiple hidden /><button class="tool-btn" data-action="autoplay-mix"><span class="tool-ic">${ICONS.sparkle}</span>Auto-mix</button><label class="tool-btn" for="publicFileInput"><span class="tool-ic">${ICONS.share}</span>Share</label><input id="publicFileInput" type="file" accept="audio/*,.mp3,.m4a,.wav,.aac,.flac,.ogg,.opus" hidden /></div></div></header>`;

  if (recentlyPlayed.length) html += `<section class="home-sec">${sectionHead('Recently Played')}<div class="grid tracks">${recentlyPlayed.map(t => tile(t)).join('')}</div></section>`;
  if (loved.length) html += `<section class="home-sec">${sectionHead('Loved')}<div class="grid tracks">${loved.map(t => tile(t)).join('')}</div></section>`;
  if (recentlyAdded.length) html += `<section class="home-sec">${sectionHead('Recently Added')}<div class="grid tracks">${recentlyAdded.map(t => tile(t)).join('')}</div></section>`;
  if (mostPlayed.length) html += `<section class="home-sec">${sectionHead('Most Played')}<div class="grid tracks">${mostPlayed.map(t => tile(t)).join('')}</div></section>`;
  if (state.publicTracks.length) html += `<section class="home-sec public-library">${sectionHead('Shared Library')}<div class="grid tracks">${state.publicTracks.map(t => tile(t)).join('')}</div></section>`;
  return html;
}

function tile(track) {
  return `<div class="tile" data-action="play-ctx" data-id="${esc(track.id)}">${coverHtml(track, 'tile-cover')}<div class="tile-name">${esc(track.title)}</div><div class="tile-sub">${esc(track.artist)}</div></div>`;
}

/* ------------------------- Browse ----------------------------------------- */
function renderBrowse() {
  const tracks = allAvailableTracks();
  if (!tracks.length) return emptyLibrary();
  const albums = groupedAlbums();
  const artists = artistStats();
  const genres = genreStats();
  const charts = [...tracks].filter(t => t.playCount).sort((a, b) => b.playCount - a.playCount).slice(0, 20);
  let html = `<header class="page-head"><p class="eyebrow accent">BROWSE</p><h1>Explore your collection</h1></header>`;
  if (charts.length) html += `<section class="home-sec">${sectionHead('Most Played')}<ol class="chart-list">${charts.map(t => chartRow(t)).join('')}</ol></section>`;
  if (genres.length) html += `<section class="home-sec">${sectionHead('Genres')}<div class="grid genres">${genres.map(([g, list]) => genreTile(g, list)).join('')}</div></section>`;
  if (albums.length) html += `<section class="home-sec">${sectionHead('Albums')}<div class="grid albums">${albums.map(list => albumTile(list[0])).join('')}</div></section>`;
  if (artists.length) html += `<section class="home-sec">${sectionHead('Artists')}<div class="grid artists">${artists.map(([name, list]) => artistTile(name, list)).join('')}</div></section>`;
  return html;
}
function chartRow(t) {
  return `<li class="chart-row"><span class="chart-num">${String(t.playCount)}</span>${coverHtml(t, 'sm-cover')}<button class="tr-main" data-action="play-ctx" data-id="${esc(t.id)}"><span class="chart-name">${esc(t.title)}</span><span class="chart-sub">${esc(t.artist)}</span></button><span class="chart-count">${t.playCount} plays</span></li>`;
}
function genreTile(g, list) {
  return `<div class="genre-tile" data-action="genre" data-genre="${esc(g)}"><span class="genre-name">${esc(g)}</span><span class="genre-count">${list.length} tracks</span></div>`;
}
function albumTile(track) {
  return `<div class="tile" data-action="album" data-id="${esc(track.id)}">${coverHtml(track, 'tile-cover')}<div class="tile-name">${esc(track.album || 'Unknown album')}</div><div class="tile-sub">${esc(track.albumArtist || track.artist)}</div></div>`;
}
function artistTile(name, list) {
  const anyArt = list.find(hasArtwork) || list[0];
  return `<div class="tile" data-action="artist" data-artist="${esc(name)}">${coverHtml(anyArt, 'tile-cover')}<div class="tile-name">${esc(name)}</div><div class="tile-sub">${list.length} ${list.length === 1 ? 'song' : 'songs'}</div></div>`;
}

/* ------------------------- Radio ------------------------------------------ */
function renderRadio() {
  const tracks = allAvailableTracks();
  if (!tracks.length) return emptyLibrary();
  const artists = artistStats().filter(([, list]) => list.length >= 3);
  const genres = genreStats().filter(([, list]) => list.length >= 3);
  let html = `<header class="page-head"><p class="eyebrow accent">RADIO</p><h1>Radio</h1></header>`;
  html += `<section class="action-row single"><button class="action-card" data-action="autoplay-mix"><span class="action-icon sparkle">${ICONS.sparkle}</span><span><strong>My Station</strong></span></button></section>`;
  if (artists.length) html += `<section class="home-sec">${sectionHead('Artist Radio')}<div class="grid radio">${artists.map(([name, list]) => radioTile(name, list, 'artist')).join('')}</div></section>`;
  if (genres.length) html += `<section class="home-sec">${sectionHead('Genre Radio')}<div class="grid radio">${genres.map(([g, list]) => radioTile(g, list, 'genre')).join('')}</div></section>`;
  return html;
}
function radioTile(name, list, kind) {
  const anyArt = list.find(hasArtwork) || list[0];
  return `<div class="tile" data-action="radio-seed" data-kind="${kind}" data-value="${esc(name)}">${coverHtml(anyArt, 'tile-cover')}<div class="tile-name">${esc(name)}</div><div class="tile-sub">Radio · ${list.length} tracks</div></div>`;
}

/* ------------------------- Library ---------------------------------------- */
const LIBRARY_TABS = [
  ['songs', 'Songs'], ['albums', 'Albums'], ['artists', 'Artists'], ['playlists', 'Playlists'],
  ['downloaded', 'Downloaded'], ['recentlyAdded', 'Recently Added'], ['recentlyPlayed', 'Recently Played'],
  ['genres', 'Genres'], ['composers', 'Composers'], ['years', 'Years'],
];
function renderLibrary() {
  if (!state.tracks.length && !state.publicTracks.length && !state.playlists.length) return emptyLibrary();
  const tab = state.libraryTab;
  let html = `<header class="page-head lib"><p class="eyebrow accent">LIBRARY</p><h1>Your Library</h1>
    <div class="lib-tabs">${LIBRARY_TABS.map(([key, label]) => `<button class="lib-tab ${tab === key ? 'active' : ''}" data-action="lib-tab" data-tab="${key}">${label}</button>`).join('')}</div>
    ${tab === 'songs' ? `<div class="lib-tools"><input id="libSearch" class="inline-search" type="search" placeholder="Filter songs" value="${esc(state.searchQuery)}" /><button class="ghost-button" data-action="sort-songs">${state.sort.librarySongs === 'newest' ? 'Newest first' : state.sort.librarySongs === 'title' ? 'Title A–Z' : 'Artist'}</button><button class="ghost-button" data-action="shuffle-library">Shuffle</button></div>` : ''}
  </header>`;
  html += `<div class="lib-body" id="libBody">${renderLibraryBody(tab)}</div>`;
  return html;
}
function renderLibraryBody(tab) {
  const tracks = allAvailableTracks();
  switch (tab) {
    case 'songs': return trackListView(sortSongs([...tracks]), 'library-songs');
    case 'albums': {
      const albums = groupedAlbums();
      return albums.length ? `<div class="grid albums">${albums.map(list => albumTile(list[0])).join('')}</div>` : emptySub();
    }
    case 'artists': {
      const artists = artistStats();
      return artists.length ? `<div class="grid artists">${artists.map(([name, list]) => artistTile(name, list)).join('')}</div>` : emptySub();
    }
    case 'playlists': return renderPlaylistsGrid();
    case 'downloaded': {
      const down = tracks.filter(t => t.downloaded);
      return trackListView(sortSongs(down), 'library-songs');
    }
    case 'recentlyAdded': return trackListView([...tracks].sort((a, b) => b.addedAt - a.addedAt), 'library-songs');
    case 'recentlyPlayed': {
      const rp = tracks.filter(t => t.lastPlayedAt).sort((a, b) => b.lastPlayedAt - a.lastPlayedAt);
      return trackListView(rp, 'library-songs');
    }
    case 'genres': {
      const genres = genreStats();
      return genres.length ? `<div class="genre-list">${genres.map(([g, list]) => genreRow(g, list)).join('')}</div>` : emptySub();
    }
    case 'composers': {
      const map = new Map();
      tracks.forEach(t => { const c = t.composer || 'Unknown'; if (!map.has(c)) map.set(c, []); map.get(c).push(t); });
      const comps = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      return comps.length ? `<div class="genre-list">${comps.map(([c, list]) => genreRow(c, list, 'composer')).join('')}</div>` : emptySub();
    }
    case 'years': {
      const map = new Map();
      tracks.forEach(t => { const y = t.year || 'Unknown'; if (!map.has(y)) map.set(y, []); map.get(y).push(t); });
      const years = [...map.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      return years.length ? `<div class="genre-list">${years.map(([y, list]) => genreRow(String(y), list, 'year')).join('')}</div>` : emptySub();
    }
    default: return '';
  }
}
function sortSongs(tracks) {
  const mode = state.sort.librarySongs;
  const q = state.searchQuery.toLowerCase();
  let out = tracks;
  if (q) out = out.filter(t => `${t.title} ${t.artist} ${t.album} ${t.genre}`.toLowerCase().includes(q));
  if (mode === 'title') return out.sort((a, b) => a.title.localeCompare(b.title));
  if (mode === 'artist') return out.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
  return out.sort((a, b) => b.addedAt - a.addedAt);
}
function genreRow(g, list, kind = 'genre') {
  const anyArt = list.find(hasArtwork) || list[0];
  return `<button class="genre-row" data-action="genre" data-genre="${esc(g)}" data-kind="${kind}">${coverHtml(anyArt, 'sm-cover')}<span class="genre-row-name">${esc(g)}</span><span class="genre-row-count">${list.length}</span></button>`;
}
function renderPlaylistsGrid() {
  if (!state.playlists.length) {
    return `<div class="playlists-grid"><button class="playlist-card new" data-action="new-playlist"><span class="pl-chip">${ICONS.add}</span><span class="playlist-name">New Playlist</span></button></div>`;
  }
  return `<div class="playlists-grid">${state.playlists.map(playlistCard).join('')}<button class="playlist-card new" data-action="new-playlist"><span class="pl-chip">${ICONS.add}</span><span class="playlist-name">New Playlist</span></button></div>`;
}
function playlistCard(pl) {
  const first = pl.trackIds.map(getTrack).find(Boolean);
  const art = first ? coverHtml(first, 'tile-cover') : `<span class="cover tile-cover" ${playlistColor(pl)}><span class="cover-glyph">${ICONS.music}</span></span>`;
  return `<div class="playlist-card" data-action="playlist" data-id="${esc(pl.id)}">${art}<div class="playlist-name">${esc(pl.name)}</div><div class="tile-sub">${pl.trackIds.length} ${pl.trackIds.length === 1 ? 'song' : 'songs'}</div></div>`;
}

/* ------------------------- Search ------------------------------------------ */
function renderSearch() {
  let html = `<header class="page-head"><p class="eyebrow accent">SEARCH</p><div class="search-bar"><span class="search-ic">${ICONS.search}</span><input id="searchInput" type="search" placeholder="Songs, albums, artists, playlists" value="${esc(state.searchQuery)}" /></div></header>`;
  html += `<div id="searchResults">${searchResultsHtml(state.searchQuery)}</div>`;
  return html;
}
function searchResultsHtml(raw) {
  const q = raw.trim().toLowerCase();
  if (!q) {
    let out = '';
    if (state.searchHistory.length) {
      out += `<section class="home-sec">${sectionHead('Recent Searches')}<div class="chip-wrap">${state.searchHistory.map(h => `<button class="search-chip" data-action="recent-search" data-q="${esc(h)}">${esc(h)}</button>`).join('')}</div></section>`;
    }
    out += `<section class="home-sec">${sectionHead('Suggested')}<div class="chip-wrap">${(state.settings.suggestions || ['happy songs', 'my playlists', 'recently played', 'favorites']).map(s => `<button class="search-chip" data-action="suggest" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div></section>`;
    return out;
  }
  const available = allAvailableTracks();
  const songHits = available.filter(t => `${t.title} ${t.artist} ${t.album} ${t.genre}`.toLowerCase().includes(q)).slice(0, 30);
  const albumHits = [...new Map(available.filter(t => `${t.album} ${t.albumArtist} ${t.artist}`.toLowerCase().includes(q)).map(t => [albumKey(t), t])).values()].slice(0, 20);
  const artistHits = [...new Set(available.filter(t => t.artist.toLowerCase().includes(q)).map(t => t.artist))].slice(0, 15);
  const playlistHits = state.playlists.filter(p => p.name.toLowerCase().includes(q));
  let out = '<section class="search-results">';
  if (songHits.length) out += `<div class="search-group">${sectionHead('Songs')}${trackListView(songHits, 'search-songs')}</div>`;
  if (artistHits.length) out += `<div class="search-group">${sectionHead('Artists')}<div class="grid artists">${artistHits.map(name => {      const list = allAvailableTracks().filter(t => t.artist === name); return artistTile(name, list); }).join('')}</div></div>`;
  if (albumHits.length) out += `<div class="search-group">${sectionHead('Albums')}<div class="grid albums">${albumHits.map(t => albumTile(t)).join('')}</div></div>`;
  if (playlistHits.length) out += `<div class="search-group">${sectionHead('Playlists')}<div class="playlists-grid">${playlistHits.map(playlistCard).join('')}</div></div>`;
  if (!songHits.length && !albumHits.length && !artistHits.length && !playlistHits.length) out += `<div class="empty-state"><h3>No results</h3><p>Try a different search.</p></div>`;
  out += '</section>';
  return out;
}
function renderGenreFilter(param) {
  let kind = 'genre', value = '';
  try { const p = JSON.parse(param); kind = p.kind; value = p.value; } catch (e) { value = param; }
  const available = allAvailableTracks();
  const list = kind === 'genre' ? available.filter(t => t.genre === value)
    : kind === 'composer' ? available.filter(t => (t.composer || 'Unknown') === value)
    : available.filter(t => String(t.year || 'Unknown') === value);
  let html = `<header class="page-head"><p class="eyebrow accent">${esc(kind === 'genre' ? 'GENRE' : kind === 'composer' ? 'COMPOSER' : 'YEAR')}</p><h1>${esc(value)}</h1><p class="page-copy">${list.length} tracks</p><div class="detail-actions"><button class="primary-button" data-action="play-context" data-ctx="genre-filter">${ICONS.play} Play all</button><button class="ghost-button" data-action="shuffle-context" data-ctx="genre-filter">Shuffle</button></div></header>`;
  html += trackListView(list, 'genre-filter');
  return html;
}
function saveSearch(q) {
  q = q.trim();
  if (!q) return;
  state.searchHistory = [q, ...state.searchHistory.filter(h => h !== q)].slice(0, 8);
  dbPut(DB_SETTINGS, { key: 'searchHistory', value: state.searchHistory });
}

/* ------------------------- track list view -------------------------------- */
function trackListView(tracks, ctxKey) {
  if (!tracks.length) return emptySub();
  state.renderContexts[ctxKey] = tracks;
  const items = tracks.map((t, i) => trackRow(t, ctxKey, i)).join('');
  return `<div class="track-list">${items}</div>`;
}
function trackRow(track, ctxKey, i, playlistId = '') {
  const playing = track.id === state.currentTrackId;
  const loved = track.loved ? ' loved' : '';
  return `<div class="track-row ${playing ? 'playing' : ''}" data-ctx="${esc(ctxKey)}" ${playlistId ? `data-playlist="${esc(playlistId)}"` : ''}>
    <button class="tr-num" data-action="play-ctx" data-id="${esc(track.id)}">${playing ? ICONS.listen : String(i + 1).padStart(2, '0')}</button>
    <button class="tr-main" data-action="play-ctx" data-id="${esc(track.id)}">${coverHtml(track, 'tr-cover')}<span class="tr-text"><span class="tr-name">${esc(track.title)}</span><span class="tr-sub">${esc(track.artist)}</span></span></button>
    <span class="tr-album">${esc(track.album || '')}</span>
    <button class="tr-love ${loved}" data-action="love" data-id="${esc(track.id)}" aria-label="Love">${track.loved ? ICONS.heartFill : ICONS.heart}</button>
    <span class="tr-dur">${fmtTime(track.duration)}</span>
    <button class="tr-more" data-action="menu" data-id="${esc(track.id)}" aria-label="More">${ICONS.more}</button>
  </div>`;
}

/* ------------------------- Album / Artist / Playlist ---------------------- */
function renderAlbum(startTrack) {
  const source = typeof startTrack === 'string' ? getTrack(startTrack) : startTrack;
  if (!source) return '<div class="empty-state"><h3>Album not found</h3></div>';
  const tracks = allAvailableTracks().filter(t => albumKey(t) === albumKey(source)).sort((a, b) => (a.discNumber || 0) - (b.discNumber || 0) || (a.trackNumber || 0) - (b.trackNumber || 0) || a.title.localeCompare(b.title));
  const art = tracks.find(hasArtwork) || source;
  const ctxKey = 'album';
  state.renderContexts[ctxKey] = tracks;
  let html = `<header class="detail-head">
    ${coverHtml(art, 'detail-cover')}
    <div class="detail-info">
      <p class="eyebrow accent">ALBUM</p>
      <h1>${esc(art.album || 'Unknown album')}</h1>
      <p class="detail-meta">${esc(art.albumArtist || art.artist)} · ${art.year || ''} · ${tracks.length} songs · ${fmtTime(tracks.reduce((s, t) => s + (t.duration || 0), 0))}</p>
      <div class="detail-actions">
        <button class="primary-button" data-action="play-album" data-id="${esc(art.id)}">${ICONS.play} Play</button>
        <button class="ghost-button" data-action="shuffle-context" data-ctx="${ctxKey}">Shuffle</button>
        <button class="ghost-button" data-action="menu-album" data-id="${esc(art.id)}">${ICONS.more}</button>
      </div>
    </div>
  </header>`;
  html += `<div class="track-list">${tracks.map((t, i) => trackRow(t, ctxKey, i)).join('')}</div>`;
  return html;
}
function renderArtist(name) {
  const list = allAvailableTracks().filter(t => t.artist === name).sort((a, b) => (a.album || '').localeCompare(b.album || '') || (a.trackNumber || 0) - (b.trackNumber || 0));
  if (!list.length) return '<div class="empty-state"><h3>Artist not found</h3></div>';
  const art = list.find(hasArtwork) || list[0];
  const topSongs = [...list].filter(t => t.playCount).sort((a, b) => b.playCount - a.playCount).slice(0, 10);
  const albums = groupedAlbums().filter(a => a.some(t => t.artist === name));
  const ctxKey = 'artist';
  state.renderContexts[ctxKey] = list;
  if (topSongs.length) state.renderContexts['artist-top'] = topSongs;
  let html = `<header class="detail-head">
    ${coverHtml(art, 'detail-cover')}
    <div class="detail-info"><p class="eyebrow accent">ARTIST</p><h1>${esc(name)}</h1><p class="detail-meta">${list.length} songs${albums.length ? ` · ${albums.length} albums` : ''}</p>
    <div class="detail-actions"><button class="primary-button" data-action="play-context" data-ctx="${ctxKey}">${ICONS.play} Play</button><button class="ghost-button" data-action="shuffle-context" data-ctx="${ctxKey}">Shuffle</button><button class="ghost-button" data-action="radio-seed" data-kind="artist" data-value="${esc(name)}">Radio</button></div></div>
  </header>`;
  if (topSongs.length) html += `<section class="home-sec">${sectionHead('Top Songs')}<div class="track-list">${topSongs.map((t, i) => trackRow(t, 'artist-top', i)).join('')}</div></section>`;
  if (albums.length) html += `<section class="home-sec">${sectionHead('Albums')}<div class="grid albums">${albums.map(a => albumTile(a[0])).join('')}</div></section>`;
  return html;
}
function renderPlaylist(id) {
  const pl = state.playlists.find(p => p.id === id);
  if (!pl) return '<div class="empty-state"><h3>Playlist not found</h3></div>';
  const list = pl.trackIds.map(getTrack).filter(Boolean);
  const first = list.find(hasArtwork) || list[0];
  const ctxKey = 'playlist';
  state.renderContexts[ctxKey] = list;
  let html = `<header class="detail-head">
    ${first ? coverHtml(first, 'detail-cover') : `<span class="cover detail-cover" ${playlistColor(pl)}><span class="cover-glyph">${ICONS.music}</span></span>`}
    <div class="detail-info"><p class="eyebrow accent">PLAYLIST</p><h1>${esc(pl.name)}</h1><p class="detail-meta">${list.length} ${list.length === 1 ? 'song' : 'songs'}</p>
    <div class="detail-actions"><button class="primary-button" data-action="play-context" data-ctx="${ctxKey}">${ICONS.play} Play</button><button class="ghost-button" data-action="shuffle-context" data-ctx="${ctxKey}">Shuffle</button><button class="ghost-button" data-action="edit-playlist" data-id="${esc(pl.id)}">Edit</button><button class="ghost-button danger" data-action="delete-playlist" data-id="${esc(pl.id)}">Delete</button></div></div>
  </header>`;
  html += `<div class="track-list">${list.map((t, i) => trackRow(t, ctxKey, i, pl.id)).join('')}</div>`;
  return html;
}

/* ------------------------- Settings ---------------------------------------- */
function renderSettings() {
  const eq = state.settings.eq;
  const uploadToken = (() => { try { return localStorage.getItem(UPLOAD_TOKEN_KEY) || ''; } catch { return ''; } })();
  const themeLabel = document.body.classList.contains('dark') ? 'Use light appearance' : 'Use dark appearance';
  return `<header class="page-head"><p class="eyebrow accent">SETTINGS</p><h1>Settings</h1></header>
  <section class="settings">
    <div class="set-group"><h3>Appearance</h3>
      <div class="set-row"><span>Theme</span><span class="set-value">${document.body.classList.contains('dark') ? 'Dark' : 'Light'}</span></div>
      <button class="ghost-button" data-action="toggle-theme">${themeLabel}</button>
    </div>
    <div class="set-group"><h3>Audio</h3>
      <div class="set-row"><span>Equalizer</span><span class="set-value" id="eqLabel">${eq ? EQ_PRESETS[eq.name]?.name || 'Custom' : 'Off'}</span></div>
      <div class="eq-presets">${['flat', 'bassboost', 'treble', 'vocal', 'rock', 'pop', 'dance', 'acoustic', 'classical'].map(k => `<button class="eq-chip ${eq && eq.name === k ? 'active' : ''}" data-action="eq" data-preset="${k}">${EQ_PRESETS[k].name}</button>`).join('')}</div>
      <button class="ghost-button ${!eq ? 'disabled' : ''}" data-action="eq" data-preset="off" style="margin-top:10px">Disable EQ</button>
    </div>
    <div class="set-group"><h3>Shared library</h3>
      <p class="set-note">Upload an audio file to the server so every Mixdeck visitor can play it. This requires the Node server; GitHub Pages alone cannot receive uploads.</p>
      <input id="publicUploadToken" class="sheet-input" type="password" placeholder="Upload token (if the server requires one)" value="${esc(uploadToken)}" autocomplete="off" />
      <label class="primary-button upload-label" for="publicFileInput">Upload a song for everyone ${ICONS.share}</label>
      <input id="publicFileInput" type="file" accept="audio/*,.mp3,.m4a,.wav,.aac,.flac,.ogg,.opus" hidden />
      <div id="publicUploadStatus" class="set-note" aria-live="polite"></div>
    </div>
    <div class="set-group"><h3>Storage</h3>
      <div class="set-row"><span>Keep files on this device</span><span class="set-value" id="storageInfo">checking…</span></div>
      <button class="ghost-button" data-action="request-persist">Ask to keep files permanently</button>
      <button class="ghost-button" data-action="clear-app-cache">Clear app cache &amp; update (fixes stale version)</button>
      <button class="ghost-button danger" data-action="clear-library">Erase all imported music</button>
    </div>
    <div class="set-group"><h3>About</h3>
      <div class="set-row"><span>Version</span><span class="set-value">1.0 · ${(() => { try { const v = localStorage.getItem('mixdeck-sw-version') || ''; return v ? `shell v${v}` : 'shell not installed'; } catch { return 'shell —'; } })()}</span></div>
      <p class="set-note">All music is stored locally on this device. Nothing is uploaded.</p>
    </div>
  </section>`;
}

/* ------------------------- empty states ------------------------------------ */
function emptyLibrary() {
  return `<header class="hero minimal"><p class="eyebrow accent">LISTEN NOW</p><div class="hero-row"><h1>Listen Now</h1><div class="toolbar"><label class="tool-btn" for="fileInput"><span class="tool-ic">${ICONS.import}</span>Import</label><input id="fileInput" type="file" accept="audio/*,.mp3,.m4a,.wav,.aac,.flac,.ogg" multiple hidden /><label class="tool-btn" for="publicFileInput"><span class="tool-ic">${ICONS.share}</span>Share</label><input id="publicFileInput" type="file" accept="audio/*,.mp3,.m4a,.wav,.aac,.flac,.ogg,.opus" hidden /></div></div></header>
  <section class="empty-state"><div class="empty-art"><span class="cover-glyph">${ICONS.music}</span></div><h3>Your library is waiting</h3><p>Import a few songs from the Files app and we'll build your first mix.</p><label class="primary-button" for="fileInput">Choose music files ${ICONS.import}</label></section>`;
}
function emptySub() {
  return `<div class="empty-state small"><h3>Nothing here yet</h3><p>Import some music to fill this out.</p></div>`;
}

/* ------------------------- dynamic binds ----------------------------------- */
function bindDynamic() {
  const fileInput = $('#fileInput');
  if (fileInput) fileInput.addEventListener('change', onImport);
  const publicFileInput = $('#publicFileInput');
  if (publicFileInput) publicFileInput.addEventListener('change', onPublicUpload);
  const publicUploadToken = $('#publicUploadToken');
  if (publicUploadToken) publicUploadToken.addEventListener('change', () => { try { localStorage.setItem(UPLOAD_TOKEN_KEY, publicUploadToken.value); } catch {} });
  const searchInput = $('#searchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      state.searchQuery = searchInput.value;
      const target = $('#searchResults');
      if (target) target.innerHTML = searchResultsHtml(searchInput.value);
    });
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { saveSearch(searchInput.value); renderView(); } });
  }
  const libSearch = $('#libSearch');
  if (libSearch) libSearch.addEventListener('input', () => {
    state.searchQuery = libSearch.value;
    const target = $('#libBody');
    if (target) target.innerHTML = renderLibraryBody(state.libraryTab);
  });
  if (state.route.name === 'settings') updateStorageInfo();
}

/* ------------------------- import ------------------------------------------- */
async function onPublicUpload(event) {
  const file = [...event.target.files][0];
  event.target.value = '';
  if (!file) return;
  const status = $('#publicUploadStatus');
  if (status) status.textContent = `Preparing ${file.name}…`;
  try {
    const track = await extractMetadata(file);
    const form = new FormData();
    form.append('audio', file, file.name);
    form.append('metadata', JSON.stringify({
      name: file.name, title: track.title, artist: track.artist, albumArtist: track.albumArtist,
      album: track.album, genre: track.genre, year: track.year, composer: track.composer,
      trackNumber: track.trackNumber, discNumber: track.discNumber, bpm: track.bpm, duration: track.duration,
    }));
    let token = $('#publicUploadToken')?.value || '';
    if (!token) { try { token = localStorage.getItem(UPLOAD_TOKEN_KEY) || ''; } catch {} }
    const headers = token ? { 'X-Upload-Token': token } : {};
    const response = await fetch('/api/upload', { method: 'POST', headers, body: form });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Upload failed (${response.status})`);
    state.publicTracks = [normalizeTrack(result), ...state.publicTracks.filter(t => t.id !== result.id)];
    if (status) status.textContent = `${track.title} is now available to everyone.`;
    toast('Song uploaded to the shared library');
    renderView();
  } catch (error) {
    if (status) status.textContent = error.message.includes('404') ? 'Uploads need the Node server, not GitHub Pages.' : error.message;
    toast(error.message || 'Upload failed');
  }
}

async function onImport(event) {
  const files = [...event.target.files].filter(f => f.type.startsWith('audio/') || /\.(mp3|m4a|wav|aac|flac|ogg)$/i.test(f.name));
  if (!files.length) return;
  toast(`Adding ${files.length} ${files.length === 1 ? 'track' : 'tracks'}…`);
  let added = 0, skipped = 0;
  const addedTracks = [];
  for (const file of files) {
    const id = `${file.name}-${file.size}-${file.lastModified}`;
    if (state.tracks.some(t => t.id === id)) { skipped++; continue; }
    const track = await extractMetadata(file);
    // Store bytes rather than a File/Blob object. This avoids Safari's stale
    // Blob backing-store issue when the installed PWA is opened again.
    const bytes = await file.arrayBuffer();
    await dbPut(DB_TRACKS, { ...track, blob: bytes });
    track.blob = new Blob([bytes], { type: track.mimeType || file.type || 'audio/mpeg' });
    state.tracks.push(track);
    addedTracks.push(track);
    added++;
  }
  event.target.value = '';
  renderView();
  toast(skipped ? `${added} added · ${skipped} already in library` : `${added} added to your library`);
  // Automatically hunt for album covers for the freshly imported tracks.
  queueArtworkLookups(addedTracks);
}

/* ------------------------- global click handler ----------------------------- */
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-nav]');
  if (target) { navigate(target.dataset.nav); return; }
  const actionEl = e.target.closest('[data-action]');
  if (actionEl) { e.preventDefault(); handleAction(actionEl); }
});

function contextForKey(key) {
  return state.renderContexts[key] || [];
}
function handleAction(el) {
  const action = el.dataset.action;
  const id = el.dataset.id;
  switch (action) {
    case 'play-ctx': {
      const track = getTrack(id);
      const ctxKey = el.closest('[data-ctx]')?.dataset.ctx;
      const list = ctxKey && state.renderContexts[ctxKey] ? state.renderContexts[ctxKey] : [track];
      const idx = list.findIndex(t => t.id === id);
      playTrackList(list, Math.max(0, idx));
      break;
    }
    case 'play-context': {
      const ctxKey = el.dataset.ctx;
      const list = contextForKey(ctxKey);
      if (list.length) playTrackList(list, 0);
      break;
    }
    case 'play-album': {
      const t = getTrack(id);
      if (t) { const list = allAvailableTracks().filter(x => albumKey(x) === albumKey(t)); playTrackList(list, 0); }
      break;
    }
    case 'shuffle-context': {
      const list = contextForKey(el.dataset.ctx);
      if (list.length) { state.settings.shuffle = true; saveSettings(); playTrackList(list, Math.floor(Math.random() * list.length)); toast('Shuffle on'); }
      break;
    }
    case 'shuffle-library': { const list = sortSongs([...allAvailableTracks()]); if (list.length) { state.settings.shuffle = true; saveSettings(); playTrackList(list, Math.floor(Math.random() * list.length)); toast('Shuffling your library'); } break; }
    case 'autoplay-mix': playAutoMix([...allAvailableTracks()], 'Auto Mix'); break;
    case 'radio-seed': {
      const kind = el.dataset.kind; const value = el.dataset.value;
      const pool = kind === 'artist' ? allAvailableTracks().filter(t => t.artist === value) : allAvailableTracks().filter(t => t.genre === value);
      if (pool.length) seedStation(pool, `${value} Radio`);
      break;
    }
    case 'album': { const t = getTrack(id); if (t) navigate('album', t.id); break; }
    case 'artist': navigate('artist', el.dataset.artist); break;
    case 'genre': navigate('genre', JSON.stringify({ kind: el.dataset.kind || 'genre', value: el.dataset.genre })); break;
    case 'playlist': navigate('playlist', id); break;
    case 'new-playlist': openPlaylistEditor(null, []); break;
    case 'edit-playlist': { const pl = state.playlists.find(p => p.id === id); if (pl) openPlaylistEditor(pl); break; }
    case 'delete-playlist': {
      const pl = state.playlists.find(p => p.id === id);
      if (pl && confirm(`Delete "${pl.name}"?`)) { dbDelete(DB_PLAYLISTS, pl.id); state.playlists = state.playlists.filter(p => p.id !== id); toast('Playlist deleted'); renderView(); }
      break;
    }
    case 'love': toggleLove(id); break;
    case 'menu': openTrackMenu(id, el.closest('.track-row')?.dataset.playlist || ''); break;
    case 'menu-album': { const t = getTrack(id); if (t) openAlbumMenu(t); break; }
    case 'lib-tab': state.libraryTab = el.dataset.tab; renderView(); break;
    case 'sort-songs': {
      const order = ['newest', 'title', 'artist'];
      state.sort.librarySongs = order[(order.indexOf(state.sort.librarySongs) + 1) % order.length];
      renderView(); break;
    }
    case 'recent-search': state.searchQuery = el.dataset.q; navigate('search'); break;
    case 'suggest': state.searchQuery = el.dataset.q; navigate('search'); break;
    case 'eq': setEq(el.dataset.preset === 'off' ? null : el.dataset.preset); break;
    case 'toggle-theme': toggleTheme(); break;
    case 'request-persist': requestPersist(); break;
    case 'find-lyrics': { const track = getTrack(id); if (track) lookupLyrics(track, true); break; }
    case 'clear-app-cache': clearAppCache(); break;
    case 'clear-library': clearLibrary(); break;
    default: break;
  }
}

/* ------------------------- menus -------------------------------------------- */
function openTrackMenu(id, playlistId = '') {
  const track = getTrack(id);
  if (!track) return;
  const inQueue = state.queue.includes(id);
  const loved = track.loved;
  const playlist = playlistId ? state.playlists.find(p => p.id === playlistId) : null;
  const items = [
    { label: loved ? 'Remove from Loved' : 'Love', icon: loved ? ICONS.heartFill : ICONS.heart, action: () => toggleLove(id) },
    { label: 'Play Next', icon: ICONS.playNext, action: () => { if (state.queueIndex >= 0) { state.queue.splice(state.queueIndex + 1, 0, id); savePlaybackState(); toast('Playing next'); } else playSingle(track); } },
    { label: 'Play Last', icon: ICONS.list, action: () => { state.queue.push(id); savePlaybackState(); toast('Added to queue'); } },
    { label: inQueue ? 'Remove from Queue' : 'Add to Queue', icon: ICONS.add, action: () => { if (inQueue) { state.queue = state.queue.filter(x => x !== id); toast('Removed from queue'); } else { state.queue.push(id); } savePlaybackState(); toast(inQueue ? 'Removed from queue' : 'Added to queue'); } },
    { label: 'Add to Playlist…', icon: ICONS.library, action: () => openPlaylistSheet([id]) },
    ...(isPublicTrack(track) || hasArtwork(track) ? [] : [{ label: 'Find artwork', icon: ICONS.music, action: () => lookupArtwork(track, true) }]),
    { label: track.album ? 'View Album' : 'View Artist', icon: track.album ? ICONS.browse : ICONS.artist, action: () => track.album ? navigate('album', track.id) : navigate('artist', track.artist) },
    ...(playlist ? [
      { label: 'Move Up in Playlist', icon: ICONS.up, action: () => movePlaylistTrack(playlist, id, -1) },
      { label: 'Move Down in Playlist', icon: ICONS.down, action: () => movePlaylistTrack(playlist, id, 1) },
      { label: `Remove from ${playlist.name}`, icon: ICONS.close, danger: true, action: () => removeFromPlaylist(playlist, id) },
    ] : []),
    { label: 'Remove from Library', icon: ICONS.close, danger: true, action: () => removeTrack(track) },
  ];
  openMenu(items);
}
function openAlbumMenu(track) {
  const list = allAvailableTracks().filter(t => albumKey(t) === albumKey(track));
  openMenu([
    { label: 'Play', icon: ICONS.play, action: () => playTrackList(list, 0) },
    { label: 'Shuffle', icon: ICONS.shuffle, action: () => { state.settings.shuffle = true; saveSettings(); playTrackList(list, Math.floor(Math.random() * list.length)); } },
    { label: `Go to ${track.artist}`, icon: ICONS.artist, action: () => navigate('artist', track.artist) },
    { label: `Add ${list.length} songs to Playlist…`, icon: ICONS.library, action: () => openPlaylistSheet(list.map(t => t.id)) },
  ]);
}

function toggleLove(id) {
  const track = getTrack(id);
  if (!track) return;
  track.loved = !track.loved;
  persistTrack(track);
  toast(track.loved ? 'Added to Loved' : 'Removed from Loved');
  renderView();
  if (!nowPlayingEl.hidden) updateNowPlaying();
}
async function movePlaylistTrack(playlist, trackId, direction) {
  if (!playlist) return;
  const index = playlist.trackIds.indexOf(trackId);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= playlist.trackIds.length) {
    toast(direction < 0 ? 'Already first in playlist' : 'Already last in playlist');
    return;
  }
  [playlist.trackIds[index], playlist.trackIds[next]] = [playlist.trackIds[next], playlist.trackIds[index]];
  await dbPut(DB_PLAYLISTS, playlist);
  renderView();
}
async function removeFromPlaylist(playlist, trackId) {
  if (!playlist) return;
  playlist.trackIds = playlist.trackIds.filter(id => id !== trackId);
  await dbPut(DB_PLAYLISTS, playlist);
  toast(`Removed from ${playlist.name}`);
  renderView();
}
async function removeTrack(track) {
  await dbDelete(DB_TRACKS, track.id);
  const wasCurrent = state.currentTrackId === track.id;
  const removedQueueIndex = state.queue.indexOf(track.id);
  if (wasCurrent) {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    loadedAudioTrackId = null;
    state.currentTrackId = null;
    state.queueIndex = -1;
  }
  state.tracks = state.tracks.filter(t => t.id !== track.id);
  state.queue = state.queue.filter(id => id !== track.id);
  state.baseQueue = state.baseQueue.filter(id => id !== track.id);
  savePlaybackState();
  if (state.station) {
    state.station.pool = state.station.pool.filter(id => id !== track.id);
    state.station.orderIndex = Math.min(state.station.orderIndex, Math.max(0, state.station.pool.length - 1));
    if (!state.station.pool.length) state.station = null;
  }
  if (!wasCurrent && removedQueueIndex >= 0 && removedQueueIndex < state.queueIndex) state.queueIndex--;
  if (state.queueIndex >= state.queue.length) state.queueIndex = state.queue.length - 1;
  state.history = state.history.filter(id => id !== track.id);
  dbPut(DB_SETTINGS, { key: 'history', value: state.history });
  if (state.objectUrls.has(track.id)) { URL.revokeObjectURL(state.objectUrls.get(track.id)); state.objectUrls.delete(track.id); }
  if (state.artworkUrls.has(track.id)) { URL.revokeObjectURL(state.artworkUrls.get(track.id)); state.artworkUrls.delete(track.id); }
  if (state.artworkBlobs.has(track.id)) state.artworkBlobs.delete(track.id);
  state.playlists.forEach(p => { if (p.trackIds.includes(track.id)) { p.trackIds = p.trackIds.filter(x => x !== track.id); dbPut(DB_PLAYLISTS, p); } });
  toast('Removed from your library');
  renderView();
}
async function clearLibrary() {
  if (!confirm('Erase all imported music and playlists? This cannot be undone.')) return;
  await dbClear(DB_TRACKS); await dbClear(DB_PLAYLISTS); await dbClear(DB_ARTWORK_CACHE).catch(() => {});
  state.objectUrls.forEach(url => URL.revokeObjectURL(url));
  state.artworkUrls.forEach(url => URL.revokeObjectURL(url));
  state.objectUrls.clear();
  state.artworkUrls.clear();
  state.artworkBlobs.clear();
  state.tracks = []; state.playlists = []; state.queue = []; state.baseQueue = []; state.history = []; state.station = null; state.currentTrackId = null; state.queueIndex = -1;
  audio.pause(); audio.removeAttribute('src'); audio.load();
  loadedAudioTrackId = null;
  dbPut(DB_SETTINGS, { key: 'history', value: [] });
  savePlaybackState();
  navigate('listennow');
  toast('Library erased');
}
function toggleTheme() {
  const dark = document.body.classList.toggle('dark');
  state.settings.theme = dark ? 'dark' : 'light';
  dbPut(DB_SETTINGS, { key: 'theme', value: state.settings.theme });
  renderView();
}
async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const ok = await navigator.storage.persist();
      toast(ok ? 'Storage is now permanent' : 'Browser declined — you may need to re-import after iOS clears cache');
    }
  } catch (e) { toast('Persistent storage unavailable'); }
  updateStorageInfo();
}

async function clearAppCache() {
  if (!confirm('Clear Mixdeck\u2019s cached app version and reload?\n\nYour imported music stays safe — only the stored copy of the website is removed.')) return;
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch (e) { /* ignore */ }
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch (e) { /* ignore */ }
  try { localStorage.removeItem('mixdeck-sw-version'); } catch (e) { /* ignore */ }
  location.reload();
}

async function checkForAppUpdate() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration || !registration.active) return;
    let activeVersion = '';
    try {
      const res = await fetch(registration.active.scriptURL, { cache: 'no-store' });
      const text = await res.text();
      const match = text.match(/mixdeck-v(\d+)/);
      if (match) activeVersion = match[1];
    } catch (e) { /* ignore */ }
    const known = (() => { try { return localStorage.getItem('mixdeck-sw-version') || ''; } catch { return ''; } })();
    if (known && activeVersion && known !== activeVersion) {
      appUpdateAvailable = true;
      toast('Mixdeck updated — tap to refresh');
    }
    try { localStorage.setItem('mixdeck-sw-version', activeVersion || known); } catch (e) { /* ignore */ }
  } catch (e) { /* ignore */ }
}
async function updateOfflineStatus() {
  const el = $('#offlineStatus');
  if (!el) return;
  const online = navigator.onLine;
  el.classList.toggle('offline', !online);
  $('.status-label', el).textContent = online ? 'Online' : 'Offline library';
  el.title = online ? 'Connected — imported music remains available offline' : 'Offline mode — using music saved on this device';
}

async function updateStorageInfo() {
  const el = $('#storageInfo');
  if (!el) return;
  try {
    if (navigator.storage && navigator.storage.persisted) {
      const persisted = await navigator.storage.persisted();
      el.textContent = persisted ? 'Permanent ✓' : 'Best-effort (iOS may clear)';
    }
  } catch (e) { /* ignore */ }
}

/* ------------------------- mini player -------------------------------------- */
function updateMiniPlayer() {
  const track = getTrack(state.currentTrackId);
  if (!track) { miniPlayer.hidden = true; return; }
  miniPlayer.hidden = false;
  const url = artworkUrl(track);
  $('#miniArt').innerHTML = url ? `<img src="${url}" alt="" />` : `<span class="cover-glyph">${ICONS.music}</span>`;
  $('#miniTitle').textContent = track.title;
  $('#miniArtist').textContent = track.artist;
  $('#miniPlay').innerHTML = audio.paused ? ICONS.play : ICONS.pause;
}

/* ------------------------- now playing --------------------------------------- */
function openNowPlaying() {
  nowPlayingEl.hidden = false;
  nowPlayingEl.classList.remove('np-in');
  void nowPlayingEl.offsetWidth;
  nowPlayingEl.classList.add('np-in');
  document.body.classList.add('np-open');
  updateNowPlaying();
}
function closeNowPlaying() {
  nowPlayingEl.hidden = true;
  document.body.classList.remove('np-open');
  state.lyricIndex = -1;
}
function updateNowPlaying() {
  if (nowPlayingEl.hidden) return;
  const track = getTrack(state.currentTrackId);
  $('#npSourceText').textContent = state.station ? state.station.label : 'Now Playing';
  if (!track) {
    $('#npArt').innerHTML = `<span class="cover-glyph">${ICONS.music}</span>`; $('#npTitle').textContent = 'Nothing playing';
    $('#npArtist').textContent = 'Choose a track'; $('#npAlbum').textContent = '';
    $('#npArtist').disabled = true;
    $('#npAlbum').disabled = true;
    $('#npPlay').innerHTML = ICONS.play; $('#npLove').innerHTML = ICONS.heart;
    $('#npProgress').value = 0; $('#npCurrentTime').textContent = '0:00'; $('#npTotalTime').textContent = '0:00';
    paintSeek();
  } else {
    const url = artworkUrl(track);
    $('#npArt').innerHTML = url ? `<img src="${url}" alt="" />` : `<span class="cover-glyph">${ICONS.music}</span>`;
    $('#npTitle').textContent = track.title;
    $('#npArtist').textContent = track.artist;
    $('#npAlbum').textContent = track.album || '';
    $('#npLove').innerHTML = track.loved ? ICONS.heartFill : ICONS.heart;
    $('#npLove').classList.toggle('on', track.loved);
    $('#npArtist').disabled = false;
    $('#npAlbum').disabled = !track.album;
    $('#npPlay').innerHTML = audio.paused ? ICONS.play : ICONS.pause;
    $('#npProgress').value = audio.duration ? Math.round((audio.currentTime / audio.duration) * 1000) : 0;
    $('#npCurrentTime').textContent = fmtTime(audio.currentTime);
    $('#npTotalTime').textContent = fmtTime(track.duration || audio.duration);
    paintSeek();
  }
  $('#npShuffle').classList.toggle('on', state.settings.shuffle);
  $('#npRepeat').classList.toggle('on', state.settings.repeat !== 'off');
  $('#npRepeat').classList.toggle('one', state.settings.repeat === 'one');
  $('#npRepeat').innerHTML = state.settings.repeat === 'one' ? ICONS.repeatOne : ICONS.repeat;
  $('#npVolume').value = state.settings.volume;
  paintVolume();
  renderNpPanel();
}
/* The player's three side panels (Up Next / Lyrics / History) live side by
   side on one sliding liquid-glass track. Drag-to-swipe and the springy tab
   pill both call positionNpCarousel(). */
const NP_ORDER = ['upnext', 'lyrics', 'history'];

function npActiveKind() { return NP_ORDER.find(k => state.panels[k]) || 'upnext'; }
function npActiveIndex() { return NP_ORDER.indexOf(npActiveKind()); }
function npCarouselWidth() {
  const track = $('#npPanels');
  return track ? Math.max(1, track.getBoundingClientRect().width) : 1;
}
function refreshNpPage(kind) {
  const page = $(`.np-page[data-page="${kind}"]`);
  if (!page) return;
  page.innerHTML = `<div class="np-panel-inner">${renderPanelContent(kind)}</div>`;
  page.classList.toggle('lyrics-pane', kind === 'lyrics');
}
function refreshNpActivePage() { refreshNpPage(npActiveKind()); }
function positionNpCarousel(animate = true) {
  const track = $('#npCarouselTrack');
  if (!track) return;
  if (!animate) track.style.transition = 'none';
  track.style.transform = `translate3d(${(-npActiveIndex() * npCarouselWidth()).toFixed(2)}px,0,0)`;
  updateNpPill(animate);
  if (!animate) { void track.offsetWidth; track.style.transition = ''; }
}
function updateNpPill(animate = true) {
  const pill = $('#npPill');
  const active = $('.np-panel-tab.active');
  if (!pill || !active) return;
  if (!animate) pill.style.transition = 'none';
  pill.style.left = `${active.offsetLeft}px`;
  pill.style.width = `${active.offsetWidth}px`;
  if (!animate) { void pill.offsetWidth; pill.style.transition = ''; }
}
function sizeNpPanels() {
  const wrap = $('#npPanels');
  if (!wrap || nowPlayingEl.hidden || nowPlayingEl.classList.contains('lyrics-mode')) return;
  const page = $$('.np-page')[npActiveIndex()];
  if (!page) return;
  const cap = Math.round(window.innerHeight * (window.innerWidth <= 600 ? 0.24 : 0.26));
  wrap.style.height = `${Math.max(64, Math.min(page.scrollHeight + 4, cap))}px`;
}
function renderNpPanel() {
  NP_ORDER.forEach(refreshNpPage);
  positionNpCarousel(false);
  sizeNpPanels();
  requestAnimationFrame(updateLyricScroll);
}
function renderPanelContent(kind) {
  if (kind === 'upnext') {
    const list = state.queue.map(getTrack).filter(Boolean);
    if (!list.length) return '<div class="np-empty">Nothing up next — play something.</div>';
    return list.map((t, i) => {
      const isCur = i === state.queueIndex;
      return `<div class="np-queue-row ${isCur ? 'playing' : ''}" draggable="true" data-qi="${i}">
        ${coverHtml(t, 'npq-cover')}
        <button class="npq-main" data-action="np-jump" data-qi="${i}"><span class="npq-name">${esc(t.title)}</span><span class="npq-sub">${esc(t.artist)}</span></button>
        <button class="npq-x" data-action="np-remove" data-qi="${i}" aria-label="Remove">${ICONS.close}</button>
      </div>`;
    }).join('');
  }
  if (kind === 'lyrics') {
    const track = getTrack(state.currentTrackId);
    if (!track) return '<div class="np-empty">Choose a track to see lyrics.</div>';
    if (state.lyricLookup.has(track.id)) return '<div class="np-empty lyric-loading"><span class="loading-dot"></span>Finding lyrics…</div>';
    if (track.syncedLyrics && track.syncedLyrics.length) {
      const rows = track.syncedLyrics.map((l, i) => {
        const active = i === state.lyricIndex;
        const cls = ['lq-line', active ? 'cur' : '', i === state.lyricIndex + 1 ? 'next' : ''].filter(Boolean).join(' ');
        return `<p class="${cls}" data-lyric-index="${i}" data-ts="${Math.max(0, Number(l.time) || 0)}"><span class="lq-char">${esc(l.text) || '\u00A0'}</span></p>`;
      }).join('');
      return `<div class="lq-wrap">${rows}</div>`;
    }
    if (track.lyrics) {
      const source = track.lyricsSource === 'Online lyrics' ? 'Lyrics' : (track.lyricsSource || 'Embedded lyrics');
      return `<div class="lyrics-static"><div class="lyrics-source">${esc(source)}</div>${track.lyrics.split(/\r?\n/).filter(Boolean).map(l => `<p>${esc(l)}</p>`).join('')}</div>`;
    }
    return lyricsEmptyHtml(track);
  }
  if (kind === 'history') {
    const list = state.history.map(getTrack).filter(Boolean);
    if (!list.length) return '<div class="np-empty">Nothing played yet.</div>';
    return `<div class="history-list">${list.map((t, i) => `<button class="hist-row" data-action="play-ctx" data-id="${esc(t.id)}">${coverHtml(t, 'npq-cover')}<span class="npq-name">${esc(t.title)}</span><span class="npq-sub">${esc(t.artist)}</span></button>`).join('')}</div>`;
  }
  return '';
}
function updateLyricScroll() {
  if (!state.panels.lyrics) return;
  const track = getTrack(state.currentTrackId);
  if (!track || !track.syncedLyrics || !track.syncedLyrics.length) return;
  const t = audio.currentTime;
  let idx = -1;
  for (let i = 0; i < track.syncedLyrics.length; i++) {
    if (t >= track.syncedLyrics[i].time) idx = i; else break;
  }
  if (idx !== state.lyricIndex) {
    state.lyricIndex = idx;
    const page = $('.np-page[data-page="lyrics"]');
    if (page) {
      $$('.lq-line', page).forEach((p, i) => {
        p.classList.toggle('cur', i === idx);
        p.classList.toggle('next', i === idx + 1);
        if (i === idx) p.classList.remove('past');
        else if (i < idx && !p.classList.contains('past')) p.classList.add('past');
      });
      const active = $('.lq-line.cur', page);
      if (active && active.scrollIntoView) active.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

/* ------------------------- now playing events -------------------------------- */
$('#miniPlayer').addEventListener('click', (e) => {
  if (e.target.closest('#miniPlay')) { togglePlay(); return; }
  if (e.target.closest('#miniPrev')) { previousTrack(); return; }
  if (e.target.closest('#miniNext')) { nextTrack(); return; }
  openNowPlaying();
});
$('#npBack').addEventListener('click', closeNowPlaying);
$('#npPlay').addEventListener('click', togglePlay);
$('#npPrev').addEventListener('click', previousTrack);
$('#npNext').addEventListener('click', nextTrack);
$('#npShuffle').addEventListener('click', toggleShuffle);
$('#npRepeat').addEventListener('click', toggleRepeat);
$('#npLove').addEventListener('click', () => { if (state.currentTrackId) toggleLove(state.currentTrackId); });
$('#npArtist').addEventListener('click', () => { const track = getTrack(state.currentTrackId); if (track) navigate('artist', track.artist); });
$('#npAlbum').addEventListener('click', () => { const track = getTrack(state.currentTrackId); if (track && track.album) navigate('album', track.id); });
function selectNpPanel(kind, animate = true) {
  if (npActiveKind() === kind) return;
  state.panels = { upnext: false, lyrics: false, history: false };
  state.panels[kind] = true;
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const doAnim = animate && !reduce;
  nowPlayingEl.classList.toggle('lyrics-mode', kind === 'lyrics');
  const wrap = $('#npPanels');
  if (kind === 'lyrics' && wrap) wrap.style.height = '';
  $$('.np-panel-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.panel === kind));
  // Refresh the incoming page first so it slides in with live content.
  refreshNpPage(kind);
  positionNpCarousel(doAnim);
  sizeNpPanels();
  if (kind === 'lyrics') {
    const track = getTrack(state.currentTrackId);
    if (track && !track.lyrics && !track.syncedLyrics) lookupLyrics(track);
  }
  clearTimeout(selectNpPanel._t);
  selectNpPanel._t = setTimeout(() => {
    sizeNpPanels();
    requestAnimationFrame(updateLyricScroll);
  }, doAnim ? 260 : 0);
}
$('#npLyrics').addEventListener('click', () => selectNpPanel('lyrics'));
$('#npShare').addEventListener('click', async () => {
  const track = getTrack(state.currentTrackId);
  if (!track) return;
  const data = { title: track.title, text: `${track.title} — ${track.artist}` };
  try { if (navigator.share) await navigator.share(data); else toast('Sharing not available'); } catch (e) { /* cancel */ }
});
$('#npMenu').addEventListener('click', () => { const t = getTrack(state.currentTrackId); if (t) openTrackMenu(t.id); });
$$('.np-panel-tab').forEach(b => b.addEventListener('click', () => selectNpPanel(b.dataset.panel)));
/* ------------------------- liquid sliders ----------------------------------- */
const seekRange = $('#npProgress');
const volRange = $('#npVolume');
const seekWrap = $('#npSeekWrap');
const seekBubble = $('#npSeekBubble');
function sliderFill(input) {
  const min = Number(input.min) || 0;
  const max = Number(input.max) || 100;
  const pct = max > min ? clamp((Number(input.value) - min) / (max - min), 0, 1) * 100 : 0;
  input.style.setProperty('--fill', `${pct.toFixed(2)}%`);
  return pct;
}
function positionSeekBubble(pct) {
  if (!seekBubble) return;
  seekBubble.style.left = `${clamp(pct, 7, 93)}%`;
}
function paintSeek() {
  if (!seekRange) return;
  const pct = sliderFill(seekRange);
  if (seekBubble) {
    positionSeekBubble(pct);
    seekBubble.textContent = fmtTime(audio.currentTime);
  }
}
function paintVolume() { if (volRange) sliderFill(volRange); }
if (seekRange) {
  seekRange.addEventListener('input', () => {
    if (audio.duration) audio.currentTime = clamp((Number(seekRange.value) / 1000) * audio.duration, 0, audio.duration);
    paintSeek();
  });
}
if (volRange) volRange.addEventListener('input', () => { setVolume(Number(volRange.value)); paintVolume(); });
function armLiquidRange(wrap, range, showBubble) {
  if (!wrap || !range) return;
  let inside = false;
  range.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    inside = true;
    wrap.classList.add('scrubbing');
    if (showBubble && seekBubble) seekBubble.classList.add('show');
    if (range === seekRange) paintSeek();
  });
  const off = () => {
    if (!inside) return;
    inside = false;
    wrap.classList.remove('scrubbing');
    if (showBubble && seekBubble) setTimeout(() => seekBubble.classList.remove('show'), 600);
  };
  window.addEventListener('pointerup', off);
  window.addEventListener('pointercancel', off);
  range.addEventListener('pointerleave', () => { if (!inside) off(); });
}
armLiquidRange(seekWrap, seekRange, true);
armLiquidRange(volRange ? volRange.closest('.np-range-wrap') : null, volRange, false);
paintSeek();
paintVolume();
$('#npPanels').addEventListener('click', (e) => {
  const lq = e.target.closest('.lq-line[data-ts]');
  if (lq) {
    const ts = Number(lq.dataset.ts);
    if (Number.isFinite(ts) && audio && Number.isFinite(audio.duration)) {
      audio.currentTime = Math.min(ts, Math.max(0, audio.duration - .25));
      if (audio.paused) audio.play().catch(() => {});
      $('#npCurrentTime').textContent = fmtTime(audio.currentTime);
      $('#npProgress').value = Math.round((audio.currentTime / audio.duration) * 1000);
    }
    return;
  }
  const jump = e.target.closest('[data-action="np-jump"]');
  if (jump) { state.queueIndex = Number(jump.dataset.qi); playCurrent(); return; }
  const rem = e.target.closest('[data-action="np-remove"]');
  if (rem) {
    const qi = Number(rem.dataset.qi);
    if (!Number.isInteger(qi) || qi < 0 || qi >= state.queue.length) return;
    const removedId = state.queue[qi];
    const wasCurrent = qi === state.queueIndex;
    state.queue.splice(qi, 1);
    state.baseQueue = state.baseQueue.filter(id => id !== removedId);
    if (wasCurrent) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      state.currentTrackId = null;
      state.queueIndex = -1;
      savePlaybackState();
    } else if (qi < state.queueIndex) {
      state.queueIndex--;
    }
    renderNpPanel();
    updateMiniPlayer();
    updateNowPlaying();
  }
});
// reorder queue via drag
$('#npPanels').addEventListener('dragstart', (e) => {
  const row = e.target.closest('.np-queue-row');
  if (row) { e.dataTransfer.setData('text/plain', row.dataset.qi); row.classList.add('dragging'); }
});
$('#npPanels').addEventListener('dragover', (e) => e.preventDefault());
$('#npPanels').addEventListener('drop', (e) => {
  e.preventDefault();
  const from = Number(e.dataTransfer.getData('text/plain'));
  const toRow = e.target.closest('.np-queue-row');
  if (!toRow || isNaN(from)) return;
  const to = Number(toRow.dataset.qi);
  if (from === to) return;
  const moved = state.queue.splice(from, 1)[0];
  state.queue.splice(to, 0, moved);
  if (from === state.queueIndex) state.queueIndex = to;
  else if (from < state.queueIndex && to >= state.queueIndex) state.queueIndex--;
  else if (from > state.queueIndex && to <= state.queueIndex) state.queueIndex++;
  savePlaybackState();
  renderNpPanel();
});
$('#npPanels').addEventListener('dragend', () => $$('.np-queue-row').forEach(r => r.classList.remove('dragging')));

/* ------------------------- swipe between panels (liquid) -------------------- */
let npSwipe = null;
let npSwipedAt = 0;
nowPlayingEl.addEventListener('pointerdown', (e) => {
  if (nowPlayingEl.hidden) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const target = e.target instanceof Element ? e.target : null;
  if (!target || target.closest('button, input, label, a, [draggable="true"], .np-range')) return;
  npSwipe = {
    id: e.pointerId, startX: e.clientX, startY: e.clientY,
    base: 0, width: 1, active: false, lastX: e.clientX, lastT: performance.now(), v: 0,
  };
});
window.addEventListener('pointermove', (e) => {
  const s = npSwipe;
  if (!s || e.pointerId !== s.id) return;
  const dx = e.clientX - s.startX;
  const dy = e.clientY - s.startY;
  if (!s.active) {
    if (Math.abs(dx) < 8) return;
    if (Math.abs(dy) > Math.abs(dx) * 1.2) { npSwipe = null; return; } // vertical intent — let it scroll
    s.active = true;
    s.width = npCarouselWidth();
    s.base = -npActiveIndex() * s.width;
    nowPlayingEl.classList.add('np-swiping');
  }
  const dt = Math.max(1, performance.now() - s.lastT);
  s.v = (e.clientX - s.lastX) / dt;
  s.lastX = e.clientX;
  s.lastT = performance.now();
  if (e.cancelable) e.preventDefault();
  const raw = s.base + dx;
  const min = -(NP_ORDER.length - 1) * s.width;
  const max = 0;
  const target = raw > max ? max + (raw - max) * 0.32 : raw < min ? min + (raw - min) * 0.32 : raw;
  const track = $('#npCarouselTrack');
  if (track) {
    track.style.transition = 'none';
    track.style.transform = `translate3d(${target.toFixed(2)}px,0,0)`;
  }
}, { passive: false });
function endNpSwipe(e) {
  const s = npSwipe;
  if (!s || e.pointerId !== s.id) return;
  npSwipe = null;
  nowPlayingEl.classList.remove('np-swiping');
  if (!s.active) return;
  const width = s.width;
  const dx = e.clientX - s.startX;
  let idx = npActiveIndex();
  const fling = Math.abs(s.v) > 0.55;
  if (dx < -width * 0.16 || (fling && s.v < -0.55)) idx++;
  else if (dx > width * 0.16 || (fling && s.v > 0.55)) idx--;
  idx = clamp(idx, 0, NP_ORDER.length - 1);
  npSwipedAt = performance.now();
  if (idx !== npActiveIndex()) selectNpPanel(NP_ORDER[idx]);
  else positionNpCarousel(true);
}
window.addEventListener('pointerup', endNpSwipe);
window.addEventListener('pointercancel', endNpSwipe);
// a big drag must not double-fire as a click on whatever the finger lands on
document.addEventListener('click', (e) => {
  if (performance.now() - npSwipedAt < 400) { e.preventDefault(); e.stopPropagation(); }
}, true);
window.addEventListener('resize', () => {
  if (!nowPlayingEl.hidden) { positionNpCarousel(false); sizeNpPanels(); }
});
updateNpPill(false);

/* ------------------------- audio element events ------------------------------- */
audio.addEventListener('play', () => { updateMiniPlayer(); updateNowPlaying(); });
audio.addEventListener('pause', () => {
  savePlaybackState();
  updateMiniPlayer();
  updateNowPlaying();
});
let lastPlaybackSave = 0;
audio.addEventListener('timeupdate', () => {
  updateMediaSessionPosition();
  if (Date.now() - lastPlaybackSave > 4000) { lastPlaybackSave = Date.now(); savePlaybackState(); }
  if (nowPlayingEl.hidden) return;
  $('#npProgress').value = audio.duration ? Math.round((audio.currentTime / audio.duration) * 1000) : 0;
  $('#npCurrentTime').textContent = fmtTime(audio.currentTime);
  paintSeek();
  updateLyricScroll();
});
audio.addEventListener('loadedmetadata', () => {
  const track = getTrack(state.currentTrackId);
  if (track) {
    if (state.restorePosition != null) {
      const position = state.restorePosition;
      state.restorePosition = null;
      if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = Math.min(position, Math.max(0, audio.duration - 0.25));
    }
    $('#npTotalTime').textContent = fmtTime(track.duration || audio.duration);
    updateMediaSession(track);
    savePlaybackState();
  }
});
function reattachCurrentAudio() {
  const track = getTrack(state.currentTrackId);
  if (!track || (!track.blob && !isPublicTrack(track))) return;
  const resumeAt = state.playback.currentTrackId === track.id ? Number(state.playback.position) || 0 : 0;
  const freshUrl = isPublicTrack(track) ? trackUrl(track) : refreshTrackUrl(track);
  if (!freshUrl) return;
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  audio.src = freshUrl;
  loadedAudioTrackId = track.id;
  state.restorePosition = resumeAt;
  audio.load();
  updateMiniPlayer();
  updateNowPlaying();
}
window.addEventListener('pagehide', savePlaybackState);
window.addEventListener('beforeunload', savePlaybackState);
window.addEventListener('pageshow', () => {
  // A restored PWA only needs the source reattached; playback still starts from
  // the explicit Play tap required by iOS.
  if (state.currentTrackId && audio.error) reattachCurrentAudio();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.currentTrackId && audio.error) reattachCurrentAudio();
});
window.addEventListener('online', () => { updateOfflineStatus(); toast('Back online'); });
window.addEventListener('offline', () => { updateOfflineStatus(); toast('Offline mode — local music is still available'); });  audio.addEventListener('error', () => {
  if (state.currentTrackId) toast('Audio is unavailable — tap Play to retry the local file');
  updateMiniPlayer();
  updateNowPlaying();
});
audio.addEventListener('stalled', () => {
  if (state.currentTrackId && audio.paused) toast('Playback paused — tap Play to retry');
});
audio.addEventListener('ended', nextTrack);


/* ------------------------- theme + init --------------------------------------- */
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) { e.preventDefault(); togglePlay(); }
  if (e.key === 'ArrowRight' && nowPlayingEl.hidden === false && document.activeElement?.tagName !== 'INPUT') { audio.currentTime += 15; }
  if (e.key === 'ArrowLeft' && nowPlayingEl.hidden === false && document.activeElement?.tagName !== 'INPUT') { audio.currentTime -= 15; }
});

async function init() {
  try { db = await openDB(); } catch (e) { toast('Local library storage is unavailable'); return; }
  await loadSettings();
  await loadPublicTracks();
  if (state.settings.theme === 'dark') document.body.classList.add('dark');
  try {
    state.tracks = await Promise.all((await dbGetAll(DB_TRACKS)).map(hydrateLocalTrack));
    // Persist the normalized record only after the bytes have been successfully
    // rehydrated; this keeps old Safari IDB representations readable on the next launch.
    state.tracks.forEach(track => {    if (track.blob) {
      const source = track.blob;
      Promise.resolve(typeof source.arrayBuffer === 'function' ? source.arrayBuffer() : source)
        .then(bytes => dbPut(DB_TRACKS, { ...track, blob: bytes }))
        .catch(() => {});
    } });
    state.playlists = (await dbGetAll(DB_PLAYLISTS)).map(p => ({
      ...p,
      id: p.id || uid('pl'),
      name: p.name || 'Untitled playlist',
      color: p.color || '#a395ff',
      trackIds: Array.isArray(p.trackIds) ? p.trackIds : [],
      createdAt: Number(p.createdAt) || Date.now(),
    }));
  } catch (e) { /* ignore */ }
  setVolume(state.settings.volume);
  if (state.settings.eq) { eqEnabled = ensureAudioGraph(); applyEqGraph(); }
  restorePlaybackState();
  bindMediaSession();
  updateOfflineStatus();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // updateViaCache: 'none' stops iOS Safari from serving a stale copy of
      // the service worker script itself, which silently blocked updates.
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(() => setTimeout(checkForAppUpdate, 2500)).catch(() => {});
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      try { localStorage.setItem('mixdeck-sw-version', ''); } catch (e) { /* ignore */ }
      setTimeout(() => location.reload(), 600);
    });
  }
  renderView();
  // Sweep the whole library (local + shared) for covers: catches tracks
  // imported before the artwork feature existed and retries anything that
  // failed earlier.
  queueArtworkLookups([...state.tracks, ...state.publicTracks]);
}
init();