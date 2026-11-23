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

async function searchDb(query, page, limit, extra = {}) {
  const { data } = await axios.get(`${dbUrl}/index.php`, {
    params: { api: "search", q: query, page, limit, ...extra },
  });
  const rows = (data && (data.results || data.data || data.media || data.items)) || [];
  return { rows, total: (data && data.total) || 0, pages: (data && data.pages) || 0 };
}

// The API's status filter only accepts the vocabulary its rows use
// (FINISHED / RELEASING); anything else silently returns nothing.
function mapFilterStatus(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "";
  if (v === "currently-airing" || v === "airing" || v === "ongoing" || v === "releasing")
    return "RELEASING";
  if (v === "finished-airing" || v === "finished" || v === "completed")
    return "FINISHED";
  return "";
}

function rowTitle(row) {
  return (
    (row.title && (row.title.english || row.title.romaji || row.title.native)) ||
    row.title_english ||
    row.title_romaji ||
    ""
  );
}

function applyRowFilters(rows, filters = {}) {
  let out = rows;
  const format = String(filters.type || "").trim();
  if (format) {
    out = out.filter(
      (row) => String(row.format || "").toLowerCase() === format.toLowerCase(),
    );
  }
  const language = String(filters.language || "").trim().toLowerCase();
  if (language === "sub") {
    out = out.filter((row) => Number(row.anikoto_sub || 0) > 0);
  } else if (language === "dub") {
    out = out.filter((row) => Number(row.anikoto_dub || 0) > 0);
  }
  const sort = String(filters.sort || "").trim();
  if (sort === "score") {
    out = [...out].sort(
      (a, b) => Number(b.average_score || 0) - Number(a.average_score || 0),
    );
  } else if (sort === "most-viewed") {
    out = [...out].sort(
      (a, b) => Number(b.popularity || 0) - Number(a.popularity || 0),
    );
  } else if (sort === "name-az") {
    out = [...out].sort((a, b) => rowTitle(a).localeCompare(rowTitle(b)));
  } else if (sort === "latest-updated") {
    out = [...out].sort((a, b) => Number(b.year || 0) - Number(a.year || 0));
  }
  return out;
}

async function listPage(query, page, filters = {}) {
  const limit = 20;
  const status = mapFilterStatus(filters.status);
  let found = { rows: [], total: 0, pages: 0 };
  try {
    found = await searchDb(query, page, limit, status ? { status } : {});
  } catch (_) {}
  const results = applyRowFilters(found.rows, filters).map(rowToResult);
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
  // Episode counts per track: the CDN detail uses sub_dub, the DB detail uses
  // anikoto_sub/anikoto_dub. Both tell the app whether a DUB exists.
  const rawSub = subDub.sub ?? detail.anikoto_sub ?? detail.subbed;
  const rawDub = subDub.dub ?? detail.anikoto_dub ?? detail.dubbed;
  const subCount = Number(rawSub);
  const dubCount = Number(rawDub);
  const hasSub =
    rawSub != null && Number.isFinite(subCount) ? subCount > 0 : null;
  const hasDub =
    rawDub != null && Number.isFinite(dubCount) ? dubCount > 0 : null;
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
    hasSub: hasSub ?? undefined,
    hasDub: hasDub ?? undefined,
    subOrDub:
      hasSub && hasDub ? "both" : hasDub ? "dub" : hasSub ? "sub" : undefined,
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

// The stream URL is an HLS master; its EXT-X-STREAM-INF line carries the real
// resolution, so report that instead of a "default" quality.
async function detectQuality(url, headers) {
  try {
    const { data } = await axios.get(url, {
      headers,
      timeout: 10000,
      responseType: "text",
    });
    const match = /RESOLUTION=\d+x(\d+)/i.exec(String(data || ""));
    if (match) return `${Number(match[1])}p`;
  } catch (_) {}
  return "default";
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
      const urls = [
        streamUrl,
        ...((data && data.fallbackStreams) || []).filter(Boolean),
      ];
      const serverName = (data && data.server) || `AniXo ${track}`;
      const qualities = await Promise.all(
        urls.map((url) => detectQuality(url, headers)),
      );
      const sources = urls.map((url, index) => ({
        url,
        quality: qualities[index],
        name: index === 0 ? serverName : `${serverName} (backup ${index})`,
        type: track,
        isM3U8: true,
        headers,
      }));

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
  return listPage(query, Number(filters.page || 1), filters);
}

async function fetchRecentEpisodes(filters = {}) {
  return listPage("", Number(filters.page || 1), filters);
}

module.exports = {
  name: "anixo",
  version: "1.0.4",
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
