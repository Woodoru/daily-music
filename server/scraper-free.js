// server/scraper-free.js
// Free data pipeline — MusicBrainz API, no API key required.
// ─────────────────────────────────────────────────────────────────────────
// TO SWITCH TO AI PIPELINE: see comment block in server/index.js
// ─────────────────────────────────────────────────────────────────────────

const MB_BASE  = 'https://musicbrainz.org/ws/2';
const MB_AGENT = 'TuneScope/1.0 (music-release-tracker; contact@localhost)';
const sleep    = ms => new Promise(r => setTimeout(r, ms));
const pad      = n  => String(n).padStart(2, '0');

// ─── GENRE MAP ─────────────────────────────────────────────────────────────

const GENRE_MAP = {
  'hip hop':'Hip-Hop','rap':'Hip-Hop','trap':'Hip-Hop','drill':'Hip-Hop',
  'pop':'Pop','k-pop':'K-Pop','j-pop':'J-Pop','synth-pop':'Synth-Pop',
  'rock':'Rock','indie rock':'Indie Rock','alternative rock':'Alt Rock',
  'electronic':'Electronic','edm':'Electronic','house':'House',
  'techno':'Techno','ambient':'Ambient','idm':'IDM','downtempo':'Downtempo',
  'r&b':'R&B','soul':'Soul','funk':'Funk','neo soul':'Neo-Soul',
  'jazz':'Jazz','blues':'Blues','classical':'Classical',
  'country':'Country','folk':'Folk','americana':'Americana',
  'metal':'Metal','punk':'Punk','hardcore':'Hardcore','post-punk':'Post-Punk',
  'indie':'Indie','indie pop':'Indie Pop','shoegaze':'Shoegaze',
  'dream pop':'Dream Pop','post-rock':'Post-Rock','emo':'Emo',
};

function capitalize(s) {
  return (s || '').replace(/\b\w/g, c => c.toUpperCase());
}

function mapGenre(tags = []) {
  if (!tags.length) return { genre: 'Various', tags: [] };
  const sorted = [...tags].sort((a, b) => (b.count || 0) - (a.count || 0));
  const names  = sorted.map(t => (t.name || '').toLowerCase()).filter(Boolean);
  const genre  = names.reduce((f, n) => f || GENRE_MAP[n] || null, null)
                 || capitalize(names[0]) || 'Various';
  const extra  = names.map(n => GENRE_MAP[n] || capitalize(n))
                       .filter(t => t !== genre).slice(0, 3);
  return { genre, tags: extra };
}

function normalizeDate(d) {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  if (/^\d{4}-\d{2}$/.test(d))  return `${d}-01`;
  if (/^\d{4}$/.test(d))         return `${d}-01-01`;
  return null;
}

function extractArtist(artistCredit = []) {
  return artistCredit
    .map(ac => (typeof ac === 'object' ? ac.artist?.name || ac.name || '' : ac))
    .join('')
    .trim() || null;
}

function extractType(rel) {
  const pt = (rel['release-group']?.['primary-type'] || '').toLowerCase();
  if (pt === 'single') return 'Single';
  if (pt === 'ep')     return 'EP';
  return 'Album'; // default
}

// ─── FETCH WITH RETRY ──────────────────────────────────────────────────────

async function mbFetch(url, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': MB_AGENT, 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(15000),
    });
    if (res.status === 503 || res.status === 429) {
      console.log(`[musicbrainz] Rate limited — waiting 5s...`);
      await sleep(5000);
      if (attempt < 4) return mbFetch(url, attempt + 1);
      throw new Error('Rate limited, giving up');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (e) {
    if (attempt < 3 && e.name !== 'AbortError') {
      await sleep(3000);
      return mbFetch(url, attempt + 1);
    }
    throw e;
  }
}

// ─── FETCH ONE MONTH ───────────────────────────────────────────────────────
// One query per month (no type filtering in query — type is read from results).
// Paginates up to MAX_PAGES × 100 results.

const MAX_PAGES = 2; // 200 results per month — fast and covers all notable releases

async function fetchMonth(yearMonth) {
  const releases = [];
  let offset = 0;
  let total  = null;
  let page   = 0;

  do {
    await sleep(1200); // MusicBrainz: max 1 req/sec, we use 1.2s to be safe

    // Simple, reliable query: just date:YYYY-MM
    const url = `${MB_BASE}/release?query=date:${yearMonth}&limit=100&offset=${offset}&fmt=json`;

    try {
      const data    = await mbFetch(url);
      const results = data.releases || [];
      total = total ?? data.count ?? 0;
      page++;

      console.log(`[musicbrainz] ${yearMonth} page ${page}: ${results.length} releases (${offset}/${total} total)`);

      for (const rel of results) {
        const releaseDate = normalizeDate(rel.date);
        if (!releaseDate)                          continue;
        if (!releaseDate.startsWith(yearMonth))    continue; // filter to exact month

        const artist = extractArtist(rel['artist-credit']);
        if (!rel.title || !artist)                 continue;

        const tags = [
          ...(rel.tags || []),
          ...(rel['release-group']?.tags || []),
        ];

        // Cover Art Archive: free, no key needed
        // URL pattern: https://coverartarchive.org/release/{mbid}/front-250
        const mbid     = rel.id || null;
        const coverUrl = mbid
          ? `https://coverartarchive.org/release/${mbid}/front-250`
          : null;

        releases.push({
          title:        rel.title,
          artist,
          type:         extractType(rel),
          release_date: releaseDate,
          ...mapGenre(tags),
          label:        rel['label-info']?.[0]?.label?.name || null,
          duration:     null,
          cover_url:    coverUrl,
          source:       'musicbrainz',
        });
      }

      offset += results.length;
      if (results.length < 100) break; // last page

    } catch (e) {
      console.warn(`[musicbrainz] ${yearMonth} page ${page} failed:`, e.message);
      break;
    }

  } while (offset < total && page < MAX_PAGES);

  // Deduplicate within month
  const seen    = new Set();
  const deduped = releases.filter(r => {
    const key = `${r.title.toLowerCase()}::${r.artist.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[musicbrainz] ${yearMonth}: ${deduped.length} unique releases saved`);
  return deduped;
}

// ─── PUBLIC API ────────────────────────────────────────────────────────────

async function fetchFreeReleases() {
  const today     = new Date();
  const thisMonth = `${today.getFullYear()}-${pad(today.getMonth()+1)}`;
  const nextD     = new Date(today.getFullYear(), today.getMonth()+1, 1);
  const nextMonth = `${nextD.getFullYear()}-${pad(nextD.getMonth()+1)}`;

  console.log(`[free-scraper] Daily run: ${thisMonth} + ${nextMonth}`);

  // Sequential to respect rate limit
  const a = await fetchMonth(thisMonth).catch(e => { console.warn(e.message); return []; });
  const b = await fetchMonth(nextMonth).catch(e => { console.warn(e.message); return []; });

  const seen = new Set();
  return [...a, ...b].filter(r => {
    const key = `${r.title.toLowerCase()}::${r.artist.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function fetchFullYearBackfill(year) {
  console.log(`\n[free-scraper] ══════════════════════════════════`);
  console.log(`[free-scraper]  FULL YEAR BACKFILL: ${year}`);
  console.log(`[free-scraper]  ~3-5 min. Watch progress below.`);
  console.log(`[free-scraper] ══════════════════════════════════\n`);

  const all = [];
  for (let m = 1; m <= 12; m++) {
    const yearMonth = `${year}-${pad(m)}`;
    console.log(`\n[free-scraper] ── Month ${m}/12: ${yearMonth} ──`);
    const results = await fetchMonth(yearMonth).catch(e => {
      console.warn(`[free-scraper] ${yearMonth} failed:`, e.message);
      return [];
    });
    all.push(...results);
    console.log(`[free-scraper] Running total: ${all.length} releases`);
    if (m < 12) await sleep(1500);
  }

  // Final cross-month dedup
  const seen    = new Set();
  const deduped = all.filter(r => {
    const key = `${r.title.toLowerCase()}::${r.artist.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`\n[free-scraper] ══ BACKFILL DONE: ${deduped.length} unique releases for ${year} ══\n`);
  return deduped;
}

module.exports = { fetchFreeReleases, fetchFullYearBackfill };
