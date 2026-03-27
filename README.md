# TUNESCOPE

Community music rating site — daily release tracker with automatic data updates.

## Quick Start (no API key needed)

```bash
npm install
npm start
```
Open http://localhost:3000 — real release data starts loading within 10 seconds.

---

## How it works

The server runs a background scheduler every 24 hours that pulls real release data from:
- **MusicBrainz** — open music database (free, no key, covers current + upcoming month)
- **Album of the Year** — release calendar with upcoming albums (free, scrapable)

Data is deduplicated automatically — running the scheduler multiple times never creates duplicates.

---

## Project Structure

```
tunescope/
├── .env                    ← Your config (copy from .env.example)
├── .env.example
├── package.json
├── data/tunescope.db       ← SQLite database (auto-created)
├── server/
│   ├── index.js            ← Express server + scheduler
│   ├── db.js               ← Database schema and queries
│   ├── scraper-free.js     ← FREE pipeline (MusicBrainz + AOTY)
│   ├── scraper.js          ← AI pipeline: RSS/news scraper (kept for future use)
│   └── extractor.js        ← AI pipeline: Claude extraction (kept for future use)
├── tools/
│   └── clear-fake-data.js  ← One-time script to wipe demo data
└── public/
    └── index.html          ← Frontend
```

---

## Switching to the AI pipeline (future)

When you want richer data and upcoming release announcements from music news sites:

1. Get an Anthropic API key at https://console.anthropic.com
2. Add to your `.env`:
   ```
   ANTHROPIC_API_KEY=sk-ant-your-key-here
   ```
3. Open `server/index.js` and change **two lines** at the top:

   ```js
   // CHANGE FROM:
   const { fetchFreeReleases } = require('./scraper-free');
   const USE_AI_PIPELINE = false;

   // TO:
   const { scrapeAll }       = require('./scraper');
   const { extractReleases } = require('./extractor');
   const USE_AI_PIPELINE = true;
   ```

4. Restart the server — that's it. No other changes needed.

**AI pipeline cost:** ~$0.003–0.005 per run, ~$0.10/month at daily schedule.

---

## Removing demo data (first run)

If you're upgrading from a version that had fake seed data:
```bash
npm run clear-fake-data
```
This safely removes all fake entries and leaves real data untouched.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/releases?date=YYYY-MM-DD` | Releases for a date |
| GET | `/api/releases?month=YYYY-MM` | Releases for a month |
| GET | `/api/releases/top-today` | Top-rated release today |
| GET | `/api/releases/:id` | Single release |
| POST | `/api/releases` | Add manually |
| DELETE | `/api/releases/:id` | Delete |
| POST | `/api/ratings` | Submit rating (1–5) |
| GET | `/api/ratings/check?release_id=X` | Check if IP has voted |
