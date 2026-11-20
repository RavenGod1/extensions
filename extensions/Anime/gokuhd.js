/**
 * StrawVerse Extension - GokuHD (gokuhd.nl)
 * Catalogue from the WordPress "Hindi Dubbed Series" archive and the search
 * RSS feed (the site only hosts download links, never a playable stream),
 * titles/episodes from TMDB, streams via the Cinezo resolver chain
 * (punkflix -> flikhub -> yenime).
 */
const cheerio = require("cheerio");
const axios = global.axios || require("axios");

const baseUrl = "https://gokuhd.nl";
const listUrl = `${baseUrl}/series/hindi-dubbed-series/`;
const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_KEY = "8476a7ab80ad76f0936744df0430e67c";
const CINEZO_HEADERS = {
  Referer: "https://player.cinezo.live/",
  Origin: "https://player.cinezo.live",
};

// slug -> { tmdbId, title }
const resolved = new Map();
// tmdbId -> { info, episodes }
const episodeCache = new Map();

async function tmdb(path, params = {}) {
  // TMDB rate-limits bursts (429) and resets sockets; both are transient.
  for (let attempt = 0; ; attempt++) {
    try {
      const { data } = await axios.get(`${TMDB_API}${path}`, {
        params: { api_key: TMDB_KEY, ...params },
      });
      return data;
    } catch (e) {
      const status = e.response && e.response.status;
      const retryable = !status || status === 429 || status >= 500;
      if (attempt >= 3 || !retryable) throw e;
      await new Promise((resolve) => setTimeout(resolve, 600 + attempt * 700));
    }
  }
}

function normalizeTitle(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// "Naruto: Shippuden (Season 1 - 18) Hindi Dubbed (ORG) [MULTi-Audio] WEB-DL 1080p 720p HD | [E390 Added | Anime Series]"
// -> "Naruto: Shippuden"
function cleanTitle(raw) {
  let title = String(raw || "").split("|")[0];
  title = title.replace(/\((?:season|s\d)[^)]*\)/gi, " ");
  title = title.replace(/\bseason\s*\d+(?:\s*[-&]\s*\d+)?\b/gi, " ");
  title = title.replace(
    /\b(?:hindi|english|tamil|telugu|malayalam|bangla|bengali|kannada|marathi|punjabi|urdu|gujarati|japanese|korean|multi[\s-]*audio|dual[\s-]*audio|official[\s-]*dubbed|dubbed|org|web[\s-]*dl|webrip|blu[\s-]*ray|bluray|hdtv|hdrip|hd|full[\s-]*hd|1080p|720p|480p|4k|episodes?|series|download|nf|amzn)\b/gi,
    " ",
  );
  title = title.replace(/[\[\]()]/g, " ").replace(/\s+/g, " ").trim();
  return title;
}

function decodeEntities(text) {
  const named = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
  };
  return String(text || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, name) => named[name] || "");
}

// TMDB search returns near-duplicates ("ONE PIECE" 2023, "LEGO ONE PIECE"),
// so the Japanese original with the animation genre wins.
async function findOnTmdb(title) {
  const query = normalizeTitle(title);
  if (!query) return null;
  const data = await tmdb("/search/tv", { query, include_adult: "false" });
  const hits = data.results || [];
  if (!hits.length) return null;
  let best = null;
  let bestScore = -1;
  for (const hit of hits) {
    const name = normalizeTitle(hit.original_name || hit.name || "");
    let score = 0;
    if (name === query) score += 100;
    else if (name.startsWith(query) || query.startsWith(name)) score += 60;
    else if (name.includes(query) || query.includes(name)) score += 30;
    if (hit.original_language === "ja") score += 20;
    if ((hit.genre_ids || []).includes(16)) score += 20;
    if (score > bestScore) {
      bestScore = score;
      best = hit;
    }
  }
  return best ? { tmdbId: best.id, title: best.name || best.original_name } : null;
}

function slugOf(href) {
  return String(href || "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\/+$/, "");
}

async function resolveAnime(id) {
  const key = String(id);
  if (resolved.has(key)) return resolved.get(key);
  let html = "";
  try {
    const { data } = await axios.get(`${baseUrl}/${key}/`, {
      headers: { Referer: `${baseUrl}/` },
    });
    html = typeof data === "string" ? data : "";
  } catch (_) {}
  const heading = html.match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i);
  const rawTitle = heading ? heading[1].replace(/<[^>]+>/g, "") : "";
  const title = cleanTitle(rawTitle.replace(/\s+/g, " "));
  let found = null;
  try {
    found = await findOnTmdb(title);
  } catch (_) {}
  const entry = { tmdbId: found ? found.tmdbId : null, title, rawTitle };
  resolved.set(key, entry);
  return entry;
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();
  $("article").each((_, el) => {
    const anchor = $(el).find(".entry-title a[href]").first();
    const slug = slugOf(anchor.attr("href"));
    if (!slug || seen.has(slug)) return;
    const rawTitle = anchor.text().replace(/\s+/g, " ").trim();
    const title = cleanTitle(rawTitle);
    if (!title) return;
    seen.add(slug);
    const img = $(el).find("img").first();
    const year = (rawTitle.match(/\b(19|20)\d{2}\b/) || [])[1];
    results.push({
      id: slug,
      title,
      image: img.attr("src") || img.attr("data-src") || null,
      year: year ? Number(year) : null,
      type: "TV",
    });
  });
  return results;
}

function parseTotalPages(html) {
  const $ = cheerio.load(html);
  let max = 0;
  $(".wp-pagenavi a, .pagination a, a.page-numbers").each((_, el) => {
    const href = $(el).attr("href") || "";
    for (const m of href.matchAll(/\/page\/(\d+)/g)) {
      max = Math.max(max, Number(m[1]));
    }
    const text = parseInt(($(el).text() || "").trim(), 10);
    if (!isNaN(text)) max = Math.max(max, text);
  });
  return max || null;
}

async function fetchRecentEpisodes(filters = {}) {
  const page = Math.max(1, Number(filters?.page || 1));
  const url = page === 1 ? listUrl : `${listUrl}page/${page}/`;
  let html = "";
  try {
    const { data } = await axios.get(url, { headers: { Referer: `${baseUrl}/` } });
    html = typeof data === "string" ? data : "";
  } catch (e) {
    if (e.response && e.response.status === 404) {
      return { currentPage: page, totalPages: page - 1, hasNextPage: false, results: [] };
    }
    throw e;
  }
  const results = parseCards(html);
  return {
    currentPage: page,
    totalPages: parseTotalPages(html) || page,
    hasNextPage: results.length > 0,
    results,
  };
}

// The search page is rendered by a Typesense proxy that blocks server requests,
// so the WordPress search RSS feed is used instead.
function parseSearchFeed(rss) {
  const items = [...String(rss || "").matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const results = [];
  const seen = new Set();
  for (const item of items) {
    const link = (item.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
    const slug = slugOf(link);
    if (!slug || seen.has(slug)) continue;
    const rawTitle = decodeEntities((item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const title = cleanTitle(rawTitle);
    if (!title) continue;
    seen.add(slug);
    const year = (rawTitle.match(/\b(19|20)\d{2}\b/) || [])[1];
    results.push({
      id: slug,
      title,
      image: null,
      year: year ? Number(year) : null,
      type: "TV",
    });
  }
  return results;
}

async function fetchPoster(slug) {
  try {
    const { data } = await axios.get(`${baseUrl}/${slug}/`, {
      headers: { Referer: `${baseUrl}/` },
    });
    const html = String(data || "");
    const image = (html.match(/property=["']og:image["']\s+content=["']([^"']+)/i) || [])[1];
    return image || null;
  } catch (_) {
    return null;
  }
}

async function SearchAnime(query, filters = {}) {
  const q = String(query || "").trim();
  if (!q) return fetchRecentEpisodes(filters);
  let rss = "";
  try {
    const { data } = await axios.get(
      `${baseUrl}/search/${encodeURIComponent(q)}/feed/rss2/`,
      { headers: { Referer: `${baseUrl}/` } },
    );
    rss = typeof data === "string" ? data : "";
  } catch (_) {}
  const results = parseSearchFeed(rss);
  // The feed has no thumbnails; the post pages do.
  await Promise.all(
    results.slice(0, 6).map(async (row) => {
      row.image = await fetchPoster(row.id);
    }),
  );
  return { currentPage: 1, totalPages: 1, hasNextPage: false, results };
}

async function loadEpisodes(tmdbId) {
  if (episodeCache.has(tmdbId)) return episodeCache.get(tmdbId);
  const info = await tmdb(`/tv/${tmdbId}`);
  const episodes = [];
  for (const s of info.seasons || []) {
    if (!s.season_number || !s.episode_count) continue;
    const season = await tmdb(`/tv/${tmdbId}/season/${s.season_number}`);
    for (const e of season.episodes || []) {
      episodes.push({
        id: `tv:${tmdbId}:${s.season_number}:${e.episode_number}`,
        number: episodes.length + 1,
        title: e.name || `Episode ${e.episode_number}`,
        season: s.season_number,
        episode: e.episode_number,
        duration: e.runtime || null,
        // Every title on the site is a Hindi dub listing.
        langs: ["dub"],
      });
    }
  }
  const payload = { info, episodes };
  episodeCache.set(tmdbId, payload);
  return payload;
}

async function AnimeInfo(id) {
  const entry = await resolveAnime(id);
  if (!entry.tmdbId) {
    return {
      id: String(id),
      title: entry.title || String(id),
      image: null,
      description: "",
      genres: [],
      status: "Unknown",
      year: null,
      type: "TV",
      totalEpisodes: null,
      hasDub: true,
      subOrDub: "dub",
    };
  }
  const { info, episodes } = await loadEpisodes(entry.tmdbId);
  const release = info.first_air_date || "";
  const poster = info.poster_path
    ? `https://image.tmdb.org/t/p/w500${info.poster_path}`
    : null;
  return {
    id: String(id),
    title: info.name || entry.title,
    image: poster,
    description: info.overview || "",
    genres: (info.genres || []).map((g) => g.name),
    status: info.status || "Unknown",
    year: release ? Number(release.slice(0, 4)) || null : null,
    type: "TV",
    totalEpisodes: episodes.length || info.number_of_episodes || null,
    seasons: (info.seasons || [])
      .filter((s) => s.season_number)
      .map((s) => ({
        id: `${entry.tmdbId}:s${s.season_number}`,
        number: s.season_number,
        name: s.name || `Season ${s.season_number}`,
        episodeCount: s.episode_count || 0,
      })),
    hasDub: true,
    subOrDub: "dub",
  };
}

async function fetchEpisode(id, page = 1) {
  try {
    const entry = await resolveAnime(id);
    if (!entry.tmdbId) {
      return { episodes: [], totalPages: 0, total: 0, currentPage: page };
    }
    const { episodes } = await loadEpisodes(entry.tmdbId);
    return { episodes, totalPages: 1, total: episodes.length, currentPage: 1 };
  } catch (_) {
    return { episodes: [], totalPages: 0, total: 0, currentPage: page };
  }
}

// Resolvers from the Cinezo provider chain. Coverage varies per title, so every
// resolver that answers is returned as its own source entry.
async function resolveWithCinezo(tmdbId, season, episode) {
  const out = [];
  try {
    const { data } = await axios.get(
      `https://punkflix.net/tv/${tmdbId}/${season}/${episode}.json`,
      { headers: CINEZO_HEADERS, timeout: 12000 },
    );
    const stream = (data && data.stream) || {};
    for (const key of ["original", "remux", "hls"]) {
      const url = stream[key];
      if (url && typeof url === "string" && /^https?:/.test(url)) {
        out.push({
          url,
          quality: key === "remux" ? "1080p" : key === "original" ? "720p" : "default",
          name: `GokuHD Punkflix ${key}`,
          type: "dub",
          isM3U8: /\.m3u8/i.test(url),
          headers: CINEZO_HEADERS,
        });
      }
    }
  } catch (_) {}

  const proxies = [
    {
      name: "GokuHD Flikhub",
      url: `https://proxy1.flikhub.net/tv?id=${tmdbId}&season=${season}&episode=${episode}&mode=json&sources=sadie&hevc=1`,
    },
    {
      name: "GokuHD Yenime",
      url: `https://proxy.yenime.net/tv?id=${tmdbId}&season=${season}&episode=${episode}&mode=json&sources=zendaya&hevc=1`,
    },
  ];
  for (const p of proxies) {
    try {
      const { data } = await axios.get(p.url, { headers: CINEZO_HEADERS, timeout: 12000 });
      const url = data && data.source && data.source.url;
      if (url && /^https?:/.test(url)) {
        out.push({
          url,
          quality: "default",
          name: p.name,
          type: "dub",
          isM3U8: /\.m3u8/i.test(url),
          headers: CINEZO_HEADERS,
        });
      }
    } catch (_) {}
  }
  return out;
}

async function fetchEpisodeSources(episodeId, category = null) {
  const parts = String(episodeId).split(":");
  const tmdbId = parts[1];
  if (!tmdbId) return { sources: [], subtitles: [] };
  const season = parts[2] || "1";
  const episode = parts[3] || "1";
  const sources = await resolveWithCinezo(tmdbId, season, episode);
  return { sources, subtitles: [] };
}

module.exports = {
  name: "gokuhd",
  version: "1.0.0",
  baseUrl,
  headerRules: [
    { match: ["gokuhd.nl"], headers: { Referer: `${baseUrl}/` } },
  ],
  SearchAnime,
  AnimeInfo,
  fetchEpisode,
  fetchEpisodeSources,
  fetchRecentEpisodes,
};
