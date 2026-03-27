// server/scraper.js
// Fetches music news and release announcements from free RSS/web sources.
// No API keys needed — all sources are publicly accessible.

const { parse: parseHTML } = require('node-html-parser');

// ─── SOURCE DEFINITIONS ────────────────────────────────────────────────────

const SOURCES = [
  {
    id:   'pitchfork-news',
    name: 'Pitchfork',
    type: 'rss',
    url:  'https://pitchfork.com/feed/feed-news/rss',
  },
  {
    id:   'pitchfork-reviews',
    name: 'Pitchfork Reviews',
    type: 'rss',
    url:  'https://pitchfork.com/feed/feed-album-reviews/rss',
  },
  {
    id:   'nme',
    name: 'NME',
    type: 'rss',
    url:  'https://www.nme.com/feed',
  },
  {
    id:   'consequence',
    name: 'Consequence of Sound',
    type: 'rss',
    url:  'https://consequence.net/feed/',
  },
  {
    id:   'stereogum',
    name: 'Stereogum',
    type: 'rss',
    url:  'https://www.stereogum.com/feed/',
  },
  {
    id:   'gnews-releases',
    name: 'Google News — new releases',
    type: 'rss',
    url:  'https://news.google.com/rss/search?q=new+album+release+announcement&hl=en-US&gl=US&ceid=US:en',
  },
  {
    id:   'gnews-upcoming',
    name: 'Google News — upcoming albums',
    type: 'rss',
    url:  'https://news.google.com/rss/search?q=upcoming+album+2026+announcement&hl=en-US&gl=US&ceid=US:en',
  },
  {
    id:   'gnews-singles',
    name: 'Google News — new singles',
    type: 'rss',
    url:  'https://news.google.com/rss/search?q=new+single+out+now+music+2026&hl=en-US&gl=US&ceid=US:en',
  },
];

// ─── RSS PARSER ────────────────────────────────────────────────────────────
// No external library — parse RSS XML manually with node-html-parser

function parseRSS(xmlText) {
  const root  = parseHTML(xmlText, { blockTextElements: { script: true, style: true } });
  const items = root.querySelectorAll('item');

  return items.slice(0, 20).map(item => {
    // Helper to safely get text content
    const text = (tag) => {
      const el = item.querySelector(tag);
      if (!el) return '';
      // Strip CDATA wrappers if present
      return el.innerText.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    };

    const title       = text('title');
    const link        = text('link') || text('guid');
    const pubDate     = text('pubdate') || text('pubDate');
    const description = text('description').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600);

    return { title, link, pubDate, description };
  }).filter(i => i.title);
}

// ─── RELEVANCE FILTER ──────────────────────────────────────────────────────
// Pre-filter articles before sending to Claude — saves API cost

const MUSIC_KEYWORDS = [
  'album', 'single', 'ep', 'release', 'track', 'song', 'debut',
  'drops', 'out now', 'premiere', 'listen', 'stream', 'announce',
  'record', 'music video', 'new music', 'tour', 'deluxe',
];

const SKIP_KEYWORDS = [
  'podcast', 'obituary', 'died', 'death', 'passes away', 'sport',
  'football', 'basketball', 'politics', 'stock', 'weather',
];

function isRelevant(item) {
  const text = `${item.title} ${item.description}`.toLowerCase();
  const hasMusic = MUSIC_KEYWORDS.some(k => text.includes(k));
  const hasSkip  = SKIP_KEYWORDS.some(k => text.includes(k));
  return hasMusic && !hasSkip;
}

// ─── FETCH WITH TIMEOUT ────────────────────────────────────────────────────

async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TuneScope/1.0; +http://localhost:3000)',
        'Accept':     'application/rss+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ─── MAIN SCRAPE FUNCTION ──────────────────────────────────────────────────

/**
 * Scrape all sources.
 * Returns { articles: [...], sourceResults: [...] }
 * Each article: { sourceId, sourceName, title, link, pubDate, description }
 */
async function scrapeAll() {
  const sourceResults = [];
  const articles      = [];

  await Promise.allSettled(
    SOURCES.map(async (source) => {
      const result = { id: source.id, name: source.name, status: 'ok', count: 0, error: null };
      try {
        const xml   = await fetchWithTimeout(source.url);
        const items = parseRSS(xml);
        const relevant = items.filter(isRelevant);

        for (const item of relevant) {
          articles.push({
            sourceId:    source.id,
            sourceName:  source.name,
            title:       item.title,
            link:        item.link,
            pubDate:     item.pubDate,
            description: item.description,
          });
        }

        result.count = relevant.length;
        console.log(`[scraper] ${source.name}: ${relevant.length}/${items.length} relevant articles`);
      } catch (e) {
        result.status = 'error';
        result.error  = e.message;
        console.warn(`[scraper] ${source.name} failed: ${e.message}`);
      }
      sourceResults.push(result);
    })
  );

  console.log(`[scraper] Total articles collected: ${articles.length}`);
  return { articles, sourceResults };
}

module.exports = { scrapeAll, SOURCES };
