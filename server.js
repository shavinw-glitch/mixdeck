const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;
const port = Number(process.env.PORT) || 8000;
const host = process.env.HOST || '0.0.0.0';
const musicDir = path.join(root, 'public-music');
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const uploadToken = process.env.UPLOAD_TOKEN || '';
// One shared AudD key for ALL users, set by the server operator. The browser
// never sees or sends it — /api/identify attaches it here before forwarding.
const auddToken = process.env.AUDD_TOKEN || '';
const AUDD_ENDPOINT = 'https://api.audd.io/';
fs.mkdirSync(musicDir, { recursive: true });

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
};
const audioExtensions = new Set(['.mp3', '.m4a', '.wav', '.aac', '.flac', '.ogg', '.opus']);

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  response.end(body);
}
function safeName(value) {
  return path.basename(String(value || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
}
function readRequest(request, limit = MAX_UPLOAD_BYTES + 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', chunk => {
      total += chunk.length;
      if (total > limit) {
        reject(Object.assign(new Error('Upload is too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}
function splitBuffer(buffer, delimiter) {
  const parts = [];
  let start = 0;
  while (start <= buffer.length) {
    const index = buffer.indexOf(delimiter, start);
    if (index < 0) { parts.push(buffer.subarray(start)); break; }
    parts.push(buffer.subarray(start, index));
    start = index + delimiter.length;
  }
  return parts;
}
function parseMultipart(buffer, contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) throw Object.assign(new Error('Missing multipart boundary'), { statusCode: 400 });
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const fields = {};
  const files = {};
  for (const rawPart of splitBuffer(buffer, boundary)) {
    let part = rawPart;
    if (part.length < 8 || part.equals(Buffer.from('--\r\n')) || part.equals(Buffer.from('--'))) continue;
    if (part.subarray(0, 2).equals(Buffer.from('\r\n'))) part = part.subarray(2);
    if (part.subarray(-2).equals(Buffer.from('\r\n'))) part = part.subarray(0, -2);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) continue;
    const headers = part.subarray(0, headerEnd).toString('utf8');
    const content = part.subarray(headerEnd + 4);
    const disposition = headers.match(/content-disposition:\s*form-data;\s*([^\r\n]+)/i)?.[1] || '';
    const name = disposition.match(/name="([^"]+)"/)?.[1];
    const filename = disposition.match(/filename="([^"]*)"/)?.[1];
    if (!name) continue;
    if (filename) files[name] = { filename: safeName(filename), content };
    else fields[name] = content.toString('utf8');
  }
  return { fields, files };
}
function publicTrackFromMeta(meta, id, extension) {
  return {
    id,
    name: meta.name || `shared${extension}`,
    title: meta.title || meta.name || 'Shared track',
    artist: meta.artist || 'Unknown artist',
    albumArtist: meta.albumArtist || meta.artist || 'Unknown artist',
    album: meta.album || '',
    genre: meta.genre || '',
    year: Number(meta.year) || 0,
    composer: meta.composer || '',
    trackNumber: Number(meta.trackNumber) || 0,
    discNumber: Number(meta.discNumber) || 0,
    bpm: Number(meta.bpm) || 0,
    duration: Number(meta.duration) || 0,
    artwork: null,
    lyrics: meta.lyrics || '',
    syncedLyrics: Array.isArray(meta.syncedLyrics) ? meta.syncedLyrics : null,
    lyricsSource: meta.lyricsSource || '',
    isPublic: true,
    downloaded: false,
    publicUrl: `/media/${id}${extension}`,
    uploadedAt: Number(meta.uploadedAt) || Date.now(),
  };
}
function listPublicTracks() {
  return fs.readdirSync(musicDir)
    .filter(name => name.endsWith('.json'))
    .map(name => {
      try { return JSON.parse(fs.readFileSync(path.join(musicDir, name), 'utf8')); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
}
async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const result = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!result.ok) return null;
    return result.json();
  } finally {
    clearTimeout(timer);
  }
}
async function handleLyrics(request, response, searchParams) {
  const title = String(searchParams.get('track_name') || '').trim();
  const artist = String(searchParams.get('artist_name') || '').trim();
  const album = String(searchParams.get('album_name') || '').trim();
  if (!title) return json(response, 400, { error: 'Missing track title' });
  const params = new URLSearchParams({ track_name: title });
  if (artist) params.set('artist_name', artist);
  if (album) params.set('album_name', album);
  let result = await fetchJson(`https://lrclib.net/api/get?${params}`);
  if (Array.isArray(result) && !result.length) result = null;
  if (!result) {
    const search = new URLSearchParams({ q: artist ? `${title} ${artist}` : title });
    result = await fetchJson(`https://lrclib.net/api/search?${search}`);
    if (Array.isArray(result) && !result.length) result = null;
  }
  if (!result && artist) {
    result = await fetchJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
  }
  if (!result) return json(response, 404, { error: 'Lyrics not found' });
  return json(response, 200, result);
}
async function handleArtwork(request, response, searchParams) {
  const title = String(searchParams.get('title') || '').trim();
  const artist = String(searchParams.get('artist') || '').trim();
  const album = String(searchParams.get('album') || '').trim();
  if (!title && !artist) return json(response, 400, { error: 'Missing track title' });
  const term = [title, artist, album].filter(Boolean).join(' ');
  const params = new URLSearchParams({ term, media: 'music', entity: 'song', limit: '25' });
  const data = await fetchJson(`https://itunes.apple.com/search?${params}`);
  const results = Array.isArray(data && data.results)
    ? data.results.filter(r => r && r.artworkUrl100).map(r => ({
        trackName: r.trackName,
        artistName: r.artistName,
        collectionName: r.collectionName,
        artworkUrl: String(r.artworkUrl100).replace(/100x100bb\./, '600x600bb.'),
      }))
    : [];
  if (!results.length) return json(response, 404, { error: 'Artwork not found' });
  return json(response, 200, results);
}
async function handleIdentify(request, response) {
  if (!auddToken) return json(response, 503, { error: 'AI recognition is not configured on this server' });
  const contentType = request.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return json(response, 415, { error: 'Use multipart/form-data' });
  try {
    const body = await readRequest(request, 12 * 1024 * 1024);
    const { fields, files } = parseMultipart(body, contentType);
    const file = files.file || files.audio;
    if (!file || !file.content.length) return json(response, 400, { error: 'Send an audio clip to identify' });
    const form = new FormData();
    form.append('api_token', auddToken);
    const extension = path.extname(file.filename).toLowerCase();
    form.append('file', new Blob([file.content], { type: mimeTypes[extension] || 'audio/mpeg' }), file.filename);
    if (fields.return) form.append('return', String(fields.return));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const upstream = await fetch(AUDD_ENDPOINT, { method: 'POST', body: form, signal: controller.signal });
      const data = await upstream.json().catch(() => null);
      if (!data) return json(response, 502, { error: 'AudD returned an unreadable response' });
      return json(response, 200, data);
    } finally { clearTimeout(timer); }
  } catch (error) {
    return json(response, 500, { error: 'Could not reach AudD — try again' });
  }
}
async function handleUpload(request, response) {
  if (uploadToken && request.headers['x-upload-token'] !== uploadToken) return json(response, 401, { error: 'Invalid upload token' });
  const contentType = request.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return json(response, 415, { error: 'Use multipart/form-data' });
  try {
    const body = await readRequest(request);
    const { fields, files } = parseMultipart(body, contentType);
    const file = files.audio;
    if (!file || !file.content.length) return json(response, 400, { error: 'Choose an audio file' });
    if (file.content.length > MAX_UPLOAD_BYTES) return json(response, 413, { error: 'Maximum upload size is 100 MB' });
    const extension = path.extname(file.filename).toLowerCase();
    if (!audioExtensions.has(extension)) return json(response, 415, { error: 'Unsupported audio format' });
    let meta = {};
    try { meta = JSON.parse(fields.metadata || '{}'); } catch { return json(response, 400, { error: 'Invalid track metadata' }); }
    const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
    const track = publicTrackFromMeta({ ...meta, name: file.filename }, id, extension);
    fs.writeFileSync(path.join(musicDir, `${id}${extension}`), file.content);
    fs.writeFileSync(path.join(musicDir, `${id}.json`), JSON.stringify(track, null, 2));
    return json(response, 201, track);
  } catch (error) {
    return json(response, error.statusCode || 500, { error: error.message || 'Upload failed' });
  }
}
function serveMedia(request, response, pathname) {
  const name = safeName(pathname.replace(/^\/media\//, ''));
  if (!name || name.includes('..')) return response.end('Not found');
  const filePath = path.join(musicDir, name);
  if (!fs.existsSync(filePath) || !audioExtensions.has(path.extname(filePath).toLowerCase())) {
    response.writeHead(404); return response.end('Not found');
  }
  const stat = fs.statSync(filePath);
  const type = mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
    return fs.createReadStream(filePath).pipe(response);
  }
  const match = range.match(/bytes=(\d*)-(\d*)/);
  if (!match) { response.writeHead(416); return response.end(); }
  const start = match[1] ? Number(match[1]) : Math.max(0, stat.size - Number(match[2] || 1));
  const end = match[2] ? Number(match[2]) : stat.size - 1;
  if (start > end || start >= stat.size) { response.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return response.end(); }
  response.writeHead(206, {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=3600',
    'Access-Control-Allow-Origin': '*',
  });
  return fs.createReadStream(filePath, { start, end }).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const requestedPath = decodeURIComponent(request.url.split('?')[0]);
  if (request.method === 'OPTIONS' && requestedPath.startsWith('/api/')) {
    response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',    'Access-Control-Allow-Headers': 'Content-Type, X-Upload-Token' });
    return response.end();
  }
  if (request.method === 'GET' && requestedPath === '/api/public-tracks') return json(response, 200, listPublicTracks());
  if (request.method === 'GET' && requestedPath === '/api/lyrics') return handleLyrics(request, response, new URL(request.url, `http://${request.headers.host || 'localhost'}`).searchParams);
  if (request.method === 'GET' && requestedPath === '/api/artwork') return handleArtwork(request, response, new URL(request.url, `http://${request.headers.host || 'localhost'}`).searchParams);
  if (request.method === 'GET' && requestedPath === '/api/identify-status') return json(response, 200, { enabled: Boolean(auddToken) });
  if (request.method === 'POST' && requestedPath === '/api/identify') return handleIdentify(request, response);
  if (request.method === 'POST' && requestedPath === '/api/upload') return handleUpload(request, response);
  if (request.method === 'GET' && requestedPath.startsWith('/media/')) return serveMedia(request, response, requestedPath);

  const relativePath = requestedPath === '/' ? 'index.html' : requestedPath.replace(/^\/+/, '');
  const filePath = path.resolve(root, relativePath);
  if (!filePath.startsWith(root + path.sep)) {
    response.writeHead(403); return response.end('Forbidden');
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      return response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
    }
    response.writeHead(200, { 'Content-Type': mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    response.end(content);
  });
});

server.listen(port, host, () => {
  console.log(`Mixdeck is running at http://localhost:${port}`);
  console.log('On your iPhone, use your PC IPv4 address from ipconfig instead of localhost.');
  console.log(`Shared uploads are stored in ${musicDir}`);
});
