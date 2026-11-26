/**
 * StrawVerse Extension - Anime World India (watchanimeworld.one)
 * Catalogue from the /series/ archive and the WordPress search, episodes from
 * the series pages, streams through the zephyrix FirePlayer embed:
 * episode page -> iframe play.zephyrix.org/video/<token> -> POST
 * player/index.php?data=<token>&do=getVideo -> securedLink (signed HLS with
 * title-specific audio tracks and optional player subtitles).
 */
const cheerio = require("cheerio");
const crypto = require("crypto");
const axios = global.axios || require("axios");

const baseUrl = "https://watchanimeworld.one";
const playerHost = "https://play.zephyrix.org";
const animeSaltBaseUrl = "https://animesalt.cx";
const ravokHost = "https://ravok.buzz";
const abyssPlayerHost = "https://player.abyssplayer.com";

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

function highestResolution(manifest) {
  const heights = [
    ...String(manifest || "").matchAll(/RESOLUTION=\d+x(\d+)/gi),
  ].map((m) => Number(m[1]));
  if (!heights.length) return "default";
  return `${Math.max(...heights)}p`;
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

function parseAnimeSaltEmbeds(html) {
  const ravokTokens = new Set();
  const abyssEmbeds = new Map();
  const $ = cheerio.load(String(html || ""));
  const embedUrls = [];
  $("iframe").each((_, element) => {
    for (const attribute of ["src", "data-src"]) {
      const value = $(element).attr(attribute);
      if (value) embedUrls.push(value);
    }
  });

  const addEmbed = (raw, language = "") => {
    let url;
    try {
      url = new URL(raw, animeSaltBaseUrl);
    } catch (_) {
      return;
    }
    if (url.hostname === "ravok.buzz") {
      const token = url.pathname.match(/^\/video\/([A-Za-z0-9]{16,})/)?.[1];
      if (token) ravokTokens.add(token);
      return;
    }
    if (url.hostname === "player.abyssplayer.com") {
      const slug = url.pathname.replace(/^\/+|\/+$/g, "");
      if (slug) abyssEmbeds.set(url.href, language);
      return;
    }
    if (!url.pathname.includes("/plyr/player.php")) return;
    const dataMatch = String(raw).match(/[?&]data=([^&#]+)/i);
    let data = "";
    try {
      data = decodeURIComponent(dataMatch?.[1] || url.searchParams.get("data") || "");
    } catch (_) {}
    if (!data) return;
    let rows;
    try {
      rows = JSON.parse(Buffer.from(data, "base64").toString("utf8"));
    } catch (_) {
      return;
    }
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (row?.link) addEmbed(String(row.link), String(row.language || language));
    }
  };

  for (const raw of embedUrls) addEmbed(raw);
  return {
    ravokTokens: [...ravokTokens],
    abyssEmbeds: [...abyssEmbeds].map(([url, language]) => ({ url, language })),
  };
}

function ravokVideoUrl(data) {
  if (data && typeof data === "object" && !Buffer.isBuffer(data)) {
    return data.securedLink || (data.hls ? data.videoSource : null);
  }
  const text = String(data || "");
  if (/video\s+not\s+found|<title>\s*error\s*<\/title>/i.test(text)) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed.securedLink || (parsed.hls ? parsed.videoSource : null);
  } catch (_) {
    return null;
  }
}

async function resolveRavokVideo(token, episodeUrl, sourcePlayerHost) {
  const playerUrl = `${sourcePlayerHost}/video/${token}`;
  try {
    const [playerHtml, response] = await Promise.all([
      fetchText(playerUrl, { Referer: episodeUrl }).catch(() => ""),
      axios.post(
        `${sourcePlayerHost}/player/index.php?data=${token}&do=getVideo`,
        new URLSearchParams({
          hash: token,
          r: sourcePlayerHost === ravokHost ? episodeUrl : `${baseUrl}/`,
        }).toString(),
        {
          timeout: 20000,
          responseType: "text",
          transformResponse: [(data) => data],
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            Referer: playerUrl,
            Origin: sourcePlayerHost,
            "X-Requested-With": "XMLHttpRequest",
          },
        },
      ),
    ]);
    const url = ravokVideoUrl(response.data);
    if (!url || !/^https?:/.test(url)) return null;
    const manifest = await fetchText(url, {
      Referer: `${sourcePlayerHost}/`,
      Origin: sourcePlayerHost,
    }).catch(() => "");
    const tracks = parseHlsTracks(manifest);
    const hasEnglishDub = tracks.some(
      (track) =>
        String(track.TYPE || "").toUpperCase() === "AUDIO" &&
        (/^(eng|en)$/i.test(track.LANGUAGE || "") ||
          /^english$/i.test(track.NAME || "")),
    );
    return {
      url,
      playerHtml,
      tracks,
      hasEnglishDub,
      quality: highestResolution(manifest),
    };
  } catch (_) {
    return null;
  }
}

async function buildRavokResult(video, sourcePlayerHost, sourceName) {
  const candidates = [];
  for (const track of video.tracks) {
    if (String(track.TYPE || "").toUpperCase() !== "SUBTITLES" || !track.URI) {
      continue;
    }
    try {
      candidates.push({
        lang: track.NAME || track.LANGUAGE || "Subtitles",
        url: new URL(track.URI, video.url).href,
        headers: {
          Referer: `${sourcePlayerHost}/`,
          Origin: sourcePlayerHost,
        },
      });
    } catch (_) {}
  }
  if (!candidates.length) {
    candidates.push(
      ...parsePlayerSubtitles(video.playerHtml).map((subtitle) => ({
        ...subtitle,
        headers: { Referer: `${sourcePlayerHost}/` },
      })),
    );
  }
  return {
    sources: [
      {
        url: video.url,
        quality: video.quality,
        name: video.hasEnglishDub
          ? `${sourceName} HLS (SUB + DUB)`
          : `${sourceName} HLS (SUB)`,
        type: video.hasEnglishDub ? "dub" : "sub",
        // Ravok always hands out an HLS manifest, even when the link has no
        // ".m3u8" suffix (e.g. /hls/<token>). Players must not guess from the
        // URL or they play the playlist as a plain video file.
        isM3U8: true,
        headers: {
          Referer: `${sourcePlayerHost}/`,
          Origin: sourcePlayerHost,
        },
      },
    ],
    subtitles: await resolveSubtitles(candidates),
  };
}

function parseAbyssPayload(html) {
  const match = String(html || "").match(/const\s+datas\s*=\s*"([^"]+)"/);
  if (!match) return null;
  try {
    const outer = JSON.parse(
      Buffer.from(match[1], "base64").toString("latin1"),
    );
    if (!outer?.slug || outer.md5_id == null || outer.user_id == null) {
      return null;
    }
    if (outer.media && typeof outer.media === "object") return outer;
    const encrypted = Buffer.from(
      Array.from(String(outer.media || ""), (character) => character.charCodeAt(0) & 0xff),
    );
    const keyText = crypto
      .createHash("md5")
      .update(`${outer.user_id}:${outer.slug}:${outer.md5_id}`)
      .digest("hex");
    const key = Buffer.from(keyText, "ascii");
    const decipher = crypto.createDecipheriv(
      "aes-256-ctr",
      key,
      key.subarray(0, 16),
    );
    const media = JSON.parse(
      Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8"),
    );
    return { ...outer, media };
  } catch (_) {
    return null;
  }
}

function abyssPathToken(path, size) {
  const numberMd5 = crypto
    .createHash("md5")
    .update(
      Buffer.from(
        Array.from(String(size), (digit) => Number(digit)),
      ),
    )
    .digest("hex");
  const key = Buffer.from(numberMd5, "utf8");
  const cipher = crypto.createCipheriv("aes-256-ctr", key, key.subarray(0, 16));
  const encrypted = Buffer.concat([
    cipher.update(path, "utf8"),
    cipher.final(),
  ]);
  const once = Buffer.from(encrypted)
    .toString("base64")
    .replace(/=+$/, "");
  return Buffer.from(once, "utf8")
    .toString("base64")
    .replace(/=+$/, "");
}

function abyssMediaUrl(payload, row) {
  const size = Number(row.size);
  const resId = Number(row.res_id);
  if (!size || !resId || !payload.slug) return null;
  const domains = payload.media?.mp4?.domains || [];
  const sub = String(row.sub || "");
  const domain =
    domains.find((value) => value === sub || value.startsWith(`${sub}.`)) ||
    domains[0] ||
    (() => {
      try {
        return new URL(row.url).hostname;
      } catch (_) {
        return "";
      }
    })();
  if (!domain) return null;
  let host;
  try {
    host = new URL(domain.includes("://") ? domain : `https://${domain}`).hostname;
  } catch (_) {
    return null;
  }
  const path = `/mp4/${payload.md5_id}/${resId}/${size}?v=${encodeURIComponent(payload.slug)}`;
  return `https://${host}/sora/${size}/${abyssPathToken(path, size)}`;
}

async function resolveAbyssEmbed(embed) {
  try {
    const html = await fetchText(embed.url, { Referer: `${animeSaltBaseUrl}/` });
    const payload = parseAbyssPayload(html);
    if (!payload) return null;
    const rows = (payload.media?.mp4?.sources || [])
      .filter((row) => row?.status !== false && Number(row.size) > 0)
      .sort((left, right) => {
        const height = (row) =>
          Number(String(row.label || "").match(/\d+/)?.[0] || row.res_id || 0);
        return (
          height(right) - height(left) || Number(right.size) - Number(left.size)
        );
      });
    const language = String(embed.language || "");
    // Every quality row is its own direct file - expose them all so the app
    // can offer 1080p/720p/480p instead of only the highest one.
    const sources = [];
    for (const row of rows) {
      const url = abyssMediaUrl(payload, row);
      if (!url) continue;
      sources.push({
        url,
        quality: String(row.label || "default"),
        name: `Anime Salt Abyss${language ? ` (${language})` : ""}`,
        type: language ? (/japanese/i.test(language) ? "sub" : "dub") : "sub",
        lang: language,
        isM3U8: false,
        headers: { Referer: `${abyssPlayerHost}/` },
      });
    }
    if (!sources.length) return null;
    return sources;
  } catch (_) {
    return null;
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

function parseEpisodeLinks(html, host = "watchanimeworld.one") {
  const links = [
    ...new Set(
      [...String(html).matchAll(/href=["']([^"'#?]*\/episode\/[^"'#?]+)["']/gi)].map(
        (m) => m[1],
      ),
    ),
  ].filter((href) => {
    try {
      return new URL(href, `https://${host}`).hostname === host;
    } catch (_) {
      return false;
    }
  });
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
  } catch (_) {}
  let hasEnglishDub = parseSeriesLanguages(html).some((language) =>
    /^english$/i.test(language),
  );
  let source = "watchanimeworld";
  let rows = parseEpisodeLinks(html, "watchanimeworld.one");
  if (!rows.length) {
    try {
      html = await fetchText(`${animeSaltBaseUrl}/series/${slug}/`, {
        Referer: `${animeSaltBaseUrl}/`,
      });
    } catch (_) {}
    hasEnglishDub =
      hasEnglishDub ||
      parseSeriesLanguages(html).some((language) => /^english$/i.test(language));
    rows = parseEpisodeLinks(html, "animesalt.cx");
    source = "animesalt";
  }
  const episodes = rows.map((r, i) => ({
    id: source === "animesalt" ? `ep:as:${r.slug}` : `ep:${r.slug}`,
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
  const seriesLanguages = parseSeriesLanguages(html);
  const hasEnglishDub = seriesLanguages.some((language) =>
    /^english$/i.test(language),
  );
  // Languages beyond the app's SUB/DUB (English) - the site lists them per title.
  const otherLanguages = seriesLanguages.filter(
    (language) => !/^english$/i.test(language),
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
    // Opt the title into the app's "Others" picker.
    hasOtherLanguages: otherLanguages.length > 0,
    otherLanguages,
  };
}

async function fetchEpisodeSources(episodeId) {
  const rawId = String(episodeId).replace(/^ep:/, "");
  const useAnimeSalt = rawId.startsWith("as:");
  const slug = useAnimeSalt ? rawId.slice(3) : rawId;
  const sourceBaseUrl = useAnimeSalt ? animeSaltBaseUrl : baseUrl;
  const episodeUrl = `${sourceBaseUrl}/episode/${slug}/`;
  let html = "";
  try {
    html = await fetchText(episodeUrl, { Referer: `${sourceBaseUrl}/` });
  } catch (_) {
    return { sources: [], subtitles: [] };
  }

  if (useAnimeSalt) {
    const embeds = parseAnimeSaltEmbeds(html);
    for (const token of embeds.ravokTokens) {
      const video = await resolveRavokVideo(token, episodeUrl, ravokHost);
      if (!video) continue;
      const result = await buildRavokResult(video, ravokHost, "Anime Salt");
      if (result.sources.length) return result;
    }
    const sources = [];
    for (const embed of embeds.abyssEmbeds) {
      const resolved = await resolveAbyssEmbed(embed);
      if (!resolved) continue;
      sources.push(...resolved);
    }
    return { sources, subtitles: [] };
  }

  const token = (
    html.match(/play\.zephyrix\.org\/video\/([A-Za-z0-9]{16,})/) || []
  )[1];
  if (!token) return { sources: [], subtitles: [] };
  const video = await resolveRavokVideo(token, episodeUrl, playerHost);
  if (!video) return { sources: [], subtitles: [] };
  const result = await buildRavokResult(video, playerHost, "Anime World India");
  if (!result.subtitles.length) {
    result.subtitles = await resolveSubtitles(await fetchAnimeSaltSubtitles(slug));
  }
  return result;
}

module.exports = {
  name: "animeworldindia",
  version: "1.0.8",
  // Languages the app can offer in its "Others" picker.
  statuses: ["Multi Audio", "HLS"],
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
