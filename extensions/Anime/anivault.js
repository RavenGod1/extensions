/**
 * StrawVerse Extension - AniVault (anivault.tv)
 * The site is a SvelteKit app that renders its data into the page bootstrap
 * script, so every list/detail is read from that payload. Streams come from
 * the site's own /api/sources endpoint (direct HLS + image subtitle tracks).
 *
 * Cloudflare guards the site; the app's axios interceptor solves the
 * challenge and retries when the domain is declared in bypassDomains.
 */
const axios = global.axios || require("axios");

const baseUrl = "https://anivault.tv";

// The payload is a JS object literal (unquoted keys, void 0), so it is read
// with targeted patterns instead of JSON.parse.
function payloadOf(html) {
  const i = html.indexOf("kit.start");
  return i >= 0 ? html.slice(i) : html;
}

function unescapeJs(text) {
  return String(text || "")
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function parseStringArray(raw) {
  return [...String(raw || "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

function parseReleases(html) {
  const payload = payloadOf(html);
  const results = [];
  const re =
    /\{href:"([^"]+)",title:"([^"]*)",cover:"([^"]*)",episode:(\d+),relativeTime:"[^"]*"\}/g;
  let m;
  while ((m = re.exec(payload)) !== null) {
    results.push({
      id: m[1].replace(/^\//, ""),
      title: unescapeJs(m[2]),
      image: m[3] || null,
      episode: Number(m[4]) || null,
    });
  }
  return results;
}

function parseAnimeList(html) {
  const payload = payloadOf(html);
  const results = [];
  const re =
    /\{title:"([^"]+)",href:"([^"]+)",cover:"([^"]*)",year:(null|\d+),format:"([^"]*)",episodes:(null|\d+),status:"([^"]*)"\}/g;
  let m;
  while ((m = re.exec(payload)) !== null) {
    results.push({
      id: m[2].replace(/^\//, ""),
      title: unescapeJs(m[1]),
      image: m[3] || null,
      year: m[4] === "null" ? null : Number(m[4]),
      type: m[5] || null,
      totalEpisodes: m[6] === "null" ? null : Number(m[6]),
      status: m[7] || null,
    });
  }
  return results;
}

function parseWatchPage(html) {
  const payload = payloadOf(html);
  if (!payload.includes("watchData:")) return null;
  const episodes = [];
  const re = /\{number:(\d+),token:"([^"]+)",image:"([^"]*)"\}/g;
  let m;
  while ((m = re.exec(payload)) !== null) {
    episodes.push({ number: Number(m[1]), token: m[2], image: m[3] || null });
  }
  const pick = (re) => {
    const hit = payload.match(re);
    return hit ? hit[1] : null;
  };
  return {
    title: pick(/title:"([^"]*)",cover:"([^"]*)"/) || null,
    cover: pick(/title:"([^"]*)",cover:"([^"]*)"/),
    format: pick(/format:"([^"]*)",infoHref:/),
    statusText: pick(/statusText:"([^"]*)"/),
    epCountText: pick(/epCountText:"([^"]*)"/),
    seasonText: pick(/seasonText:"([^"]*)"/),
    infoHref: pick(/infoHref:"([^"]+)"/),
    currentEpisode: Number(pick(/currentEpisode:(\d+)/)) || null,
    episodes,
  };
}

function parseAnimePage(html) {
  const payload = payloadOf(html);
  if (!payload.includes("media:")) return null;
  const pick = (re) => {
    const hit = payload.match(re);
    return hit ? hit[1] : null;
  };
  const description = pick(/description:"((?:[^"\\]|\\.)*)"/);
  return {
    title: pick(/title:"([^"]*)",cover:"([^"]*)"/),
    cover: pick(/title:"([^"]*)",cover:"([^"]*)"/),
    format: pick(/media:\{format:"([^"]*)"/),
    status: pick(/media:\{format:"[^"]*",status:"([^"]*)"/),
    totalEpisodes: pick(/media:\{format:"[^"]*",status:"[^"]*",episodes:(null|\d+)/),
    season: pick(/media:\{[^}]*season:"([^"]*)"/),
    seasonYear: pick(/seasonYear:(null|\d+)/),
    score: pick(/averageScore:(null|\d+)/),
    genres: parseStringArray(pick(/genres:\[([^\]]*)\]/) || ""),
    studios: parseStringArray(pick(/studios:\[([^\]]*)\]/) || ""),
    description: description ? unescapeJs(description) : "",
    watchHref: pick(/watchHref:"([^"]+)"/),
  };
}

function mapStatus(text) {
  if (/releasing|airing/i.test(text)) return "Ongoing";
  if (/finished/i.test(text)) return "Completed";
  if (/not yet/i.test(text)) return "Upcoming";
  if (/cancelled/i.test(text)) return "Cancelled";
  return "Unknown";
}

async function fetchPage(path) {
  const { data } = await axios.get(`${baseUrl}${path}`);
  return data;
}

async function SearchAnime(query, filters = {}) {
  const html = await fetchPage(`/anime?q=${encodeURIComponent(query)}`);
  return {
    currentPage: 1,
    hasNextPage: false,
    totalPages: 1,
    results: parseAnimeList(html),
  };
}

async function fetchRecentEpisodes(filters = {}) {
  // The home page lists the newest episodes; it has no pagination.
  const page = Math.max(1, Number(filters?.page || 1));
  const html = await fetchPage("/");
  return {
    currentPage: page,
    hasNextPage: false,
    totalPages: 1,
    results: parseReleases(html),
  };
}

// A /go/ token resolves to either an anime page or a watch page.
async function fetchEntry(id) {
  const html = await fetchPage(`/${id}`);
  const watch = parseWatchPage(html);
  if (watch) return { html, watch, anime: null };
  const anime = parseAnimePage(html);
  return { html, watch: null, anime };
}

async function AnimeInfo(id) {
  const { watch, anime } = await fetchEntry(id);
  if (watch) {
    // Episode entry: the linked anime page carries the long description.
    let details = null;
    if (watch.infoHref) {
      try {
        details = parseAnimePage(await fetchPage(watch.infoHref));
      } catch (_) {}
    }
    const meta = details || {};
    const season = watch.seasonText || meta.season || null;
    return {
      id,
      title: watch.title || meta.title || id,
      image: watch.cover || meta.cover || null,
      type: watch.format || meta.format || "TV",
      description: meta.description || "",
      genres: meta.genres || [],
      status: mapStatus(watch.statusText || meta.status || ""),
      year: meta.seasonYear ? Number(meta.seasonYear) : null,
      season: season || null,
      rating: meta.score ? Number(meta.score) : null,
      totalEpisodes: watch.episodes.length || null,
    };
  }
  if (anime) {
    const season = anime.seasonYear
      ? `${anime.season || ""} ${anime.seasonYear}`.trim()
      : anime.season || null;
    return {
      id,
      title: anime.title || id,
      image: anime.cover || null,
      type: anime.format || "TV",
      description: anime.description || "",
      genres: anime.genres || [],
      status: mapStatus(anime.status || ""),
      year: anime.seasonYear ? Number(anime.seasonYear) : null,
      season,
      rating: anime.score ? Number(anime.score) : null,
      totalEpisodes: anime.totalEpisodes || null,
    };
  }
  return {
    id,
    title: id,
    image: null,
    type: "TV",
    description: "",
    genres: [],
    status: "Unknown",
    year: null,
    season: null,
    totalEpisodes: null,
  };
}

async function fetchEpisode(id, page = 1) {
  try {
    const { watch, anime } = await fetchEntry(id);
    let episodes = watch ? watch.episodes : [];
    if (!episodes.length && anime && anime.watchHref) {
      const watchPage = parseWatchPage(await fetchPage(anime.watchHref));
      episodes = watchPage ? watchPage.episodes : [];
    }
    return {
      episodes: episodes.map((e) => ({
        id: e.token,
        number: e.number,
        title: `Episode ${e.number}`,
        duration: null,
      })),
      totalPages: 1,
      total: episodes.length,
      currentPage: 1,
    };
  } catch (_) {
    return { episodes: [], totalPages: 0, total: 0, currentPage: page };
  }
}

async function fetchEpisodeSources(episodeId, category = null) {
  const { data } = await axios.get(`${baseUrl}/api/sources`, {
    params: { id: String(episodeId) },
  });
  const url = data?.playUrl;
  if (!url) return { sources: [], subtitles: [] };
  const sources = [
    {
      url,
      quality: "default",
      name: "AniVault",
      type: String(category || "").toLowerCase() === "dub" ? "dub" : "sub",
      isM3U8: /\.m3u8/i.test(url),
      headers: { Referer: `${baseUrl}/` },
    },
  ];
  const subtitles = (data?.subtitles || [])
    .filter((s) => s && s.url)
    .map((s) => ({ url: s.url, lang: s.lang || "unknown" }));
  return { sources, subtitles };
}

module.exports = {
  name: "anivault",
  version: "1.0.0",
  baseUrl,
  bypassDomains: ["anivault.tv"],
  headerRules: [
    { match: ["anivault.tv"], headers: { Referer: `${baseUrl}/` } },
  ],
  SearchAnime,
  AnimeInfo,
  fetchEpisode,
  fetchEpisodeSources,
  fetchRecentEpisodes,
};
