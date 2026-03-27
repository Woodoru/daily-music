// server/db.js
// Sets up SQLite database with better-sqlite3 (synchronous, great for local dev)

const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

// In production (Railway), set DB_PATH env var to point to a persistent volume.
// Default: local data/ folder for development.
const DB_PATH = process.env.DB_PATH ||
                path.join(__dirname, '../data/tunescope.db');

// Ensure data directory exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// ─── SCHEMA ────────────────────────────────────────────────────────────────

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS releases (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    artist       TEXT NOT NULL,
    type         TEXT NOT NULL CHECK(type IN ('Single','Album','EP')),
    release_date TEXT NOT NULL,
    genre        TEXT NOT NULL,
    tags         TEXT NOT NULL DEFAULT '[]',
    label        TEXT,
    duration     TEXT,
    cover_url    TEXT,
    spotify_id   TEXT UNIQUE,
    source       TEXT DEFAULT 'manual',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS votes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    release_id  TEXT NOT NULL REFERENCES releases(id),
    ip_hash     TEXT NOT NULL,
    score       INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(release_id, ip_hash)
  );

  CREATE TABLE IF NOT EXISTS scrape_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    status      TEXT NOT NULL,           -- 'ok' | 'error'
    sources_ok  INTEGER DEFAULT 0,       -- sources that responded
    sources_err INTEGER DEFAULT 0,       -- sources that failed
    articles    INTEGER DEFAULT 0,       -- relevant articles found
    extracted   INTEGER DEFAULT 0,       -- releases extracted by Claude
    added       INTEGER DEFAULT 0,       -- new releases saved to DB
    skipped     INTEGER DEFAULT 0,       -- duplicates skipped
    message     TEXT,
    scraped_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    source    TEXT NOT NULL,
    status    TEXT NOT NULL,
    added     INTEGER DEFAULT 0,
    skipped   INTEGER DEFAULT 0,
    message   TEXT,
    synced_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_releases_date    ON releases(release_date);
  CREATE INDEX IF NOT EXISTS idx_releases_spotify ON releases(spotify_id);
  CREATE INDEX IF NOT EXISTS idx_votes_release    ON votes(release_id);
`);

// Migrate existing DBs — safe to run repeatedly
try { db.exec('ALTER TABLE releases ADD COLUMN spotify_id TEXT UNIQUE'); } catch (_) {}
try { db.exec("ALTER TABLE releases ADD COLUMN source TEXT DEFAULT 'manual'"); } catch (_) {}

// ─── HELPERS ───────────────────────────────────────────────────────────────

/** Hash an IP address (SHA-256, no salt needed — just for dedup, not security) */
function hashIP(ip) {
  return crypto.createHash('sha256').update(ip || 'unknown').digest('hex');
}

/** Attach aggregate rating info to a release row */
function attachRating(release) {
  const row = db.prepare(`
    SELECT
      COUNT(*)           AS vote_count,
      AVG(score) * 2.0   AS avg_score   -- convert 1-5 → 2-10 scale
    FROM votes
    WHERE release_id = ?
  `).get(release.id);

  return {
    ...release,
    tags: JSON.parse(release.tags || '[]'),
    avg_score:  row.vote_count > 0 ? Math.round(row.avg_score * 10) / 10 : null,
    vote_count: row.vote_count,
  };
}

// ─── RELEASE QUERIES ───────────────────────────────────────────────────────

const queries = {

  /** Get all releases for a specific date */
  byDate(date) {
    const rows = db.prepare('SELECT * FROM releases WHERE release_date = ? ORDER BY title').all(date);
    return rows.map(attachRating);
  },

  /** Get all releases for a month (YYYY-MM) */
  byMonth(yearMonth) {
    const rows = db.prepare(`
      SELECT * FROM releases
      WHERE strftime('%Y-%m', release_date) = ?
      ORDER BY release_date, title
    `).all(yearMonth);
    return rows.map(attachRating);
  },

  /** Get the top-rated release for a specific date */
  topToday(date) {
    const releases = queries.byDate(date);
    if (!releases.length) return null;
    return releases.reduce((best, r) => {
      const s = r.avg_score ?? 0;
      const bs = best.avg_score ?? 0;
      return s > bs ? r : best;
    });
  },

  /** Get a single release by ID */
  byId(id) {
    const row = db.prepare('SELECT * FROM releases WHERE id = ?').get(id);
    return row ? attachRating(row) : null;
  },

  /** Insert a new release */
  insert(release) {
    const stmt = db.prepare(`
      INSERT INTO releases (id, title, artist, type, release_date, genre, tags, label, duration, cover_url, spotify_id, source)
      VALUES (@id, @title, @artist, @type, @release_date, @genre, @tags, @label, @duration, @cover_url, @spotify_id, @source)
    `);
    const id = release.id || crypto.randomUUID();
    stmt.run({
      id,
      title:        release.title,
      artist:       release.artist,
      type:         release.type,
      release_date: release.release_date,
      genre:        release.genre,
      tags:         JSON.stringify(release.tags || []),
      label:        release.label || null,
      duration:     release.duration || null,
      cover_url:    release.cover_url || null,
      spotify_id:   release.spotify_id || null,
      source:       release.source || 'manual',
    });
    return queries.byId(id);
  },


  /** Find by title + artist (case-insensitive), for deduplication */
  findByTitleArtist(title, artist) {
    return db.prepare(`
      SELECT id FROM releases
      WHERE lower(title) = lower(?) AND lower(artist) = lower(?)
      LIMIT 1
    `).get(title, artist);
  },

  /**
   * Search + filter releases.
   * Supports: q (title/artist text), genre, type, year, sort
   */
  search({ q, genre, type, year, sort = 'date_desc', limit = 50, offset = 0 } = {}) {
    const conditions = [];
    const params     = [];

    if (q && q.trim()) {
      conditions.push(`(lower(title) LIKE lower(?) OR lower(artist) LIKE lower(?))`);
      params.push(`%${q.trim()}%`, `%${q.trim()}%`);
    }
    if (genre && genre !== 'all') {
      conditions.push(`lower(genre) = lower(?)`);
      params.push(genre.trim());
    }
    if (type && type !== 'all') {
      conditions.push(`type = ?`);
      params.push(type);
    }
    if (year) {
      conditions.push(`strftime('%Y', release_date) = ?`);
      params.push(String(year));
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const orderMap = {
      date_desc:  'release_date DESC, title ASC',
      date_asc:   'release_date ASC,  title ASC',
      title_asc:  'title ASC',
      artist_asc: 'artist ASC, title ASC',
      top_rated:  'avg_score DESC NULLS LAST, vote_count DESC',
    };
    const order = orderMap[sort] || orderMap.date_desc;

    // For top_rated we need a subquery with the computed avg
    let sql, countSql;
    if (sort === 'top_rated') {
      sql = `
        SELECT r.*,
          COUNT(v.id)        AS vote_count,
          AVG(v.score) * 2.0 AS avg_score
        FROM releases r
        LEFT JOIN votes v ON v.release_id = r.id
        ${where}
        GROUP BY r.id
        ORDER BY ${order}
        LIMIT ? OFFSET ?
      `;
      countSql = `SELECT COUNT(*) AS n FROM releases r ${where}`;
    } else {
      sql = `SELECT * FROM releases r ${where} ORDER BY ${order} LIMIT ? OFFSET ?`;
      countSql = `SELECT COUNT(*) AS n FROM releases r ${where}`;
    }

    const rows  = db.prepare(sql).all([...params, limit, offset]);
    const total = db.prepare(countSql).get(params).n;

    // attachRating handles both cases (pre-computed for top_rated, or fetched)
    const results = rows.map(row => {
      if (sort === 'top_rated' && row.vote_count != null) {
        return {
          ...row,
          tags:       JSON.parse(row.tags || '[]'),
          avg_score:  row.vote_count > 0 ? Math.round(row.avg_score * 10) / 10 : null,
          vote_count: row.vote_count,
        };
      }
      return attachRating(row);
    });

    return { results, total, limit, offset };
  },

  /** List all distinct genres in the DB (for filter dropdowns) */
  genres() {
    return db.prepare(`
      SELECT genre, COUNT(*) AS n
      FROM releases
      WHERE genre IS NOT NULL AND genre != 'Various' AND genre != 'Unknown'
      GROUP BY genre
      ORDER BY n DESC
      LIMIT 40
    `).all().map(r => r.genre);
  },

  /** Delete a release */
  delete(id) {
    db.prepare('DELETE FROM votes WHERE release_id = ?').run(id);
    const info = db.prepare('DELETE FROM releases WHERE id = ?').run(id);
    return info.changes > 0;
  },
};

// ─── VOTE QUERIES ──────────────────────────────────────────────────────────

const voteQueries = {

  /** Submit a vote. Returns { ok, error } */
  submit(releaseId, ip, score) {
    const ipHash = hashIP(ip);
    try {
      db.prepare(`
        INSERT INTO votes (release_id, ip_hash, score)
        VALUES (?, ?, ?)
      `).run(releaseId, ipHash, score);
      return { ok: true };
    } catch (e) {
      if (e.message.includes('UNIQUE constraint failed')) {
        return { ok: false, error: 'already_voted' };
      }
      throw e;
    }
  },

  /** Check if an IP has voted on a release */
  hasVoted(releaseId, ip) {
    const ipHash = hashIP(ip);
    const row = db.prepare('SELECT 1 FROM votes WHERE release_id = ? AND ip_hash = ?').get(releaseId, ipHash);
    return !!row;
  },
};



// ─── SCRAPE LOG ────────────────────────────────────────────────────────────

const scrapeLogQueries = {
  insert(entry) {
    db.prepare(`
      INSERT INTO scrape_log (status, sources_ok, sources_err, articles, extracted, added, skipped, message)
      VALUES (@status, @sources_ok, @sources_err, @articles, @extracted, @added, @skipped, @message)
    `).run(entry);
  },
  latest(n = 10) {
    return db.prepare('SELECT * FROM scrape_log ORDER BY scraped_at DESC LIMIT ?').all(n);
  },
};

// Migrate existing DBs
try {
  db.exec(`CREATE TABLE IF NOT EXISTS scrape_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL, sources_ok INTEGER DEFAULT 0,
    sources_err INTEGER DEFAULT 0, articles INTEGER DEFAULT 0,
    extracted INTEGER DEFAULT 0, added INTEGER DEFAULT 0,
    skipped INTEGER DEFAULT 0, message TEXT,
    scraped_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
} catch (_) {}

module.exports = { db, queries, voteQueries, scrapeLogQueries };
