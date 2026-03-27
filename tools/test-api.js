// tools/test-api.js
// Run this to test if MusicBrainz is reachable and returning data.
// Usage: node tools/test-api.js
//
// This will print exactly what MusicBrainz returns so you can
// see if the query is working before the full scraper runs.

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function test() {
  const today     = new Date();
  const pad       = n => String(n).padStart(2, '0');
  const yearMonth = `${today.getFullYear()}-${pad(today.getMonth()+1)}`;
  const year      = today.getFullYear();

  console.log('─────────────────────────────────────────────');
  console.log(' TuneScope API Tester');
  console.log('─────────────────────────────────────────────');
  console.log(`Testing MusicBrainz for month: ${yearMonth}\n`);

  // ── Test 1: Basic connectivity ──────────────────────────────────────────
  console.log('TEST 1: Checking MusicBrainz connectivity...');
  try {
    const res = await fetch('https://musicbrainz.org/ws/2/release?query=date:2026-03&limit=3&fmt=json', {
      headers: { 'User-Agent': 'TuneScope/1.0 (test script)' }
    });
    console.log(`  Status: ${res.status} ${res.statusText}`);
    if (!res.ok) {
      const text = await res.text();
      console.log(`  Response body: ${text.slice(0, 300)}`);
    } else {
      const data = await res.json();
      console.log(`  ✓ Connected! Releases returned: ${data.releases?.length ?? 0}`);
      if (data.releases?.length > 0) {
        console.log(`  Sample: "${data.releases[0].title}" by ${data.releases[0]['artist-credit']?.[0]?.artist?.name}`);
      }
    }
  } catch (e) {
    console.log(`  ✗ FAILED: ${e.message}`);
    console.log('  → Check your internet connection');
    process.exit(1);
  }

  await sleep(1200);

  // ── Test 2: Release search for current month ─────────────────────────────
  console.log(`\nTEST 2: Fetching Albums released in ${yearMonth}...`);
  try {
    const url = `https://musicbrainz.org/ws/2/release?query=date:${yearMonth}&type=album&limit=5&fmt=json`;
    console.log(`  URL: ${url}`);
    const res  = await fetch(url, {
      headers: { 'User-Agent': 'TuneScope/1.0 (test script)' }
    });
    const data = await res.json();
    const releases = data.releases || [];
    console.log(`  ✓ Found ${data.count ?? '?'} total, got ${releases.length} in this page`);
    releases.slice(0, 5).forEach(r => {
      const artist = r['artist-credit']?.[0]?.artist?.name || '?';
      console.log(`    • "${r.title}" — ${artist} (${r.date || 'no date'})`);
    });
  } catch (e) {
    console.log(`  ✗ FAILED: ${e.message}`);
  }

  await sleep(1200);

  // ── Test 3: Singles for current month ────────────────────────────────────
  console.log(`\nTEST 3: Fetching Singles released in ${yearMonth}...`);
  try {
    const url = `https://musicbrainz.org/ws/2/release?query=date:${yearMonth}&type=single&limit=5&fmt=json`;
    const res  = await fetch(url, {
      headers: { 'User-Agent': 'TuneScope/1.0 (test script)' }
    });
    const data = await res.json();
    const releases = data.releases || [];
    console.log(`  ✓ Found ${data.count ?? '?'} total, got ${releases.length} in this page`);
    releases.slice(0, 3).forEach(r => {
      const artist = r['artist-credit']?.[0]?.artist?.name || '?';
      console.log(`    • "${r.title}" — ${artist} (${r.date || 'no date'})`);
    });
  } catch (e) {
    console.log(`  ✗ FAILED: ${e.message}`);
  }

  await sleep(1200);

  // ── Test 4: Check DB ─────────────────────────────────────────────────────
  console.log('\nTEST 4: Checking your database...');
  try {
    const Database = require('better-sqlite3');
    const path     = require('path');
    const db       = new Database(path.join(__dirname, '../data/tunescope.db'));
    const total    = db.prepare('SELECT COUNT(*) AS n FROM releases').get().n;
    const today2   = new Date();
    const todayStr = `${today2.getFullYear()}-${pad(today2.getMonth()+1)}-${pad(today2.getDate())}`;
    const todayCount = db.prepare('SELECT COUNT(*) AS n FROM releases WHERE release_date = ?').get(todayStr).n;
    const yearCount  = db.prepare(`SELECT COUNT(*) AS n FROM releases WHERE release_date LIKE '${year}%'`).get().n;
    const sample     = db.prepare('SELECT title, artist, release_date FROM releases LIMIT 5').all();
    db.close();

    console.log(`  Total releases in DB: ${total}`);
    console.log(`  Releases in ${year}: ${yearCount}`);
    console.log(`  Releases today (${todayStr}): ${todayCount}`);
    if (sample.length) {
      console.log('  Sample entries:');
      sample.forEach(r => console.log(`    • "${r.title}" — ${r.artist} (${r.release_date})`));
    } else {
      console.log('  ⚠ Database is EMPTY — backfill has not run yet or failed');
    }
  } catch (e) {
    console.log(`  ✗ DB check failed: ${e.message}`);
  }

  console.log('\n─────────────────────────────────────────────');
  console.log('Done. Share this output if you need help debugging.');
  console.log('─────────────────────────────────────────────\n');
}

test().catch(e => { console.error('Unexpected error:', e.message); process.exit(1); });
