/**
 * StrawVerse Extension - PirateXPlay (piratexplay.cc)
 * Catalogue from /category/latest (series cards), search from the site's own
 * /api/search-ajax.php?keyword= endpoint, episodes from the series page and
 * streams through the live episode mirrors: episode page -> Rubystm embed ->
 * POST /dl -> signed multi-audio HLS master. Each audio language is returned
 * as its own playable HLS variant; Vidmoly is the HLS fallback.
 */
const cheerio = require("cheerio");
const axios = global.axios || require("axios");

const baseUrl = "https://piratexplay.cc";
const rubystmHost = "https://rubystm.com";
const browserUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0 Safari/537.36";

const languageCodes = {
  bengali: "bn",
  english: "en",
  hindi: "hi",
  japanese: "ja",
  kannada: "kn",
  korean: "ko",
  malayalam: "ml",
  marathi: "mr",
  tamil: "ta",
  telugu: "te",
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
  // Languages beyond the app's SUB/DUB (English) - the site lists them per title.
  const otherLanguages = languages.filter(
    (language) => !/^english$/i.test(language),
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
    hasSub: true,
    hasDub: hasEnglish,
    subOrDub: hasEnglish ? "both" : "sub",
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

function buildLanguageSources(masterUrl, manifest, languageRows, referer) {
  const variants = parseHlsVariants(manifest, masterUrl).sort(
    (a, b) => b.height - a.height,
  );
  const requested = new Map();
  for (const row of languageRows) {
    const code = languageCode(row.language);
    if (code) requested.set(code, row.language);
  }

  const sources = [];
  const seen = new Set();
  for (const track of parseHlsTracks(manifest)) {
    if (String(track.TYPE || "").toUpperCase() !== "AUDIO") continue;
    const code = languageCode(track.LANGUAGE) || languageCode(track.NAME);
    if (requested.size && !requested.has(code)) continue;
    const token = audioToken(track.URI, masterUrl);
    if (!token) continue;
    const variant = variants
      .map((item) => ({ ...item, url: variantWithAudio(item.url, token) }))
      .find((item) => item.url);
    if (!variant) continue;
    const key = code || track.NAME;
    if (seen.has(key)) continue;
    seen.add(key);
    const name = languageNames[code] || requested.get(code) || track.NAME || code;
    sources.push({
      url: variant.url,
      quality: variant.quality,
      name: `PirateXPlay ${name}`,
      server: `PirateXPlay ${name}`,
      type: "dub",
      language: code || name.toLowerCase(),
      lang: name,
      isM3U8: true,
      headers: { Referer: referer, "User-Agent": browserUserAgent },
    });
  }
  return sources;
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
  return masterUrl ? { masterUrl, referer: mirrorUrl } : null;
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

  const mirrors = parseEpisodeMirrors(html);
  const multiUrl = mirrors.find((url) => url.includes("/proxy/multi.php"));
  let languageRows = multiUrl ? decodeMultiPayload(multiUrl) : [];
  if (!languageRows.length && multiUrl) {
    try {
      languageRows = parseMultiPage(await fetchText(multiUrl));
    } catch (_) {}
  }

  const rubystmMirrors = mirrors.filter((url) => {
    try {
      return new URL(url).hostname.endsWith("rubystm.com");
    } catch (_) {
      return false;
    }
  });
  for (const mirrorUrl of rubystmMirrors) {
    try {
      const resolved = await resolveRubystm(mirrorUrl);
      if (!resolved) continue;
      const manifest = await fetchText(resolved.masterUrl, {
        Referer: resolved.referer,
        "User-Agent": browserUserAgent,
      });
      const sources = buildLanguageSources(
        resolved.masterUrl,
        manifest,
        languageRows,
        resolved.referer,
      );
      if (sources.length) return { sources, subtitles: [] };
    } catch (_) {}
  }

  const vidmolyMirrors = mirrors.filter((url) => {
    try {
      return new URL(url).hostname.includes("vidmoly.");
    } catch (_) {
      return false;
    }
  });
  for (const mirrorUrl of vidmolyMirrors) {
    try {
      const resolved = await resolveVidmoly(mirrorUrl);
      if (!resolved) continue;
      return {
        sources: [
          {
            url: resolved.masterUrl,
            quality: "default",
            name: "PirateXPlay Vidmoly",
            server: "PirateXPlay Vidmoly",
            type: "sub",
            language: "multi",
            lang: "Multi Audio",
            isM3U8: true,
            headers: {
              Referer: resolved.referer,
              "User-Agent": browserUserAgent,
            },
          },
        ],
        subtitles: [],
      };
    } catch (_) {}
  }

  return { sources: [], subtitles: [] };
}

module.exports = {
  name: "piratexplay",
  version: "1.0.2",
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
  ],
  SearchAnime,
  AnimeInfo,
  fetchEpisode,
  fetchEpisodeSources,
  fetchRecentEpisodes,
};
