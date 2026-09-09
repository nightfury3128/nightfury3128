#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  refreshAccessToken,
  fetchRecentlyPlayed,
  mergeAndPrune,
  topArtists,
  fetchImageAsDataUri,
  fetchArtistImages,
  buildRecentSvg,
  buildTopArtistsSvg,
  WINDOW_24H_MS,
  RETENTION_MS,
} = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const STORE_PATH = path.join(ROOT, 'data', 'spotify-plays.json');
const README_PATH = path.join(ROOT, 'README.md');
const OUT_RECENT = path.join(ROOT, 'spotify-recent.svg');
const OUT_TOP_24H = path.join(ROOT, 'spotify-top-artists-24h.svg');
const OUT_TOP_7D = path.join(ROOT, 'spotify-top-artists-7d.svg');

function loadStore() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeIfChanged(file, content) {
  try {
    if (fs.readFileSync(file, 'utf8') === content) return false;
  } catch { /* file missing → write */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

function replaceReadmeBlock(readme, marker, block) {
  const re = new RegExp(`(<!--${marker}:start-->)[\\s\\S]*?(<!--${marker}:end-->)`);
  if (!re.test(readme)) return readme;
  return readme.replace(re, `$1\n${block}\n$2`);
}

async function main() {
  const {
    SPOTIFY_CLIENT_ID: clientId,
    SPOTIFY_CLIENT_SECRET: clientSecret,
    SPOTIFY_REFRESH_TOKEN: refreshToken,
  } = process.env;

  const accessToken = await refreshAccessToken({ clientId, clientSecret, refreshToken });
  const response = await fetchRecentlyPlayed({ accessToken });
  const incoming = response.items || [];
  console.log(`Fetched ${incoming.length} recently-played items from Spotify`);

  const existing = loadStore();
  const now = Date.now();
  const plays = mergeAndPrune(existing, incoming, now);
  console.log(`Store: ${existing.length} -> ${plays.length} plays after merge/prune`);

  const storeChanged = writeIfChanged(STORE_PATH, JSON.stringify(plays, null, 2) + '\n');
  const updatedIso = new Date(now).toISOString();

  const recent5 = plays.slice(0, 5);
  const recentWithImages = await Promise.all(recent5.map(async (p) => ({
    ...p,
    _albumDataUri: await fetchImageAsDataUri(p.album_image),
  })));

  const top24h = topArtists(plays, WINDOW_24H_MS, now, 5);
  const top7d = topArtists(plays, RETENTION_MS, now, 5);

  const artistIds = [...new Set([...top24h, ...top7d].map((a) => a.id).filter(Boolean))];
  const artistImageUrls = await fetchArtistImages({ accessToken, ids: artistIds });
  const artistImageDataUris = new Map();
  for (const [id, url] of artistImageUrls.entries()) {
    const uri = await fetchImageAsDataUri(url);
    if (uri) artistImageDataUris.set(id, uri);
  }

  const svgRecent = buildRecentSvg({ plays: recentWithImages, updatedIso });
  const svg24h = buildTopArtistsSvg({
    artists: top24h,
    updatedIso,
    title: '🔥 Top Artists — Last 24 Hours',
    imagesById: artistImageDataUris,
  });
  const svg7d = buildTopArtistsSvg({
    artists: top7d,
    updatedIso,
    title: '📈 Top Artists — Last 7 Days',
    imagesById: artistImageDataUris,
  });

  const changed = [
    writeIfChanged(OUT_RECENT, svgRecent),
    writeIfChanged(OUT_TOP_24H, svg24h),
    writeIfChanged(OUT_TOP_7D, svg7d),
    storeChanged,
  ];

  let readmeChanged = false;
  try {
    const readme = fs.readFileSync(README_PATH, 'utf8');
    const block = [
      '<a href="https://open.spotify.com/"><img alt="Recently played on Spotify" src="./spotify-recent.svg" /></a>',
      '<a href="https://open.spotify.com/"><img alt="Top artists — last 24 hours" src="./spotify-top-artists-24h.svg" /></a>',
      '<a href="https://open.spotify.com/"><img alt="Top artists — last 7 days" src="./spotify-top-artists-7d.svg" /></a>',
    ].join('\n');
    const updated = replaceReadmeBlock(readme, 'SPOTIFY', block);
    if (updated !== readme) {
      fs.writeFileSync(README_PATH, updated);
      readmeChanged = true;
    }
  } catch (err) {
    console.warn('README update skipped:', err.message);
  }

  const anyChange = changed.some(Boolean) || readmeChanged;
  console.log(anyChange ? 'Spotify cards generated with changes' : 'No changes detected');
}

main().catch((err) => {
  console.error('Spotify update failed:', err.message);
  process.exit(1);
});
