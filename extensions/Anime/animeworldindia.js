/**
 * StrawVerse Extension - Anime World India (watchanimeworld.one)
 * Catalogue from the /series/ archive and the WordPress search, episodes from
 * the series pages, streams through the zephyrix FirePlayer embed:
 * episode page -> iframe play.zephyrix.org/video/<token> -> POST
 * player/index.php?data=<token>&do=getVideo -> securedLink (signed HLS with
 * Hindi/English/Tamil/Telugu/Japanese audio tracks).
 */
const cheerio = require("cheerio");
const axios = global.axios || require("axios");

const baseUrl = "https://watchanimeworld.one";
const playerHost = "https://play.zephyrix.org";

function slugOf(href) {
  return String(href || "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\/+$/, "");
}

async function fetchText(url) {
  const { data } = await axios.get(url, {
    timeout: 25000,
    headers: { Referer: `${baseUrl}/` },
    responseType: "text",
    transformResponse: [(d) => d],
  });
  return String(data || "");
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();
  $("article").each((_, el) => {
    const href = $(el).find("a.lnk-blk[href]").first().attr("href") || "";
    const m = href.match(/\/series\/([^/?#]+)\/?/i);
    if (!m || seen.has(m[1])) return;
    const title = $(el)
      .find(".entry-title, h2")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim();
    if (!title) return;
    seen.add(m[1]);
    let img =
      $(el).find("img").first().attr("src") ||
      $(el).find("img").first().attr("data-src") ||
      null;
    // Archive cards use protocol-relative TMDB posters.
    if (img && img.startsWith("//")) img = `https:${img}`;
    results.push({ id: m[1], title, image: img, year: null, type: "TV" });
  });
  return results;
}

function parseTotalPages(html) {
  const $ = cheerio.load(html);
  let max = 0;
  $(".pagination a, a.page-numbers, .wp-pagenavi a").each((_, el) => {
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
  const url = page === 1 ? `${baseUrl}/series/` : `${baseUrl}/series/page/${page}/`;
  let html = "";
  try {
    html = await fetchText(url);
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

async function SearchAnime(query, filters = {}) {
  const q = String(query || "").trim();
  if (!q) return fetchRecentEpisodes(filters);
  let html = "";
  try {
    html = await fetchText(`${baseUrl}/?s=${encodeURIComponent(q)}`);
  } catch (_) {}
  return { currentPage: 1, totalPages: 1, hasNextPage: false, results: parseCards(html) };
}

function parseEpisodeLinks(html) {
  const links = [
    ...new Set(
      [...String(html).matchAll(/href=["'](https:\/\/watchanimeworld\.one\/episode\/[^"'#?]+)["']/gi)].map(
        (m) => m[1],
      ),
    ),
  ];
  const rows = links
    .map((href) => {
      const slug = href.replace(/\/+$/, "").split("/").pop();
      const m = slug.match(/-(\d+)x(\d+)$/);
      return { slug, season: m ? Number(m[1]) : 1, episode: m ? Number(m[2]) : 0 };
    })
    .filter((r) => r.episode);
  rows.sort((a, b) => a.season - b.season || a.episode - b.episode);
  return rows;
}

async function fetchEpisode(id) {
  const slug = String(id).replace(/^ep:/, "");
  let html = "";
  try {
    html = await fetchText(`${baseUrl}/series/${slug}/`);
  } catch (_) {
    return { episodes: [], totalPages: 0, total: 0, currentPage: 1 };
  }
  const rows = parseEpisodeLinks(html);
  const episodes = rows.map((r, i) => ({
    id: `ep:${r.slug}`,
    number: i + 1,
    title: `Episode ${r.episode}`,
    season: r.season,
    episode: r.episode,
    duration: null,
    // The HLS renditions carry both the Japanese track and Hindi/English dubs.
    langs: ["sub", "dub"],
  }));
  return { episodes, totalPages: 1, total: episodes.length, currentPage: 1 };
}

async function AnimeInfo(id) {
  const slug = String(id);
  let html = "";
  try {
    html = await fetchText(`${baseUrl}/series/${slug}/`);
  } catch (_) {}
  const $ = cheerio.load(html);
  const title =
    $("h1").first().text().replace(/\s+/g, " ").trim() ||
    slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const tmdbImg = (html.match(/(?:src|content)=["'](\/\/image\.tmdb\.org\/t\/p\/w\d+\/[^"']+)["']/i) ||
    [])[1];
  const image = tmdbImg ? `https:${tmdbImg}` : null;
  const entryMeta = $(".entry-meta").first().text().replace(/\s+/g, " ").trim();
  const metaDesc = ($('meta[name="description"]').attr("content") || "").trim();
  const description = (entryMeta || metaDesc).slice(0, 700);
  const bodyText = $("body").text().replace(/\s+/g, " ");
  const genreMatch = bodyText.match(/Genres\s+([A-Za-z0-9&,\s-]+?)\s+Languages/i);
  const genres = genreMatch
    ? genreMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const { episodes } = await fetchEpisode(slug);
  return {
    id: slug,
    title,
    image,
    description,
    genres,
    status: "Unknown",
    year: null,
    type: "TV",
    totalEpisodes: episodes.length || null,
    hasSub: true,
    hasDub: true,
    subOrDub: "both",
  };
}

async function fetchEpisodeSources(episodeId) {
  const slug = String(episodeId).replace(/^ep:/, "");
  let html = "";
  try {
    html = await fetchText(`${baseUrl}/episode/${slug}/`);
  } catch (_) {
    return { sources: [], subtitles: [] };
  }
  const token = (html.match(/play\.zephyrix\.org\/video\/([A-Za-z0-9]{16,})/) || [])[1];
  if (!token) return { sources: [], subtitles: [] };
  try {
    const { data } = await axios.post(
      `${playerHost}/player/index.php?data=${token}&do=getVideo`,
      new URLSearchParams({ hash: token, r: `${baseUrl}/` }).toString(),
      {
        timeout: 20000,
        responseType: "text",
        transformResponse: [(d) => d],
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Referer: `${playerHost}/video/${token}`,
          Origin: playerHost,
          "X-Requested-With": "XMLHttpRequest",
        },
      },
    );
    // Real axios returns the raw body (transformResponse) but the test harness
    // pre-parses JSON content types, so accept both shapes.
    const j =
      typeof data === "object" && data !== null ? data : JSON.parse(String(data));
    const url = j.securedLink || (j.hls ? j.videoSource : null);
    if (!url || !/^https?:/.test(url)) return { sources: [], subtitles: [] };
    return {
      sources: [
        {
          url,
          quality: "default",
          name: "Anime World India HLS",
          type: "dub",
          isM3U8: /\.m3u8/i.test(url),
          headers: { Referer: `${playerHost}/`, Origin: playerHost },
        },
      ],
      subtitles: [],
    };
  } catch (_) {
    return { sources: [], subtitles: [] };
  }
}

module.exports = {
  name: "animeworldindia",
  version: "1.0.0",
  baseUrl,
  headerRules: [{ match: ["watchanimeworld.one"], headers: { Referer: `${baseUrl}/` } }],
  SearchAnime,
  AnimeInfo,
  fetchEpisode,
  fetchEpisodeSources,
  fetchRecentEpisodes,
};
