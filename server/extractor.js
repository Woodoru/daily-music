// server/extractor.js
// Uses Claude API to extract structured music release data from scraped articles.
// Batches articles to minimize API calls and cost.

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL         = 'claude-haiku-4-5-20251001'; // fast + cheap for extraction tasks

// ─── SYSTEM PROMPT ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a music data extraction assistant for a music release tracking website.

You will receive a batch of music news article summaries. Your job is to extract structured release information from them.

For each article, determine if it describes a specific music release (new album, single, or EP) with a known or announced release date. 

Return ONLY a valid JSON array. No explanation, no markdown, no code fences — just the raw JSON array.

Each extracted release must have these fields:
- title: the album/single/EP title (string)
- artist: the artist or band name (string)  
- type: exactly one of "Album", "Single", or "EP"
- release_date: in YYYY-MM-DD format. If only month/year is known, use the 1st of that month. If completely unknown or vague ("coming soon", "this year"), set to null.
- genre: best guess at genre (string, e.g. "Pop", "Hip-Hop", "Indie Rock")
- tags: array of up to 3 sub-genre or style tags (e.g. ["Dream Pop", "Shoegaze"])
- source_title: the original article headline you extracted this from

Rules:
- Skip articles that are just reviews of already-released old music with no new announcement
- Skip articles about tours, deaths, lawsuits, or non-release news
- Skip if artist or title cannot be clearly identified
- If one article mentions multiple releases, create multiple entries
- If the release date is in the past (before today ${new Date().toISOString().slice(0,10)}), still include it — it may be new to our database
- Do not hallucinate or guess titles/artists not mentioned in the text
- Return an empty array [] if nothing qualifies

Example output:
[
  {
    "title": "The Great Escape",
    "artist": "Blur",
    "type": "Album",
    "release_date": "2026-04-18",
    "genre": "Britpop",
    "tags": ["Alternative Rock", "Indie"],
    "source_title": "Blur Announce Surprise New Album for April"
  }
]`;

// ─── BATCH ARTICLES → PROMPT ───────────────────────────────────────────────

function buildUserPrompt(articles) {
  const lines = articles.map((a, i) =>
    `Article ${i + 1} [${a.sourceName}]:\nHeadline: ${a.title}\nSummary: ${a.description}\n`
  );
  return `Here are ${articles.length} music news articles. Extract any release announcements:\n\n${lines.join('\n---\n')}`;
}

// ─── CALL CLAUDE API ───────────────────────────────────────────────────────

async function callClaude(userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_anthropic_api_key_here') {
    throw new Error('ANTHROPIC_API_KEY not configured. Add it to your .env file.');
  }

  const res = await fetch(ANTHROPIC_API, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      MODEL,
      max_tokens: 2048,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Claude API error ${res.status}: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || '[]';
}

// ─── PARSE RESPONSE ────────────────────────────────────────────────────────

function parseExtractionResponse(text) {
  // Strip any accidental markdown fences
  const cleaned = text.replace(/```json|```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(r =>
      r.title && r.artist && r.type && ['Album','Single','EP'].includes(r.type)
    );
  } catch (e) {
    console.warn('[extractor] Failed to parse Claude response:', text.slice(0, 200));
    return [];
  }
}

// ─── MAIN EXTRACT FUNCTION ─────────────────────────────────────────────────

const BATCH_SIZE = 15; // articles per Claude call — keeps prompts focused

/**
 * Takes an array of scraped articles, runs them through Claude in batches,
 * and returns an array of structured release objects.
 */
async function extractReleases(articles) {
  if (!articles.length) return [];

  const allReleases = [];
  const batches = [];

  // Split into batches
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    batches.push(articles.slice(i, i + BATCH_SIZE));
  }

  console.log(`[extractor] Processing ${articles.length} articles in ${batches.length} batch(es)...`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`[extractor] Batch ${i + 1}/${batches.length} (${batch.length} articles)...`);

    try {
      const prompt   = buildUserPrompt(batch);
      const response = await callClaude(prompt);
      const releases = parseExtractionResponse(response);
      console.log(`[extractor] Batch ${i + 1}: extracted ${releases.length} releases`);
      allReleases.push(...releases);

      // Small delay between batches to be respectful of rate limits
      if (i < batches.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) {
      console.error(`[extractor] Batch ${i + 1} failed:`, e.message);
      // Continue with remaining batches even if one fails
    }
  }

  // Deduplicate by title+artist (case-insensitive)
  const seen = new Set();
  const deduped = allReleases.filter(r => {
    const key = `${r.title.toLowerCase()}::${r.artist.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[extractor] Final: ${deduped.length} unique releases extracted`);
  return deduped;
}

module.exports = { extractReleases };
