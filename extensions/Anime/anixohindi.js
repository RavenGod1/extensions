/**
 * StrawVerse Extension - AniXoHindi (anixohindi.cc)
 * Hindi-dub catalogue from /browse.php (cards carry the MAL id), episode list
 * from the watch page's WATCH_EPISODES json, and streams from the embed page,
 * whose url is obfuscated as base64 XOR with a per-request key.
 */
const cheerio = require("cheerio");
const axios = global.axios || require("axios");

const baseUrl = "https://anixohindi.cc";
const embedHost = "https://embed.anixohindi.cc";

// MAL id -> slug (the catalogue is the only place both appear together).
const idToSlug = new Map();

async function fetchHtml(url, headers = {}) {
  try {
    const { data } = await axios.get(url, {
      timeout: 25000,
      headers: { Referer: `${baseUrl}/`, ...headers },
    });
    return typeof data === "string" ? data : "";
  } catch (_) {
    return "";
  }
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();
  $(".anime-card").each((_, el) => {
    const card = $(el);
    const href = card.find("a.anime-card-poster[href*='watch.php']").first().attr("href") || "";
    const slug = decodeURIComponent((href.match(/anime=([^&]+)/) || [])[1] || "");
    if (!slug) return;
    const title = (
      card.find(".card-title a").first().text() ||
      card.find("img").first().attr("alt") ||
      ""
    ).trim();
    if (!title) return;
    const malId = card.find("[data-id]").first().attr("data-id") || "";
    const eps = (card.find(".card-ep-count span").first().text() || "").match(/\d+/);
    const year = (card.find(".meta-year").first().text() || "").match(/\d{4}/);
    const id = malId || slug;
    if (seen.has(id)) return;
    seen.add(id);
    if (malId) idToSlug.set(String(malId), slug);
    results.push({
      id,
      title,
      image: card.find("img").first().attr("src") || null,
      year: year ? Number(year[0]) : null,
      type: (card.find(".meta-tag").first().text() || "TV").trim(),
      totalEpisodes: eps ? Number(eps[0]) : null,
      malId: malId || null,
    });
  });
  return results;
}

async function loadCatalogue(query = "") {
  const url = query
    ? `${baseUrl}/browse.php?keyword=${encodeURIComponent(query)}`
    : `${baseUrl}/browse.php`;
  const html = await fetchHtml(url);
  const results = parseCards(html);
  if (query && results.length === 0) {
    // The site matches the whole keyword, so "Naruto: Shippuden" finds
    // nothing — fall back to a substring match over the whole catalogue.
    const all = parseCards(await fetchHtml(`${baseUrl}/browse.php`));
    const needle = normalize(query);
    return all.filter((r) => normalize(r.title).includes(needle));
  }
  return results;
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// The catalogue is one page of ~300 titles, so type/sort filters are applied
// client-side over the parsed cards.
function applyCatalogueFilters(results, filters = {}) {
  let out = results;
  const type = String(filters.type || "").trim();
  if (type && type.toLowerCase() !== "all") {
    out = out.filter(
      (row) => String(row.type || "").toUpperCase() === type.toUpperCase(),
    );
  }
  const sort = String(filters.sort || "").trim();
  if (sort === "name-az") {
    out = [...out].sort((a, b) => String(a.title).localeCompare(String(b.title)));
  } else if (sort === "latest-updated") {
    out = [...out].sort((a, b) => Number(b.year || 0) - Number(a.year || 0));
  } else if (sort === "most-viewed") {
    out = [...out].sort(
      (a, b) => Number(b.totalEpisodes || 0) - Number(a.totalEpisodes || 0),
    );
  }
  return out;
}

async function fetchRecentEpisodes(filters = {}) {
  const page = Math.max(1, Number(filters?.page || 1));
  // The catalogue is a single page of ~300 titles.
  if (page > 1) {
    return { currentPage: page, totalPages: 1, hasNextPage: false, results: [] };
  }
  const results = await loadCatalogue();
  return {
    currentPage: 1,
    totalPages: 1,
    hasNextPage: false,
    results: applyCatalogueFilters(results, filters),
  };
}

async function SearchAnime(query, filters = {}) {
  const q = String(query || "").trim();
  const results = await loadCatalogue(q);
  return {
    currentPage: 1,
    totalPages: 1,
    hasNextPage: false,
    results: applyCatalogueFilters(results, filters),
  };
}

// The watch page is the only place a slug, the AniList id and the episode
// list appear together.
async function loadWatchPage(id) {
  let slug = idToSlug.get(String(id));
  if (!slug) {
    const rows = await loadCatalogue();
    const hit = rows.find((r) => String(r.id) === String(id));
    slug = hit ? idToSlug.get(String(hit.id)) || null : null;
  }
  if (!slug) return null;
  const html = await fetchHtml(`${baseUrl}/watch.php?anime=${encodeURIComponent(slug)}&ep=1`);
  if (!html) return null;
  return { slug, html };
}

function parseEpisodes(html) {
  const m = html.match(/window\.WATCH_EPISODES\s*=\s*(\[.*?\]);/s);
  if (!m) return [];
  try {
    return JSON.parse(m[1]);
  } catch (_) {
    return [];
  }
}

async function AnimeInfo(id) {
  const watch = await loadWatchPage(id);
  if (!watch) {
    return {
      id,
      title: String(id),
      image: null,
      description: "",
      genres: [],
      status: "Unknown",
      year: null,
      type: "TV",
      totalEpisodes: null,
      hasSub: false,
      hasDub: true,
      subOrDub: "dub",
    };
  }
  const { slug, html } = watch;
  const $ = cheerio.load(html);
  const title = ($("h1").first().text() || "").trim() || slug;
  const description = ($(".anime-synopsis, .synopsis, .description").first().text() || "").trim();
  const total = Number((html.match(/window\.WATCH_TOTAL_EPS\s*=\s*(\d+)/) || [])[1] || 0) || null;
  const aniId = (html.match(/embed\/ani\/(\d+)/) || [])[1] || null;
  const poster =
    $(".anime-dossier-card.full-width-dossier .dossier-poster-img")
      .first()
      .attr("src") ||
    $(".dossier-poster-wrap .dossier-poster-img").first().attr("src") ||
    $('meta[property="og:image"]').attr("content") ||
    $("img").first().attr("src") ||
    null;
  return {
    id: String(id),
    title,
    image: poster
      ? poster.replace("/anime/cover/medium/", "/anime/cover/large/")
      : null,
    description,
    genres: [],
    status: "Ongoing",
    year: null,
    type: "TV",
    totalEpisodes: total,
    anilistId: aniId,
    // Every title on the site is Hindi dubbed.
    hasSub: false,
    hasDub: true,
    subOrDub: "dub",
  };
}

async function fetchEpisode(id, page = 1) {
  const watch = await loadWatchPage(id);
  if (!watch) {
    return { episodes: [], totalPages: 0, total: 0, currentPage: page };
  }
  const raw = parseEpisodes(watch.html);
  const episodes = raw
    .map((ep) => ({
      id: `${id}|${ep.number}|${ep.embed || ""}`,
      number: Number(ep.number),
      title: ep.title || `Episode ${ep.number}`,
      duration: null,
      langs: ["dub"],
    }))
    .filter((ep) => Number.isFinite(ep.number));
  return { episodes, totalPages: 1, total: episodes.length, currentPage: 1 };
}

// The embed page hides the stream url as base64 XOR'ed with a rotating key.
function decodeStream(encoded, key) {
  try {
    const bin = Buffer.from(encoded, "base64").toString("binary");
    let out = "";
    for (let i = 0; i < bin.length; i++) {
      out += String.fromCharCode(bin.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  } catch (_) {
    return null;
  }
}

async function fetchEpisodeSources(episodeId, category = null) {
  const parts = String(episodeId).split("|");
  const embedUrl = parts[2];
  if (!embedUrl) return { sources: [], subtitles: [] };
  const html = await fetchHtml(embedUrl, { Referer: `${baseUrl}/` });
  if (!html) return { sources: [], subtitles: [] };
  const encoded = (html.match(/const _p0\s*=\s*'([^']+)'/) || [])[1];
  const key = (html.match(/const _k0\s*=\s*'([^']+)'/) || [])[1];
  if (!encoded || !key) return { sources: [], subtitles: [] };
  const decoded = decodeStream(encoded, key);
  if (!decoded) return { sources: [], subtitles: [] };
  const url = decoded.startsWith("http")
    ? decoded
    : new URL(decoded, `${embedHost}/`).href;
  return {
    sources: [
      {
        url,
        quality: "default",
        name: "AniXoHindi Hindi Dub",
        type: "dub",
        isM3U8: /\.m3u8/i.test(url),
        headers: { Referer: `${embedHost}/` },
      },
    ],
    subtitles: [],
  };
}

module.exports = {
  name: "anixohindi",
  version: "1.0.4",
  baseUrl,
  headerRules: [
    {
      match: ["anixohindi.cc"],
      headers: { Referer: `${baseUrl}/` },
    },
    {
      match: ["embed.anixohindi.cc"],
      headers: { Referer: `${baseUrl}/` },
    },
  ],
  SearchAnime,
  AnimeInfo,
  fetchEpisode,
  fetchEpisodeSources,
  fetchRecentEpisodes,
};
