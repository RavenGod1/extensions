/**
 * StrawVerse Extension - Anime World India (watchanimeworld.one)
 * Catalogue from the /series/ archive and the WordPress search, episodes from
 * the series pages, streams through the zephyrix FirePlayer embed:
 * episode page -> iframe play.zephyrix.org/video/<token> -> POST
 * player/index.php?data=<token>&do=getVideo -> securedLink (signed HLS with
 * title-specific audio tracks and optional player subtitles).
 */
const cheerio = require("cheerio");
const axios = global.axios || require("axios");

const baseUrl = "https://watchanimeworld.one";
const playerHost = "https://play.zephyrix.org";
const animeSaltBaseUrl = "https://animesalt.cx";
const ravokHost = "https://ravok.buzz";

function slugOf(href) {
  return String(href || "")
    .replace(/^https?:\/\/[^/]+\//, "")
    .replace(/\/+$/, "");
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

function parseSeriesLanguages(html) {
  const $ = cheerio.load(html);
  return $(".loadactor a")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
}

function parsePoster(html) {
  const $ = cheerio.load(html);
  const images = $("article.post.single img")
    .map((_, el) => $(el).attr("src"))
    .get()
    .filter(Boolean);
  const poster =
    images.find((src) => /image\.tmdb\.org\/t\/p\//i.test(src)) ||
    images[0] ||
    (html.match(/(?:src|content)=["'](\/\/image\.tmdb\.org\/t\/p\/w\d+\/[^"']+)["']/i) || [])[1];
  if (!poster) return null;
  return poster
    .replace(/^\/\//, "https://")
    .replace(/(image\.tmdb\.org\/t\/p\/)w\d+/, "$1w500");
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

function parsePlayerSubtitles(playerHtml) {
  const match = String(playerHtml || "").match(
    /var\s+playerjsSubtitle\s*=\s*("(?:\\.|[^"\\])*")\s*;/,
  );
  if (!match) return [];
  let value;
  try {
    value = JSON.parse(match[1]);
  } catch (_) {
    return [];
  }
  return String(value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const labeled = entry.match(/^\[([^\]]+)\]\s*(.+)$/);
      const url = labeled ? labeled[2] : entry;
      if (!/^https?:/i.test(url)) return null;
      return { lang: labeled ? labeled[1] : "English", url };
    })
    .filter(Boolean);
}

async function fetchAnimeSaltSubtitles(slug) {
  if (!/-\d+x\d+$/.test(String(slug || ""))) return [];
  try {
    const episodeUrl = `${animeSaltBaseUrl}/episode/${slug}/`;
    const episodeHtml = await fetchText(episodeUrl, {
      Referer: `${animeSaltBaseUrl}/`,
    });
    const token = (
      episodeHtml.match(/ravok\.buzz\/video\/([A-Za-z0-9]{16,})/) || []
    )[1];
    if (!token) return [];
    const playerUrl = `${ravokHost}/video/${token}`;
    const playerHtml = await fetchText(playerUrl, { Referer: episodeUrl });
    return parsePlayerSubtitles(playerHtml).map((subtitle) => ({
      ...subtitle,
      headers: { Referer: `${ravokHost}/` },
    }));
  } catch (_) {
    return [];
  }
}

function normalizeSubtitleTime(value) {
  const match = String(value || "").match(
    /(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/,
  );
  if (!match) return null;
  return `${match[1].padStart(2, "0")}:${match[2]}:${match[3]}.${match[4].padEnd(3, "0")}`;
}

function toWebVtt(text) {
  const source = String(text || "").replace(/\r/g, "");
  if (/^\s*WEBVTT/.test(source)) return source;
  const cues = [];
  for (const block of source.split(/\n{2,}/)) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const [startRaw, endRaw] = lines[timingIndex].split("-->");
    const start = normalizeSubtitleTime(startRaw);
    const end = normalizeSubtitleTime(endRaw);
    const cueText = lines.slice(timingIndex + 1).join("\n").trim();
    if (!start || !end || !cueText) continue;
    cues.push(`${start} --> ${end}\n${cueText}`);
  }
  return cues.length ? `WEBVTT\n\n${cues.join("\n\n")}\n` : null;
}

function subtitleDataUrl(vtt) {
  return `data:text/vtt;base64,${Buffer.from(vtt, "utf8").toString("base64")}`;
}

async function resolveSubtitles(candidates) {
  const subtitles = [];
  for (const candidate of candidates) {
    const headers = candidate.headers || {
      Referer: `${playerHost}/`,
      Origin: playerHost,
    };
    try {
      const text = await fetchText(candidate.url, headers);
      const vtt = toWebVtt(text);
      subtitles.push(
        vtt
          ? { lang: candidate.lang, url: subtitleDataUrl(vtt) }
          : { ...candidate, headers },
      );
    } catch (_) {
      subtitles.push({ ...candidate, headers });
    }
  }
  return subtitles;
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
  const languages = parseSeriesLanguages(html);
  const hasEnglishDub = languages.some((language) =>
    /^english$/i.test(language),
  );
  const rows = parseEpisodeLinks(html);
  const episodes = rows.map((r, i) => ({
    id: `ep:${r.slug}`,
    number: i + 1,
    title: `Episode ${r.episode}`,
    season: r.season,
    episode: r.episode,
    duration: null,
    langs: hasEnglishDub ? ["sub", "dub"] : ["sub"],
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
  const image = parsePoster(html);
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
  const hasEnglishDub = parseSeriesLanguages(html).some((language) =>
    /^english$/i.test(language),
  );
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
    hasDub: hasEnglishDub,
    subOrDub: hasEnglishDub ? "both" : "sub",
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
  const playerUrl = `${playerHost}/video/${token}`;
  try {
    const [playerHtml, response] = await Promise.all([
      fetchText(playerUrl).catch(() => ""),
      axios.post(
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
      ),
    ]);
    // Real axios returns the raw body (transformResponse) but the test harness
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

    const candidates = [];
    for (const track of tracks) {
      if (String(track.TYPE || "").toUpperCase() !== "SUBTITLES" || !track.URI) {
        continue;
      }
      try {
        candidates.push({
          lang: track.NAME || track.LANGUAGE || "Subtitles",
          url: new URL(track.URI, url).href,
        });
      } catch (_) {}
    }
    if (!candidates.length) candidates.push(...parsePlayerSubtitles(playerHtml));

    let subtitles = await resolveSubtitles(candidates);
    if (!subtitles.length) {
      subtitles = await resolveSubtitles(await fetchAnimeSaltSubtitles(slug));
    }

    return {
      sources: [
        {
          url,
          quality: "default",
          name: hasEnglishDub
            ? "Anime World India HLS (SUB + DUB)"
            : "Anime World India HLS (SUB)",
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
  name: "animeworldindia",
  version: "1.0.3",
  baseUrl,
  headerRules: [
    { match: ["watchanimeworld.one"], headers: { Referer: `${baseUrl}/` } },
    {
      match: ["zephyrix.org", "zn-grid"],
      headers: { Referer: `${playerHost}/`, Origin: playerHost },
    },
    {
      match: ["animesalt.cx"],
      headers: { Referer: `${animeSaltBaseUrl}/` },
    },
    {
      match: ["ravok.buzz", "as-cdn"],
      headers: { Referer: `${ravokHost}/` },
    },
  ],
  bypassDomains: ["zephyrix.org", "zn-grid"],
  cookieDomains: ["zephyrix.org", "zn-grid"],
  SearchAnime,
  AnimeInfo,
  fetchEpisode,
  fetchEpisodeSources,
  fetchRecentEpisodes,
};
