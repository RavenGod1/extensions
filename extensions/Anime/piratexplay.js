/**
 * StrawVerse Extension - PirateXPlay (piratexplay.cc)
 * Catalogue from /category/latest (series cards), search from the site's own
 * /api/search-ajax.php?keyword= endpoint, episodes from the series page and
 * streams through the live episode mirrors: episode page -> Rubystm embed ->
 * POST /dl -> signed multi-audio HLS master. Every audio track of that master
 * is its own playable HLS variant (Japanese = SUB, English = DUB, the rest are
 * the other languages) and every resolution is exposed. The site's
 * "Multi Audio" mirror links one player per language, each with its own
 * direct files; Vidmoly is the HLS fallback.
 */
const cheerio = require("cheerio");
const crypto = require("crypto");
const axios = global.axios || require("axios");

const baseUrl = "https://piratexplay.cc";
const rubystmHost = "https://rubystm.com";
const browserUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36";

// The site and the HLS manifests spell the same language in different ways
// ("English"/"en"/"eng", "Japanese"/"ja"/"jpn").
const languageCodes = {
  bengali: "bn",
  bn: "bn",
  english: "en",
  en: "en",
  eng: "en",
  hindi: "hi",
  hi: "hi",
  hin: "hi",
  japanese: "ja",
  ja: "ja",
  jpn: "ja",
  jp: "ja",
  kannada: "kn",
  kn: "kn",
  kan: "kn",
  korean: "ko",
  ko: "ko",
  kor: "ko",
  malayalam: "ml",
  ml: "ml",
  mal: "ml",
  marathi: "mr",
  mr: "mr",
  mar: "mr",
  tamil: "ta",
  ta: "ta",
  tam: "ta",
  telugu: "te",
  te: "te",
  tel: "te",
};

const languageNames = {
  bn: "Bengali",
  en: "English",
  hi: "Hindi",
  ja: "Japanese",
  kn: "Kannada",
  ko: "Korean",
  ml: "Malayalam",
  mr: "Marathi",
  ta: "Tamil",
  te: "Telugu",
};

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

async function fetchText(url, headers = {}, timeout = 25000) {
  const { data } = await axios.get(url, {
    timeout,
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
  // The Japanese track is the SUB version; the site lists it per title.
  const hasJapanese = languages.some((language) => /^japanese$/i.test(language));
  // Languages beyond the app's SUB/DUB (English/Japanese) - the site lists
  // them per title.
  const otherLanguages = languages.filter(
    (language) => !/^(english|japanese)$/i.test(language),
  );
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
    hasSub: languages.length ? hasJapanese : true,
    hasDub: hasEnglish,
    subOrDub:
      hasEnglish && hasJapanese ? "both" : hasEnglish ? "dub" : "sub",
    // Opt the title into the app's "Others" picker.
    hasOtherLanguages: otherLanguages.length > 0,
    otherLanguages,
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

function parseHlsAttributes(line) {
  const attrs = {};
  for (const match of String(line || "").matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    attrs[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  return attrs;
}

function parseHlsTracks(manifest) {
  return String(manifest || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("#EXT-X-MEDIA:"))
    .map(parseHlsAttributes);
}

function parseHlsVariants(manifest, manifestUrl) {
  const variants = [];
  let attrs = null;
  for (const line of String(manifest || "").split(/\r?\n/)) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      attrs = parseHlsAttributes(line);
      continue;
    }
    if (!attrs || !line || line.startsWith("#")) continue;
    try {
      const height = Number(String(attrs.RESOLUTION || "").split("x")[1]) || 0;
      variants.push({
        url: new URL(line, manifestUrl).href,
        quality: height ? `${height}p` : "default",
        height,
      });
    } catch (_) {}
    attrs = null;
  }
  return variants;
}

function parseEpisodeMirrors(html) {
  const $ = cheerio.load(html);
  const mirrors = [];
  $("iframe").each((_, element) => {
    const raw = $(element).attr("src") || $(element).attr("data-src");
    if (!raw) return;
    try {
      const url = new URL(raw, baseUrl).href;
      if (!mirrors.includes(url)) mirrors.push(url);
    } catch (_) {}
  });
  return mirrors;
}

// The episode page lists every server of the site ("Rubystm - Multi Audio",
// "Multi Audio - Multi Audio", ...) with the player iframe next to it.
function parseServerList(html) {
  const $ = cheerio.load(html);
  const players = new Map();
  $("div[id^='options-']").each((_, element) => {
    const id = $(element).attr("id") || "";
    const frame = $(element).find("iframe").first();
    const raw = frame.attr("src") || frame.attr("data-src");
    if (!id || !raw) return;
    try {
      players.set(id, new URL(raw, baseUrl).href);
    } catch (_) {}
  });
  const servers = [];
  $("ul.aa-tbs-video a.btn").each((_, element) => {
    const href = $(element).attr("href") || "";
    const id = href.startsWith("#") ? href.slice(1) : "";
    const url = players.get(id);
    if (!url) return;
    const label = $(element).find("span.server").first().text().trim();
    servers.push({ label, url });
  });
  return servers;
}

// "Rubystm - Multi Audio" -> "Rubystm"
function serverName(label, fallback = "") {
  const clean = String(label || "")
    .split("-")[0]
    .trim();
  return clean || fallback;
}

function decodeMultiPayload(url) {
  try {
    const encoded = new URL(url, baseUrl).searchParams.get("data");
    if (!encoded) return [];
    const rows = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    return rows
      .map((row) => ({
        language: String(row?.language || "").trim(),
        link: String(row?.link || "").trim(),
      }))
      .filter((row) => row.language && row.link);
  } catch (_) {
    return [];
  }
}

function parseMultiPage(html) {
  const $ = cheerio.load(html);
  return $("[data-link][data-language]")
    .map((_, element) => ({
      language: String($(element).attr("data-language") || "").trim(),
      link: String($(element).attr("data-link") || "").trim(),
    }))
    .get()
    .filter((row) => row.language && row.link);
}

function extractM3u8Url(html) {
  const text = String(html || "").replace(/\\\//g, "/");
  const setup = text.match(
    /sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/i,
  );
  const candidates = setup ? [setup[1]] : [];
  for (const match of text.matchAll(
    /https?:\/\/[^"'<>\\\s]+?\.m3u8(?:\?[^"'<>\\\s]*)?/gi,
  )) {
    candidates.push(match[0]);
  }
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate, baseUrl).href;
      if (/\.m3u8(?:$|\?)/i.test(url)) return url;
    } catch (_) {}
  }
  return null;
}

function languageCode(name) {
  const value = String(name || "").trim().toLowerCase();
  return languageCodes[value] || (/^[a-z]{2,3}$/.test(value) ? value : "");
}

function isEnglishTrack(code, name) {
  const value = String(code || "").trim().toLowerCase();
  return value === "en" || /english/i.test(String(name || ""));
}

// The track with the original Japanese audio is the SUB version, every other
// track is dubbed audio. The app picks the version by this field, so a SUB
// request must never be answered with the English track.
function trackVersion(code, name) {
  const value = String(code || "").trim().toLowerCase();
  if (value === "ja") return "sub";
  return /japanese/i.test(String(name || "")) ? "sub" : "dub";
}

// The app asks for one version at a time: sub = Japanese audio, dub = English.
function languageWanted(code, name, category) {
  const want = String(category || "").trim().toLowerCase();
  if (!want || want === "both") return true;
  if (want === "sub") {
    return String(code || "").trim().toLowerCase() === "ja" ||
      /japanese/i.test(String(name || ""));
  }
  if (want === "dub") return isEnglishTrack(code, name);
  return false;
}

function filterByCategory(sources, category) {
  const want = String(category || "").trim().toLowerCase();
  if (!want || want === "both") return sources;
  return sources.filter((source) =>
    languageWanted(source.language, source.lang, want),
  );
}

function audioToken(uri, manifestUrl) {
  try {
    const path = new URL(uri, manifestUrl).pathname;
    return path.match(/\/index-(a\d+)\.m3u8$/)?.[1] || "";
  } catch (_) {
    return "";
  }
}

function variantWithAudio(variantUrl, token) {
  try {
    const url = new URL(variantUrl);
    const match = url.pathname.match(/\/index-(v\d+)-a\d+\.m3u8$/);
    if (!match) return null;
    url.pathname = url.pathname.replace(
      match[0],
      `/index-${match[1]}-${token}.m3u8`,
    );
    return url.href;
  } catch (_) {
    return null;
  }
}

// One source per audio track and per resolution: the variant URL carries the
// audio token, so the language is picked by rewriting it. The tracks of the
// master are authoritative - the site may list fewer languages than the
// stream carries.
function buildLanguageSources(
  masterUrl,
  manifest,
  referer,
  server = "Rubystm",
) {
  const variants = parseHlsVariants(manifest, masterUrl).sort(
    (a, b) => b.height - a.height,
  );

  const sources = [];
  const seen = new Set();
  for (const track of parseHlsTracks(manifest)) {
    if (String(track.TYPE || "").toUpperCase() !== "AUDIO") continue;
    const code = languageCode(track.LANGUAGE) || languageCode(track.NAME);
    if (!code) continue;
    const token = audioToken(track.URI, masterUrl);
    if (!token) continue;
    const name = languageNames[code] || track.NAME || code;
    for (const variant of variants) {
      const url = variantWithAudio(variant.url, token);
      if (!url) continue;
      const key = `${code}|${variant.quality}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({
        url,
        quality: variant.quality,
        // The server is the mirror, the language is the audio track inside it.
        name: `${server} · ${name}`,
        server,
        type: trackVersion(code, name),
        language: code,
        lang: name,
        isM3U8: true,
        headers: { Referer: referer, "User-Agent": browserUserAgent },
      });
    }
  }
  return sources;
}

// The site hands out subtitles in two ways: as HLS subtitle renditions in the
// master playlist, and as a list in the Ravok player page ("playerjsSubtitle").
// Both are optional - a server without them simply has no subtitle track.
function buildHlsSubtitles(masterUrl, manifest) {
  const subtitles = [];
  for (const track of parseHlsTracks(manifest)) {
    if (String(track.TYPE || "").toUpperCase() !== "SUBTITLES" || !track.URI) {
      continue;
    }
    let url = "";
    try {
      url = new URL(track.URI, masterUrl).href;
    } catch (_) {
      continue;
    }
    // A rendition that is a playlist cannot be muxed into a download, only a
    // real subtitle file can.
    if (!/\.(vtt|srt)(\?|$)/i.test(url)) continue;
    subtitles.push({ lang: track.NAME || track.LANGUAGE || "Subtitles", url });
  }
  return subtitles;
}

// The Ravok player lists its subtitle files as a comma separated string, every
// entry either "[English]https://..." or a bare URL.
function parsePlayerSubtitles(playerHtml) {
  const match = String(playerHtml || "").match(
    /var\s+playerjsSubtitle\s*=\s*("(?:\\.|[^"\\])*")\s*;/,
  );
  if (!match) return [];
  let value = "";
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

// "https://piratexplay.cc/proxy/play.php?url=https://ravok.buzz/video/<token>"
function ravokToken(mirrorUrl) {
  try {
    const inner = new URL(mirrorUrl, baseUrl).searchParams.get("url") || "";
    return inner.match(/ravok\.buzz\/video\/([A-Za-z0-9]{16,})/)?.[1] || "";
  } catch (_) {
    return "";
  }
}

async function resolveRubystm(mirrorUrl) {
  const landing = await axios.get(mirrorUrl, {
    timeout: 25000,
    headers: { Referer: `${baseUrl}/`, "User-Agent": browserUserAgent },
    responseType: "text",
    transformResponse: [(data) => data],
  });
  const finalUrl =
    landing.request?.res?.responseUrl ||
    landing.request?.responseUrl ||
    landing.request?.responseURL ||
    mirrorUrl;
  const code = new URL(finalUrl, baseUrl).pathname.match(
    /\/e\/([A-Za-z0-9]{12})\.html/,
  )?.[1];
  if (!code) return null;

  const response = await axios.post(
    new URL("/dl", finalUrl).href,
    new URLSearchParams({
      op: "embed",
      file_code: code,
      auto: "1",
      referer: `${baseUrl}/`,
    }).toString(),
    {
      timeout: 25000,
      responseType: "text",
      transformResponse: [(data) => data],
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Referer: finalUrl,
        Origin: new URL(finalUrl).origin,
        "User-Agent": browserUserAgent,
      },
    },
  );
  const masterUrl = extractM3u8Url(response.data);
  return masterUrl ? { masterUrl, referer: finalUrl } : null;
}

async function resolveVidmoly(mirrorUrl) {
  const url = new URL(mirrorUrl);
  url.searchParams.set("pxp", Date.now());
  const html = await fetchText(url.href, { "User-Agent": browserUserAgent });
  const masterUrl = extractM3u8Url(html);
  return masterUrl ? { masterUrl, referer: mirrorUrl, html } : null;
}

// The Vidmoly player lists its files in "baseTracks": every entry with the
// kind "captions" is a real subtitle file of the episode.
function parseVidmolySubtitles(html) {
  const text = String(html || "");
  const start = text.search(/baseTracks\s*=\s*\[/i);
  if (start < 0) return [];

  const open = text.indexOf("[", start);
  let depth = 0;
  let end = -1;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "[") depth++;
    else if (text[index] === "]") {
      depth--;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) return [];

  const subtitles = [];
  for (const block of text.slice(open, end).matchAll(/\{([^{}]*)\}/g)) {
    const entry = block[1];
    const file = entry.match(/file\s*:\s*['"]([^'"]+)['"]/i)?.[1] || "";
    const kind = entry.match(/kind\s*:\s*['"]([^'"]+)['"]/i)?.[1] || "";
    const label = entry.match(/label\s*:\s*['"]([^'"]+)['"]/i)?.[1] || "";
    if (!file || !/\.(vtt|srt)(\?|$)/i.test(file)) continue;
    if (kind && kind.toLowerCase() !== "captions") continue;
    subtitles.push({ lang: label || "English", url: file });
  }
  return subtitles;
}

// The "Multi Audio" mirror links one player per language; every player page
// carries the list of its own files (360p/720p/1080p).
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
  const mediaPath = `/mp4/${payload.md5_id}/${resId}/${size}?v=${encodeURIComponent(payload.slug)}`;
  return `https://${host}/sora/${size}/${abyssPathToken(mediaPath, size)}`;
}

async function resolveAbyssEmbed(embedUrl, language, server) {
  try {
    // The site hands out http links for the players, they only answer on https.
    const url = String(embedUrl).replace(/^http:\/\//i, "https://");
    const html = await fetchText(url, {
      Referer: `${baseUrl}/`,
      "User-Agent": browserUserAgent,
    });
    const payload = parseAbyssPayload(html);
    if (!payload) return [];
    const rows = (payload.media?.mp4?.sources || [])
      .filter((row) => row?.status !== false && Number(row.size) > 0)
      .sort((left, right) => {
        const height = (row) =>
          Number(String(row.label || "").match(/\d+/)?.[0] || row.res_id || 0);
        return (
          height(right) - height(left) || Number(right.size) - Number(left.size)
        );
      });
    const code = languageCode(language);
    const sources = [];
    for (const row of rows) {
      const url = abyssMediaUrl(payload, row);
      if (!url) continue;
      sources.push({
        url,
        quality: String(row.label || "default"),
        // The server is the mirror, the language is the file inside it.
        name: `${server} · ${language}`,
        server,
        type: trackVersion(code, language),
        language: code,
        lang: language,
        isM3U8: false,
        headers: { Referer: "https://player.abyssplayer.com/" },
      });
    }
    return sources;
  } catch (_) {
    return [];
  }
}

function hostMatches(url, suffix) {
  try {
    return new URL(url).hostname.endsWith(suffix);
  } catch (_) {
    return false;
  }
}

function hostStartsWith(url, prefix) {
  try {
    return new URL(url).hostname.startsWith(prefix);
  } catch (_) {
    return false;
  }
}

// A server that carries no subtitle of its own is not the end of the search:
// every other mirror of the same episode can ship one. The unknown players
// list their subtitle files as a plain ".vtt"/".srt" link, so a scan of their
// pages finds them - the file then belongs to every server of the episode,
// because the app muxes the episode subtitles into the stream and the
// download.
async function scanMirrorSubtitles(mirrorUrls) {
  const found = [];
  await Promise.allSettled(
    mirrorUrls.map(async (url) => {
      const html = await fetchText(
        url,
        { "User-Agent": browserUserAgent },
        4000,
      );
      for (const match of html.matchAll(
        /https?:\/\/[^"'()\s<>]+\.(?:vtt|srt)(?:\?[^"'()\s<>]*)?/gi,
      )) {
        const subtitleUrl = match[0];
        const lang =
          subtitleUrl.match(/_([A-Za-z]{2,12})\.(?:vtt|srt)/i)?.[1] ||
          "Subtitles";
        found.push({ lang, url: subtitleUrl });
      }
    }),
  );
  return found;
}

async function fetchEpisodeSources(episodeId, category = null) {
  const slug = String(episodeId).replace(/^\/episode\//, "").replace(/\/+$/, "");
  const episodeUrl = `${baseUrl}/episode/${slug}/`;
  let html = "";
  try {
    html = await fetchText(episodeUrl);
  } catch (_) {
    return { sources: [], subtitles: [] };
  }

  const servers = parseServerList(html);
  const mirrors = servers.length
    ? servers.map((entry) => entry.url)
    : parseEpisodeMirrors(html);
  const nameOf = (url) => {
    const entry = servers.find((item) => item.url === url);
    return serverName(entry?.label || "", "");
  };

  const multiUrl = mirrors.find((url) => url.includes("/proxy/multi.php"));
  let languageRows = multiUrl ? decodeMultiPayload(multiUrl) : [];
  if (!languageRows.length && multiUrl) {
    try {
      languageRows = parseMultiPage(await fetchText(multiUrl));
    } catch (_) {}
  }

  const sources = [];
  const subtitles = [];

  // Rubystm: one multi-audio HLS master with every language and resolution.
  for (const mirrorUrl of mirrors) {
    if (!hostMatches(mirrorUrl, "rubystm.com")) continue;
    try {
      const resolved = await resolveRubystm(mirrorUrl);
      if (!resolved) continue;
      const manifest = await fetchText(resolved.masterUrl, {
        Referer: resolved.referer,
        "User-Agent": browserUserAgent,
      });
      const built = buildLanguageSources(
        resolved.masterUrl,
        manifest,
        resolved.referer,
        nameOf(mirrorUrl) || "Rubystm",
      );
      if (built.length) {
        sources.push(...built);
        subtitles.push(...buildHlsSubtitles(resolved.masterUrl, manifest));
        break;
      }
    } catch (_) {}
  }

  // Ravok: the player page lists the subtitle files of the episode. Its own
  // master cannot be played as one file per language, but the subtitles work
  // for every mirror of the same episode.
  for (const mirrorUrl of mirrors) {
    const token = ravokToken(mirrorUrl);
    if (!token) continue;
    try {
      const playerHtml = await fetchText(`https://ravok.buzz/video/${token}`, {
        Referer: `${baseUrl}/`,
        "User-Agent": browserUserAgent,
      });
      subtitles.push(...parsePlayerSubtitles(playerHtml));
    } catch (_) {}
    break;
  }

  // Multi Audio: the site links one player per language, each with its own files.
  for (const row of languageRows) {
    const code = languageCode(row.language);
    if (!code) continue;
    if (!languageWanted(code, row.language, category)) continue;
    try {
      const built = await resolveAbyssEmbed(
        row.link,
        row.language,
        nameOf(multiUrl) || "Multi Audio",
      );
      if (built.length) sources.push(...built);
    } catch (_) {}
  }

  // Vidmoly: the last HLS mirror. Its player carries the subtitle files of
  // the episode, so it is read even when another server already works - the
  // subtitles of one server belong to every server of the episode.
  let vidmoly = null;
  for (const mirrorUrl of mirrors) {
    if (!hostStartsWith(mirrorUrl, "vidmoly.")) continue;
    try {
      const resolved = await resolveVidmoly(mirrorUrl);
      if (!resolved) continue;
      vidmoly = { resolved, mirrorUrl };
      subtitles.push(...parseVidmolySubtitles(resolved.html));
      break;
    } catch (_) {}
  }

  if (!sources.length && vidmoly) {
    const { resolved, mirrorUrl } = vidmoly;
    const manifest = await fetchText(resolved.masterUrl, {
      Referer: resolved.referer,
      "User-Agent": browserUserAgent,
    }).catch(() => "");
    const built = buildLanguageSources(
      resolved.masterUrl,
      manifest,
      resolved.referer,
      nameOf(mirrorUrl) || "Vidmoly",
    );
    if (built.length) {
      sources.push(...built);
      subtitles.push(...buildHlsSubtitles(resolved.masterUrl, manifest));
    } else {
      sources.push({
        url: resolved.masterUrl,
        quality: "default",
        name: `${nameOf(mirrorUrl) || "Vidmoly"} · Multi Audio`,
        server: nameOf(mirrorUrl) || "Vidmoly",
        type: "sub",
        language: "multi",
        lang: "Multi Audio",
        isM3U8: true,
        headers: {
          Referer: resolved.referer,
          "User-Agent": browserUserAgent,
        },
      });
    }
  }

  // None of the known mirrors had a subtitle: the other servers of the
  // episode get their say before the episode is given up on.
  if (!subtitles.length) {
    const scanTargets = mirrors.filter(
      (url) =>
        !hostStartsWith(url, "vidmoly.") &&
        !hostMatches(url, "rubystm.com") &&
        !url.includes("/proxy/multi.php") &&
        !url.includes("ravok.buzz"),
    );
    subtitles.push(...(await scanMirrorSubtitles(scanTargets)));
  }

  return {
    sources: filterByCategory(sources, category),
    subtitles: subtitles.filter(
      (subtitle, index) =>
        subtitles.findIndex((other) => other.url === subtitle.url) === index,
    ),
  };
}

module.exports = {
  name: "piratexplay",
  version: "1.0.7",
  // Languages the app can offer in its "Others" picker.
  statuses: ["Multi Audio", "HLS"],
  baseUrl,
  headerRules: [
    { match: ["piratexplay.cc"], headers: { Referer: `${baseUrl}/` } },
    {
      match: ["rubystm.com", "nuvorel.top"],
      headers: {
        Referer: `${baseUrl}/`,
        "User-Agent": browserUserAgent,
      },
    },
    {
      match: ["streamruby.net"],
      headers: {
        Referer: `${rubystmHost}/`,
        "User-Agent": browserUserAgent,
      },
    },
    {
      match: ["vmpx.online"],
      headers: { "User-Agent": browserUserAgent },
    },
    {
      match: ["player.abyssplayer.com", "abyssplayer.com"],
      headers: {
        Referer: `${baseUrl}/`,
        "User-Agent": browserUserAgent,
      },
    },
    {
      match: ["sssrr.org"],
      headers: {
        Referer: "https://player.abyssplayer.com/",
        "User-Agent": browserUserAgent,
      },
    },
  ],
  SearchAnime,
  AnimeInfo,
  fetchEpisode,
  fetchEpisodeSources,
  fetchRecentEpisodes,
};
