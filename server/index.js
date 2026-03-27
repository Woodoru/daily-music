// server/index.js
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const { queries, voteQueries, scrapeLogQueries } = require('./db');

// ─────────────────────────────────────────────────────────────────────────────
//  PIPELINE MODE
//  Currently using: FREE (MusicBrainz + Album of the Year, no API key needed)
//
//  SWITCHING TO AI PIPELINE IN THE FUTURE:
//  When you want to use the Claude-powered AI scraper instead:
//
//  1. Make sure ANTHROPIC_API_KEY is set in your .env file
//  2. Change the two lines below from "free" mode to "ai" mode:
//
//     CHANGE THIS:
//       const { fetchFreeReleases, fetchFullYearBackfill } = require('./scraper-free');
//       const USE_AI_PIPELINE = false;
//
//     TO THIS:
//       const { scrapeAll }       = require('./scraper');
//       const { extractReleases } = require('./extractor');
//       const USE_AI_PIPELINE = true;
//
//  That's it — no other changes needed anywhere.
// ─────────────────────────────────────────────────────────────────────────────

const { fetchFreeReleases, fetchFullYearBackfill } = require('./scraper-free');
const USE_AI_PIPELINE = false;

// AI pipeline modules — only loaded when USE_AI_PIPELINE is true
let scrapeAll, extractReleases;
if (USE_AI_PIPELINE) {
  ({ scrapeAll }       = require('./scraper'));
  ({ extractReleases } = require('./extractor'));
}

// Track backfill progress so the frontend can show a loading state
const pipelineStatus = {
  state:    'idle',   // 'idle' | 'running' | 'done' | 'error'
  label:    '',
  added:    0,
  total:    0,
  started:  null,
};

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── MIDDLEWARE ────────────────────────────────────────────────────────────

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ─── HELPER ───────────────────────────────────────────────────────────────

function getClientIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '127.0.0.1'
  );
}

// ─── RELEASES ─────────────────────────────────────────────────────────────

app.get('/api/releases', (req, res) => {
  const { date, month } = req.query;
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    return res.json(queries.byDate(date));
  }
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month))
      return res.status(400).json({ error: 'Invalid month format. Use YYYY-MM.' });
    return res.json(queries.byMonth(month));
  }
  return res.status(400).json({ error: 'Provide ?date=YYYY-MM-DD or ?month=YYYY-MM' });
});

app.get('/api/releases/top-today', (req, res) => {
  const today = new Date();
  const pad   = n => String(n).padStart(2, '0');
  const date  = `${today.getFullYear()}-${pad(today.getMonth()+1)}-${pad(today.getDate())}`;
  const top   = queries.topToday(date);
  if (!top) return res.status(404).json({ error: 'No releases today.' });
  res.json(top);
});

app.get('/api/releases/:id', (req, res) => {
  const release = queries.byId(req.params.id);
  if (!release) return res.status(404).json({ error: 'Release not found.' });
  res.json(release);
});

app.post('/api/releases', (req, res) => {
  const { title, artist, type, release_date, genre, tags, label, duration, cover_url } = req.body;
  if (!title || !artist || !type || !release_date || !genre)
    return res.status(400).json({ error: 'title, artist, type, release_date, and genre are required.' });
  if (!['Single','Album','EP'].includes(type))
    return res.status(400).json({ error: 'type must be Single, Album, or EP.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(release_date))
    return res.status(400).json({ error: 'release_date must be YYYY-MM-DD.' });
  try {
    const release = queries.insert({ title, artist, type, release_date, genre, tags, label, duration, cover_url });
    res.status(201).json(release);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/releases/:id', (req, res) => {
  const ok = queries.delete(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Release not found.' });
  res.json({ ok: true });
});

// ─── RATINGS ──────────────────────────────────────────────────────────────

app.post('/api/ratings', (req, res) => {
  const { release_id, score } = req.body;
  const ip = getClientIP(req);
  if (!release_id) return res.status(400).json({ error: 'release_id is required.' });
  const scoreNum = parseInt(score, 10);
  if (isNaN(scoreNum) || scoreNum < 1 || scoreNum > 5)
    return res.status(400).json({ error: 'score must be an integer between 1 and 5.' });
  const release = queries.byId(release_id);
  if (!release) return res.status(404).json({ error: 'Release not found.' });
  const result = voteQueries.submit(release_id, ip, scoreNum);
  if (!result.ok) {
    if (result.error === 'already_voted')
      return res.status(409).json({ error: 'You have already rated this release.' });
    return res.status(500).json({ error: 'Failed to submit vote.' });
  }
  res.json({ ok: true, release: queries.byId(release_id) });
});

app.get('/api/ratings/check', (req, res) => {
  const { release_id } = req.query;
  if (!release_id) return res.status(400).json({ error: 'release_id is required.' });
  res.json({ voted: voteQueries.hasVoted(release_id, getClientIP(req)) });
});

// ─── STATUS ───────────────────────────────────────────────────────────────
// Frontend polls this to show a loading indicator during backfill

app.get('/api/status', (req, res) => {
  const count = (() => {
    try { return queries.db ? require('./db').db.prepare('SELECT COUNT(*) AS n FROM releases').get().n : 0; }
    catch(_) { return 0; }
  })();
  res.json({ ...pipelineStatus, releaseCount: count });
});

// ─── SEARCH & FILTER ──────────────────────────────────────────────────────

/**
 * GET /api/search?q=radiohead&genre=Rock&type=Album&year=2026&sort=date_desc&limit=50&offset=0
 * Full-text search + multi-filter across all releases.
 */
app.get('/api/search', (req, res) => {
  const { q, genre, type, year, sort, limit = 50, offset = 0 } = req.query;
  try {
    const result = queries.search({
      q, genre, type,
      year:   year   ? parseInt(year)   : null,
      sort:   sort   || 'date_desc',
      limit:  Math.min(parseInt(limit)  || 50, 200),
      offset: parseInt(offset) || 0,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/genres
 * Returns list of genres present in DB, sorted by frequency.
 */
app.get('/api/genres', (req, res) => {
  res.json(queries.genres());
});

// ─── CATCH-ALL → frontend ─────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// ─── DATA PIPELINE ────────────────────────────────────────────────────────

/** Save an array of releases to DB, skip duplicates. Returns { added, skipped } */
function saveReleases(releases) {
  let added = 0, skipped = 0;
  for (const r of releases) {
    if (queries.findByTitleArtist(r.title, r.artist)) { skipped++; continue; }
    try {
      queries.insert(r);
      added++;
    } catch (e) {
      console.warn('[pipeline] Insert failed:', r.title, '-', e.message);
      skipped++;
    }
  }
  return { added, skipped };
}

async function runFreePipeline(isBackfill = false) {
  const year     = new Date().getFullYear();
  const releases = isBackfill
    ? await fetchFullYearBackfill(year)
    : await fetchFreeReleases();
  const { added, skipped } = saveReleases(releases);
  return { articles: releases.length, extracted: releases.length, added, skipped, sourcesOk: 2, sourcesErr: 0 };
}

async function runAIPipeline() {
  const { articles, sourceResults } = await scrapeAll();
  const sourcesOk  = sourceResults.filter(s => s.status === 'ok').length;
  const sourcesErr = sourceResults.filter(s => s.status === 'error').length;
  if (!articles.length)
    return { articles: 0, extracted: 0, added: 0, skipped: 0, sourcesOk, sourcesErr };
  const extracted = await extractReleases(articles);
  let added = 0, skipped = 0;
  for (const r of extracted) {
    if (!r.release_date)                               { skipped++; continue; }
    if (queries.findByTitleArtist(r.title, r.artist))  { skipped++; continue; }
    try {
      queries.insert({
        title: r.title, artist: r.artist, type: r.type,
        release_date: r.release_date, genre: r.genre || 'Unknown',
        tags: r.tags || [], source: 'scrape',
      });
      added++;
    } catch (e) { skipped++; }
  }
  return { articles: articles.length, extracted: extracted.length, added, skipped, sourcesOk, sourcesErr };
}

// ─── BACKGROUND SCHEDULER ─────────────────────────────────────────────────

function startScheduler() {
  const INTERVAL_MS  = 24 * 60 * 60 * 1000; // 24 hours
  const mode         = USE_AI_PIPELINE ? 'AI' : 'free';

  async function doRun(label, isBackfill = false) {
    console.log(`[scheduler] Starting ${label} (${mode} pipeline)...`);
    pipelineStatus.state   = 'running';
    pipelineStatus.label   = label;
    pipelineStatus.started = new Date().toISOString();
    pipelineStatus.added   = 0;

    try {
      const r = USE_AI_PIPELINE
        ? await runAIPipeline()
        : await runFreePipeline(isBackfill);

      pipelineStatus.state = 'done';
      pipelineStatus.added = r.added;
      console.log(`[scheduler] ${label} done — ${r.extracted} found → +${r.added} saved, ${r.skipped} skipped`);
      scrapeLogQueries.insert({
        status: 'ok', sources_ok: r.sourcesOk, sources_err: r.sourcesErr,
        articles: r.articles, extracted: r.extracted,
        added: r.added, skipped: r.skipped,
        message: `${label} (${mode})`,
      });
    } catch (e) {
      pipelineStatus.state = 'error';
      console.error(`[scheduler] ${label} failed:`, e.message);
      scrapeLogQueries.insert({
        status: 'error', sources_ok: 0, sources_err: 0,
        articles: 0, extracted: 0, added: 0, skipped: 0,
        message: e.message,
      });
    }
  }

  // ── Startup logic ──
  // Check how many releases are already in the DB
  const existingCount = (() => {
    try { return require('./db').db.prepare('SELECT COUNT(*) AS n FROM releases').get().n; }
    catch (_) { return 0; }
  })();

  if (existingCount < 20) {
    // Empty or near-empty DB — run a full-year backfill first
    console.log(`[scheduler] DB has ${existingCount} releases — running full-year backfill for ${new Date().getFullYear()}...`);
    setTimeout(() => doRun('full-year backfill', true), 5000);

    // After backfill completes (estimate ~10 min for 12 months), schedule daily runs
    // We use a generous delay so daily run doesn't overlap with backfill
    setTimeout(() => {
      doRun('daily run');
      setInterval(() => doRun('daily run'), INTERVAL_MS);
    }, 15 * 60 * 1000); // 15 minutes after startup, then every 24h

  } else {
    // DB already has data — just run a normal daily update
    console.log(`[scheduler] DB has ${existingCount} releases — running daily update in 10s...`);
    setTimeout(() => doRun('daily run'), 10_000);
    setInterval(() => doRun('daily run'), INTERVAL_MS);
  }

  console.log(`[scheduler] Mode: ${mode} | Backfill: ${existingCount < 20 ? 'YES (first run)' : 'no (already populated)'}`);
}

// ─── START ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  const existingCount = (() => {
    try { return require('./db').db.prepare('SELECT COUNT(*) AS n FROM releases').get().n; }
    catch (_) { return 0; }
  })();
  const isFirstRun = existingCount < 20;

  console.log(`
  ╔════════════════════════════════════════════╗
  ║   TUNESCOPE  server running                ║
  ║   http://localhost:${PORT}                    ║
  ║                                            ║
  ║   Pipeline:  ${USE_AI_PIPELINE ? 'AI (Claude)          ' : 'Free (MusicBrainz)   '}  ║
  ║   DB:        ${String(existingCount).padEnd(5)} releases in database  ║
  ║   Startup:   ${isFirstRun ? 'BACKFILL entire year ' : 'daily update in 10s  '}  ║
  ╚════════════════════════════════════════════╝
  `);
  startScheduler();
});
