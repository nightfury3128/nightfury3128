'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  mergeAndPrune,
  topArtists,
  escapeXml,
  buildRecentSvg,
  buildTopArtistsSvg,
  WINDOW_24H_MS,
  RETENTION_MS,
} = require('./lib');

const NOW = Date.parse('2026-09-09T12:00:00.000Z');

function rawItem({ trackId, playedAt, name = 'T', artistId = 'A1', artistName = 'Alice', extraArtists = [] }) {
  return {
    played_at: playedAt,
    track: {
      id: trackId,
      name,
      external_urls: { spotify: `https://open.spotify.com/track/${trackId}` },
      album: { images: [{ width: 300, url: 'https://img/300' }, { width: 64, url: 'https://img/64' }] },
      artists: [
        { id: artistId, name: artistName, external_urls: { spotify: `https://open.spotify.com/artist/${artistId}` } },
        ...extraArtists,
      ],
    },
  };
}

test('mergeAndPrune dedupes by track_id + played_at', () => {
  const a = rawItem({ trackId: 't1', playedAt: '2026-09-09T11:00:00Z' });
  const b = rawItem({ trackId: 't1', playedAt: '2026-09-09T11:00:00Z' });
  const merged = mergeAndPrune([], [a, b], NOW);
  assert.equal(merged.length, 1);
});

test('mergeAndPrune keeps distinct plays of the same track at different times', () => {
  const a = rawItem({ trackId: 't1', playedAt: '2026-09-09T11:00:00Z' });
  const b = rawItem({ trackId: 't1', playedAt: '2026-09-09T09:00:00Z' });
  const merged = mergeAndPrune([], [a, b], NOW);
  assert.equal(merged.length, 2);
});

test('mergeAndPrune drops plays older than 7 days', () => {
  const fresh = rawItem({ trackId: 't1', playedAt: '2026-09-09T11:00:00Z' });
  const old = rawItem({ trackId: 't2', playedAt: '2026-09-01T11:00:00Z' });
  const merged = mergeAndPrune([], [fresh, old], NOW);
  assert.deepEqual(merged.map((p) => p.id), ['t1']);
});

test('mergeAndPrune preserves existing plays and merges new', () => {
  const existing = [{
    id: 't0', played_at: '2026-09-09T10:00:00.000Z', name: 'Old', url: '', album_image: null,
    artists: [{ id: 'A0', name: 'Zed', url: '' }],
  }];
  const incoming = [rawItem({ trackId: 't1', playedAt: '2026-09-09T11:00:00Z' })];
  const merged = mergeAndPrune(existing, incoming, NOW);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 't1');
});

test('topArtists 24h window excludes plays older than 24h', () => {
  const plays = [
    { id: 't1', played_at: '2026-09-09T11:00:00Z', artists: [{ id: 'A1', name: 'Alice', url: '' }] },
    { id: 't2', played_at: '2026-09-07T11:00:00Z', artists: [{ id: 'A2', name: 'Bob', url: '' }] },
  ];
  const top = topArtists(plays, WINDOW_24H_MS, NOW);
  assert.deepEqual(top.map((a) => a.name), ['Alice']);
});

test('topArtists 24h boundary is inclusive at exactly -24h', () => {
  const at = new Date(NOW - WINDOW_24H_MS).toISOString();
  const justOutside = new Date(NOW - WINDOW_24H_MS - 1).toISOString();
  const plays = [
    { id: 't1', played_at: at, artists: [{ id: 'A1', name: 'In', url: '' }] },
    { id: 't2', played_at: justOutside, artists: [{ id: 'A2', name: 'Out', url: '' }] },
  ];
  const top = topArtists(plays, WINDOW_24H_MS, NOW);
  assert.deepEqual(top.map((a) => a.name), ['In']);
});

test('topArtists counts every credited artist once per play', () => {
  const plays = [
    { id: 't1', played_at: '2026-09-09T11:00:00Z', artists: [
      { id: 'A1', name: 'Alice', url: '' },
      { id: 'A2', name: 'Bob', url: '' },
    ]},
    { id: 't2', played_at: '2026-09-09T11:30:00Z', artists: [
      { id: 'A1', name: 'Alice', url: '' },
    ]},
  ];
  const top = topArtists(plays, RETENTION_MS, NOW);
  const alice = top.find((a) => a.name === 'Alice');
  const bob = top.find((a) => a.name === 'Bob');
  assert.equal(alice.plays, 2);
  assert.equal(bob.plays, 1);
});

test('topArtists dedupes same artist appearing twice on one track', () => {
  const plays = [{
    id: 't1', played_at: '2026-09-09T11:00:00Z',
    artists: [
      { id: 'A1', name: 'Alice', url: '' },
      { id: 'A1', name: 'Alice', url: '' },
    ],
  }];
  const top = topArtists(plays, RETENTION_MS, NOW);
  assert.equal(top[0].plays, 1);
});

test('escapeXml escapes special characters', () => {
  assert.equal(escapeXml(`<a>&"'</a>`), '&lt;a&gt;&amp;&quot;&apos;&lt;/a&gt;');
});

test('buildRecentSvg escapes hostile track/artist strings', () => {
  const svg = buildRecentSvg({
    plays: [{
      id: 't1', played_at: '2026-09-09T11:00:00Z',
      name: '</text><script>alert(1)</script>',
      url: 'https://open.spotify.com/track/t1',
      album_image: null,
      artists: [{ id: 'A1', name: 'A & B', url: '' }],
      _albumDataUri: null,
    }],
    updatedIso: new Date(NOW).toISOString(),
  });
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;/text&gt;'));
  assert.ok(svg.includes('A &amp; B'));
});

test('buildRecentSvg shows empty-state when no plays', () => {
  const svg = buildRecentSvg({ plays: [], updatedIso: new Date(NOW).toISOString() });
  assert.ok(svg.includes('No listening history yet'));
});

test('buildTopArtistsSvg falls back to placeholder when image missing', () => {
  const svg = buildTopArtistsSvg({
    artists: [{ id: 'A1', name: 'Alice', url: 'https://open.spotify.com/artist/A1', plays: 3 }],
    updatedIso: new Date(NOW).toISOString(),
    title: 'Top',
    imagesById: new Map(),
  });
  assert.ok(svg.includes('data:image/svg+xml;base64'));
  assert.ok(svg.includes('3 plays'));
});

test('buildTopArtistsSvg handles empty artist list', () => {
  const svg = buildTopArtistsSvg({
    artists: [], updatedIso: new Date(NOW).toISOString(),
    title: 'Top', imagesById: new Map(),
  });
  assert.ok(svg.includes('No plays in this window yet'));
});
