'use strict';

const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_RECENT_URL = 'https://api.spotify.com/v1/me/player/recently-played?limit=50';
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_24H_MS = 24 * 60 * 60 * 1000;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing Spotify credentials');
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken });
  const res = await fetchImpl(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (res.status === 400 || res.status === 401) {
    throw new Error('Spotify authorization failed (refresh token invalid or expired)');
  }
  if (!res.ok) {
    throw new Error(`Spotify token endpoint returned ${res.status}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error('Spotify token response missing access_token');
  return json.access_token;
}

async function fetchRecentlyPlayed({ accessToken, fetchImpl = fetch, maxRetries = 3 }) {
  let attempt = 0;
  while (true) {
    const res = await fetchImpl(SPOTIFY_RECENT_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || '1');
      if (attempt >= maxRetries) throw new Error('Spotify rate limit exceeded (max retries reached)');
      attempt += 1;
      await sleep(Math.min(retryAfter, 60) * 1000);
      continue;
    }
    if (res.status === 401) throw new Error('Spotify access token rejected');
    if (res.status === 204) return { items: [] };
    if (!res.ok) throw new Error(`Spotify recently-played returned ${res.status}`);
    return res.json();
  }
}

function normalizePlay(item) {
  if (!item || !item.track || !item.played_at) return null;
  const t = item.track;
  const artists = Array.isArray(t.artists) ? t.artists : [];
  const images = (t.album && Array.isArray(t.album.images)) ? t.album.images : [];
  return {
    id: t.id,
    played_at: item.played_at,
    name: t.name || '',
    url: (t.external_urls && t.external_urls.spotify) || (t.id ? `https://open.spotify.com/track/${t.id}` : ''),
    album_image: pickImage(images, 120),
    artists: artists.map((a) => ({
      id: a.id,
      name: a.name || '',
      url: (a.external_urls && a.external_urls.spotify) || (a.id ? `https://open.spotify.com/artist/${a.id}` : ''),
    })).filter((a) => a.name),
  };
}

function pickImage(images, targetPx) {
  if (!images.length) return null;
  const sorted = [...images].sort((a, b) => (a.width || 0) - (b.width || 0));
  for (const img of sorted) if ((img.width || 0) >= targetPx) return img.url;
  return sorted[sorted.length - 1].url;
}

// Merge new items into existing store; dedupe by track_id + played_at; prune > 7 days.
function mergeAndPrune(existing, incoming, now = Date.now()) {
  const map = new Map();
  for (const p of existing) map.set(`${p.id}@${p.played_at}`, p);
  for (const raw of incoming) {
    const p = normalizePlay(raw);
    if (!p || !p.id) continue;
    map.set(`${p.id}@${p.played_at}`, p);
  }
  const cutoff = now - RETENTION_MS;
  const plays = [];
  for (const p of map.values()) {
    const ts = Date.parse(p.played_at);
    if (Number.isFinite(ts) && ts >= cutoff) plays.push(p);
  }
  plays.sort((a, b) => Date.parse(b.played_at) - Date.parse(a.played_at));
  return plays;
}

// Count each credited artist once per play (deduped within a track).
// Rationale: matches how listeners perceive collaborations — every credited
// artist gets one play per track spin, regardless of featured order.
function topArtists(plays, windowMs, now = Date.now(), limit = 5) {
  const cutoff = now - windowMs;
  const counts = new Map();
  for (const p of plays) {
    const ts = Date.parse(p.played_at);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const seen = new Set();
    for (const a of p.artists || []) {
      const key = a.id || a.name;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const prev = counts.get(key) || { id: a.id, name: a.name, url: a.url, plays: 0 };
      prev.plays += 1;
      counts.set(key, prev);
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[c]);
}

function truncate(s, n) {
  s = String(s ?? '');
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

async function fetchImageAsDataUri(url, fetchImpl = fetch) {
  if (!url) return null;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

async function fetchArtistImages({ accessToken, ids, fetchImpl = fetch }) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const out = new Map();
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const url = `https://api.spotify.com/v1/artists?ids=${chunk.join(',')}`;
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') || '1');
      await sleep(Math.min(retryAfter, 60) * 1000);
      i -= 50;
      continue;
    }
    if (!res.ok) continue;
    const json = await res.json();
    for (const a of json.artists || []) {
      if (a && a.id) out.set(a.id, pickImage(a.images || [], 80));
    }
  }
  return out;
}

const PLACEHOLDER_PALETTE = ['#1DB954', '#F97583', '#79B8FF', '#B392F0', '#FFAB70', '#F0C674'];

function initialsFor(name) {
  const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] || '').join('').toUpperCase() || '?';
}

function placeholderTile(name) {
  const initials = escapeXml(initialsFor(name));
  const hash = [...String(name || '')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0);
  const bg = PLACEHOLDER_PALETTE[Math.abs(hash) % PLACEHOLDER_PALETTE.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="8" fill="${bg}"/><text x="50%" y="54%" font-family="-apple-system, Segoe UI, Helvetica, Arial, sans-serif" font-size="28" font-weight="700" fill="#0d1117" text-anchor="middle" dominant-baseline="middle">${initials}</text></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

function buildRecentSvg({ plays, updatedIso }) {
  const rows = plays.slice(0, 5);
  const rowH = 68;
  const width = 480;
  const headerH = 46;
  const footerH = 28;
  const height = headerH + Math.max(1, rows.length) * rowH + footerH;

  const rowSvg = rows.map((p, i) => {
    const y = headerH + i * rowH;
    const img = p._albumDataUri || placeholderTile(p.name);
    const title = escapeXml(truncate(p.name, 42));
    const artist = escapeXml(truncate((p.artists || []).map((a) => a.name).join(', '), 46));
    const href = escapeXml(p.url || 'https://open.spotify.com/');
    return `
    <a href="${href}" target="_blank">
      <g transform="translate(16 ${y})">
        <image href="${img}" width="52" height="52" preserveAspectRatio="xMidYMid slice"/>
        <text class="title" x="66" y="20">${title}</text>
        <text class="artist" x="66" y="40">${artist}</text>
      </g>
    </a>`;
  }).join('');

  const empty = rows.length === 0
    ? `<text class="artist" x="${width / 2}" y="${headerH + 40}" text-anchor="middle">No listening history yet — check back after a few plays.</text>`
    : '';

  return svgShell({
    width,
    height,
    title: '🎧 Recently Played',
    body: rowSvg + empty,
    updatedIso,
  });
}

function buildTopArtistsSvg({ artists, updatedIso, title, imagesById }) {
  const rows = artists.slice(0, 5);
  const rowH = 62;
  const width = 480;
  const headerH = 46;
  const footerH = 28;
  const height = headerH + Math.max(1, rows.length) * rowH + footerH;

  const rowSvg = rows.map((a, i) => {
    const y = headerH + i * rowH;
    const img = (a.id && imagesById.get(a.id)) || placeholderTile(a.name);
    const name = escapeXml(truncate(a.name, 38));
    const plays = `${a.plays} play${a.plays === 1 ? '' : 's'}`;
    const href = escapeXml(a.url || 'https://open.spotify.com/');
    return `
    <a href="${href}" target="_blank">
      <g transform="translate(16 ${y})">
        <image href="${img}" width="46" height="46" preserveAspectRatio="xMidYMid slice"/>
        <text class="title" x="60" y="20">${name}</text>
        <text class="artist" x="60" y="38">${escapeXml(plays)}</text>
      </g>
    </a>`;
  }).join('');

  const empty = rows.length === 0
    ? `<text class="artist" x="${width / 2}" y="${headerH + 40}" text-anchor="middle">No plays in this window yet.</text>`
    : '';

  return svgShell({ width, height, title, body: rowSvg + empty, updatedIso });
}

function svgShell({ width, height, title, body, updatedIso }) {
  const updated = escapeXml(new Date(updatedIso).toUTCString());
  const t = escapeXml(title);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${t}">
  <style><![CDATA[
    .card { fill: #ffffff; stroke: #d0d7de; }
    .title { font: 600 14px -apple-system, Segoe UI, Helvetica, Arial, sans-serif; fill: #1f2328; }
    .artist { font: 400 12px -apple-system, Segoe UI, Helvetica, Arial, sans-serif; fill: #656d76; }
    .header { font: 700 15px -apple-system, Segoe UI, Helvetica, Arial, sans-serif; fill: #1f2328; }
    .footer { font: 400 10px -apple-system, Segoe UI, Helvetica, Arial, sans-serif; fill: #656d76; }
    @media (prefers-color-scheme: dark) {
      .card { fill: #0d1117; stroke: #30363d; }
      .title, .header { fill: #e6edf3; }
      .artist, .footer { fill: #8b949e; }
    }
  ]]></style>
  <rect class="card" x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10"/>
  <text class="header" x="16" y="28">${t}</text>
  ${body}
  <text class="footer" x="${width - 16}" y="${height - 10}" text-anchor="end">Updated ${updated}</text>
</svg>`;
}

module.exports = {
  refreshAccessToken,
  fetchRecentlyPlayed,
  normalizePlay,
  mergeAndPrune,
  topArtists,
  escapeXml,
  truncate,
  fetchImageAsDataUri,
  fetchArtistImages,
  buildRecentSvg,
  buildTopArtistsSvg,
  RETENTION_MS,
  WINDOW_24H_MS,
};
