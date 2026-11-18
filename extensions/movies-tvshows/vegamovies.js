/**
 * StrawVerse Extension - VegaMovies (vegamovies.lease)
 * Catalogue scraped from the VegaMovies poster grid (the site only hosts
 * download links, never a playable stream), titles/episodes from the TMDB v3
 * API, streams via the Cinezo resolver chain (punkflix -> flikhub -> yenime).
 * Post pages carry the IMDb id, which is mapped to a TMDB id; when they do
 * not, the cleaned title + year are searched on TMDB instead.
 */
const cheerio = require("cheerio");
const axios = global.axios || require("axios");

const baseUrl = "https://vegamovies.lease";
const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_KEY = "8476a7ab80ad76f0936744df0430e67c";
const CINEZO_HEADERS = {
  Referer: "https://player.cinezo.live/",
  Origin: "https://player.cinezo.live",
};
const PER_PAGE = 18;

const mediaCache = new Map();
let totalPagesCache = null;
// The site repeats one pinned post across adjacent archive pages; remembering
// the previous page's ids keeps the infinite scroll free of duplicates.
let prevPage = null;
let prevIds = new Set();

function tmdb(path, params = {}) {
  return axios
    .get(`${TMDB_API}${path}`, { params: { api_key: TMDB_KEY, ...params } })
    .then((r) => r.data);
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    const v = headers.get(name);
    if (v != null) return v;
  }
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return null;
}

function mediaId(type, id) {
  return `${type}:${id}`;
}

function parseId(raw) {
  const [type, id] = String(raw).split(":");
  return { type: type === "tv" ? "tv" : "movie", id };
}

// "Download The Odyssey (2026) Dual Audio {Hindi-English} 2160p || 4k ..."
// -> "The Odyssey"
function cleanTitle(raw) {
  let title = String(raw || "")
    .replace(/^Download\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  title = title.split(/\s*[{|(]/)[0].trim();
  title = title.replace(/\s*\[.*$/, "").trim();
  title = title.replace(/\s*\b(19|20)\d{2}\b\s*$/, "").trim();
  return title;
}

function extractYear(raw) {
  const text = String(raw || "");
  const inParens = text.match(/\((19|20)\d{2}\)/);
  if (inParens) return Number(inParens[0].slice(1, 5));
  const standalone = text.match(/\b(19|20)\d{2}\b/);
  return standalone ? Number(standalone[0]) : null;
}

function isSeries(raw) {
  return /\bseason\s*\d|\bS\d{1,2}\s?E\d{1,2}\b|\bE\d{1,2}\b|\bS\d{1,2}\b/i.test(
    String(raw || ""),
  );
}

function slugOf(href) {
  return String(href || "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\/+$/, "");
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const results = [];
  $("#moviesGridMain a[href*='/download-']").each((_, el) => {
    const slug = slugOf($(el).attr("href"));
    if (!slug || results.some((r) => r.id === slug)) return;
    const img = $(el).find("img").first();
    const rawTitle =
      $(el).find(".poster-title").first().text().trim() ||
      img.attr("alt") ||
      "";
    const title = cleanTitle(rawTitle);
    if (!title) return;
    const score = ($(el).find(".imdb-score").first().text() || "").match(/([\d.]+)/);
    results.push({
      id: slug,
      title,
      image: img.attr("data-src") || img.attr("src") || null,
      year: extractYear(rawTitle),
      rating: score ? Number(score[1]) : null,
      type: isSeries(rawTitle) ? "TV" : "Movie",
    });
  });
  return results;
}

function titleFromSlug(slug) {
  const text = slug.replace(/^download-/, "").replace(/-+/g, " ");
  const year = text.match(/\b(19|20)\d{2}\b/);
  const title = text
    .split(/\b(19|20)\d{2}\b/)[0]
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  return { title, year: year ? Number(year[0]) : null };
}

async function findOnTmdb(title, year) {
  if (!title) return null;
  const data = await tmdb("/search/multi", { query: title, include_adult: "false" });
  const hits = (data.results || []).filter(
    (x) => x && (x.media_type === "movie" || x.media_type === "tv"),
  );
  if (!hits.length) return null;
  const withYear = year
    ? hits.find((x) => {
        const date = x.release_date || x.first_air_date || "";
        return date.slice(0, 4) === String(year);
      })
    : null;
  const hit = withYear || hits[0];
  return {
    type: hit.media_type === "tv" ? "tv" : "movie",
    id: hit.id,
  };
}

// Listing ids are post slugs; TMDB ids arrive as "movie:<id>" / "tv:<id>".
async function resolveMedia(rawId) {
  const id = String(rawId);
  if (/^(movie|tv):\d+$/.test(id)) return parseId(id);
  if (mediaCache.has(id)) return mediaCache.get(id);

  const slug = slugOf(id);
  let html = "";
  try {
    const { data } = await axios.get(`${baseUrl}/${slug}/`, {
      headers: { Referer: `${baseUrl}/` },
    });
    html = typeof data === "string" ? data : "";
  } catch (_) {}

  let found = null;
  const imdb =
    html.match(/imdb\.com\/title\/(tt\d{7,8})/i) ||
    html.match(/\b(tt\d{7,8})\b/i);
  if (imdb) {
    try {
      const data = await tmdb("/find/" + imdb[1], { external_source: "imdb_id" });
      if (data.movie_ids && data.movie_ids.length) {
        found = { type: "movie", id: data.movie_ids[0] };
      } else if (data.tv_ids && data.tv_ids.length) {
        found = { type: "tv", id: data.tv_ids[0] };
      }
    } catch (_) {}
  }
  if (!found) {
    const heading = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/i);
    const rawTitle = heading ? heading[1].replace(/<[^>]+>/g, "") : "";
    const title = cleanTitle(rawTitle) || titleFromSlug(slug).title;
    const year = extractYear(rawTitle) || titleFromSlug(slug).year;
    try {
      found = await findOnTmdb(title, year);
    } catch (_) {}
  }
  if (!found) found = { type: "movie", id: null };
  mediaCache.set(id, found);
  return found;
}

async function latestMovies(filters = {}) {
  const page = Math.max(1, Number(filters?.page || 1));
  const url = page === 1 ? baseUrl : `${baseUrl}/page/${page}/`;
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
  const rawIds = results.map((r) => r.id);
  const pageResults =
    page === prevPage + 1 ? results.filter((r) => !prevIds.has(r.id)) : results;
  prevPage = page;
  prevIds = new Set(rawIds);
  let totalPages = null;
  if (totalPagesCache) {
    totalPages = totalPagesCache;
  } else {
    try {
      const { headers } = await axios.get(`${baseUrl}/wp-json/wp/v2/posts?per_page=1`, {
        headers: { Referer: `${baseUrl}/` },
      });
      const total = Number(headerValue(headers, "x-wp-total"));
      if (total > 0) {
        totalPagesCache = Math.ceil(total / PER_PAGE);
        totalPages = totalPagesCache;
      }
    } catch (_) {}
  }
  return {
    currentPage: page,
    totalPages,
    hasNextPage: pageResults.length > 0,
    results: pageResults,
  };
}

async function SearchMovies(query, filters = {}) {
  // The site's own ?s= search returns an unrelated page without download
  // links, so the query is resolved through TMDB instead.
  const page = Math.max(1, Number(filters?.page || 1));
  const data = await tmdb("/search/multi", {
    query,
    page,
    include_adult: "false",
  });
  const results = (data.results || [])
    .filter((x) => x && (x.media_type === "movie" || x.media_type === "tv"))
    .filter((x) => x.title || x.name)
    .map((x) => {
      const type = x.media_type === "tv" ? "tv" : "movie";
      return {
        id: mediaId(type, x.id),
        title: x.title || x.name || "",
        image: x.poster_path
          ? `https://image.tmdb.org/t/p/w500${x.poster_path}`
          : null,
        year: (x.release_date || x.first_air_date || "").slice(0, 4) || null,
        rating: x.vote_average ? Number(x.vote_average.toFixed(1)) : null,
        type: type === "tv" ? "TV" : "Movie",
      };
    });
  return {
    currentPage: data.page || page,
    totalPages: data.total_pages || 1,
    hasNextPage: (data.page || page) < (data.total_pages || 1),
    results,
  };
}

async function MovieInfo(rawId) {
  const { type, id } = await resolveMedia(rawId);
  if (!id) {
    return {
      id: rawId,
      title: cleanTitle(String(rawId).replace(/^download-/, "")) || String(rawId),
      image: null,
      description: "",
      genres: [],
      status: "Unknown",
      year: null,
      type: "Movie",
      rating: null,
      runtime: null,
      totalEpisodes: null,
      episodes: [],
    };
  }
  const data = await tmdb(`/${type}/${id}`, { append_to_response: "credits,images" });
  const genres = (data.genres || []).map((g) => g.name);
  const title = data.title || data.name || id;
  const release = data.release_date || data.first_air_date || "";
  const image =
    data.poster_path ||
    (data.images && data.images.posters && data.images.posters[0]
      ? data.images.posters[0].file_path
      : null);

  const info = {
    id: rawId,
    title,
    image: image ? `https://image.tmdb.org/t/p/w500${image}` : null,
    description: data.overview || "",
    genres,
    status: data.status || (type === "movie" ? "Released" : "Unknown"),
    year: release ? Number(release.slice(0, 4)) || null : null,
    type: type === "tv" ? "TV" : "Movie",
    rating: data.vote_average ? Number(data.vote_average.toFixed(1)) : null,
    runtime: data.runtime || null,
    totalEpisodes: type === "tv" ? data.number_of_episodes || null : null,
    seasons:
      type === "tv"
        ? (data.seasons || []).map((s) => ({
            id: `${mediaId(type, id)}:s${s.season_number}`,
            number: s.season_number,
            name: s.name || `Season ${s.season_number}`,
            episodeCount: s.episode_count || 0,
          }))
        : undefined,
  };

  if (type === "tv") {
    info.episodes = await tvEpisodes(type, id);
  } else {
    info.episodes = [
      { id: mediaId("movie", id), number: 1, title: null, duration: null },
    ];
  }
  return info;
}

async function tvEpisodes(type, id) {
  const info = await tmdb(`/tv/${id}`);
  const episodes = [];
  for (const s of info.seasons || []) {
    if (!s.season_number) continue; // skip specials
    const season = await tmdb(`/tv/${id}/season/${s.season_number}`);
    for (const e of season.episodes || []) {
      episodes.push({
        id: `${mediaId(type, id)}:${s.season_number}:${e.episode_number}`,
        number: episodes.length + 1,
        title: e.name || null,
        season: s.season_number,
        episode: e.episode_number,
        duration: null,
      });
    }
  }
  return episodes;
}

async function fetchEpisode(rawId, page = 1) {
  try {
    const { type, id } = await resolveMedia(rawId);
    if (!id) {
      return { episodes: [], totalPages: 0, total: 0, currentPage: page };
    }
    if (type === "movie") {
      return {
        episodes: [{ id: mediaId("movie", id), number: 1, title: null, duration: null }],
        totalPages: 1,
        total: 1,
        currentPage: 1,
      };
    }
    const episodes = await tvEpisodes(type, id);
    return { episodes, totalPages: 1, total: episodes.length, currentPage: 1 };
  } catch (_) {
    return { episodes: [], totalPages: 0, total: 0, currentPage: page };
  }
}

// Resolvers from the Cinezo provider chain. Coverage varies per title, so every
// resolver that answers is returned as its own source entry.
async function resolveWithCinezo(type, tmdbId, season, episode) {
  const out = [];
  const path =
    type === "movie"
      ? `/movie/${tmdbId}.json`
      : `/tv/${tmdbId}/${season}/${episode}.json`;

  // 1) punkflix direct JSON
  try {
    const { data } = await axios.get(`https://punkflix.net${path}`, {
      headers: CINEZO_HEADERS,
      timeout: 12000,
    });
    const stream = (data && data.stream) || {};
    for (const key of ["original", "remux", "hls"]) {
      const url = stream[key];
      if (url && typeof url === "string" && /^https?:/.test(url)) {
        out.push({
          url,
          quality: key === "remux" ? "1080p" : key === "original" ? "720p" : "default",
          name: `Punkflix ${key}`,
          isM3U8: /\.m3u8/i.test(url),
          headers: CINEZO_HEADERS,
        });
      }
    }
  } catch (_) {}

  // 2) flikhub (sadie) + yenime (zendaya) proxies
  const proxies =
    type === "movie"
      ? [
          { name: "Flikhub", url: `https://proxy1.flikhub.net/movie?id=${tmdbId}&mode=json&sources=sadie&hevc=1` },
          { name: "Yenime", url: `https://proxy.yenime.net/movie?id=${tmdbId}&mode=json&sources=zendaya&hevc=1` },
        ]
      : [
          { name: "Flikhub", url: `https://proxy1.flikhub.net/tv?id=${tmdbId}&season=${season}&episode=${episode}&mode=json&sources=sadie&hevc=1` },
          { name: "Yenime", url: `https://proxy.yenime.net/tv?id=${tmdbId}&season=${season}&episode=${episode}&mode=json&sources=zendaya&hevc=1` },
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
          isM3U8: /\.m3u8/i.test(url),
          headers: CINEZO_HEADERS,
        });
      }
    } catch (_) {}
  }
  return out;
}

async function fetchMovieSources(episodeId, category = null) {
  const parts = String(episodeId).split(":");
  const type = parts[0] === "tv" ? "tv" : "movie";
  const tmdbId = parts[1];
  const season = type === "tv" ? parts[2] || "1" : null;
  const episode = type === "tv" ? parts[3] || "1" : null;

  const sources = await resolveWithCinezo(type, tmdbId, season, episode);
  return { sources, subtitles: [] };
}

module.exports = {
  name: "vegamovies",
  version: "1.0.0",
  baseUrl,
  headerRules: [
    {
      match: ["vegamovies.lease"],
      headers: { Referer: `${baseUrl}/` },
    },
  ],
  SearchMovies,
  latestMovies,
  MovieInfo,
  fetchEpisode,
  fetchMovieSources,
};
