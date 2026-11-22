/**
 * StrawVerse Extension - PirateXPlay (piratexplay.cc)
 * Catalogue from /category/latest (series cards), search from the site's own
 * /api/search-ajax.php?keyword= endpoint, episodes from the series page and
 * streams through the ravok player: episode page -> ravok.buzz/video/<token>
 * -> POST player/index.php?data=<token>&do=getVideo -> securedLink (a signed
 * HLS master with one audio track per dubbed language).
 */
const cheerio = require("cheerio");
const axios = global.axios || require("axios");

const baseUrl = "https://piratexplay.cc";
const playerHost = "https://ravok.buzz";

// AnimeInfo and fetchEpisode both need the series page; keep it for a minute
// so opening a title costs one request, not two.
const seriesCache = new Map();

async function fetchSeriesPage(slug) {
  const hit = seriesCache.get(slug);
  if (hit && Date.now() - hit.at < 60000) return hit.html;
  const html = await fetchText(`${baseUrl}/series/${slug}`);
  seriesCache.set(slug, { html, at: Date.now() });
  return html;
}

async function fetchText(url, headers = {}) {
  const { data } = await axios.get(url, {
    timeout: 25000,
    headers: { Referer: `${baseUrl}/`, ...headers },
    responseType: "text",
    transformResponse: [(d) => d],
  });
  return String(data || "");
}

function tmdbImage(poster, size = "w500") {
  if (!poster) return null;
  const raw = String(poster).trim();
  if (/^https?:\/\//i.test(raw)) {
    return raw.replace(/(image\.tmdb\.org\/t\/p\/)w\d+/, `$1${size}`);
  }
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return `https://image.tmdb.org/t/p/${size}${path}`;
}

// The catalogue renders one <li class="post series"> per title; movies share
// the markup but their player is a different (unverified) chain, so only
// series are exposed.
function parseCards(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();
  $("li.post.series").each((_, el) => {
    const card = $(el);
    const href = card.find("a.lnk-blk").first().attr("href") || "";
    const slug = href.replace(/^\/series\//, "").replace(/\/+$/, "");
    if (!slug || seen.has(slug)) return;
    const title = card.find("h2.entry-title").first().text().trim();
    if (!title) return;
    seen.add(slug);
    const img = card.find("img").first();
    results.push({
      id: slug,
      title,
      image: tmdbImage(img.attr("src") || img.attr("data-src")),
    });
  });
  return results;
}

function parseTotalPages(html) {
  let max = 1;
  const $ = cheerio.load(html);
  $('a[href*="/page/"]').each((_, el) => {
    const n = Number(String($(el).attr("href") || "").match(/\/page\/(\d+)/)?.[1]);
    if (n > max) max = n;
  });
  return max;
}

async function fetchRecentEpisodes(filters = {}) {
  const page = Math.max(1, Number(filters?.page || 1));
  const url =
    page === 1
      ? `${baseUrl}/category/latest`
      : `${baseUrl}/category/latest/page/${page}`;
  const html = await fetchText(url);
  const results = parseCards(html);
  return {
    currentPage: page,
    totalPages: parseTotalPages(html),
    hasNextPage: results.length > 0,
    results,
  };
}

async function SearchAnime(query) {
  const q = String(query || "").trim();
  if (!q) {
    return { currentPage: 1, totalPages: 1, hasNextPage: false, results: [] };
  }
  const url = `${baseUrl}/api/search-ajax.php?keyword=${encodeURIComponent(q)}`;
  const { data } = await axios.get(url, {
    timeout: 20000,
    headers: { Referer: `${baseUrl}/` },
  });
  // Real axios parses JSON, the test harness may hand back the raw string.
  let payload = data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch (_) {
      payload = null;
    }
  }
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const results = rows
    .map((row) => (row && row.tmdb ? row.tmdb : row))
    .filter((row) => row && String(row.type || "").toLowerCase() === "series")
    .map((row) => ({
      id: String(row.url || ""),
      title: String(row.title || "").trim(),
      image: tmdbImage(row.poster),
      year: row.release_year || null,
    }))
    .filter((row) => row.id && row.title);
  return { currentPage: 1, totalPages: 1, hasNextPage: false, results };
}

function parseLanguages($) {
  return $("p.loadactor a")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
}

async function AnimeInfo(id) {
  const slug = String(id).replace(/^\/?series\//, "").replace(/\/+$/, "");
  const html = await fetchSeriesPage(slug);
  const $ = cheerio.load(html);
  const title = ($("h1.entry-title").first().text() || "").trim() || slug;
  const description = ($("p.description").first().text() || "").trim();
  const genres = $("p.genres a")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  const languages = parseLanguages($);
  const yearText = $(".year .overviewCss").first().text().trim();
  const year = Number((yearText.match(/\d{4}/) || [])[0]) || null;
  const poster =
    $("img[alt^='Image']").first().attr("src") ||
    $("article.post.single img").first().attr("src") ||
    null;
  const hasEnglish = languages.some((language) => /^english$/i.test(language));
  return {
    id: slug,
    title,
    image: tmdbImage(poster),
    description,
    genres,
    status: "Unknown",
    year,
    type: "TV",
    totalEpisodes: $("ul#episode_by_temp a.lnk-blk").length || null,
    hasSub: true,
    hasDub: hasEnglish,
    subOrDub: hasEnglish ? "both" : "sub",
  };
}

async function fetchEpisode(id) {
  const slug = String(id).replace(/^\/episode\//, "").replace(/\/+$/, "");
  const html = await fetchSeriesPage(slug.replace(/-1x\d+$/, ""));
  const $ = cheerio.load(html);
  const languages = parseLanguages($);
  const hasEnglish = languages.some((language) => /^english$/i.test(language));
  const langs = hasEnglish ? ["sub", "dub"] : ["sub"];
  const episodes = [];
  const seen = new Set();
  $("ul#episode_by_temp a.lnk-blk").each((_, el) => {
    const href = $(el).attr("href") || "";
    const episodeSlug = href.replace(/^\/episode\//, "").replace(/\/+$/, "");
    if (!episodeSlug || seen.has(episodeSlug)) return;
    seen.add(episodeSlug);
    const article = $(el).closest("article");
    const numText = article.find("span.num-epi").first().text().trim();
    const number = Number((numText.match(/x(\d+)/) || [])[1]) || episodes.length + 1;
    const episodeTitle = article.find("h2.entry-title").first().text().trim();
    episodes.push({
      id: episodeSlug,
      number,
      title: episodeTitle || `Episode ${number}`,
      langs,
    });
  });
  return {
    episodes,
    totalPages: 1,
    total: episodes.length,
    currentPage: 1,
  };
}

function parseHlsTracks(manifest) {
  return String(manifest || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("#EXT-X-MEDIA:"))
    .map((line) => {
      const attrs = {};
      for (const match of line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
        attrs[match[1]] = match[2].replace(/^"|"$/g, "");
      }
      return attrs;
    });
}

async function fetchEpisodeSources(episodeId) {
  const slug = String(episodeId).replace(/^\/episode\//, "").replace(/\/+$/, "");
  const episodeUrl = `${baseUrl}/episode/${slug}/`;
  let html = "";
  try {
    html = await fetchText(episodeUrl);
  } catch (_) {
    return { sources: [], subtitles: [] };
  }
  const token = (html.match(/ravok\.buzz\/video\/([A-Za-z0-9]{16,})/) || [])[1];
  if (!token) return { sources: [], subtitles: [] };
  const playerUrl = `${playerHost}/video/${token}`;
  try {
    const response = await axios.post(
      `${playerHost}/player/index.php?data=${token}&do=getVideo`,
      new URLSearchParams({ hash: token, r: `${baseUrl}/` }).toString(),
      {
        timeout: 20000,
        responseType: "text",
        transformResponse: [(d) => d],
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Referer: playerUrl,
          Origin: playerHost,
          "X-Requested-With": "XMLHttpRequest",
        },
      },
    );
    // Real axios returns the raw body (transformResponse), the test harness
    // pre-parses JSON content types, so accept both shapes.
    const data = response.data;
    const j =
      typeof data === "object" && data !== null ? data : JSON.parse(String(data));
    const url = j.securedLink || (j.hls ? j.videoSource : null);
    if (!url || !/^https?:/.test(url)) return { sources: [], subtitles: [] };

    const manifest = await fetchText(url, {
      Referer: `${playerHost}/`,
      Origin: playerHost,
    }).catch(() => "");
    const tracks = parseHlsTracks(manifest);
    const hasEnglishDub = tracks.some(
      (track) =>
        String(track.TYPE || "").toUpperCase() === "AUDIO" &&
        (/^(eng|en)$/i.test(track.LANGUAGE || "") ||
          /^english$/i.test(track.NAME || "")),
    );

    const subtitles = tracks
      .filter(
        (track) =>
          String(track.TYPE || "").toUpperCase() === "SUBTITLES" && track.URI,
      )
      .map((track) => {
        try {
          return {
            lang: track.NAME || track.LANGUAGE || "Subtitles",
            url: new URL(track.URI, url).href,
          };
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean);

    return {
      sources: [
        {
          url,
          quality: "default",
          name: hasEnglishDub
            ? "PirateXPlay HLS (SUB + DUB)"
            : "PirateXPlay HLS (SUB)",
          type: hasEnglishDub ? "dub" : "sub",
          isM3U8: /\.m3u8/i.test(url),
          headers: { Referer: `${playerHost}/`, Origin: playerHost },
        },
      ],
      subtitles,
    };
  } catch (_) {
    return { sources: [], subtitles: [] };
  }
}

module.exports = {
  name: "piratexplay",
  version: "1.0.0",
  baseUrl,
  headerRules: [
    { match: ["piratexplay.cc"], headers: { Referer: `${baseUrl}/` } },
    {
      match: ["ravok.buzz", "as-cdn"],
      headers: { Referer: `${playerHost}/` },
    },
  ],
  SearchAnime,
  AnimeInfo,
  fetchEpisode,
  fetchEpisodeSources,
  fetchRecentEpisodes,
};
