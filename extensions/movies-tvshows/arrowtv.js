/**
 * StrawVerse Extension - ArrowTV (arrowtv.net)
 * Catalogue scraped from ArrowTV search cards (TMDB-backed ids), titles/episodes
 * from the TMDB v3 API, streams via the Cinezo resolver chain (punkflix ->
 * flikhub -> yenime) because ArrowTV's own player never exposes raw sources.
 */
const axios = global.axios || require("axios");

const baseUrl = "https://arrowtv.net";
const TMDB_API = "https://api.themoviedb.org/3";
const TMDB_KEY = "8476a7ab80ad76f0936744df0430e67c";
const CINEZO_HEADERS = {
  Referer: "https://player.cinezo.live/",
  Origin: "https://player.cinezo.live",
};

function tmdb(path, params = {}) {
  return axios
    .get(`${TMDB_API}${path}`, { params: { api_key: TMDB_KEY, ...params } })
    .then((r) => r.data);
}

function mediaId(type, id) {
  return `${type}:${id}`;
}

function parseId(raw) {
  const [type, id] = String(raw).split(":");
  return { type: type === "tv" ? "tv" : "movie", id };
}

function abs(src) {
  if (!src) return null;
  try {
    return new URL(src, baseUrl).href;
  } catch (_) {
    return src;
  }
}

function parseCards(html) {
  const $ = require("cheerio").load(html);
  const results = [];
  $("a[href*='/movie/'], a[href*='/tv/']").each((_, el) => {
    const href = ($(el).attr("href") || "").split("?")[0];
    const m = href.match(/^\/(movie|tv)\/(\d+)$/);
    if (!m) return;
    const img = $(el).find("img").first();
    // Cards carry the title in aria-label ("4. VisionQuest" — strip the
    // rank prefix); img alt is empty on this site.
    const title = (
      $(el).attr("aria-label") ||
      img.attr("alt") ||
      ""
    )
      .replace(/^\d+\.\s*/, "")
      .trim();
    if (!title || results.some((r) => r.id === mediaId(m[1], m[2]))) return;
    results.push({
      id: mediaId(m[1], m[2]),
      title,
      image: img.attr("src") || null,
      type: m[1] === "tv" ? "TV" : "Movie",
    });
  });
  return results;
}

function parseDiscover(items) {
  return (items || [])
    .filter((x) => x && x.id)
    .map((x) => {
      const type = x.media_type === "tv" ? "tv" : "movie";
      return {
        id: mediaId(type, x.id),
        // TV rows carry "name"/"original_name" instead of "title".
        title: x.title || x.name || x.original_name || "",
        image: x.poster_path
          ? `https://image.tmdb.org/t/p/w500${x.poster_path}`
          : null,
        year: (x.release_date || x.first_air_date || "").slice(0, 4) || null,
        rating: x.vote_average ? Number(x.vote_average.toFixed(1)) : null,
        type: type === "tv" ? "TV" : "Movie",
      };
    })
    .filter((x) => x.title);
}

async function SearchMovies(query, filters = {}) {
  const { data: html } = await axios.get(`${baseUrl}/search`, {
    params: { q: query },
  });
  return { currentPage: 1, hasNextPage: false, totalPages: 1, results: parseCards(html) };
}

async function latestMovies(filters = {}) {
  // /api/discover paginates for real (20/page, total_pages 500). Movies and
  // shows live in separate queries, so both are merged into one page.
  const page = Math.max(1, Number(filters?.page || 1));
  let movies = null;
  let shows = null;
  try {
    [movies, shows] = await Promise.all([
      axios.get(`${baseUrl}/api/discover`, { params: { type: "movie", page } }),
      axios.get(`${baseUrl}/api/discover`, { params: { type: "tv", page } }),
    ]);
  } catch (_) {}
  const results = [
    ...parseDiscover(movies?.data?.results),
    ...parseDiscover(shows?.data?.results),
  ];
  return {
    currentPage: page,
    totalPages: Math.min(
      movies?.data?.total_pages || 1,
      shows?.data?.total_pages || 1,
    ),
    hasNextPage: results.length > 0,
    results,
  };
}

async function MovieInfo(mediaIdRaw) {
  const { type, id } = parseId(mediaIdRaw);
  const data = await tmdb(`/${type}/${id}`, {
    append_to_response: "credits,images",
  });

  const genres = (data.genres || []).map((g) => g.name);
  const title = data.title || data.name || id;
  const release = data.release_date || data.first_air_date || "";
  const image =
    data.poster_path || (data.images && data.images.posters && data.images.posters[0]
      ? data.images.posters[0].file_path
      : null);

  return {
    id: mediaIdRaw,
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
            id: `${mediaIdRaw}:s${s.season_number}`,
            number: s.season_number,
            name: s.name || `Season ${s.season_number}`,
            episodeCount: s.episode_count || 0,
          }))
        : undefined,
  };
}

async function fetchEpisode(mediaIdRaw, page = 1) {
  const { type, id } = parseId(mediaIdRaw);
  if (type === "movie") {
    return {
      episodes: [{ id: mediaIdRaw, number: 1, title: null, duration: null }],
      totalPages: 1,
      total: 1,
      currentPage: 1,
    };
  }
  const info = await tmdb(`/tv/${id}`);
  const episodes = [];
  for (const s of info.seasons || []) {
    if (!s.season_number) continue; // skip specials
    const season = await tmdb(`/tv/${id}/season/${s.season_number}`);
    for (const e of season.episodes || []) {
      episodes.push({
        id: `${mediaIdRaw}:${s.season_number}:${e.episode_number}`,
        number: episodes.length + 1,
        title: e.name || null,
        season: s.season_number,
        episode: e.episode_number,
        duration: null,
      });
    }
  }
  return { episodes, totalPages: 1, total: episodes.length, currentPage: 1 };
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
  const raw = String(episodeId);
  // Accept "movie:123", "tv:123:2:5", or a bare "movie:123:2:5" episode id from fetchEpisode.
  const parts = raw.split(":");
  const type = parts[0] === "tv" ? "tv" : "movie";
  const tmdbId = parts[1];
  const season = type === "tv" ? parts[2] || "1" : null;
  const episode = type === "tv" ? parts[3] || "1" : null;

  const sources = await resolveWithCinezo(type, tmdbId, season, episode);
  return { sources, subtitles: [] };
}

module.exports = {
  name: "arrowtv",
  version: "1.0.2",
  baseUrl,
  headerRules: [
    {
      match: ["arrowtv.net"],
      headers: { Referer: `${baseUrl}/` },
    },
  ],
  SearchMovies,
  latestMovies,
  MovieInfo,
  fetchEpisode,
  fetchMovieSources,
};
