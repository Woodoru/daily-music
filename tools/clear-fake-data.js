// tools/clear-fake-data.js
// Run this ONCE to delete all fake seeded releases from your existing database.
// Usage:  node tools/clear-fake-data.js
//
// Safe to run multiple times — it only deletes rows that match the known
// fake IDs (r1–r17) or were inserted with source='seed'.
// Your real manually-added or scraped releases are NOT touched.

const Database = require('better-sqlite3');
const path     = require('path');
const readline = require('readline');

const DB_PATH = path.join(__dirname, '../data/tunescope.db');

// Check DB exists
const fs = require('fs');
if (!fs.existsSync(DB_PATH)) {
  console.log('No database found at', DB_PATH);
  console.log('Nothing to clean up — start fresh with: npm start');
  process.exit(0);
}

const db = new Database(DB_PATH);

// Find all fake rows
const FAKE_IDS = ['r1','r2','r3','r4','r5','r6','r7','r8','r9','r10','r11','r12','r13','r14','r15','r16','r17'];
const FAKE_TITLES = [
  'Neon Curtain','Glass Hammer','Ultraviolet','Salt & Wire','RIOT SEASON',
  'Shallow Graves','Pacific Rim Dream','Foxhole Radio','Binary Sunsets',
  'Tender Machines','Dead Letters','Rust Belt Symphony','Moth Light',
  'Chromatic Mass','Night Shift','Holocene','Fever Logic',
];

// Find by fake IDs or known fake titles
const placeholdersIds    = FAKE_IDS.map(() => '?').join(',');
const placeholdersTitles = FAKE_TITLES.map(() => '?').join(',');

const fakeReleases = db.prepare(`
  SELECT id, title, artist, release_date, source FROM releases
  WHERE id IN (${placeholdersIds})
     OR title IN (${placeholdersTitles})
     OR source = 'seed'
`).all([...FAKE_IDS, ...FAKE_TITLES]);

if (!fakeReleases.length) {
  console.log('✓ No fake data found. Your database is already clean.');
  db.close();
  process.exit(0);
}

console.log(`\nFound ${fakeReleases.length} fake release(s) to delete:\n`);
fakeReleases.forEach(r => {
  console.log(`  [${r.id}] "${r.title}" — ${r.artist} (${r.release_date})`);
});

// Count how many votes will be removed too
const totalVotes = fakeReleases.reduce((sum, r) => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM votes WHERE release_id = ?').get(r.id).n;
  return sum + count;
}, 0);

console.log(`\nThis will also delete ${totalVotes} associated fake vote(s).\n`);

// Ask for confirmation
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Delete all fake data? (yes/no): ', (answer) => {
  rl.close();

  if (answer.toLowerCase() !== 'yes') {
    console.log('Cancelled. Nothing was deleted.');
    db.close();
    process.exit(0);
  }

  // Delete in a transaction
  const deleteAll = db.transaction(() => {
    for (const r of fakeReleases) {
      db.prepare('DELETE FROM votes    WHERE release_id = ?').run(r.id);
      db.prepare('DELETE FROM releases WHERE id = ?').run(r.id);
    }
  });

  deleteAll();

  const remaining = db.prepare('SELECT COUNT(*) AS n FROM releases').get().n;
  console.log(`\n✓ Deleted ${fakeReleases.length} fake release(s) and ${totalVotes} fake vote(s).`);
  console.log(`  ${remaining} real release(s) remain in the database.\n`);
  console.log('Now restart the server — the AI scraper will populate real data within 10 seconds.');

  db.close();
});
