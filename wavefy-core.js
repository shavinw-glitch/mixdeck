/* =========================================================================
   Wavefy core — the non-UI engine, ported from Mixdeck's backend features.
   Everything here talks to the copied backend (server.js) and the cloud
   (Supabase) exactly like the old app did; only the rendering stays in
   index.html.
   ========================================================================= */

/* ------------------------------ constants ------------------------------ */
const DB_NAME = 'wavefy-db';
const DB_VERSION = 1;
const DB_TRACKS = 'tracks';
const DB_SETTINGS = 'settings';
const DB_ARTWORK_CACHE = 'artwork-cache';
const CLOUD_CFG_KEY = 'wavefy-cloud-config';
const PLAYBACK_STORAGE_KEY = 'wavefy-playback';

const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search';
const ARTWORK_RETRY_MS = 30 * 60 * 1000; // a failed lookup retries within 30 min

/* ------------------------------ tiny utils ----------------------------- */
function uid(prefix = 'id') { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

/* ---------------------- byte-level tag identification -------------------
   Ported from Mixdeck metadata.js — reads ID3v2/ID3v1, MP4 iTunes atoms,
   FLAC Vorbis comments + embedded pictures directly from the bytes, then
   falls back to the bundled vendor parser and filename heuristics. */
function decStr(bytes, label) { try { return new TextDecoder(label).decode(bytes); } catch { return ''; } }
function be32(u8, i) { return (u8[i] * 0x1000000) + (u8[i + 1] << 16) + (u8[i + 2] << 8) + u8[i + 3]; }
function le32(u8, i) { return u8[i] + (u8[i + 1] << 8) + (u8[i + 2] << 16) + (u8[i + 3] * 0x1000000); }
function syncsafe(u8, i) { return ((u8[i] & 0x7f) << 21) | ((u8[i + 1] & 0x7f) << 14) | ((u8[i + 2] & 0x7f) << 7) | (u8[i + 3] & 0x7f); }
function cleanText(s) { return String(s || '').replace(/^\u0000+|\u0000+$/g, '').replace(/\u0000/g, '').trim(); }

function tagText(buf) {
  if (!buf || !buf.length) return '';
  const enc = buf[0]; const body = buf.subarray(1);
  if (enc === 3) return cleanText(decStr(body, 'utf-8'));
  if (enc === 2) return cleanText(decStr(body, 'utf-16be'));
  if (enc === 1) return cleanText(decStr(body, 'utf-16le'));
  return cleanText(decStr(body, 'windows-1252'));
}
function tagTrackNo(value) { const m = String(value || '').match(/\d+/); return m ? parseInt(m[0], 10) || 0 : 0; }
function tagYear(value) { const m = String(value || '').match(/(19|20)\d{2}/); return m ? parseInt(m[0], 10) || 0 : 0; }

function parseID3v1(u8) {
  if (!u8 || u8.length < 128) return null;
  const o = u8.length - 128;
  if (decStr(u8.subarray(o, o + 3), 'ascii') !== 'TAG') return null;
  return {
    title: cleanText(decStr(u8.subarray(o + 3, o + 33), 'windows-1252')),
    artist: cleanText(decStr(u8.subarray(o + 33, o + 63), 'windows-1252')),
    album: cleanText(decStr(u8.subarray(o + 63, o + 93), 'windows-1252')),
    albumArtist: '', genre: '', composer: '',
    year: tagYear(cleanText(decStr(u8.subarray(o + 93, o + 97), 'ascii'))),
    trackNumber: (u8[o + 125] === 0 && u8[o + 126]) ? u8[o + 126] : 0,
    artwork: null,
  };
}

function parseID3v2(u8) {
  if (!u8 || u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return null;
  const ver = u8[3];
  if (ver !== 2 && ver !== 3 && ver !== 4) return null;
  const end = Math.min(u8.length, 10 + syncsafe(u8, 6));
  const canon = { TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', TP2: 'TPE2', TCO: 'TCON', TYE: 'TYER', TRK: 'TRCK', TCM: 'TCOM' };
  const tags = {};
  let o = 10;
  while (o + 6 < end) {
    let fid, dStart, size;
    if (ver === 2) {
      fid = String.fromCharCode(u8[o], u8[o + 1], u8[o + 2]);
      size = (u8[o + 3] << 16) | (u8[o + 4] << 8) | u8[o + 5];
      dStart = o + 6;
    } else {
      fid = String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
      size = ver === 4 ? syncsafe(u8, o + 4) : be32(u8, o + 4);
      dStart = o + 10;
    }
    if (!fid || fid.charCodeAt(0) === 0) break;
    if (size <= 0) { o += ver === 2 ? 6 : 10; continue; }
    const dEnd = Math.min(end, dStart + size);
    const key = canon[fid] || fid;
    try {
      if (key[0] === 'T' && key !== 'TXXX') {
        const val = tagText(u8.subarray(dStart, dEnd));
        if (val) tags[key] = val;
      } else if (key === 'APIC' && u8[dStart] === 0) {
        let m = dStart + 1;
        while (m < dEnd && u8[m] !== 0) m++;
        const mime = cleanText(decStr(u8.subarray(dStart + 1, m), 'windows-1252'));
        let s = m + 2;
        while (s < dEnd && u8[s] !== 0) s++;
        s++;
        if (s < dEnd) {
          const data = u8.slice(s, dEnd);
          tags.artwork = { data, mime: mime || (data[0] === 0xff ? 'image/jpeg' : 'image/png') };
        }
      }
    } catch { /* malformed frame — skip */ }
    o = dEnd;
  }
  return {
    title: tags.TIT2 || '', artist: tags.TPE1 || '', album: tags.TALB || '',
    albumArtist: tags.TPE2 || '', genre: tags.TCON || '', composer: tags.TCOM || '',
    year: tagYear(tags.TDRC || tags.TYER),
    trackNumber: tagTrackNo(tags.TRCK),
    artwork: tags.artwork || null,
  };
}

function parseFLAC(u8) {
  if (!u8 || u8.length < 8 || decStr(u8.subarray(0, 4), 'ascii') !== 'fLaC') return null;
  const kv = {};
  let art = null;
  let o = 4;
  while (o + 4 <= u8.length) {
    const hdr = be32(u8, o);
    const last = (hdr & 0x80000000) !== 0;
    const type = (hdr >>> 24) & 0x7f;
    const size = hdr & 0xffffff;
    const dStart = o + 4, dEnd = Math.min(u8.length, dStart + size);
    if (type === 4) {
      let p = dStart;
      if (p + 4 > dEnd) break;
      const vendorLen = le32(u8, p); p += 4;
      p += vendorLen;
      if (p + 4 > dEnd) break;
      let count = le32(u8, p); p += 4;
      while (count-- > 0 && p + 4 <= dEnd) {
        const len = le32(u8, p); p += 4;
        if (p + len > dEnd) break;
        const line = decStr(u8.subarray(p, p + len), 'utf-8');
        p += len;
        const eq = line.indexOf('=');
        if (eq > 0) kv[line.slice(0, eq).toUpperCase()] = line.slice(eq + 1);
      }
    } else if (type === 6 && !art) {
      try {
        let p = dStart + 4;
        const mimeLen = be32(u8, p); p += 4;
        const mime = cleanText(decStr(u8.subarray(p, p + mimeLen), 'windows-1252')); p += mimeLen;
        const descLen = be32(u8, p); p += 4 + descLen;
        p += 16;
        if (p + 4 <= dEnd) {
          const dataLen = be32(u8, p); p += 4;
          if (dataLen > 0 && p + dataLen <= dEnd) {
            const data = u8.slice(p, p + dataLen);
            art = { data, mime: mime || (data[0] === 0xff && data[1] === 0xd8 ? 'image/jpeg' : 'image/png') };
          }
        }
      } catch { /* ignore picture block */ }
    }
    if (last) break;
    o = dEnd;
  }
  return {
    title: kv.TITLE || '', artist: kv.ARTIST || '', album: kv.ALBUM || '',
    albumArtist: kv.ALBUMARTIST || kv.ALBUM_ARTIST || '',
    genre: kv.GENRE || '', composer: kv.COMPOSER || '',
    year: tagYear(kv.DATE || kv.YEAR), trackNumber: tagTrackNo(kv.TRACKNUMBER || kv.TRACK),
    artwork: art,
  };
}

function parseMP4(u8) {
  if (!u8 || u8.length < 12 || decStr(u8.subarray(4, 8), 'ascii') !== 'ftyp') return null;
  const tags = {};
  let art = null;
  function fourcc(o) { return String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]); }
  function findIlst(start, end) {
    let o = start;
    while (o + 8 <= end) {
      const sz = be32(u8, o);
      const type = fourcc(o + 4);
      const childStart = o + 8 + (type === 'meta' ? 4 : 0);
      let childEnd = sz === 1 ? end : (sz === 0 ? end : Math.min(end, o + sz));
      if (type === 'ilst') return { start: childStart, end: childEnd };
      if (type === 'moov' || type === 'udta' || type === 'meta') {
        const sub = findIlst(childStart, childEnd);
        if (sub) return sub;
      }
      if (childEnd <= o) break;
      o = childEnd;
    }
    return null;
  }
  const ilst = findIlst(0, u8.length);
  if (!ilst) return null;
  const nameMap = { '©nam': 'TIT2', '©ART': 'TPE1', aART: 'TPE2', '©alb': 'TALB', '©gen': 'TCON', '©day': 'TDRC', '©wrt': 'TCOM' };
  let o = ilst.start;
  while (o + 8 <= ilst.end) {
    const itemSz = be32(u8, o);
    const name = fourcc(o + 4);
    let itemEnd = itemSz === 1 ? ilst.end : (itemSz === 0 ? ilst.end : Math.min(ilst.end, o + itemSz));
    let p = o + 8;
    while (p + 8 <= itemEnd) {
      const dSz = be32(u8, p);
      const dType = fourcc(p + 4);
      const dEnd = dSz === 0 ? itemEnd : Math.min(itemEnd, p + dSz);
      if (dType === 'data') {
        const payload = u8.subarray(p + 16, dEnd);
        try {
          if (name === 'covr') {
            if (!art && payload.length) art = { data: payload, mime: (payload[0] === 0xff && payload[1] === 0xd8) ? 'image/jpeg' : 'image/png' };
          } else if (name === 'trkn' && payload.length >= 6) {
            let no = (payload[2] << 8) | payload[3];
            if (!no && payload.length >= 10) no = (payload[6] << 8) | payload[7];
            if (no) tags.TRCK = String(no);
          } else {
            const key = nameMap[name];
            if (key) {
              const val = cleanText(decStr(payload, 'utf-8'));
              if (val && !tags[key]) tags[key] = val;
            }
          }
        } catch { /* skip item */ }
      }
      if (dEnd <= p) break;
      p = dEnd;
    }
    if (itemEnd <= o) break;
    o = itemEnd;
  }
  return {
    title: tags.TIT2 || '', artist: tags.TPE1 || '', album: tags.TALB || '',
    albumArtist: tags.TPE2 || '', genre: tags.TCON || '', composer: tags.TCOM || '',
    year: tagYear(tags.TDRC), trackNumber: tagTrackNo(tags.TRCK),
    artwork: art,
  };
}

function sniffFormat(u8) {
  if (!u8 || u8.length < 4) return 'unknown';
  if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) return 'mp3';
  if (decStr(u8.subarray(0, 4), 'ascii') === 'fLaC') return 'flac';
  if (u8.length >= 12 && decStr(u8.subarray(4, 8), 'ascii') === 'ftyp') return 'mp4';
  if (decStr(u8.subarray(0, 4), 'ascii') === 'OggS') return 'ogg';
  if (decStr(u8.subarray(0, 4), 'ascii') === 'RIFF') return 'wav';
  return 'unknown';
}

export function identifyFromBytes(u8) {
  let parsed = null;
  if (!u8 || !u8.length) parsed = null;
  else if (u8.length >= 3 && u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) parsed = parseID3v2(u8);
  else if (u8.length >= 12) {
    if (decStr(u8.subarray(4, 8), 'ascii') === 'ftyp') parsed = parseMP4(u8);
    else if (decStr(u8.subarray(0, 4), 'ascii') === 'fLaC') parsed = parseFLAC(u8);
  }
  if (!parsed || !(parsed.title || parsed.artist || parsed.album || parsed.artwork)) parsed = parseID3v1(u8);
  const empty = { title: '', artist: '', album: '', albumArtist: '', genre: '', composer: '', year: 0, trackNumber: 0, artwork: null, format: sniffFormat(u8) };
  if (!parsed) return empty;
  return {
    title: parsed.title || '', artist: parsed.artist || '', album: parsed.album || '',
    albumArtist: parsed.albumArtist || '', genre: parsed.genre || '', composer: parsed.composer || '',
    year: Number(parsed.year) || 0, trackNumber: Number(parsed.trackNumber) || 0,
    artwork: parsed.artwork || null, format: empty.format,
  };
}

/* ------------------------- filename heuristics -------------------------- */
export function filenameMetadata(name) {
  const raw = String(name || '').replace(/\.[^/.]+$/, '').trim();
  const stem = raw.replace(/^\s*\d{1,3}\s*[.)\-–—]\s*/, '').trim();
  const match = stem.match(/^(.+?)\s+[-–—~|]\s+(.+)$/);
  if (!match) return { artist: '', title: stem || 'Untitled track' };
  const artist = match[1].trim()
    .replace(/^\s*\[[^\]]*\]\s*/, '')
    .replace(/^\s*\([^)]*\)\s*/, '')
    .replace(/^[\[\]()\s]+|[\[\]()\s]+$/g, '')
    .trim();
  const title = match[2].trim().replace(/\s+[\[\(][^\]\)]*[\]\)]\s*$/, '').trim();
  return { artist, title };
}
function guessArtist(title) {
  const t = String(title || '');
  const m = t.match(/\s+[-–—~|]\s+/);
  const raw = m ? t.slice(0, m.index).trim() : '';
  return raw || 'Unknown artist';
}
function fileTitle(name) {
  return (String(name || '').replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled track');
}

/* ------------------------ comparison / text utils ----------------------- */
export function normCompare(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
export function nameTokens(value) {
  const norm = normCompare(value);
  const tokens = norm ? norm.split(' ') : [];
  return tokens.filter(w => w.length > 1 || /^\d+$/.test(w));
}
export function tokenOverlap(a, b) {
  const A = a || [], B = b || [];
  if (!A.length || !B.length) return 0;
  const setB = new Set(B);
  const hit = A.filter(w => setB.has(w)).length;
  const union = new Set([...A, ...B]).size;
  return union ? hit / union : 0;
}
export function isJunkArtist(value) {
  const v = String(value || '').replace(/\u0000/g, '').trim();
  if (!v) return true;
  if (v === 'Unknown' || v === 'Unknown artist') return true;
  if (/^(various|various\s*artists|va|uncredited|unknown|track|artist|soundtrack|composer|none|null|\?|mixed\s*by|dj)$/i.test(v)) return true;
  if (/^(https?:|www\.)|youtube|youtu\.be|@|(feat\.?|ft\.?)\s*$|^\s*[-–—~|]\s*$/i.test(v)) return true;
  if (v === v.toLowerCase() && /^[a-z0-9 _-]{0,40}$/i.test(v) && !/[A-Z]/.test(v) && /\s/.test(v) && v.split(' ').length > 4) return true;
  return false;
}
export function primaryArtist(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  const parts = v.split(/\s*[;/,&]\s*|\s+(?:feat\.?|ft\.?|featuring|with)\s+/i);
  for (const part of parts) {
    const candidate = part.trim();
    if (candidate && !isJunkArtist(candidate)) return candidate;
  }
  return v.split(/\s*[;/,&]\s*|\s+(?:feat\.?|ft\.?|featuring|with)\s+/i)[0].trim();
}
export function cleanTitleString(value) {
  return String(value || '')
    .replace(/\s*\[[^\]]+\]\s*$/g, '')
    .replace(/\s*\([^)]*(?:official|lyrics|audio|video|mv|hd|4k)[^)]*\)\s*$/ig, '')
    .trim();
}

/* ---------------------------- IndexedDB --------------------------------- */
let db;
export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(DB_TRACKS)) d.createObjectStore(DB_TRACKS, { keyPath: 'id' });
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

export async function initStore() {
  db = await openDB();
}
export async function loadLocalTracks() {
  const rows = await dbGetAll(DB_TRACKS);
  return rows.map(normalizeTrack);
}
export async function saveTrack(track) {
  if (isPublicTrack(track)) return;
  await dbPut(DB_TRACKS, track);
}

/* --------------------------- track records ------------------------------ */
export function isPublicTrack(track) { return Boolean(track && (track.isPublic || track.cloud)); }
export function normalizeTrack(track) {
  const fileMeta = filenameMetadata(track.name || '');
  const title = track.title || fileMeta.title || 'Untitled track';
  const artist = track.artist || fileMeta.artist || guessArtist(title);
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
    artworkType: track.artworkType || '',
    lyrics: track.lyrics || '',
    syncedLyrics: Array.isArray(track.syncedLyrics) ? track.syncedLyrics : null,
    lyricsSource: track.lyricsSource || '',
    lyricsFetchedAt: Number(track.lyricsFetchedAt) || 0,
    lyricsLookupFailed: Boolean(track.lyricsLookupFailed),
    artworkSource: track.artworkSource || '',
    artworkFetchedAt: Number(track.artworkFetchedAt) || 0,
    artworkLookupFailed: Boolean(track.artworkLookupFailed),
    metaSource: track.metaSource || '',
    playCount: Number(track.playCount) || 0,
    lastPlayedAt: Number(track.lastPlayedAt) || 0,
    loved: Boolean(track.loved),
    isPublic: Boolean(track.isPublic),
    publicUrl: track.publicUrl || '',
    cloud: Boolean(track.cloud),
  };
}

const state = {
  artworkUrls: new Map(),
  artworkBlobs: new Map(),
  objectUrls: new Map(),
  // Two independent transports. Keeping them apart matters: a working cloud used
  // to mark the *local server* as available, which sent artwork lookups at a
  // /api/artwork endpoint that did not exist.
  localServerAvailable: false,
  cloudAvailable: false,
  serverAvailable: false, // either transport — kept for back-compat
  tracks: [],       // local imported tracks
  publicTracks: [], // shared library (cloud or local server)
};

/* Tracks that could not be looked up because no proxy was reachable. They are
   retried the moment one appears, instead of waiting out the failure window. */
const needsProxy = new Set();
function flushNeedsProxy() {
  if (!state.localServerAvailable && !state.cloudAvailable) return;
  const pending = [...needsProxy];
  needsProxy.clear();
  pending.forEach(t => {
    t.artworkNeedsProxy = false;
    lookupArtwork(t).then(ok => { if (ok) lookupLyrics(t); }).catch(() => {});
  });
}

export function getState() { return state; }
export function allTracks() { return [...state.tracks, ...state.publicTracks]; }
export function getTrack(id) { return allTracks().find(t => t.id === id); }

export function hasArtwork(track) { return Boolean(track && track.artworkBytes && track.artworkBytes.length); }
export function artworkUrl(track) {
  if (!track || !hasArtwork(track)) return null;
  if (!state.artworkUrls.has(track.id)) {
    let blob = state.artworkBlobs.get(track.id);
    if (!blob) {
      try { blob = new Blob([track.artworkBytes], { type: track.artworkType || 'image/jpeg' }); }
      catch { return null; }
      state.artworkBlobs.set(track.id, blob);
    }
    try { state.artworkUrls.set(track.id, URL.createObjectURL(blob)); }
    catch { return null; }
  }
  return state.artworkUrls.get(track.id);
}

export function trackUrl(track) {
  if (!track) return '';
  if (isPublicTrack(track)) {
    const base = track.cloud ? '' : (track.publicUrl || '');
    return base ? new URL(base, location.href).href : (track.url || '');
  }
  if (!track.blob) return '';
  if (!state.objectUrls.has(track.id)) {
    try { state.objectUrls.set(track.id, URL.createObjectURL(track.blob)); } catch { return ''; }
  }
  return state.objectUrls.get(track.id) || '';
}

/* ----------------------------- import flow ------------------------------ */
async function readDuration(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const probe = new Audio();
    const done = d => { URL.revokeObjectURL(url); resolve(d); };
    probe.preload = 'metadata';
    probe.src = url;
    probe.onloadedmetadata = () => done(Number.isFinite(probe.duration) ? probe.duration : 0);
    probe.onerror = () => done(0);
    setTimeout(() => done(Number.isFinite(probe.duration) ? probe.duration : 0), 6000);
  });
}

/* Extract identity: byte-level reader first, vendor parser as a supplement,
   filename as a last resort. This mirrors the old app's pipeline. */
export async function extractMetadata(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const tags = identifyFromBytes(bytes);
  const fallback = filenameMetadata(file.name);

  let vendor = {};
  try {
    const mod = await import('./vendor/music-metadata.js');
    if (mod && mod.parseBlob) {
      const parsed = await mod.parseBlob(file, { duration: false, skipPostHeaders: true });
      const common = parsed?.common || {};
      vendor = {
        title: common.title || '', artist: common.artist || '', album: common.album || '',
        year: Number(common.year) || 0, trackNumber: Number(common.track?.no) || 0,
        artwork: parsed?.common?.picture?.[0] ? { data: new Uint8Array(parsed.common.picture[0].data), mime: parsed.common.picture[0].format } : null,
        duration: Number(parsed?.format?.duration) || 0,
      };
    }
  } catch { /* vendor parser is optional */ }

  const pick = (a, b, c) => a || b || c || '';
  const title = pick(tags.title, vendor.title, fallback.title);
  // Placeholder tag artists never override the real performer from the filename.
  const artist = (tags.artist && !isJunkArtist(tags.artist)) ? tags.artist
    : (vendor.artist && !isJunkArtist(vendor.artist)) ? vendor.artist
    : (fallback.artist || 'Unknown artist');
  const duration = Number(vendor.duration) || 0;
  const artwork = tags.artwork || vendor.artwork || null;

  return {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    name: file.name,
    blob: file,
    mimeType: file.type || 'application/octet-stream',
    size: file.size,
    addedAt: Date.now(),
    duration: duration || await readDuration(file),
    title, artist,
    albumArtist: tags.albumArtist || artist,
    album: pick(tags.album, vendor.album),
    genre: tags.genre || '', year: Number(tags.year) || 0,
    composer: tags.composer || '',
    trackNumber: Number(tags.trackNumber) || 0, discNumber: 0, bpm: 0,
    artworkBytes: artwork?.data?.length ? artwork.data : null,
    artworkType: artwork?.mime || '',
    artworkSource: artwork ? 'Embedded' : '',
    artworkFetchedAt: artwork ? Date.now() : 0,
    artworkLookupFailed: false,
    lyrics: '', syncedLyrics: null, lyricsSource: '', lyricsFetchedAt: 0, lyricsLookupFailed: false,
    metaSource: tags.title ? 'tags' : (vendor.title ? 'tags' : 'filename'),
    format: tags.format || 'unknown',
    bytes,
  };
}

/* ------------------------- cover recognition ----------------------------
   iTunes Search API with the strict gated matcher from the old app:
   wrong-artist candidates are rejected outright; title must agree. */
const ARTWORK_MIN_SCORE = 5;
function artworkScore(item, title, artist, album) {
  const nTitle = normCompare(title);
  const nArtist = isJunkArtist(artist) ? '' : normCompare(artist);
  const nAlbum = normCompare(album);
  const t = normCompare(item.trackName || item.name || '');
  const a = normCompare(item.artistName || item.artist || '');
  const al = normCompare(item.collectionName || item.album || '');
  const titleSim = (nTitle && t) ? tokenOverlap(nameTokens(t), nameTokens(title)) : 0;
  const titleExact = Boolean(nTitle && t === nTitle);
  const albumExact = Boolean(nAlbum && al === nAlbum);
  const albumSim = (nAlbum && al) ? tokenOverlap(nameTokens(al), nameTokens(album)) : 0;
  const artistOk = Boolean(nArtist && (a === nArtist || normCompare(primaryArtist(a)) === normCompare(primaryArtist(artist))));
  let score = 0;
  let pass = true;
  if (titleExact) score += 6;
  else if (titleSim >= 0.8) score += 3;
  else if (titleSim >= 0.5) score += 1;
  if (nArtist) {
    const artistSim = tokenOverlap(nameTokens(a), nameTokens(artist));
    if (artistOk) { score += 4; }
    else if (artistSim >= 0.7) { score += 2; }
    else { pass = false; }
  } else if (!(titleExact || titleSim >= 0.8)) {
    pass = false;
  }
  if (!(titleExact || titleSim >= 0.5) && !(albumExact && artistOk)) pass = false;
  if (albumExact) score += 3;
  else if (albumSim >= 0.7) score += 2;
  return pass ? score : -1e9;
}
function chooseArtworkResult(items, title, artist, album) {
  let best = null, bestScore = -1e9;
  for (const item of items) {
    if (!item || !(item.artworkUrl || item.artworkUrl100)) continue;
    const s = artworkScore(item, title, artist, album);
    if (s > bestScore) { bestScore = s; best = item; }
  }
  return bestScore >= ARTWORK_MIN_SCORE ? best : null;
}
function artworkImageUrl(item) {
  const base = String(item.artworkUrl || item.artworkUrl100 || '');
  return base.replace(/\/60x60bb\./, '/600x600bb.').replace(/\/100x100bb\./, '/600x600bb.');
}
async function fetchJson(url, extraHeaders) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const headers = { Accept: 'application/json', ...(extraHeaders || {}) };
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return await response.json();
  } finally { clearTimeout(timer); }
}
async function fetchArtworkCandidates(track, opts = {}) {
  const title = cleanTitleString(track.title);
  const rawArtist = track.artist && track.artist !== 'Unknown artist' ? track.artist : '';
  const artist = rawArtist ? primaryArtist(rawArtist) : '';
  const album = track.album || '';
  const albumScope = Boolean(opts.albumScope);
  const searchTerm = albumScope && album ? `${album} ${artist}`.trim() : [title, artist, album].filter(Boolean).join(' ');
  const itunesParams = new URLSearchParams({ term: searchTerm, media: 'music', entity: albumScope ? 'album' : 'song', limit: '25' });
  // Direct iTunes first, exactly like the original app — it is the one source
  // that needs no backend. A mobile browser only succeeds at it in
  // "Request Desktop Website" mode (Apple 301s a mobile UA into a `musics://`
  // deep link that fetch() cannot follow), so the proxies stay behind it as
  // automatic fallbacks rather than replacing it.
  const requests = [{ url: `${ITUNES_SEARCH_URL}?${itunesParams.toString()}` }];
  if (!albumScope) {
    const proxyParams = new URLSearchParams({ title, term: searchTerm });
    if (rawArtist) proxyParams.set('artist', rawArtist);
    if (album) proxyParams.set('album', album);
    // Proxies as fallbacks, for when the direct call is blocked by the browser.
    if (state.localServerAvailable) {
      requests.push({ url: `/api/artwork?${proxyParams.toString()}` });
    }
    const cfg = cloudConfig();
    if (cfg && cfg.supabaseUrl && cfg.supabaseKey) {
      requests.push({
        url: `${cloudBase()}/functions/v1/artwork?${proxyParams.toString()}`,
        headers: { apikey: cfg.supabaseKey, Authorization: `Bearer ${cfg.supabaseKey}` },
      });
    }
  }
  if (!requests.length) {
    const err = new Error('No artwork proxy is reachable from this browser');
    err.code = 'NO_PROXY';
    throw err;
  }
  for (const req of requests) {
    try {
      const data = await fetchJson(req.url, req.headers);
      const items = Array.isArray(data) ? data : (data && Array.isArray(data.results) ? data.results : null);
      if (Array.isArray(items) && items.length) return items;
    } catch { /* next source */ }
  }
  return [];
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
  } finally { clearTimeout(timer); }
}

const artworkListeners = new Set();
export function onArtworkFound(fn) { artworkListeners.add(fn); return () => artworkListeners.delete(fn); }
function notifyArtwork(track) { artworkListeners.forEach(fn => { try { fn(track); } catch { /* ignore */ } }); }

export async function lookupArtwork(track, force = false, quiet = true) {
  if (!track) return false;
  const staleFailure = track.artworkLookupFailed && Date.now() - (track.artworkFetchedAt || 0) > ARTWORK_RETRY_MS;
  const alreadyHandled = hasArtwork(track) || (track.artworkLookupFailed && !staleFailure);
  if (!force && alreadyHandled) return false;
  if (!navigator.onLine) return false;
  try {
    const title = cleanTitleString(track.title);
    const artist = track.artist && track.artist !== 'Unknown artist' ? track.artist : '';
    const album = track.album || '';
    let result = chooseArtworkResult(await fetchArtworkCandidates(track), title, artist, album);
    if (!result && album && artist) {
      result = chooseArtworkResult(await fetchArtworkCandidates(track, { albumScope: true }), title, artist, album);
    }
    if (!result && artist) {
      result = chooseArtworkResult(await fetchArtworkCandidates({ ...track, title: `${artist} ${title}`, artist: '' }), title, artist, album);
    }
    if (!result) throw new Error('No artwork found');
    const blob = await fetchImageBlob(artworkImageUrl(result));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.length) throw new Error('Artwork image is empty');
    if (state.artworkUrls.has(track.id)) { URL.revokeObjectURL(state.artworkUrls.get(track.id)); state.artworkUrls.delete(track.id); }
    state.artworkBlobs.delete(track.id);
    track.artworkBytes = bytes;
    track.artworkType = blob.type || track.artworkType || 'image/jpeg';
    track.artworkSource = 'Online artwork';
    track.artworkFetchedAt = Date.now();
    track.artworkLookupFailed = false;
    if (isPublicTrack(track)) {
      await dbPut(DB_ARTWORK_CACHE, { id: track.id, artworkBytes: bytes, artworkType: track.artworkType, artworkFetchedAt: track.artworkFetchedAt });
    } else {
      await saveTrack(track);
    }
    notifyArtwork(track);
    return true;
  } catch (err) {
    if (err && err.code === 'NO_PROXY') {
      // Nothing was actually wrong with this track. Do NOT set
      // artworkLookupFailed - that would lock it out for ARTWORK_RETRY_MS.
      track.artworkNeedsProxy = true;
      needsProxy.add(track);
      return false;
    }
    track.artworkLookupFailed = true;
    track.artworkFetchedAt = Date.now();
    if (!isPublicTrack(track)) saveTrack(track).catch(() => {});
    return false;
  }
}

export function queueArtworkLookups(tracks) {
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

/* ------------------------------- lyrics ---------------------------------
   LRCLIB via the local proxy first, then direct. Strict gated matcher:
   wrong-song candidates are never accepted. */
function cleanLyricLine(line) {
  return String(line || '')
    .replace(/^\[(ar|al|ti|by|au|re|ve|length|offset|tool|language|url)\s*:[^\]]*\]/i, '')
    .replace(/^\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/g, '')
    .trim();
}
export function parseLRC(text) {
  const lines = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    let rest = raw;
    const times = [];
    while (true) {
      const m = rest.match(/^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/);
      if (!m) break;
      const fraction = m[3] ? Number(m[3].padEnd(3, '0').slice(0, 3)) / 1000 : 0;
      times.push(Number(m[1]) * 60 + Number(m[2]) + fraction);
      rest = rest.slice(m[0].length);
    }
    if (!times.length) continue;
    const content = rest.trim();
    if (!content || /^[♪♫~…•·\-–—\s]+$/.test(content)) continue;
    for (const time of times) lines.push({ time, text: content });
  }
  return lines.length ? lines.sort((a, b) => a.time - b.time) : null;
}
function cleanLyricText(text) {
  return String(text || '').split(/\r?\n/).map(cleanLyricLine).filter(Boolean).join('\n');
}
function chooseLyricResult(data, title, artist) {
  const normalizedTitle = title.toLowerCase();
  const normalizedArtist = artist.toLowerCase();
  const items = Array.isArray(data) ? data : data ? [data] : [];
  let best = null;
  let bestScore = -1e9;
  for (const item of items) {
    if (!item || !(item.syncedLyrics || item.plainLyrics || item.lyrics)) continue;
    if (item.instrumental) continue;
    const itemTitle = String(item.trackName || item.name || '').toLowerCase();
    const itemArtist = String(item.artistName || item.artist || '').toLowerCase();
    const titleExact = Boolean(normalizedTitle && itemTitle === normalizedTitle);
    const titleContains = !titleExact && Boolean(normalizedTitle && itemTitle && itemTitle.includes(normalizedTitle));
    if (!titleExact && !titleContains) continue;
    const artistExact = Boolean(normalizedArtist && itemArtist === normalizedArtist);
    const artistRelated = Boolean(normalizedArtist && itemArtist && (itemArtist.includes(normalizedArtist) || normalizedArtist.includes(itemArtist)));
    let score = titleExact ? 6 : 3;
    if (artistExact) score += 3;
    else if (artistRelated) score += 1;
    else if (normalizedArtist && itemArtist) score -= 8;
    if (item.syncedLyrics) score += 1;
    if (score > bestScore) { bestScore = score; best = item; }
  }
  return best && bestScore >= 6 ? best : null;
}

const lyricListeners = new Set();
export function onLyricsFound(fn) { lyricListeners.add(fn); return () => lyricListeners.delete(fn); }
function notifyLyrics(track) { lyricListeners.forEach(fn => { try { fn(track); } catch { /* ignore */ } }); }

export async function lookupLyrics(track, force = false) {
  if (!track) return false;
  if (!force && (track.lyrics || track.syncedLyrics || track.lyricsLookupFailed)) return false;
  if (!navigator.onLine) return false;
  try {
    const title = cleanTitleString(track.title);
    const artist = track.artist && track.artist !== 'Unknown artist' ? track.artist : '';
    const getParams = new URLSearchParams({ track_name: title });
    if (artist) getParams.set('artist_name', artist);
    if (track.album) getParams.set('album_name', track.album);
    const searchParams = new URLSearchParams({ q: artist ? `${title} ${artist}` : title });
    const requests = [
      `/api/lyrics?${getParams.toString()}`,
      `https://lrclib.net/api/get?${getParams.toString()}`,
      `https://lrclib.net/api/search?${searchParams.toString()}`,
    ];
    let result = null;
    for (const url of requests) {
      try {
        const data = await fetchJson(url);
        result = chooseLyricResult(data, title, artist);
        if (result) break;
      } catch { /* try the next source */ }
    }
    if (!result) throw new Error('No lyrics in result');
    const syncedText = result.syncedLyrics || '';
    const plainRaw = (result.plainLyrics || result.lyrics || syncedText || '').trim();
    if (!plainRaw) throw new Error('No lyrics in result');
    const synced = parseLRC(syncedText) || parseLRC(plainRaw);
    if (synced && synced.length) {
      track.syncedLyrics = synced;
      track.lyrics = synced.map(l => l.text).join('\n');
    } else {
      track.syncedLyrics = null;
      track.lyrics = cleanLyricText(plainRaw);
    }
    track.lyricsSource = 'Online lyrics';
    track.lyricsFetchedAt = Date.now();
    track.lyricsLookupFailed = false;
    await saveTrack(track);
    notifyLyrics(track);
    return true;
  } catch {
    track.lyricsLookupFailed = true;
    await saveTrack(track).catch?.(() => {});
    try { await saveTrack(track); } catch { /* public tracks skip */ }
    return false;
  }
}

/* ------------------------ import orchestration -------------------------- */
export async function importFiles(fileList, { onProgress } = {}) {
  const files = [...fileList].filter(f => /\.(mp3|m4a|wav|aac|flac|ogg|opus)$/i.test(f.name) || (f.type || '').startsWith('audio/'));
  const imported = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (onProgress) onProgress(i, files.length, file.name);
    try {
      const existingId = `${file.name}-${file.size}-${file.lastModified}`;
      const existing = state.tracks.find(t => t.id === existingId);
      const meta = await extractMetadata(file);
      let track;
      if (existing) {
        // Re-import heals identity without losing play counts or edits.
        track = { ...existing, ...meta, id: existing.id, playCount: existing.playCount, lastPlayedAt: existing.lastPlayedAt, loved: existing.loved };
        if (existing.metaSource === 'manual' && !meta.artworkBytes) { track.title = existing.title; track.artist = existing.artist; }
      } else {
        track = normalizeTrack(meta);
      }
      delete track.bytes; // do not persist the raw buffer twice
      state.tracks = [track, ...state.tracks.filter(t => t.id !== track.id)];
      await saveTrack(track);
      imported.push(track);
      // Cover + lyrics are matched in the background per track.
      lookupArtwork(track).then(() => lookupLyrics(track));
    } catch { /* skip unreadable files */ }
  }
  return imported;
}

/* --------------------- shared library (server + cloud) ------------------ */
const CLOUD_BUILTIN = {
  supabaseUrl: 'https://nqyfpdkvsxekqhysmkgr.supabase.co/rest/v1',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5xeWZwZGt2c3hla3FoeXNta2dyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2ODcwNzYsImV4cCI6MjEwNDI2MzA3Nn0.I9FpIy2gvS_sXT2nX1vd1iQiPmy-MBw9mwPJcJaf--8',
};
function cloudConfig() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CLOUD_CFG_KEY) || 'null'); } catch { saved = null; }
  if (saved && saved.supabaseUrl && saved.supabaseKey) return saved;
  return { ...CLOUD_BUILTIN };
}
export function cloudConfigured() { const c = cloudConfig(); return Boolean(c && c.supabaseUrl && c.supabaseKey); }
function cloudBase() {
  return ((cloudConfig() || {}).supabaseUrl || '').replace(/\/(rest|storage|auth|realtime)\/v1\/?$/, '');
}
function cloudHeaders(json) {
  const cfg = cloudConfig() || {};
  const h = { Authorization: `Bearer ${cfg.supabaseKey}` };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}
function cloudTrackFromDoc(d) {
  return normalizeTrack({
    id: d.id || uid('ctrack'), isPublic: true, publicUrl: d.url || '', url: d.url || '',
    name: d.name || `${d.title || 'track'}.audio`,
    title: d.title || '', artist: d.artist || '', albumArtist: d.albumArtist || d.artist || '',
    album: d.album || '', genre: d.genre || '', year: Number(d.year) || 0,
    duration: Number(d.duration) || 0, size: Number(d.size) || 0,
    mimeType: d.mimeType || '', addedAt: Number(d.uploadedAt) || Date.now(),
    uploadedAt: Number(d.uploadedAt) || 0, cloud: true,
  });
}
async function cloudReadManifest() {
  const res = await fetch(`${cloudBase()}/storage/v1/object/public/songs/library.json?t=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return [];
  if (!res.ok) {
    let missing = false;
    try { const body = await res.json(); missing = body && (body.code === 'NoSuchKey' || body.statusCode === '404' || body.statusCode === 404); } catch { /* not json */ }
    if (missing) return [];
    throw new Error(`Supabase read failed (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}
async function cloudWriteManifest(list) {
  const res = await fetch(`${cloudBase()}/storage/v1/object/songs/library.json`, {
    method: 'POST',
    headers: { ...cloudHeaders(true), 'x-upsert': 'true' },
    body: JSON.stringify(list),
  });
  if (!res.ok) throw new Error(`Supabase write failed (${res.status})`);
}
export async function cloudListTracks() {
  try {
    const docs = await cloudReadManifest();
    return docs.map(cloudTrackFromDoc).sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
  } catch { return null; }
}
const CLOUD_MAX_UPLOAD = 49 * 1024 * 1024;
export async function cloudUploadTrack(file, meta, onStatus) {
  if (!cloudConfigured()) throw new Error('Cloud sync is not configured.');
  if (file.size > CLOUD_MAX_UPLOAD) throw new Error('The free cloud plan allows up to 50 MB per song.');
  const id = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ext = (file.name.match(/\.([a-z0-9]+)$/i) || [0, 'mp3'])[1].toLowerCase();
  const storagePath = `songs/${id}.${ext}`;
  if (onStatus) onStatus('Uploading audio…');
  const res = await fetch(`${cloudBase()}/storage/v1/object/${storagePath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cloudConfig().supabaseKey}`, 'Content-Type': file.type || 'audio/mpeg', 'x-upsert': 'true' },
    body: file,
  });
  if (!res.ok) throw new Error(`Supabase upload failed (${res.status})`);
  const url = `${cloudBase()}/storage/v1/object/public/${storagePath}`;
  if (onStatus) onStatus('Publishing to the shared library…');
  const doc = { id, ...meta, url, storagePath, uploadedAt: Date.now(), size: file.size, mimeType: file.type || 'audio/mpeg' };
  const list = await cloudReadManifest().catch(() => []);
  list.unshift(doc);
  await cloudWriteManifest(list);
  return cloudTrackFromDoc(doc);
}

async function hydratePublicArtwork() {
  const cache = await dbGetAll(DB_ARTWORK_CACHE).catch(() => []);
  const byId = new Map(cache.map(c => [c.id, c]));
  state.publicTracks.forEach(t => {
    const c = byId.get(t.id);
    if (c && c.artworkBytes && c.artworkBytes.length) {
      t.artworkBytes = new Uint8Array(c.artworkBytes);
      t.artworkType = c.artworkType || 'image/jpeg';
      t.artworkSource = 'Online artwork';
    }
  });
}

/* Probe the local Node server. This is awaited during boot so the artwork
   pipeline always knows whether a proxy exists before it starts looking
   anything up - previously lookups raced ahead of server detection and failed
   permanently on mobile. */
export async function probeLocalServer(timeout = 3000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(`/api/health?t=${Date.now()}`, { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    state.localServerAvailable = res.ok;
  } catch { state.localServerAvailable = false; }
  state.serverAvailable = state.localServerAvailable || state.cloudAvailable;
  if (state.localServerAvailable) flushNeedsProxy();
  return state.localServerAvailable;
}

export async function loadPublicTracks() {
  // Cloud first: the shared library works with the PC off, from any network.
  if (cloudConfigured()) {
    try {
      const cloudTracks = await cloudListTracks();
      if (cloudTracks) {
        state.publicTracks = cloudTracks;
        state.cloudAvailable = true;
        await hydratePublicArtwork();
        state.serverAvailable = state.localServerAvailable || state.cloudAvailable;
        flushNeedsProxy();
        return state.publicTracks;
      }
    } catch { state.cloudAvailable = false; }
  }
  // Local Node server as the secondary source.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch('/api/public-tracks', { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) {
      const tracks = await response.json();
      state.publicTracks = Array.isArray(tracks) ? tracks.map(normalizeTrack) : [];
      state.localServerAvailable = true;
      await hydratePublicArtwork();
    } else {
      state.localServerAvailable = false;
    }
  } catch { state.localServerAvailable = false; }
  state.serverAvailable = state.localServerAvailable || state.cloudAvailable;
  flushNeedsProxy();
  return state.publicTracks;
}

/* Upload a local track to the shared library: cloud first, then the server. */
export async function shareTrack(track, { onStatus } = {}) {
  if (!track?.blob) throw new Error('This track has no local audio to share.');
  const meta = {
    name: track.name, title: track.title, artist: track.artist, albumArtist: track.albumArtist,
    album: track.album, genre: track.genre, year: track.year, composer: track.composer,
    trackNumber: track.trackNumber, discNumber: track.discNumber, bpm: track.bpm, duration: track.duration,
  };
  let uploaded = null;
  if (cloudConfigured()) {
    try { uploaded = await cloudUploadTrack(track.blob, meta, onStatus); }
    catch (cloudErr) {
      if (String(cloudErr.message || '').includes('50 MB')) throw cloudErr;
      if (onStatus) onStatus('Cloud upload failed — trying the local server');
    }
  }
  if (!uploaded) {
    const form = new FormData();
    form.append('audio', track.blob, track.name || 'audio.mp3');
    form.append('metadata', JSON.stringify(meta));
    let token = '';
    try { token = localStorage.getItem('wavefy-upload-token') || ''; } catch { /* optional */ }
    const headers = token ? { 'X-Upload-Token': token } : {};
    const response = await fetch('/api/upload', { method: 'POST', headers, body: form });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Upload failed (${response.status})`);
    uploaded = normalizeTrack(result);
  }
  state.publicTracks = [uploaded, ...state.publicTracks.filter(t => t.id !== uploaded.id)];
  return uploaded;
}

/* --------------------------- playback engine ---------------------------- */
const audio = new Audio();
audio.preload = 'metadata';

const playbackListeners = { time: new Set(), state: new Set(), track: new Set(), lyric: new Set() };
export function onPlayback(kind, fn) { playbackListeners[kind]?.add(fn); return () => playbackListeners[kind]?.delete(fn); }
function emit(kind, payload) { playbackListeners[kind]?.forEach(fn => { try { fn(payload); } catch { /* ignore */ } }); }

export const playback = {
  get current() { return currentTrack; },
  get playing() { return !audio.paused; },
  get elapsed() { return audio.currentTime || 0; },
  get duration() { return Number.isFinite(audio.duration) ? audio.duration : (currentTrack?.duration || 0); },
  play, pause, toggle: () => (audio.paused ? play() : pause()),
  seek(seconds) { if (Number.isFinite(seconds)) audio.currentTime = seconds; },
};

let queue = [];
let queueIndex = -1;
let currentTrack = null;
let shuffleOn = false;
let repeatOn = false;

export function setQueue(tracks, index = 0) {
  queue = tracks.slice();
  queueIndex = index;
  return playAt(index);
}
export function playTrack(track) { return setQueue(allTracks().filter(t => t.id), Math.max(0, allTracks().findIndex(t => t.id === track.id))); }
export function getQueue() { return queue.slice(); }
export function getQueueIndex() { return queueIndex; }
export function setShuffle(on) { shuffleOn = Boolean(on); }
export function setRepeat(on) { repeatOn = Boolean(on); }

export async function playAt(index) {
  if (index < 0 || index >= queue.length) return null;
  queueIndex = index;
  const track = queue[index];
  if (!track) return null;
  currentTrack = track;
  const url = trackUrl(track);
  if (!url) { emit('state', { playing: false, error: 'This track has no playable audio yet' }); return track; }
  audio.src = url;
  const attempt = audio.play();
  if (attempt) await attempt.catch(() => { /* autoplay guard — user will press play */ });
  emit('track', track);
  emit('state', { playing: !audio.paused });
  track.playCount = (track.playCount || 0) + 1;
  track.lastPlayedAt = Date.now();
  saveTrack(track).catch(() => {});
  if (!hasArtwork(track) && track.artworkLookupFailed !== true) lookupArtwork(track).then(() => lookupLyrics(track));
  else if (!track.lyrics && !track.lyricsLookupFailed) lookupLyrics(track);
  return track;
}
export function playNext() { return playAt(shuffleOn ? Math.floor(Math.random() * queue.length) : queueIndex + 1); }
export function playPrev() { return playAt(queueIndex - 1 < 0 ? queue.length - 1 : queueIndex - 1); }

export function play(track) {
  if (!audio.src) return;
  audio.play().catch(() => {});
}
export function pause() { audio.pause(); }

audio.addEventListener('timeupdate', () => emit('time', { elapsed: audio.currentTime, duration: audio.duration || 0 }));
audio.addEventListener('durationchange', () => emit('time', { elapsed: audio.currentTime, duration: audio.duration || 0 }));
audio.addEventListener('play', () => emit('state', { playing: true }));
audio.addEventListener('pause', () => emit('state', { playing: false }));
audio.addEventListener('ended', () => { if (repeatOn) { audio.currentTime = 0; audio.play().catch(() => {}); } else playNext(); });
audio.addEventListener('error', () => emit('state', { playing: false, error: 'This track could not be played' }));

/* Restore last session's library on boot. */
export async function boot() {
  await initStore();
  // Resolve the transport situation BEFORE any artwork lookup is queued.
  await probeLocalServer();
  state.tracks = await loadLocalTracks();
  await loadPublicTracks();
  return {
    local: state.tracks,
    public: state.publicTracks,
    serverAvailable: state.serverAvailable,
    artworkProxy: state.localServerAvailable || state.cloudAvailable,
  };
}
