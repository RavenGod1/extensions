/**
 * StrawVerse Extension - AniXo (anixo.buzz)
 * Catalogue + search via the AniXo anime DB (db.anixo.buzz), details via the
 * AniClipse CDN, episode lists via the AniXo unified API, and streams via the
 * anixo.buzz embed ticket -> /api/stream/resolve chain.
 */
const axios = global.axios || require("axios");

const baseUrl = "https://anixo.buzz";
const dbUrl = "https://db.anixo.buzz";
const cdnUrl = "https://cdn.aniclipse.com";
const episodesUrl = "https://ritesh0997-index.hf.space/api/tmdb/episodes";

// The catalogue hands out MAL ids while detail/episode/embed endpoints key on
// AniList ids, so the mapping learned from each row is cached.
const malToAni = new Map();

const HTML_ENTITIES = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
  nbsp: " ",
};

function stripHtml(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&(amp|quot|apos|lt|gt|nbsp);/g, (_, name) => HTML_ENTITIES[name] || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function mapStatus(status) {
  if (/finished|completed/i.test(String(status || ""))) return "Completed";
  if (/releasing|airing|ongoing/i.test(String(status || ""))) return "Ongoing";
  return "Unknown";
}

function rowToResult(row) {
  const malId = row.mal_id || row.idMal || null;
  const aniId = row.anilist_id || row.id || null;
  if (malId && aniId) malToAni.set(String(malId), String(aniId));
  const id = malId || aniId;
  const title =
    (row.title && (row.title.english || row.title.romaji || row.title.native)) ||
    row.title_english ||
    row.title_romaji ||
    String(id);
  const image =
    (row.cover_image &&
      (row.cover_image.extra_large || row.cover_image.large || row.cover_image.medium)) ||
    (row.coverImage &&
      (row.coverImage.extraLarge || row.coverImage.large || row.coverImage.medium)) ||
    (typeof row.cover_image === "string" ? row.cover_image : null) ||
    row.poster ||
    null;
  return { id: String(id), title, image };
}

async function searchDb(query, page, limit) {
  const { data } = await axios.get(`${dbUrl}/index.php`, {
    params: { api: "search", q: query, page, limit },
  });
  const rows = (data && (data.results || data.data || data.media || data.items)) || [];
  return { rows, total: (data && data.total) || 0, pages: (data && data.pages) || 0 };
}

async function listPage(query, page) {
  const limit = 20;
  let found = { rows: [], total: 0, pages: 0 };
  try {
    found = await searchDb(query, page, limit);
  } catch (_) {}
  const results = found.rows.map(rowToResult);
  const totalPages = found.pages || Math.max(1, Math.ceil(found.total / limit));
  return { currentPage: page, totalPages, hasNextPage: page < totalPages, results };
}

// Catalogue ids are MAL ids; every downstream endpoint wants the AniList id.
async function resolveAniId(malId) {
  const key = String(malId);
  if (malToAni.has(key)) return malToAni.get(key);
  try {
    const { data } = await axios.get(`${dbUrl}/index.php`, {
      params: { api: "anizip", mal_id: key },
    });
    const mappings = data && data.mappings;
    if (mappings && mappings.anilist_id && String(mappings.mal_id) === key) {
      malToAni.set(key, String(mappings.anilist_id));
      return String(mappings.anilist_id);
    }
  } catch (_) {}
  try {
    const { data } = await axios.get(`${dbUrl}/index.php`, {
      params: { api: "search", q: key, page: 1, limit: 5 },
    });
    const hit = ((data && data.results) || []).find(
      (row) => String(row.mal_id) === key && row.anilist_id,
    );
    if (hit) {
      malToAni.set(key, String(hit.anilist_id));
      return String(hit.anilist_id);
    }
  } catch (_) {}
  return null;
}

async function AnimeInfo(id) {
  const aniId = await resolveAniId(id);
  if (!aniId) throw new Error(`anixo: unknown anime id ${id}`);

  let detail = null;
  try {
    const { data } = await axios.get(`${cdnUrl}/v1/anime/${aniId}`);
    if (data && (data.title || data.description)) detail = data;
  } catch (_) {}
  if (!detail) {
    const { data } = await axios.get(`${dbUrl}/index.php`, {
      params: { api: "detail", id: aniId },
    });
    detail = data || {};
  }

  const cover = detail.cover_image || {};
  const subDub = detail.sub_dub || {};
  return {
    id: String(id),
    title:
      (detail.title && (detail.title.english || detail.title.romaji || detail.title.native)) ||
      detail.title_english ||
      detail.title_romaji ||
      String(id),
    image:
      cover.extra_large ||
      cover.large ||
      cover.medium ||
      (typeof detail.cover_image === "string" ? detail.cover_image : null) ||
      detail.banner_image ||
      null,
    description: stripHtml(detail.description || ""),
    genres: detail.genres || [],
    status: mapStatus(detail.status),
    year: detail.season_year || detail.year || null,
    season: detail.season || null,
    type: detail.format || "TV",
    totalEpisodes:
      detail.episodes_total || subDub.sub || detail.episodes || detail.next_air_ep || null,
  };
}

async function fetchEpisode(id, page = 1) {
  const aniId = await resolveAniId(id);
  if (!aniId) return { episodes: [], totalPages: 0, total: 0, currentPage: page };

  let raw = null;
  try {
    const { data } = await axios.get(`${episodesUrl}/${aniId}`);
    if (data && data.episodes) raw = data.episodes;
  } catch (_) {}
  if (!raw) {
    try {
      const { data } = await axios.get(`${dbUrl}/index.php`, {
        params: { api: "anizip", mal_id: id },
      });
      if (data && data.episodes) raw = data.episodes;
    } catch (_) {}
  }

  const episodes = Object.keys(raw || {})
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => {
      const ep = raw[key] || {};
      return {
        id: `${aniId}:${key}`,
        number: Number(ep.episodeNumber || key),
        title: (ep.title && (ep.title.en || ep.title.ja)) || `Episode ${key}`,
        duration: Number(ep.runtime || ep.length) || null,
      };
    });

  return { episodes, totalPages: 1, total: episodes.length, currentPage: 1 };
}

async function fetchEpisodeSources(episodeId, category = null) {
  const raw = String(episodeId);
  const idx = raw.lastIndexOf(":");
  const aniId = idx > 0 ? raw.slice(0, idx) : raw;
  const number = idx > 0 ? Number(raw.slice(idx + 1)) || 1 : 1;
  const wanted = String(category || "").toLowerCase() === "dub" ? "dub" : "sub";
  const tracks = wanted === "dub" ? ["dub", "sub"] : ["sub", "dub"];

  for (const track of tracks) {
    try {
      const embedUrl = `${baseUrl}/embed/ani/${aniId}/${number}?track=${track}&server=1`;
      // The embed page rejects requests without an anixo.buzz referer.
      const { data: html } = await axios.get(embedUrl, {
        headers: { Referer: `${baseUrl}/` },
      });
      const page = String(html || "");
      const ticket = /const ticket = "([^"]+)"/.exec(page);
      if (!ticket) continue;
      const malId = (/const malId = "([^"]*)"/.exec(page) || [])[1] || aniId;
      const title = (/const animeTitle = "([^"]*)"/.exec(page) || [])[1] || "";

      const { data } = await axios.get(`${baseUrl}/api/stream/resolve`, {
        params: {
          malId: malId || aniId,
          anilistId: aniId,
          title: title || aniId,
          episode: number,
          track,
          server: 1,
        },
        headers: {
          Origin: baseUrl,
          Referer: embedUrl,
          "x-embed-ticket": ticket[1],
          Accept: "application/json",
        },
      });

      const streamUrl = data && data.streamUrl;
      if (!streamUrl) continue;

      const headers = { Referer: `${baseUrl}/` };
      const sources = [
        {
          url: streamUrl,
          quality: "default",
          name: (data && data.server) || `AniXo ${track}`,
          type: track,
          isM3U8: true,
          headers,
        },
      ];
      for (const alt of (data && data.fallbackStreams) || []) {
        if (!alt) continue;
        sources.push({
          url: alt,
          quality: "default",
          name: `AniXo ${track} (backup)`,
          type: track,
          isM3U8: true,
          headers,
        });
      }

      return {
        sources,
        subtitles: ((data && data.subtitles) || [])
          .filter((sub) => sub && sub.url)
          .map((sub) => ({ lang: sub.label || sub.lang || "English", url: sub.url })),
      };
    } catch (_) {}
  }
  return { sources: [], subtitles: [] };
}

async function SearchAnime(query, filters = {}) {
  return listPage(query, Number(filters.page || 1));
}

async function fetchRecentEpisodes(filters = {}) {
  return listPage("", Number(filters.page || 1));
}

module.exports = {
  name: "anixo",
  version: "1.0.0",
  baseUrl,
  headerRules: [
    { match: ["anixo.buzz"], headers: { Referer: `${baseUrl}/` } },
  ],
  SearchAnime,
  AnimeInfo,
  fetchEpisode,
  fetchEpisodeSources,
  fetchRecentEpisodes,
};
