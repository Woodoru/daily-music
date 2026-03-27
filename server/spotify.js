// server/spotify.js
// Handles Spotify Client Credentials auth and new-release fetching.
// No user login required — only Client ID + Secret needed.

const SPOTIFY_TOKEN_URL  = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_BASE   = 'https://api.spotify.com/v1';

// In-memory token cache
let _token      = null;
let _tokenExpiry = 0;

// ─── AUTH ──────────────────────────────────────────────────────────────────

async function getAccessToken() {
  // Return cached token if still valid (with 60s buffer)
  if (_token && Date.now() < _tokenExpiry - 60_000) return _token;

  const clientId     = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret ||
      clientId === 'your_client_id_here' ||
      clientSecret === 'your_client_secret_here') {
    throw new Error('Spotify credentials not configured. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to your .env file.');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Spotify auth failed: ${err.error_description || res.statusText}`);
  }

  const data = await res.json();
  _token       = data.access_token;
  _tokenExpiry = Date.now() + data.expires_in * 1000;
  return _token;
}

// ─── API HELPER ────────────────────────────────────────────────────────────

async function spotifyGet(path, params = {}) {
  const token = await getAccessToken();
  const url   = new URL(SPOTIFY_API_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Spotify API error ${res.status}: ${err.error?.message || res.statusText}`);
  }
  return res.json();
}

// ─── MAP SPOTIFY RELEASE → TUNESCOPE FORMAT ────────────────────────────────

function toReleaseDate(dateStr, precision) {
  // Spotify gives "2026-03-26", "2026-03", or "2026" depending on precision
  if (precision === 'day')   return dateStr;                         // already YYYY-MM-DD
  if (precision === 'month') return `${dateStr}-01`;                 // use 1st of month
  if (precision === 'year')  return `${dateStr}-01-01`;              // use Jan 1st
  return dateStr;
}

function mapAlbumType(spotifyType) {
  // Spotify: "album" | "single" | "compilation"
  if (spotifyType === 'single')      return 'Single';
  if (spotifyType === 'compilation') return 'Album';
  return 'Album';
}

function extractGenres(artistGenres) {
  // Spotify genres are on the artist, not the album — we get them separately
  if (!artistGenres || !artistGenres.length) return { genre: 'Unknown', tags: [] };
  const cleaned = artistGenres.map(g =>
    g.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
  );
  return { genre: cleaned[0], tags: cleaned.slice(1, 4) };
}

// ─── FETCH NEW RELEASES ────────────────────────────────────────────────────

/**
 * Fetch up to `limit` new releases from Spotify.
 * Optionally filter to only releases on or after `sinceDate` (YYYY-MM-DD).
 *
 * Returns an array of release objects ready for DB insertion.
 */
async function fetchNewReleases({ limit = 50, market = 'US', sinceDate = null } = {}) {
  // Step 1: get the new-releases list (album objects without genres)
  const data = await spotifyGet('/browse/new-releases', { limit, market });
  const albums = data.albums?.items || [];

  if (!albums.length) return [];

  // Step 2: filter by date if requested
  const filtered = sinceDate
    ? albums.filter(a => {
        const rd = toReleaseDate(a.release_date, a.release_date_precision);
        return rd >= sinceDate;
      })
    : albums;

  if (!filtered.length) return [];

  // Step 3: batch-fetch artist details to get genres
  //   Spotify allows up to 50 artists per request
  const artistIds = [...new Set(filtered.flatMap(a => a.artists.map(ar => ar.id)))].slice(0, 50);
  let artistGenreMap = {};

  try {
    const artistData = await spotifyGet('/artists', { ids: artistIds.join(',') });
    for (const artist of artistData.artists || []) {
      if (artist) artistGenreMap[artist.id] = artist.genres || [];
    }
  } catch (e) {
    console.warn('[spotify] Could not fetch artist genres:', e.message);
  }

  // Step 4: map to TuneScope format
  const releases = filtered.map(album => {
    const primaryArtist  = album.artists[0];
    const artistGenres   = artistGenreMap[primaryArtist?.id] || [];
    const { genre, tags } = extractGenres(artistGenres);
    const artistNames    = album.artists.map(a => a.name).join(', ');

    return {
      spotify_id:   album.id,
      title:        album.name,
      artist:       artistNames,
      type:         mapAlbumType(album.album_type),
      release_date: toReleaseDate(album.release_date, album.release_date_precision),
      genre,
      tags,
      label:        null,   // not in browse endpoint; could add via /albums/:id if needed
      duration:     album.total_tracks > 1 ? `${album.total_tracks} tracks` : null,
      cover_url:    album.images?.[0]?.url || null,
    };
  });

  return releases;
}

/**
 * Search Spotify for a specific artist's recent releases.
 */
async function searchArtistReleases(artistName, { limit = 10 } = {}) {
  const searchData = await spotifyGet('/search', {
    q:      artistName,
    type:   'album',
    limit:  5,
  });

  const artists = searchData.albums?.items?.map(a => a.artists[0]) || [];
  if (!artists.length) return [];

  // Take the first matching artist's albums
  const artistId   = artists[0].id;
  const albumsData = await spotifyGet(`/artists/${artistId}/albums`, {
    include_groups: 'album,single',
    limit,
    market: 'US',
  });

  const artistGenreData = await spotifyGet(`/artists/${artistId}`).catch(() => ({ genres: [] }));
  const { genre, tags } = extractGenres(artistGenreData.genres || []);

  return (albumsData.items || []).map(album => ({
    spotify_id:   album.id,
    title:        album.name,
    artist:       album.artists.map(a => a.name).join(', '),
    type:         mapAlbumType(album.album_type),
    release_date: toReleaseDate(album.release_date, album.release_date_precision),
    genre,
    tags,
    label:        null,
    duration:     album.total_tracks > 1 ? `${album.total_tracks} tracks` : null,
    cover_url:    album.images?.[0]?.url || null,
  }));
}

module.exports = { fetchNewReleases, searchArtistReleases, getAccessToken };
