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
/* Backoff for a cover that was not found. A throttled source is handled
   separately (see scheduleCoverRetry) and never consumes one of these. */
const COVER_BACKOFF_MS = [60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3];
const COVER_MAX_ATTEMPTS = 6;

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
/* Some tags glue several artists together with no separator at all
   ("GorillazAsha PuthliBobby Womack…"). There is nothing to split on, and the
   glued string matches no catalogue entry — so a case boundary is used, but only
   when the string is long enough that it cannot be one name and has no other
   separator to prefer. */
function splitGluedArtists(value) {
  const v = String(value || '');
  if (v.length < 16 || /[;/,&|]|\s(?:feat|ft|featuring|with)\s/i.test(v)) return [v];
  const parts = [];
  let start = 0;
  for (let i = 1; i < v.length; i += 1) {
    if (/[a-z0-9]/.test(v[i - 1]) && /[A-Z]/.test(v[i])) { parts.push(v.slice(start, i)); start = i; }
  }
  parts.push(v.slice(start));
  const first = parts[0].trim();
  return parts.length > 1 && first.length >= 3 ? parts : [v];
}
export function primaryArtist(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  const glued = splitGluedArtists(v);
  const parts = glued.length > 1
    ? glued
    : v.split(/\s*[;/,&]\s*|\s+(?:feat\.?|ft\.?|featuring|with)\s+/i);
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
    /* A trailing group that names the *edition* rather than the song. A catalogue
       indexes "Purple Rain", not "Purple Rain (2015 Paisley Park Remaster)", so
       keeping it on the query returns nothing at all — and it then fails the
       title comparison against a candidate that is in fact exactly right. Only
       applied to a trailing group, so "(I Can't Get No) Satisfaction" survives. */
    .replace(/\s*[([][^)\]]*(?:\b(?:remaster|remastered|re-?recorded|version|edit|mix|remix|deluxe|reissue|mono|stereo|slowed|sped\s*up|explicit|clean|bonus|anniversary|live|acoustic|unplugged|demo|instrumental|karaoke|extended|radio|album|single|feat|ft|with)\b|\b(?:19|20)\d{2}\b)[^)\]]*[)\]]\s*$/ig, '')
    .trim();
}

/* ------------------ compilations wearing an album tag --------------------
   A folder rip ("90s Hits", "Now 42", "100 Top Songs") tags every one of its
   files with the compilation as the *album*. Sent to a catalogue that name is
   a real release — and it is the release that answers for every track in the
   folder, so a whole shelf ends up wearing one identical sleeve. Worse, an
   exact album match then earned the highest score, so the compilation beat the
   artist's own album every time.

   So: a compilation tag is never sent as an album, and a candidate whose album
   *is* that compilation is downgraded, never preferred. Which tags are
   compilations is decided twice over — by name, and from the library itself,
   since an album several unrelated artists contributed to is one no matter
   what it calls itself. */
const COMPILATION_PATTERNS = [
  /\b(?:hits?|top\s*\d+|top\s*songs?|charts?|greatest|best\s*of|essential|anthology|compilation|playlist|mixtape|various|va)\b/i,
  /\bnow\s*(?:that'?s|\d)/i,
  /\b\d{2,4}s\b/i,
];
/* An album credited to one of these is a compilation record by definition. */
const COMPILATION_ARTISTS = new Set(['various artists', 'various', 'va', 'v.a.', 'unknown', 'unknown artist', 'soundtrack', 'original soundtrack', 'ost']);
let compilationNames = new Set();

export function looksLikeCompilation(name) {
  const raw = String(name || '').trim();
  if (!raw) return false;
  return COMPILATION_PATTERNS.some(re => re.test(raw));
}

export function isCompilationAlbum(name) {
  const key = normCompare(name);
  if (!key) return false;
  return compilationNames.has(key) || looksLikeCompilation(name);
}

/* Rebuild the set from the library. Called whenever the track list changes;
   cheap enough to redo (one pass) and it must not go stale after an import. */
export function registerCompilationAlbums(tracks) {
  const byAlbum = new Map();
  (tracks || []).forEach(t => {
    const album = String((t && t.album) || '').trim();
    if (!album) return;
    const key = normCompare(album);
    if (!key) return;
    const info = byAlbum.get(key) || { name: album, artists: new Set(), count: 0 };
    const artist = String((t && t.artist) || '').trim();
    if (artist && !isJunkArtist(artist)) info.artists.add(normCompare(primaryArtist(artist)));
    info.count += 1;
    byAlbum.set(key, info);
  });
  const next = new Set();
  byAlbum.forEach((info, key) => {
    /* Four unrelated artists on one "album" is a compilation; a collaboration
       record with a couple of guests is not. */
    if (info.artists.size >= 4) next.add(key);
    if (info.artists.size >= 2 && looksLikeCompilation(info.name)) next.add(key);
    if (looksLikeCompilation(info.name)) next.add(key);
  });
  compilationNames = next;
  return compilationNames;
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
function dbGet(name, key) { return new Promise((res, rej) => { const r = store(name).get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); }); }
function dbPut(name, value) { return new Promise((res, rej) => { const r = store(name, 'readwrite').put(value); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
function dbDelete(name, key) { return new Promise((res, rej) => { const r = store(name, 'readwrite').delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }

export async function initStore() {
  db = await openDB();
}
/* A one-time reset of the old failure flags. The pipeline used to reject a
   perfectly good candidate — an artist credit that continues past the name we
   know ("Prince" vs "Prince & The Revolution") — and then lock that track out
   for minutes, and the flag is *persisted with the local track*. A device that
   had already run the old code would therefore keep showing those covers as
   missing long after the fix shipped. Bumping this version gives every such
   track one fresh attempt. */
const ARTWORK_PIPELINE_KEY = 'wavefy-artwork-pipeline';
const ARTWORK_PIPELINE_VERSION = '4';
function resetStaleArtworkFailures(tracks) {
  let seen = '';
  try { seen = localStorage.getItem(ARTWORK_PIPELINE_KEY) || ''; } catch { /* private mode */ }
  if (seen === ARTWORK_PIPELINE_VERSION) return;
  /* Everything a previous pipeline decided about a track's cover is now stale:
     the old build could reject a perfectly good match and then lock the track
     out, and any backoff it left behind would delay the new sources. Give every
     coverless track one clean start. */
  tracks.filter(t => !hasCover(t)).forEach(t => {
    t.artworkLookupFailed = false;
    t.artworkFetchedAt = 0;
    t.coverAttempts = 0;
    t.coverNextAt = 0;
    t.coverReason = '';
    dbPut(DB_TRACKS, t).catch(() => {});
  });
  try { localStorage.setItem(ARTWORK_PIPELINE_KEY, ARTWORK_PIPELINE_VERSION); } catch { /* ignore */ }
}

/* ----------- covers resolved before compilations were understood -----------
   The matcher fix alone cannot repair an existing library. A cover found by the
   old rules is already stored — on the device *and* in the shared cover file —
   and `hasCover()` counts it as finished, so nothing would ever look at that
   track again. Every file from a folder rip therefore keeps the folder's sleeve
   forever.

   So those covers are forgotten once per device, which puts the tracks back in
   the queue to be resolved individually, and their entries in the shared file
   are deleted rather than overwritten — an entry that is simply wrong must not
   be inherited by the next device that installs. Burnt ids are remembered so a
   stale address cannot come back through the shared file on the boot after
   this one. */
const COVER_RULES_KEY = 'wavefy.coverRules';
const COVER_RULES_VERSION = 'compilation-v1';
const COVER_PURGED_KEY = 'wavefy.coverPurgedIds';
const coverRemovals = new Set();

function purgedCoverIds() {
  try {
    const raw = localStorage.getItem(COVER_PURGED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list : []);
  } catch { return new Set(); }
}

function purgeCompilationCovers(tracks) {
  let seen = '';
  try { seen = localStorage.getItem(COVER_RULES_KEY) || ''; } catch { /* private mode */ }
  if (seen === COVER_RULES_VERSION) return 0;
  const purged = purgedCoverIds();
  const affected = [];
  (tracks || []).forEach(t => {
    if (!t || !t.id || !isCompilationAlbum(t.album)) return;
    if (!hasCover(t) && !state.artworkBlobs.has(t.id)) return;
    const url = state.artworkUrls.get(t.id);
    if (url) { retireArtworkUrl(url); state.artworkUrls.delete(t.id); }
    state.artworkBlobs.delete(t.id);
    t.artworkRemoteUrl = '';
    t.artworkBytes = null;
    t.artworkFetchedAt = 0;
    // A clean start, not a retry: the old backoff was earned by a pipeline
    // that was asking the wrong question about this track.
    t.coverAttempts = 0;
    t.coverNextAt = 0;
    t.coverReason = '';
    t.coverLookupFailed = false;
    clearCoverRetry(t);
    purged.add(t.id);
    coverRemovals.add(t.id);
    if (isPublicTrack(t)) {
      dbPut(DB_ARTWORK_CACHE, { id: t.id, artworkRemoteUrl: '', artworkBytes: null, coverAttempts: 0, coverNextAt: 0, coverReason: '' }).catch(() => {});
    } else {
      dbPut(DB_TRACKS, t).catch(() => {});
    }
    affected.push(t);
  });
  writePurgedCoverIds(purged);
  try { localStorage.setItem(COVER_RULES_KEY, COVER_RULES_VERSION); } catch { /* ignore */ }
  if (affected.length) {
    queueArtworkLookups(affected);
    scheduleCoverPublish();
  }
  return affected.length;
}

function writePurgedCoverIds(set) {
  try { localStorage.setItem(COVER_PURGED_KEY, JSON.stringify([...set].slice(-800))); } catch { /* ignore */ }
}

export async function loadLocalTracks() {
  const rows = await dbGetAll(DB_TRACKS);
  const tracks = rows.map(normalizeTrack);
  resetStaleArtworkFailures(tracks);
  return tracks;
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
    /* The real https URL the cover was downloaded from. iOS will not render a
       blob: URL on the lock screen — Media Session needs an address the system
       can fetch for itself — so the address is kept alongside the bytes. */
    artworkRemoteUrl: track.artworkRemoteUrl || '',
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

/* The build id is shown in the Library menu and written to localStorage under
   BUILD_KEY, so the diagnostics page can report which build a device is
   actually running — an installed app can happily serve a stale shell. */
export const BUILD = 'wavefy-cover-pipeline-5';
export const BUILD_KEY = 'wavefy-build';

export const state = {
  artworkUrls: new Map(),
  artworkBlobs: new Map(),
  artworkUrlLookups: new Set(), // track ids currently resolving a remote cover URL
  objectUrls: new Map(),
  /* Whether the Supabase shared library answered. There is no other transport:
     every cover, lyric and artist photo now comes straight from the browser. */
  cloudAvailable: false,
  tracks: [],       // local imported tracks
  publicTracks: [], // shared library
};

function rememberBuild() {
  try { localStorage.setItem(BUILD_KEY, BUILD); } catch { /* private mode */ }
}

export function getState() { return state; }
export function allTracks() { return [...state.tracks, ...state.publicTracks]; }
export function getTrack(id) { return allTracks().find(t => t.id === id); }

/* ----------------------------- playlists --------------------------------
   User playlists are names plus track ids. They live in localStorage rather
   than IndexedDB: they are tiny, they must be readable synchronously while the
   library renders, and losing them is not losing audio. Track ids are resolved
   against the live library on read, so a playlist survives a rename, a
   re-import or a track that no longer exists (it is simply skipped). */
const PLAYLIST_KEY = 'wavefy.playlists';
const PLAYLIST_MAX_TRACKS = 500;
let playlists = null;

function readPlaylists() {
  if (playlists) return playlists;
  playlists = [];
  try {
    const raw = JSON.parse(localStorage.getItem(PLAYLIST_KEY) || '[]');
    if (Array.isArray(raw)) {
      playlists = raw
        .filter(p => p && typeof p.name === 'string')
        .map(p => ({
          id: p.id || uid('pl'),
          name: p.name.slice(0, 60),
          trackIds: Array.isArray(p.trackIds) ? p.trackIds.filter(x => typeof x === 'string').slice(0, PLAYLIST_MAX_TRACKS) : [],
          createdAt: Number(p.createdAt) || Date.now(),
        }));
    }
  } catch {
    // Private mode, or a corrupted value: start clean rather than break boot.
    playlists = [];
  }
  return playlists;
}

function writePlaylists() {
  try { localStorage.setItem(PLAYLIST_KEY, JSON.stringify(playlists || [])); } catch { /* ignore */ }
}

export function getPlaylists() {
  return readPlaylists().map(p => ({ ...p, trackIds: p.trackIds.slice() }));
}

export function getPlaylist(id) {
  const found = readPlaylists().find(p => p.id === id);
  return found ? { ...found, trackIds: found.trackIds.slice() } : null;
}

/* The playlist's tracks, in order, with anything missing from the library
   silently dropped — so callers can always just queue what comes back. */
export function playlistTracks(id) {
  const list = readPlaylists().find(p => p.id === id);
  if (!list) return [];
  const byId = new Map(allTracks().map(t => [t.id, t]));
  return list.trackIds.map(trackId => byId.get(trackId)).filter(Boolean);
}

export function createPlaylist(name, trackIds = []) {
  const clean = String(name || '').trim().slice(0, 60) || 'New playlist';
  const list = readPlaylists();
  // Reuse an existing playlist with the same name instead of duplicating it.
  const existing = list.find(p => p.name.toLowerCase() === clean.toLowerCase());
  const target = existing || { id: uid('pl'), name: clean, trackIds: [], createdAt: Date.now() };
  if (!existing) list.unshift(target);
  trackIds.filter(id => typeof id === 'string' && !target.trackIds.includes(id))
    .slice(0, PLAYLIST_MAX_TRACKS - target.trackIds.length)
    .forEach(id => target.trackIds.push(id));
  writePlaylists();
  return { ...target, trackIds: target.trackIds.slice() };
}

export function renamePlaylist(id, name) {
  const list = readPlaylists();
  const target = list.find(p => p.id === id);
  if (!target) return null;
  target.name = String(name || '').trim().slice(0, 60) || target.name;
  writePlaylists();
  return { ...target, trackIds: target.trackIds.slice() };
}

export function deletePlaylist(id) {
  const list = readPlaylists();
  const index = list.findIndex(p => p.id === id);
  if (index < 0) return false;
  list.splice(index, 1);
  writePlaylists();
  return true;
}

export function addToPlaylist(id, trackId) {
  const target = readPlaylists().find(p => p.id === id);
  if (!target || !trackId) return 0;
  if (!target.trackIds.includes(trackId) && target.trackIds.length < PLAYLIST_MAX_TRACKS) {
    target.trackIds.push(trackId);
    writePlaylists();
  }
  return target.trackIds.length;
}

export function removeFromPlaylist(id, trackId) {
  const target = readPlaylists().find(p => p.id === id);
  if (!target) return 0;
  target.trackIds = target.trackIds.filter(x => x !== trackId);
  writePlaylists();
  return target.trackIds.length;
}

export function hasArtwork(track) { return Boolean(track && track.artworkBytes && track.artworkBytes.length); }
/* A track "has a cover" if we can paint one, which is not the same as having
   the bytes. An <img src="https://…"> is not subject to CORS, so an address
   always paints; only downloading the bytes needs a permission the browser (or
   the CDN) can refuse. Anything that decides whether to look a cover up again
   must ask this question, not hasArtwork — otherwise a track whose address we
   know but whose bytes never arrived is retried forever or, worse, shown blank. */
export function hasCover(track) {
  if (!track) return false;
  if (hasArtwork(track)) return true;
  if (/^https?:\/\//i.test(track.artworkMirrorUrl || '')) return true;
  return /^https?:\/\//i.test(track.artworkRemoteUrl || '');
}
export function artworkUrl(track) {
  if (!track) return null;
  // If we have blob bytes, use them (preferred).
  if (hasArtwork(track)) {
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
  /* Our own copy beats the catalogue's URL. Measured on the real library: 141 of
     186 covers resolved to coverartarchive.org, and that URL 307-redirects to
     archive.org — a host a phone on a mobile network frequently cannot reach,
     and one that costs two extra round trips when it can. A mirrored copy lives
     on the same origin the audio already streams from, so it always paints. */
  if (track.artworkMirrorUrl && /^https?:\/\//i.test(track.artworkMirrorUrl)) {
    return track.artworkMirrorUrl;
  }
  // Fallback: use the remote URL directly (no blob download needed).
  // This is critical for cloud tracks on mobile where the blob fetch may fail.
  if (track.artworkRemoteUrl && /^https?:\/\//i.test(track.artworkRemoteUrl)) {
    return track.artworkRemoteUrl;
  }
  return null;
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
  /* Compare on the primary artist only, through the same normalisation on both
     sides: a catalogue credit is often longer than ours ("Prince & The
     Revolution" for "Prince") and a tag is sometimes several names glued
     together, and neither should cost the track its cover. */
  const artistCore = primaryArtist(artist);
  const nArtist = (isJunkArtist(artist) || !artistCore) ? '' : normCompare(artistCore);
  const nAlbum = normCompare(album);
  /* The catalogue's own title carries feature credits and edition notes that
     ours does not ("Waterfalls (feat. Sam Harper & Bobby Harvey)"), which made
     an exact title look like a poor match and cost the track its cover. Both
     sides are cleaned the same way, so the comparison is like for like. */
  const t = normCompare(cleanTitleString(item.trackName || item.name || ''));
  /* Keep the RAW names around: primaryArtist() splits on "&", "feat." and
     friends, and normalising first deletes exactly those separators — which is
     how "Prince" stopped matching "Prince & The Revolution" and a whole
     shelf of normal-looking albums got no cover. */
  const aRaw = String(item.artistName || item.artist || '');
  const a = normCompare(aRaw);
  const al = normCompare(item.collectionName || item.album || '');
  const titleSim = (nTitle && t) ? tokenOverlap(nameTokens(t), nameTokens(title)) : 0;
  const titleExact = Boolean(nTitle && t === nTitle);
  const albumExact = Boolean(nAlbum && al === nAlbum);
  const albumSim = (nAlbum && al) ? tokenOverlap(nameTokens(al), nameTokens(album)) : 0;
  /* Our album tag is a compilation (a folder rip). Two things follow: the
     candidate that *is* that compilation is wearing the shared sleeve every
     track in the folder has, and a Various Artists credit is the same trap
     under a different name. Both are demoted below any candidate from the
     artist's own record. */
  const compilation = isCompilationAlbum(album);
  const candidateCredit = String(item.collectionArtistName || item.albumArtist || '').trim().toLowerCase();
  const candidateVA = COMPILATION_ARTISTS.has(candidateCredit);
  const sameCompilation = Boolean(compilation && nAlbum && al === nAlbum);
  const artistOk = Boolean(nArtist && (a === nArtist || normCompare(primaryArtist(aRaw)) === normCompare(primaryArtist(artist))));
  /* "The Beatles" for "The Beatles & ...", "Prince" for "Prince & The
     Revolution": a catalogue credit often continues past the artist we know, so
     an exact prefix counts as a match — but a weaker one than an exact name. */
  const artistLeads = Boolean(nArtist && a.startsWith(`${nArtist} `));
  let score = 0;
  let pass = true;
  if (titleExact) score += 6;
  else if (titleSim >= 0.8) score += 3;
  else if (titleSim >= 0.5) score += 1;
  if (nArtist) {
    const artistSim = tokenOverlap(nameTokens(a), nameTokens(artist));
    if (artistOk) { score += 4; }
    else if (artistSim >= 0.7 || artistLeads) { score += 2; }
    else { pass = false; }
  } else if (!(titleExact || titleSim >= 0.8)) {
    pass = false;
  }
  if (!(titleExact || titleSim >= 0.5) && !(albumExact && artistOk)) pass = false;
  if (!compilation || !sameCompilation) {
    if (albumExact) score += 3;
    else if (albumSim >= 0.7) score += 2;
  }
  if (compilation) {
    /* Not an outright refusal: a track that genuinely only exists on
       compilations should still get *something*, it just must never beat the
       artist's own album. */
    if (sameCompilation) score -= 6;
    if (candidateVA) score -= 3;
  }
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

/* ------------------------- Deezer (no server needed) --------------------
   Deezer is the one keyless catalogue that carries both real artist photos and
   high-resolution album covers. Two things make it the server-free path:

     * it sends no Access-Control-Allow-Origin header, so a plain cross-origin
       fetch() is refused — but it speaks JSONP, and a <script> tag is not
       subject to CORS at all;
     * Apple answers a phone's User-Agent with a 301 into a `musics://` deep
       link that fetch() cannot follow, which is why covers silently stopped
       working on mobile the moment the local server was not there.

   So this runs entirely in the browser, with no proxy, no key and no server. */
const DEEZER_API = 'https://api.deezer.com';
let jsonpSeq = 0;
function jsonp(url, timeout = 3500) {
  return new Promise((resolve, reject) => {
    const callback = `__wavefyJsonp${++jsonpSeq}`;
    const script = document.createElement('script');
    let settled = false;
    const finish = fn => value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { delete window[callback]; } catch { window[callback] = undefined; }
      script.remove();
      fn(value);
    };
    const timer = setTimeout(finish(() => reject(new Error('JSONP timed out'))), timeout);
    window[callback] = finish(resolve);
    script.onerror = finish(() => reject(new Error('JSONP request failed')));
    /* A JSONP reply calls back DURING the script's own execution, so `onload`
       firing with our callback still un-run means the response was not valid
       JSONP at all — a 403, a captcha, an HTML error page. Without this the
       promise waited out the entire timeout; with it a blocked network fails in
       milliseconds and the next source is tried immediately. */
    script.onload = () => finish(() => reject(new Error('JSONP returned no callback')))();
    script.src = `${url}${url.includes('?') ? '&' : '?'}output=jsonp&callback=${callback}`;
    document.head.appendChild(script);
  });
}

/* Clean compound artist names for search: "Drake; Future; Molly Santana" → "Drake".
   This prevents Deezer from returning no results for featured-credit strings. */
function cleanSearchArtist(artist) {
  if (!artist) return '';
  // primaryArtist already knows about feature credits, separators and glued
  // multi-artist tags, so the query gets the same answer the matcher does.
  return primaryArtist(artist) || String(artist).trim();
}

/* Candidates are shaped like the iTunes ones, so the existing matcher scores
   every source with the same rules. */
function deezerTrackCandidate(item) {
  const album = (item && item.album) || {};
  const cover = album.cover_xl || album.cover_big || album.cover_medium || '';
  if (!cover) return null;
  return {
    trackName: item.title,
    artistName: (item.artist && item.artist.name) || '',
    collectionName: album.title || '',
    // the CDN path encodes the size, so 1000px can be asked for at 600
    artworkUrl100: String(cover).replace('1000x1000', '600x600'),
  };
}
async function fetchDeezerCandidates(term, entity) {
  const params = new URLSearchParams({ q: term, limit: entity === 'artist' ? '12' : '25' });
  const path = entity === 'artist' ? '/search/artist' : '/search';
  const data = await jsonp(`${DEEZER_API}${path}?${params.toString()}`);
  const items = data && Array.isArray(data.data) ? data.data : [];
  if (entity === 'artist') {
    return items
      .filter(item => item && item.name && (item.picture_big || item.picture_xl))
      .map(item => ({ name: item.name, image: item.picture_big || item.picture_xl, fans: item.nb_fan || 0 }));
  }
  return items.map(deezerTrackCandidate).filter(Boolean);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function nonEmpty(list) { return Array.isArray(list) && list.length ? list : null; }

/* --------------------- Cover Art Archive (keyless, CORS) -----------------
   MusicBrainz finds the release, Cover Art Archive serves its sleeve. Both send
   Access-Control-Allow-Origin: * and need no key or account, which is what makes
   them usable from an installed app with no server behind it. MusicBrainz asks
   for at most one request per second, so calls are paced here rather than in
   every caller. */
const MUSICBRAINZ_API = 'https://musicbrainz.org/ws/2';
const COVERART_API = 'https://coverartarchive.org';
const MB_MIN_GAP_MS = 1100;
let mbNextAt = 0;
/* What the last candidate pass heard back: how many sources errored versus how
   many actually replied. The difference is the difference between "no cover
   exists" and "the network is having a bad minute". */
let lastFetchOutcome = { errors: 0, answered: 0 };

async function mbFetchJson(url, attempt = 0) {
  const wait = Math.max(0, mbNextAt - Date.now());
  if (wait) await sleep(wait);
  mbNextAt = Date.now() + MB_MIN_GAP_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    /* MusicBrainz sheds load with a 503 that clears within seconds — measured:
       the same query answered 503, then 200 a few seconds later. So it is worth
       a short retry here rather than reporting the track as unfindable. */
    if (response.status === 503 || response.status === 429) {
      if (attempt < 2) {
        await sleep(attempt === 0 ? 900 : 2200);
        return mbFetchJson(url, attempt + 1);
      }
      const err = new Error('MusicBrainz is busy');
      err.code = 'SOURCE_BUSY';
      throw err;
    }
    if (!response.ok) throw new Error(`MusicBrainz ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

/* Candidates are shaped like the iTunes ones so the single matcher scores every
   source with the same rules.

   The image address is asked for, never assumed. `/release/<id>/front-500` looks
   right and redirects correctly *when the release has a front cover* — but plenty
   of releases simply do not, and that URL then answers 404 with an HTML body. A
   guessed address like that is worse than no cover: it paints a broken tile, and
   now that addresses are shared it would hand the same dead link to every other
   device. So the release's cover art is looked up and the real image URL (its
   500px thumbnail when offered) is used; a release with no art is skipped in
   favour of the next candidate. Results are memoised per release, because the
   same release usually backs several tracks. */
const coverArtByRelease = new Map();

async function coverArtImageFor(releaseId) {
  if (!releaseId) return '';
  if (coverArtByRelease.has(releaseId)) return coverArtByRelease.get(releaseId);
  let url = '';
  try {
    const data = await fetchJson(`${COVERART_API}/release/${releaseId}`);
    const images = Array.isArray(data && data.images) ? data.images : [];
    const front = images.find(i => i && i.front && i.image) || images.find(i => i && i.image);
    if (front) {
      const thumbs = front.thumbnails || {};
      url = thumbs['500'] || thumbs.large || front.image;
    }
  } catch { url = ''; }
  coverArtByRelease.set(releaseId, url);
  return url;
}
async function fetchCoverArtArchiveCandidates(title, artist, album) {
  const clean = value => String(value || '').replace(/["\\]/g, ' ').trim();
  const query = [`recording:"${clean(title)}"`, artist ? `AND artist:"${clean(artist)}"` : ''].filter(Boolean).join(' ');
  const data = await mbFetchJson(`${MUSICBRAINZ_API}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=5`);
  const recordings = Array.isArray(data && data.recordings) ? data.recordings : [];
  const wantedAlbum = normCompare(album);
  const items = [];
  for (const rec of recordings) {
    if (!rec) continue;
    const releases = (Array.isArray(rec.releases) ? rec.releases : []).filter(r => r && r.id);
    if (!releases.length) continue;
    /* Prefer the release that matches the album tag when we have one — the first
       entry is often a compilation whose sleeve is not this album's — then fall
       through to the others until one actually has cover art. */
    const ordered = wantedAlbum
      ? [...releases.filter(r => normCompare(r.title || '') === wantedAlbum), ...releases.filter(r => normCompare(r.title || '') !== wantedAlbum)]
      : releases;
    const credit = (rec['artist-credit'] || []).filter(a => a && a.name).map(a => a.name).join(' & ');
    for (const release of ordered.slice(0, 3)) {
      const artworkUrl = await coverArtImageFor(release.id);
      if (!artworkUrl) continue; // no front cover on this release — try the next
      items.push({
        trackName: rec.title || '',
        artistName: credit,
        collectionName: release.title || '',
        artworkUrl,
      });
      break;
    }
    if (items.length >= 3) break;
  }
  return items;
}

/* ------------- Apple: the one source that throttles per public IP ---------
   Measured on this machine: /search answers `429` with the body
   "Rate limit has been exceeded for: itunes-apple-com|general|<ip>", then `403`
   for a while. A burst of lookups therefore arms itself to fail — the first few
   tracks succeed and everything after them is refused, which is exactly what
   "some songs get a cover and some just don't" looks like. One global gate
   fixes it: a minimum gap between calls, then a shared cooldown that is
   PERSISTED, so relaunching the app cannot reset it and re-arm the burst. */
const APPLE_MIN_GAP_MS = 3000;
const APPLE_JOIN_DELAY_MS = 1200;
const APPLE_COOLDOWN_KEY = 'wavefy-apple-cooldown';
const APPLE_COOLDOWN_STEPS = [60e3, 2 * 60e3, 5 * 60e3, 15 * 60e3];
const APPLE_DECAY_MS = 5 * 60e3;
let appleNextAt = 0;          // earliest time the next Apple call may start
let appleCooldownUntil = 0;   // set only when Apple refuses us
let appleLevel = 0;           // which cooldown step we are on
let appleLastThrottleAt = 0;

function readAppleCooldown() {
  try {
    const raw = JSON.parse(localStorage.getItem(APPLE_COOLDOWN_KEY) || 'null');
    if (!raw) return;
    appleLevel = Math.max(0, Math.min(APPLE_COOLDOWN_STEPS.length - 1, Number(raw.level) || 0));
    appleCooldownUntil = Number(raw.until) || 0;
    appleLastThrottleAt = Number(raw.at) || 0;
  } catch { /* private mode — the in-memory gate still works */ }
}
function writeAppleCooldown() {
  try {
    localStorage.setItem(APPLE_COOLDOWN_KEY, JSON.stringify({ level: appleLevel, until: appleCooldownUntil, at: appleLastThrottleAt }));
  } catch { /* ignore */ }
}
readAppleCooldown();

/** How long Apple is refusing this device, in ms (0 when it is open again). */
export function appleCooldownRemaining() { return Math.max(0, appleCooldownUntil - Date.now()); }
export function coverDiagnostics() {
  return {
    appleCooldownMs: appleCooldownRemaining(),
    appleLevel,
    mbNextInMs: Math.max(0, mbNextAt - Date.now()),
  };
}

function appleThrottled(status, body) {
  if (status === 429) return true;
  /* Measured: while the budget is spent Apple answers 429 with the body "Rate
     limit has been exceeded for: itunes-apple-com|general|<ip>", and then a bare
     403 with an EMPTY body for a while after — so a 403 here means blocked, not
     "bad request". Matching on the text alone missed most of the block. */
  if (status === 403) return true;
  return /rate limit|too many requests/i.test(String(body || ''));
}
function armAppleCooldown() {
  appleLevel = Math.min(APPLE_COOLDOWN_STEPS.length - 1, appleLevel + 1);
  const base = APPLE_COOLDOWN_STEPS[appleLevel];
  appleCooldownUntil = Date.now() + Math.round(base * (0.8 + Math.random() * 0.4));
  appleLastThrottleAt = Date.now();
  writeAppleCooldown();
}
function relaxAppleCooldown() {
  if (!appleLevel || Date.now() - appleLastThrottleAt < APPLE_DECAY_MS) return;
  appleLevel -= 1;
  writeAppleCooldown();
}

/* Waits for this device's turn. `stop()` is how the caller says the race has
   already been decided, so a slow gate never spends budget on an answer nobody
   is waiting for any more. */
async function waitForAppleSlot(stop) {
  for (;;) {
    if (stop && stop()) throw new Error('Apple slot no longer needed');
    const wait = Math.max(0, Math.max(appleNextAt, appleCooldownUntil) - Date.now());
    if (!wait) break;
    await sleep(Math.min(wait, 250));
  }
  appleNextAt = Date.now() + APPLE_MIN_GAP_MS;
}

async function itunesCandidates(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    const text = await response.text();
    if (appleThrottled(response.status, text)) { armAppleCooldown(); throw new Error('iTunes is rate limiting this network'); }
    if (!response.ok) throw new Error(`iTunes ${response.status}`);
    let data = null;
    try { data = JSON.parse(text); } catch { throw new Error('iTunes gave a non-JSON reply'); }
    relaxAppleCooldown();
    return Array.isArray(data.results) ? data.results : [];
  } finally { clearTimeout(timer); }
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
  /* A compilation tag is not an album. Sent to a catalogue it queries the
     compilation release, which is exactly what must not answer: it is the one
     sleeve every file in that folder shares. */
  const albumIsCompilation = isCompilationAlbum(album);
  const albumScope = Boolean(opts.albumScope) && !albumIsCompilation;
  /* An album tag is only worth sending when it is plausibly the album. Plenty
     of files carry a compilation or playlist name instead ("00s Hits - 100 Top
     Songs"), and a query weighted by that returns *nothing at all* for a song
     the catalogue certainly has — which is how a correct title and artist ended
     up with no cover. Callers retry with `omitAlbum` before giving up. */
  const includeAlbum = Boolean(album) && !albumIsCompilation && !albumScope && !opts.omitAlbum;
  const searchTerm = albumScope && album ? `${album} ${artist}`.trim() : [title, artist, includeAlbum ? album : ''].filter(Boolean).join(' ');
  const itunesParams = new URLSearchParams({ term: searchTerm, media: 'music', entity: albumScope ? 'album' : 'song', limit: '25' });
  const itunesUrl = `${ITUNES_SEARCH_URL}?${itunesParams.toString()}`;
  // Clean compound artist names for Deezer: "Drake; Future; Molly Santana" → "Drake"
  const deezerArtist = cleanSearchArtist(artist);
  const deezerTerm = albumScope && album ? `${album} ${deezerArtist}`.trim() : [title, deezerArtist, includeAlbum ? album : ''].filter(Boolean).join(' ');

  /* Sources are ordered by what they cost, not by preference:
       · Deezer           — free, keyless, no CORS (JSONP), CORS-open images
       · Cover Art Archive— free, keyless, CORS-open, two hops
       · Apple            — the best catalogue, and the only one that throttles
                            per public IP, so it is spent last and never before
                            the free pair has had its chance.
     All of them run concurrently and the first real answer wins; Apple simply
     joins late (APPLE_JOIN_DELAY_MS) and only while its gate is open. */
  const sources = [
    { name: 'deezer', run: async () => fetchDeezerCandidates(deezerTerm) },
    { name: 'cca', run: async () => fetchCoverArtArchiveCandidates(title, deezerArtist, albumIsCompilation ? '' : album) },
  ];
  if (opts.allowApple !== false && appleCooldownRemaining() === 0) {
    sources.push({
      name: 'apple',
      run: async stop => {
        await sleep(APPLE_JOIN_DELAY_MS);
        if (stop()) throw new Error('race already decided');
        await waitForAppleSlot(stop);
        return itunesCandidates(itunesUrl);
      },
    });
  }

  lastFetchOutcome = { errors: 0, answered: 0 };
  return new Promise(resolve => {
    let pending = sources.length;
    let settled = false;
    const stop = () => settled;
    const settle = items => { if (!settled) { settled = true; resolve(items || []); } };
    const fire = async source => {
      let found = null;
      try {
        found = nonEmpty(await source.run(stop));
        // The source replied; it simply had nothing for this track.
        if (!settled) lastFetchOutcome.answered += 1;
      } catch {
        // Every source erroring is an infrastructure problem, not a verdict on
        // the track — the caller must not spend its retry budget on that.
        if (!settled) lastFetchOutcome.errors += 1;
      }
      if (found) settle(found);
      else if (--pending <= 0) settle(null);
    };
    sources.forEach(fire);
  });
}
async function fetchImageBlob(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
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
/* Covers arrive in a stream — dozens land inside a second on a cold start — and
   every listener used to be called once per track, which for the library meant a
   full 186-row re-render per cover. They are coalesced per frame instead: the
   listeners still see every track, just in one batch per painted frame, so the
   work scales with the frame rate rather than with the number of covers. */
const pendingArtwork = [];
const pendingArtworkSeen = new Set();
let artworkFlushScheduled = false;
function notifyArtwork(track) {
  if (!track || !track.id) return;
  if (!pendingArtworkSeen.has(track.id)) {
    pendingArtworkSeen.add(track.id);
    pendingArtwork.push(track);
    // One batch must not grow without bound while the queue is running hot.
    if (pendingArtwork.length > 32) pendingArtworkSeen.delete(pendingArtwork.shift().id);
  }
  if (artworkFlushScheduled) return;
  artworkFlushScheduled = true;
  const flush = () => {
    artworkFlushScheduled = false;
    const batch = pendingArtwork.splice(0, pendingArtwork.length);
    pendingArtworkSeen.clear();
    for (const t of batch) {
      artworkListeners.forEach(fn => { try { fn(t); } catch { /* ignore */ } });
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 100);
}

/* Fired whenever a track's identity changes behind the UI's back (recognition
   filled in a title, artists were rebuilt, and so on). */
const trackListeners = new Set();
export function onTrackUpdated(fn) { trackListeners.add(fn); return () => trackListeners.delete(fn); }
function notifyTrackUpdated(track) { trackListeners.forEach(fn => { try { fn(track); } catch { /* ignore */ } }); }

export async function lookupArtwork(track, force = false, quiet = true) {
  if (!track) return false;
  if (!force && (hasCover(track) || !coverLookupDue(track, Date.now()))) return false;
  if (!navigator.onLine) return false;
  try {
    const title = cleanTitleString(track.title);
    const artist = track.artist && track.artist !== 'Unknown artist' ? track.artist : '';
    const album = track.album || '';
    /* The cascade is deliberately short, and only its FIRST pass runs on the
       initial sweep. Every extra pass costs another Apple query against a
       per-IP budget, so the looser attempts are reserved for a track that has
       already failed once and come back through the retry queue. */
    const deep = force || (Number(track.coverAttempts) || 0) > 0;
    let result = chooseArtworkResult(await fetchArtworkCandidates(track), title, artist, album);
    // Retry without the album next: it is the single most common reason a
    // lookup that should have succeeded came back empty.
    if (!result) {
      result = chooseArtworkResult(await fetchArtworkCandidates(track, { omitAlbum: true }), title, artist, album);
    }
    if (!result && deep && album && artist) {
      result = chooseArtworkResult(await fetchArtworkCandidates(track, { albumScope: true }), title, artist, album);
    }
    if (!result && deep && artist) {
      result = chooseArtworkResult(await fetchArtworkCandidates({ ...track, title: `${artist} ${title}`, artist: '', album: '' }), title, artist, album);
    }
    if (!result) {
      /* Nothing answered at all — MusicBrainz shedding load, Deezer blocked,
         Apple throttled. That is not "this song has no cover", so it must not
         consume an attempt; it is simply retried a little later. */
      if (lastFetchOutcome.errors > 0 && lastFetchOutcome.answered === 0) {
        scheduleCoverRetry(track, 'busy');
        return false;
      }
      throw new Error('No artwork found');
    }
    const remoteUrl = artworkImageUrl(result);

    /* The address is recorded FIRST, and the UI is told immediately. This is the
       difference between a cover and a blank square on a phone: `fetch()` for
       the image bytes is subject to CORS and to the browser's own timeout, while
       an <img src="https://…"> is not — so a cover whose CDN refuses a fetch
       still paints perfectly. Failing the whole lookup because the *download*
       was refused is exactly how a perfectly good cover went missing. */
    track.artworkRemoteUrl = remoteUrl;
    track.artworkSource = 'Online artwork';
    track.artworkFetchedAt = Date.now();
    track.artworkLookupFailed = false;
    await persistArtworkRecord(track);
    notifyArtwork(track);

    // Then cache the bytes, for offline use and lock-screen artwork. Best
    // effort: the cover is already on screen either way.
    try {
      const blob = await fetchImageBlob(remoteUrl);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (!bytes.length) throw new Error('Artwork image is empty');
      const previous = state.artworkUrls.get(track.id);
      if (previous) { retireArtworkUrl(previous); state.artworkUrls.delete(track.id); }
      state.artworkBlobs.delete(track.id);
      track.artworkBytes = bytes;
      track.artworkType = blob.type || track.artworkType || 'image/jpeg';
      if (isPublicTrack(track)) {
        await dbPut(DB_ARTWORK_CACHE, { id: track.id, artworkBytes: bytes, artworkType: track.artworkType, artworkRemoteUrl: remoteUrl, artworkFetchedAt: track.artworkFetchedAt });
      } else {
        await saveTrack(track);
      }
      notifyArtwork(track);
      /* We are holding the bytes already, so this is the cheapest moment to make
         a copy every other device can load. Deliberately not awaited: the cover
         is on screen either way, and an upload must never delay the queue. */
      if (cloudConfigured()) mirrorCoverBytes(track, bytes).catch(() => {});
    } catch { /* the address alone is enough to paint the cover */ }
    clearCoverRetry(track);
    persistArtworkRecord(track);
    // Share it. One resolution on any device spares every other device the
    // lookup, which is what stops a cold phone from hammering the catalogues.
    scheduleCoverPublish();
    return true;
  } catch (err) {
    /* A throttled source is not this track's fault, so it must not be counted
       as an attempt — it is rescheduled for when the gate reopens instead. Any
       other failure gets a backoff slot and stays resumable. */
    const throttled = appleCooldownRemaining() > 0;
    scheduleCoverRetry(track, throttled ? 'throttled' : 'failed');
    return false;
  }
}

/* ---------------------- retry bookkeeping for covers --------------------
   A failed lookup used to be forgotten for the session, which is what leaves
   tiles blank until the app is reinstalled. Each track now carries its own
   record — how many times we tried, when the next try is due, why the last one
   failed — and it is persisted, so a relaunch resumes instead of starting over. */
function coverLookupDue(track, now) {
  if (!track || hasCover(track)) return false;
  if (track.coverReason === 'no-match') return false;
  return (Number(track.coverNextAt) || 0) <= now;
}
function clearCoverRetry(track) {
  track.coverAttempts = 0;
  track.coverNextAt = 0;
  track.coverReason = '';
  track.artworkLookupFailed = false;
}
function scheduleCoverRetry(track, reason) {
  const now = Date.now();
  track.artworkFetchedAt = now;
  if (reason === 'throttled' || reason === 'busy') {
    /* Apple refusing us, or every source erroring, says nothing about the
       track: wait for the gate (or a few minutes) and come back. Deliberately
       NOT counted against the attempt budget, so a bad network minute cannot
       write a song off for good. */
    track.coverReason = reason;
    const wait = reason === 'throttled' ? appleCooldownRemaining() + 5000 : 120e3;
    track.coverNextAt = now + Math.round(wait * (0.8 + Math.random() * 0.4));
    track.artworkLookupFailed = false;
  } else {
    const attempts = (Number(track.coverAttempts) || 0) + 1;
    track.coverAttempts = attempts;
    if (attempts >= COVER_MAX_ATTEMPTS) {
      track.coverReason = 'no-match';
      track.coverNextAt = 0;
    } else {
      const base = COVER_BACKOFF_MS[Math.min(attempts, COVER_BACKOFF_MS.length) - 1];
      track.coverReason = 'retry';
      track.coverNextAt = now + Math.round(base * (0.8 + Math.random() * 0.4));
    }
    track.artworkLookupFailed = true;
  }
  persistArtworkRecord(track);
}

/* A replaced object URL can still be painted by an <img> in the DOM — the queue
   runs behind a rendered grid, so revoking immediately leaves a broken image
   with no way back until the next full render. Retire it instead, and only cash
   the revocation in once nothing points at it. */
const retiredUrls = new Map(); // url -> retired at
function retireArtworkUrl(url) {
  if (!url) return;
  retiredUrls.set(url, Date.now());
  if (retiredUrls.size > 120) sweepRetiredUrls(true);
}
function sweepRetiredUrls(aggressive = false) {
  const now = Date.now();
  for (const [url, at] of retiredUrls) {
    const young = now - at < 120e3;
    if (!aggressive && young) continue;
    let inUse = null;
    try { inUse = document.querySelector(`img[src="${url}"]`); } catch { inUse = null; }
    if (inUse) continue;
    try { URL.revokeObjectURL(url); } catch { /* already gone */ }
    retiredUrls.delete(url);
  }
}
setInterval(() => sweepRetiredUrls(false), 60e3);

/* A cover address that used to work can stop working — a CDN retires a URL, a
   catalogue reorganises. Because a shared address now arrives pre-filled from
   the manifest, nothing would ever notice: `hasCover()` counts it as done and
   the queue skips it, leaving a permanently blank tile with no retry. The
   browser tells us the truth the moment an <img> fails, so that is the signal
   we act on: forget the dead address (in memory AND in the cache, or it comes
   back on the next boot) and put the track back in the queue. */
const coverInvalidatedAt = new Map();
export function invalidateCover(trackId, failedSrc) {
  if (!trackId) return false;
  const now = Date.now();
  /* Two guards, both learned the hard way: only act on the image that is
     actually on screen (a recycled <img> can report an old src), and never more
     than once a minute per track — otherwise a source that keeps handing back
     dead links would spin the queue against the network forever. */
  if (now - (coverInvalidatedAt.get(trackId) || 0) < 60e3) return false;
  const track = allTracks().find(t => t.id === trackId);
  if (!track) return false;
  const current = track.artworkRemoteUrl || state.artworkUrls.get(trackId) || '';
  if (failedSrc && current && failedSrc !== current) return false;
  coverInvalidatedAt.set(trackId, now);
  coverCorrections.add(trackId);
  const hadAddress = Boolean(track.artworkRemoteUrl) || state.artworkBlobs.has(trackId);
  track.artworkRemoteUrl = '';
  track.artworkBytes = null;
  track.artworkFetchedAt = 0;
  const url = state.artworkUrls.get(trackId);
  if (url) { retireArtworkUrl(url); state.artworkUrls.delete(trackId); }
  state.artworkBlobs.delete(trackId);
  // Start the track over rather than continuing its backoff: the failure was a
  // stale address, not a bad network, and a fresh lookup should not have to
  // wait out a delay earned by the old one.
  track.coverAttempts = 0;
  track.coverNextAt = 0;
  track.coverReason = '';
  track.coverLookupFailed = false;
  clearCoverRetry(track);
  if (isPublicTrack(track)) {
    (async () => {
      try {
        const existing = (await dbGet(DB_ARTWORK_CACHE, trackId)) || {};
        await dbPut(DB_ARTWORK_CACHE, {
          ...existing, id: trackId, artworkRemoteUrl: '', artworkBytes: null,
          coverAttempts: 0, coverNextAt: 0, coverReason: '',
        });
      } catch { /* private mode — memory state is still correct */ }
    })();
  } else {
    saveTrack(track).catch(() => {});
  }
  queueArtworkLookups([track]);
  return hadAddress;
}

/* Media Session is handed an image *address*, not image bytes: iOS will not
   paint a blob: URL on the lock screen, so a cover that only exists in
   IndexedDB shows nothing there. Tracks whose cover was fetched before the
   address was recorded have bytes but no URL, so this resolves the address on
   demand. It is lookup-only — no image is downloaded, and the bytes, the
   storage and the UI are untouched; the address is simply remembered. */
export async function resolveArtworkRemoteUrl(track) {
  if (!track) return null;
  if (/^https?:\/\//i.test(track.artworkRemoteUrl || '')) return track.artworkRemoteUrl;
  if (state.artworkUrlLookups.has(track.id)) return null; // already in flight
  state.artworkUrlLookups.add(track.id);
  try {
    const title = cleanTitleString(track.title);
    const artist = track.artist && track.artist !== 'Unknown artist' ? track.artist : '';
    const album = track.album || '';
    const result = chooseArtworkResult(await fetchArtworkCandidates(track), title, artist, album);
    if (!result) return null;
    const url = artworkImageUrl(result);
    if (!url) return null;
    track.artworkRemoteUrl = url;
    track.artworkFetchedAt = track.artworkFetchedAt || Date.now();
    // persistArtworkRecord merges instead of replacing, so the retry
    // bookkeeping stored alongside the address survives this write.
    persistArtworkRecord(track).catch(() => {});
    notifyArtwork(track);
    scheduleCoverPublish();
    return url;
  } catch {
    return null;
  } finally {
    state.artworkUrlLookups.delete(track.id);
  }
}

/* ------------- covers that are only an address (the cold-start case) -------
   A fresh install paints from the shared cover file, so the addresses are right
   from the first frame — but nothing has the BYTES, which means every paint is a
   network fetch to whoever the catalogue happened to be. That is the mobile
   experience: tiles that trickle in, or never arrive at all when the host is
   unreachable. This walks those tracks once in the background, downloads each
   cover a single time, keeps the bytes locally (so the next paint is instant and
   works offline) and mirrors a copy into our own bucket for everyone else.

   It is deliberately a separate, gentler pass than the lookup queue: these
   tracks are already visible, so it must not crowd out the ones that are not. */
const COVER_BYTES_WORKERS = 4;
let coverBytesRunning = false;
/* A host that refuses the bytes twice is not going to start: every remaining
   track on it is skipped for the rest of the session rather than burning mobile
   data on requests that cannot succeed — which is exactly what archive.org does
   on a phone network, and it backs three quarters of this library. */
const coverHostFailures = new Map();
function coverHostOf(url) { try { return new URL(url).host; } catch { return ''; } }

export async function hydrateCoverBytes(tracks) {
  if (coverBytesRunning || !navigator.onLine) return 0;
  const queue = (tracks || []).filter(t => t && t.id
    && !hasArtwork(t)
    && (isMirroredCover(t.artworkMirrorUrl) || /^https?:\/\//i.test(t.artworkRemoteUrl || '')));
  if (!queue.length) return 0;
  coverBytesRunning = true;
  let done = 0;
  let index = 0;
  try {
    const worker = async () => {
      while (index < queue.length) {
        const track = queue[index++];
        if (hasArtwork(track)) continue;
        const url = isMirroredCover(track.artworkMirrorUrl) ? track.artworkMirrorUrl : track.artworkRemoteUrl;
        const host = coverHostOf(url);
        if (host && (coverHostFailures.get(host) || 0) >= 2) continue;
        try {
          const blob = await fetchImageBlob(url);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          if (!bytes.length) continue;
          track.artworkBytes = bytes;
          track.artworkType = blob.type || track.artworkType || 'image/jpeg';
          await persistArtworkRecord(track).catch(() => {});
          notifyArtwork(track);
          done += 1;
          if (cloudConfigured() && !isMirroredCover(url)) mirrorCoverBytes(track, bytes).catch(() => {});
        } catch {
          /* An unreachable host still leaves the address to paint from; it just
             does not get asked again. */
          if (host) coverHostFailures.set(host, (coverHostFailures.get(host) || 0) + 1);
        }
      }
    };
    await Promise.all(Array.from({ length: COVER_BYTES_WORKERS }, worker));
  } finally {
    coverBytesRunning = false;
  }
  return done;
}

/* The queue is a single shared pump, not a per-render loop: a render while it is
   already working must not start a second pass over the same tracks (that is how
   186 tracks became a thousand lookups). It also pauses in the background and
   slows right down when the user has asked to save data. */
/* Six, not three. Every source is a different host with its own budget — Deezer
   over JSONP, MusicBrainz, the Cover Art Archive, Apple behind its own gate — so
   the limit that matters is per host, not global, and three meant a cold library
   walked 186 tracks at a third of the speed the network was giving us. */
const COVER_WORKERS = 6;
const coverQueue = [];
const coverQueued = new Set();
let coverPumpRunning = false;
let coverSchedulerInstalled = false;

function whenIdle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => fn(), { timeout: 2000 });
  else setTimeout(fn, 250);
}

function pumpCoverQueue() {
  if (coverPumpRunning) return;
  coverPumpRunning = true;
  whenIdle(async () => {
    const workers = Array.from({ length: COVER_WORKERS }, async () => {
      while (coverQueue.length) {
        if (document.hidden) return; // the visibility handler resumes us
        const track = coverQueue.shift();
        coverQueued.delete(track.id);
        /* Re-check at pick-up, not just at enqueue. A track can sit in this
           queue while its address arrives from the shared cover file — and a
           phone's whole point is that it looks nothing up. Without this the
           workers keep grinding through tracks that already have a cover. */
        if (!coverLookupDue(track, Date.now())) continue;
        try { await lookupArtwork(track, false, true); } catch { /* recorded per track */ }
        const conn = navigator.connection;
        if (conn && conn.saveData) await sleep(4000);
      }
    });
    await Promise.all(workers);
    coverPumpRunning = false;
    if (coverQueue.length && !document.hidden) pumpCoverQueue();
  });
}

function installCoverScheduler() {
  if (coverSchedulerInstalled) return;
  coverSchedulerInstalled = true;
  const resume = () => { if (!document.hidden) queueArtworkLookups(allTracks()); };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('online', resume);
  // A slow tick picks up whatever backoff has come due while the app stayed open.
  setInterval(resume, 5 * 60e3);
}

export function queueArtworkLookups(tracks) {
  installCoverScheduler();
  const now = Date.now();
  let added = 0;
  for (const track of tracks) {
    if (!track || !track.id || coverQueued.has(track.id)) continue;
    if (!coverLookupDue(track, now)) continue;
    coverQueued.add(track.id);
    coverQueue.push(track);
    added += 1;
  }
  if (added) pumpCoverQueue();
}

/** How many tracks are waiting, cooling down, or written off — for the UI. */
export function coverQueueStatus(tracks) {
  const now = Date.now();
  const status = { total: 0, haveCover: 0, queued: 0, cooling: 0, noMatch: 0, idle: 0 };
  for (const track of tracks) {
    if (!track) continue;
    status.total += 1;
    if (hasCover(track)) { status.haveCover += 1; continue; }
    if (track.coverReason === 'no-match') { status.noMatch += 1; continue; }
    if (coverQueued.has(track.id)) { status.queued += 1; continue; }
    if ((Number(track.coverNextAt) || 0) > now) { status.cooling += 1; continue; }
    status.idle += 1;
  }
  return status;
}

/** Re-arm every cover lookup that is due, right now (used by the UI's retry). */
export function retryCoverLookupsNow() {
  for (const track of allTracks()) {
    if (hasCover(track)) continue;
    track.coverAttempts = 0;
    track.coverNextAt = 0;
    track.coverReason = '';
  }
  queueArtworkLookups(allTracks());
}

/* --------------------------- artist portraits ---------------------------
   The Library's artist row wants a photo of the singer or band, not the sleeve
   of whichever track happened to sort first. Sources are tried in the browser
   (Deezer over JSONP, then Wikipedia), so this works with no server at all.
   Resolved URLs are memoised in memory and in localStorage, so re-rendering the
   row costs nothing and a relaunch paints them immediately. */
const ARTIST_IMAGE_STORAGE_KEY = 'wavefy-artist-images';
const artistImageCache = new Map();   // normalized artist name -> photo url
const artistImageMisses = new Set();  // looked up, genuinely nothing found
const artistImageInFlight = new Map();
let artistImageCacheLoaded = false;

function artistCacheKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}
function loadArtistImageCache() {
  if (artistImageCacheLoaded) return;
  artistImageCacheLoaded = true;
  try {
    const saved = JSON.parse(localStorage.getItem(ARTIST_IMAGE_STORAGE_KEY) || '{}');
    Object.entries(saved || {}).forEach(([key, url]) => { if (url) artistImageCache.set(key, String(url)); });
  } catch { /* best effort only */ }
}
function persistArtistImageCache() {
  try {
    const entries = [...artistImageCache.entries()].slice(-300);
    localStorage.setItem(ARTIST_IMAGE_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* quota or private mode — the in-memory cache still works */ }
}

/* Synchronous peek, so the row can paint a known photo on the first frame of
   every re-render instead of flicking through the placeholder. */
export function cachedArtistImage(name) {
  loadArtistImageCache();
  return artistImageCache.get(artistCacheKey(name)) || null;
}

/* Best match wins: an exact name first, otherwise stay among the related results
   and take the best-known act, so "Coldplay" cannot land on a tribute band. */
function pickArtistCandidate(items, name) {
  const key = artistCacheKey(name);
  const exact = items.find(item => artistCacheKey(item.name) === key);
  const related = items.filter(item => {
    const other = artistCacheKey(item.name);
    return other && (other.includes(key) || key.includes(other));
  });
  const pool = exact ? [exact] : (related.length ? related : items);
  return pool.slice().sort((a, b) => b.fans - a.fans)[0] || null;
}

/* Wikipedia's REST API does send CORS headers, and a music article's page image
   is usually a usable press shot. The blurb is checked first, so an unrelated
   article that merely shares the name is not used as a portrait. */
const MUSIC_BLURB = /(band|singer|musician|rapper|duo|trio|group|songwriter|composer|producer|vocalist|musical|disc jockey|\bdj\b)/i;
async function wikipediaArtistImage(name) {
  const page = encodeURIComponent(String(name).trim().replace(/\s+/g, '_'));
  const summary = await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${page}`);
  if (!summary || summary.type === 'disambiguation') return '';
  const blurb = `${summary.description || ''} ${summary.extract || ''}`.slice(0, 400);
  if (!MUSIC_BLURB.test(blurb)) return '';
  const image = (summary.thumbnail && summary.thumbnail.source) || (summary.originalimage && summary.originalimage.source) || '';
  return /\.(jpe?g|png|webp)/i.test(image) ? image : '';
}

/* Deezer first (real photos, straight from the phone via JSONP), Wikipedia
   second, and the optional local server only as a last resort. No step needs a
   server to be running — which is the whole point: the installed app on a phone
   has no server behind it and still has to show photos. */
async function resolveArtistImage(name) {
  try {
    const best = pickArtistCandidate(await fetchDeezerCandidates(name, 'artist'), name);
    if (best) return best.image;
  } catch { /* try the next source */ }
  try {
    const wiki = await wikipediaArtistImage(name);
    if (wiki) return wiki;
  } catch { /* try the next source */ }
  return '';
}

export async function lookupArtistImage(name) {
  const key = artistCacheKey(name);
  if (!key) return null;
  loadArtistImageCache();
  if (artistImageCache.has(key)) return artistImageCache.get(key);
  if (artistImageMisses.has(key)) return null;
  if (!navigator.onLine) return null;
  if (artistImageInFlight.has(key)) return artistImageInFlight.get(key);
  const request = (async () => {
    try {
      const url = await resolveArtistImage(name);
      // No image anywhere is a verdict for this session; a thrown error is not,
      // so it stays retryable.
      if (!url) { artistImageMisses.add(key); return null; }
      artistImageCache.set(key, url);
      persistArtistImageCache();
      return url;
    } catch {
      return null;
    } finally {
      artistImageInFlight.delete(key);
    }
  })();
  artistImageInFlight.set(key, request);
  return request;
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
    // LRCLIB direct: it sends Access-Control-Allow-Origin: *, so lyrics need no
    // proxy at all — which is why they keep working where covers do not.
    const requests = [
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
export async function importFiles(fileList, { onProgress, onStatus } = {}) {
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
      /* Refresh the compilation set *before* this track's cover is looked up.
         Importing a folder rip is exactly the moment the album tag stops being
         an album, and a lookup that runs against a stale set is the lookup that
         stamps the folder's sleeve onto the file. */
      registerCompilationAlbums(allTracks());
      // Identity first, then cover and lyrics. Order matters: artwork and lyrics
      // are searched by title and artist, so recognising an untagged file has to
      // finish before either lookup runs or they search for the wrong thing.
      (async () => {
        let renamed = false;
        if (needsRecognition(track)) {
          try { renamed = await recognizeTrack(track, { onStatus }); } catch { /* keep the filename identity */ }
          if (renamed) notifyArtwork(track);
        }
        // Forced when the identity just changed: the earlier attempt would have
        // searched for whatever the filename claimed.
        await lookupArtwork(track, renamed).catch(() => {});
        await lookupLyrics(track, renamed).catch(() => {});
      })();
    } catch { /* skip unreadable files */ }
  }
  registerCompilationAlbums(allTracks());
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

/* ----------------- the shared cover file (songs/covers.json) --------------
   Resolved cover addresses live in their own object rather than inside the
   track manifest, for one blunt reason: `library.json` is read-modify-written
   by the uploader, and a cover publish landing a second after an upload would
   silently drop that track from the library. Two files means a lost race costs
   a cover address (self-healing, re-resolved) instead of a track.

   Shape: { "<trackId>": "https://…" } — roughly 90 bytes a track, ~17 KB for
   the whole library, against the manifest's 96 KB. */
const COVERS_OBJECT = 'songs/covers.json';

async function cloudReadCovers() {
  const res = await fetch(`${cloudBase()}/storage/v1/object/public/${COVERS_OBJECT}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) {
    if (res.status === 404) return {};
    let missing = false;
    try {
      const body = await res.json();
      missing = body && (body.code === 'NoSuchKey' || body.statusCode === '404' || body.statusCode === 404);
    } catch { /* not json */ }
    if (missing) return {};
    throw new Error(`Supabase read failed (${res.status})`);
  }
  const data = await res.json().catch(() => null);
  /* Anything unexpected — an array, a string, null — is read as "no shared
     covers yet" rather than an error. The local pipeline stays the source of
     truth, and it must never be blocked by the state of this file. */
  return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
}

async function cloudWriteCovers(map) {
  const res = await fetch(`${cloudBase()}/storage/v1/object/${COVERS_OBJECT}`, {
    method: 'POST',
    headers: { ...cloudHeaders(true), 'x-upsert': 'true' },
    body: JSON.stringify(map),
  });
  if (!res.ok) throw new Error(`Supabase write failed (${res.status})`);
}

/* ------------------- mirroring covers into our own storage --------------
   An address is only as good as the host behind it, and the hosts are the
   problem: three quarters of this library resolved through the Cover Art
   Archive, whose URL redirects to archive.org. On a phone that host is often
   unreachable, so the tile stays blank — and where it is reachable it costs two
   extra round trips on every single paint.

   So the bytes are kept. The first device to resolve a cover downloads it once,
   stores a copy next to the songs in the same bucket the audio already streams
   from, and points the shared cover file at that copy. After that every device —
   and every later paint on this one — loads the cover from one origin we know
   answers, with no redirect chain and a real HTTP cache behind it.

   Objects are named from the hash of the source URL, so the twenty tracks that
   share an album sleeve share one object (and one download, and one upload). */
const COVER_MIRROR_DIR = 'songs/covers';
const mirroredBySource = new Map(); // source url -> mirror url (this session)

function coverMirrorName(sourceUrl) {
  let h = 2166136261;
  for (let i = 0; i < sourceUrl.length; i += 1) {
    h ^= sourceUrl.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${COVER_MIRROR_DIR}/${(h >>> 0).toString(36)}.jpg`;
}
function isMirroredCover(url) {
  return typeof url === 'string' && url.indexOf(`/object/public/${COVER_MIRROR_DIR}/`) !== -1;
}

async function uploadCoverMirror(name, bytes, type) {
  const res = await fetch(`${cloudBase()}/storage/v1/object/${name}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cloudConfig().supabaseKey}`,
      'Content-Type': type || 'image/jpeg',
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Cover mirror rejected (${res.status})`);
  return `${cloudBase()}/storage/v1/object/public/${name}`;
}

/* Downscale before storing: the catalogues hand back 500–600px art, and a phone
   pays for every kilobyte of it. 512px is everything the app can actually draw
   (the largest tile is 300 CSS px, so ~600 device pixels) at a fraction of the
   weight. Any failure falls back to the original bytes — this is an
   optimisation, never a requirement. */
const COVER_MIRROR_MAX = 512;
function reencodeCover(bytes, type) {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return Promise.resolve(null);
  return new Promise(resolve => {
    createImageBitmap(new Blob([bytes], { type: type || 'image/jpeg' })).then(bitmap => {
      const scale = Math.min(1, COVER_MIRROR_MAX / Math.max(bitmap.width, bitmap.height));
      if (scale >= 1 && bytes.length < 40 * 1024) { bitmap.close && bitmap.close(); resolve(null); return; }
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      if (bitmap.close) bitmap.close();
      canvas.toBlob(blob => {
        if (!blob || !blob.size) { resolve(null); return; }
        blob.arrayBuffer().then(buf => resolve(new Uint8Array(buf))).catch(() => resolve(null));
      }, 'image/jpeg', 0.82);
    }).catch(() => resolve(null));
  });
}

/* One cover, from bytes we already hold to an address every device can use. */
async function mirrorCoverBytes(track, bytes) {
  if (!cloudConfigured() || !track || !bytes || !bytes.length) return null;
  if (track.artworkMirrorUrl && isMirroredCover(track.artworkMirrorUrl)) return track.artworkMirrorUrl;
  const source = track.artworkRemoteUrl || '';
  if (!/^https?:\/\//i.test(source) || isMirroredCover(source)) return null;
  const cached = mirroredBySource.get(source);
  if (cached) {
    track.artworkMirrorUrl = cached;
    await persistArtworkRecord(track).catch(() => {});
    return cached;
  }
  try {
    const smaller = await reencodeCover(bytes, track.artworkType);
    const name = coverMirrorName(source);
    const url = await uploadCoverMirror(name, smaller || bytes, smaller ? 'image/jpeg' : (track.artworkType || 'image/jpeg'));
    mirroredBySource.set(source, url);
    track.artworkMirrorUrl = url;
    await persistArtworkRecord(track).catch(() => {});
    // The shared file must adopt the mirror, or the next device inherits the
    // slow (or unreachable) catalogue URL we are trying to get away from.
    coverCorrections.add(track.id);
    scheduleCoverPublish();
    return url;
  } catch {
    return null;
  }
}

export { mirrorCoverBytes };

/* Fill in the addresses this device does not have. Called after the local cache
   has been hydrated, so a device that already knows an address keeps its own —
   this only ever adds. For a fresh install, which has nothing cached at all,
   this is the step that paints the whole library without a single lookup. */
async function applySharedCovers(tracks) {
  const shared = await cloudReadCovers().catch(() => ({}));
  let applied = 0;
  /* Addresses this device has proven wrong must not come back: the shared file
     is only rewritten when a publish succeeds, so on a boot that happens before
     that write, the bad entry would be inherited all over again. */
  const purged = purgedCoverIds();
  tracks.forEach(t => {
    if (purged.has(t.id)) return;
    const url = shared[t.id];
    if (!url || !/^https?:\/\//i.test(url)) return;
    /* An entry that points into our own bucket is a mirrored cover: it goes in
       its own field, because it is the address to PAINT and also the promise
       that the bytes behind it can be fetched from a host we control. */
    if (isMirroredCover(url)) {
      if (t.artworkMirrorUrl === url) return;
      t.artworkMirrorUrl = url;
      if (!t.artworkSource) t.artworkSource = 'Online artwork';
      applied += 1;
      return;
    }
    if (/^https?:\/\//i.test(t.artworkRemoteUrl || '') || isMirroredCover(t.artworkMirrorUrl)) return;
    t.artworkRemoteUrl = url;
    if (!t.artworkSource) t.artworkSource = 'Online artwork';
    applied += 1;
  });
  return applied;
}

/* ------------------- sharing resolved covers between devices --------------
   The moment a cover is resolved anywhere, its address is written to the
   shared cover file. Any other device — a phone installing the app, a browser
   after clearing site data — then paints the whole library with zero lookups,
   which is exactly what a cold start could not do against rate-limited
   catalogues. Only the address is shared; the image itself still comes from
   wherever it was found.

   Three rules keep this safe to run from several devices at once:
     · the file is re-read immediately before writing and merged into that
       fresh copy, so a concurrent publish is not thrown away;
     · it only ever FILLS a gap unless forced, so devices cannot fight over a
       track — whichever one resolved it first wins;
     · a device never deletes another device's entry. A URL that looks dead to
       one network is left alone; that device re-resolves it and publishes its
       own address, which is the self-correcting path.
   Nothing is published unless something actually changed, so a library at rest
   produces no traffic at all. */
const COVER_PUBLISH_DELAY_MS = 30e3;
let coverPublishTimer = null;
let coverPublishRunning = false;
let coverPublishDirty = false;
/* Tracks whose shared address this device has proven wrong — an <img> failed on
   it. Without this, the "never overwrite" rule would keep the dead URL in the
   shared file forever and every other device would inherit the blank tile. The
   flag makes the corrected address the one exception: it is written over the
   dead one, then cleared. */
const coverCorrections = new Set();

function scheduleCoverPublish() {
  if (!cloudConfigured()) return;
  coverPublishDirty = true;
  if (coverPublishTimer) return;
  coverPublishTimer = setTimeout(() => {
    coverPublishTimer = null;
    publishCoverAddresses().catch(() => {});
  }, COVER_PUBLISH_DELAY_MS);
}

export async function publishCoverAddresses({ force = false } = {}) {
  if (!cloudConfigured()) return { updated: 0, reason: 'cloud not configured' };
  if (coverPublishRunning) return { updated: 0, reason: 'already publishing' };
  if (!coverPublishDirty && !force) return { updated: 0, reason: 'nothing new' };
  coverPublishRunning = true;
  try {
    if (!state.publicTracks.length) await loadPublicTracks();
    // Only cloud tracks exist in the shared file; a local import has nowhere
    // to be shared to and is skipped.
    const cloudIds = new Set(state.publicTracks.map(t => t.id));
    const mine = new Map();
    allTracks().forEach(t => {
      if (!cloudIds.has(t.id)) return;
      // The mirror is what other devices should use; the catalogue URL is the
      // fallback for tracks we have not been able to copy yet.
      if (isMirroredCover(t.artworkMirrorUrl)) { mine.set(t.id, t.artworkMirrorUrl); return; }
      if (!/^https?:\/\//i.test(t.artworkRemoteUrl || '')) return;
      mine.set(t.id, t.artworkRemoteUrl);
    });
    if (!mine.size) return { updated: 0, reason: 'no covers resolved yet' };
    const shared = await cloudReadCovers();
    let updated = 0;
    /* An address that was *wrong* — a compilation's sleeve standing in for a
       track's own album — is deleted, not overwritten: until this device has
       re-resolved the track there is nothing better to put in its place, and
       leaving the bad entry guarantees every other device inherits it. */
    let removed = 0;
    coverRemovals.forEach(id => {
      if (!(id in shared)) return;
      delete shared[id];
      removed += 1;
    });
    const corrected = [];
    mine.forEach((url, id) => {
      const replacing = coverCorrections.has(id);
      if (shared[id] === url) { if (replacing) coverCorrections.delete(id); return; }
      if (shared[id] && !force && !replacing) return; // already known — leave it alone
      if (replacing) corrected.push(id);
      shared[id] = url;
      updated += 1;
    });
    if (!updated && !removed) return { updated: 0, reason: 'up to date' };
    await cloudWriteCovers(shared);
    // Only clear the flags once the write actually succeeded, so a failed
    // publish does not lose the knowledge that these addresses were dead.
    corrected.forEach(id => coverCorrections.delete(id));
    coverRemovals.clear();
    coverPublishDirty = false;
    return { updated, removed, corrected: corrected.length, total: Object.keys(shared).length };
  } catch (err) {
    return { updated: 0, reason: (err && err.message) || 'publish failed' };
  } finally {
    coverPublishRunning = false;
  }
}

async function cloudRemoveTracks(ids) {
  const removeSet = new Set(ids);
  const list = await cloudReadManifest().catch(() => []);
  const filtered = list.filter(d => !removeSet.has(d.id));
  if (filtered.length === list.length) return;
  await cloudWriteManifest(filtered);
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

/* The single writer for a track's artwork record: the address, whatever bytes
   are already cached, and the retry bookkeeping. Splitting these between
   callers is how a URL that resolved before its download wiped a download that
   had already succeeded. */
async function persistArtworkRecord(track) {
  if (!track || !track.id || !isPublicTrack(track)) {
    if (track && track.id) saveTrack(track).catch(() => {});
    return;
  }
  try {
    const existing = (await dbGet(DB_ARTWORK_CACHE, track.id)) || {};
    await dbPut(DB_ARTWORK_CACHE, {
      ...existing,
      id: track.id,
      artworkRemoteUrl: track.artworkRemoteUrl || existing.artworkRemoteUrl || '',
      artworkType: track.artworkType || existing.artworkType || 'image/jpeg',
      artworkBytes: (track.artworkBytes && track.artworkBytes.length) ? track.artworkBytes : (existing.artworkBytes || null),
      artworkFetchedAt: track.artworkFetchedAt || existing.artworkFetchedAt || 0,
      coverAttempts: Number(track.coverAttempts) || 0,
      coverNextAt: Number(track.coverNextAt) || 0,
      coverReason: track.coverReason || '',
    });
  } catch { /* private mode / quota — the in-memory track still paints */ }
}

async function hydratePublicArtwork() {
  const cache = await dbGetAll(DB_ARTWORK_CACHE).catch(() => []);
  const byId = new Map(cache.map(c => [c.id, c]));
  state.publicTracks.forEach(t => {
    const c = byId.get(t.id);
    if (!c) return;
    /* The address is restored even when the bytes are missing: that is the
       whole point of having stored it. Requiring bytes here is what left a
       cloud track blank on a phone while the very URL that paints it sat in
       the cache, unused. */
    if (c.artworkRemoteUrl) t.artworkRemoteUrl = c.artworkRemoteUrl;
    if (c.artworkBytes && c.artworkBytes.length) {
      t.artworkBytes = new Uint8Array(c.artworkBytes);
      t.artworkType = c.artworkType || 'image/jpeg';
      t.artworkSource = 'Online artwork';
    }
    // Retry bookkeeping survives a relaunch, so a track that was waiting out a
    // backoff (or a throttled Apple) resumes where it left off.
    t.coverAttempts = Number(c.coverAttempts) || 0;
    t.coverNextAt = Number(c.coverNextAt) || 0;
    t.coverReason = c.coverReason || '';
  });
}

/* There is nothing to probe any more. Boot used to spend up to three seconds
   asking a local server whether a proxy existed, which also stalled the first
   paint on a device that had no server behind it — the normal case for an
   installed app. Every source is now browser-direct, so boot has no transport
   to discover. */

export async function loadPublicTracks() {
  // Cloud first: the shared library works with the PC off, from any network.
  if (cloudConfigured()) {
    try {
      const cloudTracks = await cloudListTracks();
      if (cloudTracks) {
        state.publicTracks = cloudTracks;
        state.cloudAvailable = true;
        registerCompilationAlbums(allTracks());
        // Local first (bytes and addresses this device already knows), then the
        // shared file fills in whatever is still missing.
        await hydratePublicArtwork();
        await applySharedCovers(state.publicTracks);
        return state.publicTracks;
      }
    } catch { state.cloudAvailable = false; }
  }
  return state.publicTracks;
}

/* Upload a local track to the shared library: cloud first, then the server. */
export async function shareTrack(track, { onStatus } = {}) {
  if (!track?.blob) throw new Error('This track has no local audio to share.');
  // Publishing to a shared library is the last chance to get the identity right,
  // so an untagged song is listened to before its metadata is uploaded.
  if (needsRecognition(track)) {
    try { await recognizeTrack(track, { onStatus }); } catch { /* publish what we have */ }
  }
  const meta = {
    name: track.name, title: track.title, artist: track.artist, albumArtist: track.albumArtist,
    album: track.album, genre: track.genre, year: track.year, composer: track.composer,
    trackNumber: track.trackNumber, discNumber: track.discNumber, bpm: track.bpm, duration: track.duration,
  };
  /* Cloud upload is the only route now — the shared library lives in Supabase
     storage, and the app must work on a device with nothing else running. */
  const uploaded = await cloudUploadTrack(track.blob, meta, onStatus);
  state.publicTracks = [uploaded, ...state.publicTracks.filter(t => t.id !== uploaded.id)];
  return uploaded;
}

/* ---------------------- AI song recognition (AudD) ----------------------
   The AudD key ships with the app, so recognition works on every device with
   no setup and no server: the page posts the clip straight to AudD, which
   answers with CORS-open headers (Access-Control-Allow-Origin: *, on both the
   preflight and the POST) so a cross-origin call from the browser is allowed.

   It is a free, shared key, so it is deliberately public and may be rate
   limited. Set AUDD_TOKEN in the environment to run the server proxy on your
   own account; the server also stays wired up as a fallback for networks that
   block the direct cross-origin call. */

const AUDD_TOKEN = '7b523b16dda42f0e79c49c3f0c4e52ac';
const AUDD_ENDPOINT = 'https://api.audd.io/';

/* The key is built in, so recognition is always available — no probe needed.
   Kept async because callers await it. */
export async function identifyAvailable() {
  return Boolean(AUDD_TOKEN);
}

/* Normalise an AudD reply. AudD answers 200 with an `error` object for things
   like an invalid or exhausted token, so surface that as a real error instead
   of dressing it up as "no match", which would send you hunting for a better
   clip. */
function auddReply(data, status) {
  if (data && data.error) {
    throw new Error(data.error.error_message || `AudD error ${data.error.error_code || ''}`.trim());
  }
  if (status >= 400) throw new Error(`Recognition failed (${status})`);
  return (data && data.result) || null;
}

function auddForm(blob) {
  const form = new FormData();
  form.append('api_token', AUDD_TOKEN);
  form.append('file', blob, 'wavefy-clip.webm');
  // Ask for the streaming links as well, so a match can actually be played.
  form.append('return', 'apple_music,spotify');
  return form;
}

export async function identifyClip(blob) {
  // Straight to AudD from the page: no server, no configuration. AudD answers
  // with CORS-open headers on both the preflight and the POST, which is what
  // makes this possible at all.
  try {
    const res = await fetch(AUDD_ENDPOINT, { method: 'POST', body: auddForm(blob) });
    const data = await res.json().catch(() => null);
    return auddReply(data, res.status);
  } catch (err) {
    // A TypeError means no reply arrived at all (offline, DNS, CORS blocked).
    // Say that plainly instead of passing on fetch's opaque "Failed to fetch".
    if (err instanceof TypeError) throw new Error('Could not reach the recognition service — check your connection.');
    throw err;
  }
}

/* Shape an AudD match into something the queue, the player and the library rows
   all understand. Marked public so it never lands in "Your songs", but it is
   not added to the shared library — it is just a match you can play. */
export function trackFromMatch(match) {
  if (!match) return null;
  const apple = match.apple_music || {};
  const spotify = match.spotify || {};
  const preview = (Array.isArray(apple.previews) && apple.previews[0] && apple.previews[0].url)
    || spotify.preview_url
    || '';
  const artist = match.artist || '';
  const title = match.title || 'Unknown title';
  return normalizeTrack({
    id: uid('match'),
    isPublic: true,
    cloud: false,
    source: 'ai',
    title,
    artist,
    album: match.album || '',
    publicUrl: preview,
    url: preview,
    previewUrl: preview,
    name: `${artist || 'track'} - ${title}.audio`,
    addedAt: Date.now(),
  });
}

/* ------------------- automatic recognition on upload --------------------
   A file that arrives with no usable tags (or with tags guessed from its
   filename) gets listened to: we cut a short clip out of the audio, ask AudD,
   and write the real title, artist and album back onto the track before the
   cover and lyrics lookups run — so those lookups finally have something
   accurate to search for. */

let identifyReady = null;
export function recognitionEnabled() {
  if (!identifyReady) identifyReady = identifyAvailable().catch(() => false);
  return identifyReady;
}

/* True when a track's identity came from its filename or is a placeholder, and
   therefore is worth listening to. Well-tagged files are left alone: their tags
   describe the release you actually own, which a fingerprint cannot. */
export function needsRecognition(track) {
  if (!track || !track.blob) return false;
  if (track.source === 'ai' || track.metaSource === 'ai') return false;
  if (track.metaSource !== 'tags') return true;
  return isJunkArtist(track.artist);
}

/* Decode the file and re-encode a mono WAV slice. Re-encoding rather than
   slicing raw bytes means any format the browser can decode works — cutting a
   container format (m4a, flac, ogg) at an arbitrary byte offset would produce
   something AudD cannot read at all. */
export async function recognitionClip(file, { seconds = 12, from = 0.3 } = {}) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  // Decoding holds the whole track in memory, so skip anything huge rather
  // than risk killing a phone's tab.
  if (!Ctx || file.size > 40 * 1024 * 1024) return null;
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    const rate = 16000;
    const wanted = Math.min(Math.round(seconds * decoded.sampleRate), decoded.length);
    const offset = Math.max(0, Math.round((decoded.length - wanted) * from));
    const out = new Float32Array(Math.round(wanted * rate / decoded.sampleRate));
    const channels = decoded.numberOfChannels;
    for (let ch = 0; ch < channels; ch++) {
      const data = decoded.getChannelData(ch);
      for (let i = 0; i < out.length; i++) {
        const src = offset + Math.round(i * decoded.sampleRate / rate);
        if (src < data.length) out[i] += data[src] / channels;
      }
    }
    return pcmToWav(out, rate);
  } catch {
    // Undecodable format: hand over the original when it is small enough for
    // the server's identify limit, otherwise give up quietly.
    return file.size <= 8 * 1024 * 1024 ? file : null;
  } finally { try { ctx.close(); } catch { /* already closed */ } }
}

function pcmToWav(samples, rate) {
  const view = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const ascii = (at, text) => { for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0, at = 44; i < samples.length; i++, at += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(at, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([view.buffer], { type: 'audio/wav' });
}

/* Write an AudD match onto a track, without clobbering anything it already has. */
function applyMatch(track, match) {
  const apple = match.apple_music || {};
  const spotify = match.spotify || {};
  if (match.title) track.title = match.title;
  if (match.artist) { track.artist = match.artist; track.albumArtist = match.albumArtist || match.artist; }
  if (match.album) track.album = match.album;
  const year = Number(String(match.release_date || '').slice(0, 4));
  if (year) track.year = year;
  track.recognizedAt = Date.now();
  track.metaSource = 'ai';
  track.matchSource = match.song_link || apple.url || spotify.external_urls?.spotify || '';
  return track;
}

/* Listen to one track and fill in what it really is. Returns true if the
   identity was improved. Best-effort: a failure leaves the track untouched. */
export async function recognizeTrack(track, { onStatus } = {}) {
  if (!track?.blob) return false;
  if (!(await recognitionEnabled())) return false;
  if (onStatus) onStatus('Identifying the song…');
  const clip = await recognitionClip(track.blob);
  if (!clip) return false;
  const match = await identifyClip(clip);
  if (!match) return false;
  applyMatch(track, match);
  if (!isPublicTrack(track)) await saveTrack(track);
  notifyTrackUpdated(track);
  return true;
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

/* Stop and clear everything. The mini player's swipe-to-dismiss calls this, so
   dismissing leaves no half-alive "paused but still loaded" state behind a
   pill that has animated away — and the OS now-playing card clears with it. */
export function stopPlayback() {
  try { audio.pause(); } catch { /* nothing was loaded */ }
  try {
    audio.removeAttribute('src');
    audio.load();
  } catch { /* no-op on the engines that dislike this */ }
  currentTrack = null;
  queue = [];
  queueIndex = -1;
  emit('track', null);
  emit('state', { playing: false });
  if (typeof navigator !== 'undefined' && navigator.mediaSession) {
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = 'none';
    } catch { /* unsupported */ }
  }
}

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
  if (!hasCover(track) && track.artworkLookupFailed !== true) lookupArtwork(track).then(() => lookupLyrics(track));
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

/* ---- Deduplication ----
   Removes duplicate tracks from the local library. Two tracks are considered
   duplicates if they share the same title + artist (case-insensitive, trimmed).
   When both a local and a cloud version exist, the cloud version wins.
   Returns { removed, kept } so the UI can report what happened. */
function normKey(t) { return `${(t.title || '').trim().toLowerCase()}|${(t.artist || '').trim().toLowerCase()}`; }

export function deduplicateLibrary() {
  const st = state;
  const all = [...st.publicTracks, ...st.tracks];
  const seen = new Map();  // key → track (the winner)
  const toRemove = [];     // ids to delete from IndexedDB

  for (const t of all) {
    const k = normKey(t);
    const existing = seen.get(k);
    if (!existing) {
      seen.set(k, t);
    } else {
      // Cloud beats local; if both same type, newer wins
      const keepCloud = isPublicTrack(t) && !isPublicTrack(existing);
      const keepLocal = !isPublicTrack(t) && isPublicTrack(existing);
      const keepNewer = (t.addedAt || 0) > (existing.addedAt || 0);
      if (keepCloud || (keepNewer && !keepLocal)) {
        toRemove.push(existing.id);
        seen.set(k, t);
      } else {
        toRemove.push(t.id);
      }
    }
  }

  if (!toRemove.length) return { removed: 0, kept: all.length, cloudRemoved: 0 };

  const removeSet = new Set(toRemove);
  const cloudRemoved = toRemove.filter(id => st.publicTracks.some(t => t.id === id));
  st.tracks = st.tracks.filter(t => !removeSet.has(t.id));
  st.publicTracks = st.publicTracks.filter(t => !removeSet.has(t.id));

  // Persist removals from IndexedDB
  for (const id of toRemove) dbDelete(DB_TRACKS, id).catch(() => {});
  // Remove cloud duplicates from the manifest
  if (cloudRemoved.length) cloudRemoveTracks(cloudRemoved).catch(() => {});

  return { removed: toRemove.length, kept: st.tracks.length + st.publicTracks.length, cloudRemoved: cloudRemoved.length };
}

/* Restore last session's library on boot. */
export async function boot() {
  rememberBuild();
  await initStore();
  state.tracks = await loadLocalTracks();
  await loadPublicTracks();
  /* Which albums are really compilations has to be known before a single cover
     is looked up: it decides both what is sent to the catalogues and which
     candidates are allowed to win. Then the covers those old rules already
     stored are thrown away, once. */
  registerCompilationAlbums(allTracks());
  purgeCompilationCovers(allTracks());
  /* Then, off the critical path, turn the addresses we just painted from into
     bytes we own: local copies for instant repaints and offline, plus a mirror
     in the bucket so no device has to visit a catalogue again. Queued behind a
     short idle so it never competes with the first paint. */
  whenIdle(() => { hydrateCoverBytes(allTracks()).catch(() => {}); });
  return {
    local: state.tracks,
    public: state.publicTracks,
    build: BUILD,
  };
}
