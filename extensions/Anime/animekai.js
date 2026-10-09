/**
 * StrawVerse Extension - AnimeKai Scraper
 * Copyright (C) 2026 TheYogMehta
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 *
 * DISCLAIMER: This extension is intended for research, educational,
 * and developer testing purposes only. It functions as a client-side parser
 * of publicly available web pages. The developers do not host or distribute
 * any copyrighted media. Users are responsible for compliance with the terms of
 * service of the target website.
 */

const cheerio = require("cheerio");

// Default domain first. Only verified hosts are listed.
const baseUrls = ["https://animekai.li"];
let baseUrl = baseUrls[0];

function swapBase(url, base) {
  return String(url).replace(/https:\/\/animekai\.[a-z]+/i, base);
}

function getBaseVariants(url) {
  if (!/animekai/i.test(String(url))) return [String(url)];
  const seen = new Set();
  const out = [];
  for (const b of [baseUrl, ...baseUrls]) {
    const v = swapBase(url, b);
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

async function fetchText(url, headers = {}, maxRetries = 3) {
  const client = global.axios || require("axios");
  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    for (const tryUrl of getBaseVariants(url)) {
      const tryBase =
        (/https:\/\/animekai\.[a-z]+/i.exec(tryUrl) || [])[0] || baseUrl;
      try {
        const { data } = await client.get(tryUrl, {
          headers: { Referer: tryBase + "/", ...headers },
          timeout: 20000,
          responseType: "text",
        });
        if (typeof data === "string" && data.length > 0) {
          baseUrl = tryBase;
          return data;
        }
        lastErr = new Error(`Empty response from ${tryBase}`);
      } catch (err) {
        lastErr = err;
      }
    }
    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr || new Error("Failed to fetch page");
}

async function fetchJson(url, headers = {}) {
  const client = global.axios || require("axios");
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const tryUrl of getBaseVariants(url)) {
      const tryBase =
        (/https:\/\/animekai\.[a-z]+/i.exec(tryUrl) || [])[0] || baseUrl;
      try {
        const { data } = await client.get(tryUrl, {
          headers: { Referer: tryBase + "/", ...headers },
          timeout: 20000,
        });
        if (data && typeof data === "object") {
          baseUrl = tryBase;
          return data;
        }
        lastErr = new Error(`Invalid JSON from ${tryBase}`);
      } catch (err) {
        lastErr = err;
      }
    }
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr || new Error("Failed to fetch JSON");
}

function absUrl(u) {
  if (!u) return null;
  if (u.startsWith("http://") || u.startsWith("https://")) return u;
  return baseUrl + (u.startsWith("/") ? u : "/" + u);
}

function parseSearchCards(html) {
  const $ = cheerio.load(html);
  const results = [];
  $(".aitem").each((_, el) => {
    const card = $(el);
    const posterA = card.find("a.poster").first();
    const href = posterA.attr("href") || "";
    const m = href.match(/\/watch\/([^/?#]+)/);
    if (!m) return;
    const id = m[1];
    const img = posterA.find("img").first();
    const image = absUrl(img.attr("src") || img.attr("data-src") || null);
    const title =
      card.find("a.title").first().text().trim() ||
      img.attr("alt") ||
      "";
    if (id && title && !results.some((r) => r.id === id)) {
      results.push({ id, title, image });
    }
  });
  return results;
}

function resolveList(list) {
  if (list === undefined || list === null || list === "") return [];
  const arr = Array.isArray(list) ? list : String(list).split(",");
  return arr.map((v) => String(v).trim()).filter(Boolean);
}

// Builds a /browse URL from Discover filters. Single values (as sent by
// the app's filter dropdowns) and comma lists are both accepted.
function buildBrowseUrl(query, filters = {}) {
  const params = new URLSearchParams();
  if (query) params.append("keyword", query);
  for (const g of resolveList(filters?.genre)) {
    params.append("genre[]", g);
  }
  const status = String(filters?.status || "").trim();
  if (status) params.append("status[]", status);
  const type = String(filters?.type || "").trim();
  if (type) params.append("type[]", type);
  const sort = String(filters?.sort || "").trim();
  if (sort) params.append("sort", sort);
  const page = parseInt(filters?.page, 10) || 1;
  if (page > 1) params.append("page", String(page));
  return `${baseUrl}/browse?${params.toString()}`;
}

function hasActiveFilters(filters = {}) {
  return (
    resolveList(filters?.genre).length > 0 ||
    !!String(filters?.status || "").trim() ||
    !!String(filters?.type || "").trim() ||
    !!String(filters?.sort || "").trim()
  );
}

function hasNextBrowsePage(html, page) {
  return (
    html.includes(`page=${page + 1}`) ||
    html.includes(`page%3D${page + 1}`) ||
    />Next\s*&raquo;/.test(html)
  );
}

async function SearchAnime(query, filters = {}) {
  if (!query && !hasActiveFilters(filters))
    return fetchRecentEpisodes(filters);
  const page = parseInt(filters?.page, 10) || 1;
  const url = hasActiveFilters(filters)
    ? buildBrowseUrl(query, filters)
    : `${baseUrl}/search?q=${encodeURIComponent(query || "")}${page > 1 ? `&page=${page}` : ""}`;
  const html = await fetchText(url);
  const results = parseSearchCards(html);
  return {
    currentPage: page,
    hasNextPage: hasActiveFilters(filters)
      ? hasNextBrowsePage(html, page)
      : results.length > 0,
    totalPages: page,
    results,
  };
}

async function fetchRecentEpisodes(filters = {}) {
  const page = parseInt(filters?.page, 10) || 1;
  if (!hasActiveFilters(filters)) {
    // Full catalog sorted by latest updates: 30 posters per page with
    // real pagination (the homepage trending strip has neither).
    const html = await fetchText(
      `${baseUrl}/browse?sort=updated_date${page > 1 ? `&page=${page}` : ""}`,
    );
    const results = parseSearchCards(html);
    return {
      currentPage: page,
      hasNextPage: hasNextBrowsePage(html, page),
      totalPages: page,
      results,
    };
  }
  const html = await fetchText(buildBrowseUrl(null, filters));
  const results = parseSearchCards(html);
  return {
    currentPage: page,
    hasNextPage: hasNextBrowsePage(html, page),
    totalPages: page,
    results,
  };
}

async function AnimeInfo(id) {
  const slug = String(id || "").split("/")[0];
  const html = await fetchText(`${baseUrl}/watch/${slug}`);
  const $ = cheerio.load(html);
  const page = $("#watch-page");
  const title =
    page.attr("data-title") ||
    $('meta[property="og:title"]').attr("content") ||
    slug;
  let image = absUrl(
    page.attr("data-poster") ||
      $('meta[property="og:image"]').attr("content") ||
      null,
  );
  const description =
    $('meta[name="description"]').attr("content") || "";
  let genres = [];
  try {
    const ldJson = $('script[type="application/ld+json"]')
      .map((_, el) => $(el).html())
      .get()
      .join("\n");
    const genreMatch = ldJson.match(/"genre"\s*:\s*\[([^\]]*)\]/);
    if (genreMatch) {
      genres = [...genreMatch[1].matchAll(/"([^"]+)"/g)].map((g) => g[1]);
    }
  } catch (_) {}
  const totalEpisodes = $("li[data-ep-item]").length || 0;
  return {
    id: slug,
    title,
    image,
    description,
    genres,
    type: "Anime",
    totalEpisodes,
    status: "Unknown",
  };
}

async function fetchEpisode(id, page = 1) {
  const slug = String(id || "").split("/")[0];
  const html = await fetchText(`${baseUrl}/watch/${slug}`);
  const $ = cheerio.load(html);
  const episodes = [];
  $("li[data-ep-item]").each((_, el) => {
    const li = $(el);
    const num = parseInt(li.attr("data-number"), 10);
    if (isNaN(num)) return;
    const a = li.find("a").first();
    const href = a.attr("href") || "";
    const m = href.match(/\/watch\/(.+)/);
    const epId = m ? m[1].replace(/^\/+|\/+$/g, "") : `${slug}/ep-${num}`;
    const rawTitle = a.text().trim().replace(/^[\d.]+\s*/, "").trim();
    const langs = [];
    if (li.attr("data-has-sub") === "1") langs.push("sub");
    if (li.attr("data-has-dub") === "1") langs.push("dub");
    episodes.push({
      id: epId,
      number: num,
      title: rawTitle || `Episode ${num}`,
      langs: langs.length > 0 ? langs : ["sub"],
    });
  });
  episodes.sort((a, b) => a.number - b.number);
  return {
    TotalPages: 1,
    total: episodes.length,
    episodes: episodes,
  };
}

async function fetchEpisodeSources(episodeId, category = null) {
  const epPath = String(episodeId || "").replace(/^\/+|\/+$/g, "");
  const html = await fetchText(`${baseUrl}/watch/${epPath}`);
  const $ = cheerio.load(html);
  const catLower = (category || "").toLowerCase();
  const panels =
    catLower === "dub"
      ? ['dub']
      : catLower === "sub"
        ? ['sub']
        : ['sub', 'dub'];
  const sources = [];
  for (const panel of panels) {
    $(`div.server-items[data-id="${panel}"] span.server[data-server-url]`).each(
      (_, el) => {
        const s = $(el);
        const embedUrl = s.attr("data-server-url") || s.attr("data-url");
        if (!embedUrl) return;
        // megaplay embeds are a JS-gated stub with no static payload and
        // can never resolve here; skip them so failures surface fast
        // instead of burning retries on a dead end.
        if (/megaplay\.buzz/i.test(embedUrl)) return;
        const label = s.attr("data-label") || "Server";
        const lang = (s.attr("data-lang") || panel).toLowerCase();
        sources.push({
          quality: "auto",
          name: `${label} (${lang === "dub" ? "Dub" : "Sub"})`,
          url: embedUrl,
          lang: lang === "dub" ? "dub" : "sub",
          type: lang === "dub" ? "dub" : "sub",
          isUnresolved: true,
          rawServer: { url: embedUrl, embedUrl, label, lang },
        });
      },
    );
  }
  return { sources, subtitles: [] };
}

// Embed pages sit behind bot protection that plain requests often fail.
// Try the clearance session once, then a single direct fetch. Deliberately
// NO tight retry loop here: megavid rate-limits aggressive retries (the
// 403s feed on themselves), and the task-level backoff (5s/10s/20s)
// provides the spacing instead.
async function fetchEmbedHtml(embedUrl, playerReferer) {
  if (typeof global.scrapperFetch === "function") {
    try {
      const html = await global.scrapperFetch(embedUrl);
      if (html && html.includes("player-payload")) return html;
    } catch (_) {}
  }
  const client = global.axios || require("axios");
  const { data } = await client.get(embedUrl, {
    headers: {
      Referer: playerReferer,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
    timeout: 20000,
    responseType: "text",
  });
  if (!data || !data.includes("player-payload")) {
    throw new Error("Embed page blocked or has no player");
  }
  return data;
}

async function processServer(server) {
  if (!server?.url) return null;
  try {
    const embedUrl = server.url;
    const embedObj = new URL(embedUrl);
    const playerReferer = embedObj.origin + "/";
    const embedHtml = await fetchEmbedHtml(embedUrl, playerReferer);
    const $ = cheerio.load(embedHtml);
    const payloadRaw = $("#player-payload").html() || "";
    let payload = null;
    try {
      payload = JSON.parse(payloadRaw);
    } catch (_) {
      throw new Error("Embed page has no player payload");
    }
    if (!payload?.sourceUrl)
      throw new Error("Embed page has no source URL");
    const sourceApi = payload.sourceUrl.startsWith("http")
      ? payload.sourceUrl
      : embedObj.origin + payload.sourceUrl;
    const sourceHeaders = {
      Referer: embedUrl,
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    };
    let data = null;
    try {
      data = await fetchJson(sourceApi, sourceHeaders);
    } catch (_) {
      data = null;
    }
    if (!data || data.status !== "ok" || !data.source) {
      // Provider-direct fallback (?provider=1 skips the cached copy),
      // mirroring the player's own failover.
      try {
        const sep = sourceApi.includes("?") ? "&" : "?";
        data = await fetchJson(sourceApi + sep + "provider=1", sourceHeaders);
      } catch (_) {
        data = null;
      }
    }
    if (!data || data.status !== "ok" || !data.source)
      throw new Error("Source API returned no stream");
    if (global.setDynamicReferer) {
      try {
        const streamDomain = new URL(data.source).hostname;
        global.setDynamicReferer(streamDomain, playerReferer);
        global.setFallbackReferer(playerReferer);
      } catch (_) {}
    }
    const subtitles = Array.isArray(data.tracks)
      ? data.tracks
          .filter((t) => t && t.file)
          .map((t) => ({ file: t.file, lang: t.label || "English" }))
      : [];
    return {
      url: data.source,
      quality: server.quality || "auto",
      isM3U8: data.type
        ? data.type === "hls" || String(data.source).includes(".m3u8")
        : true,
      headers: { Referer: playerReferer },
      lang: server.lang || "sub",
      type: server.type || "sub",
      subtitles,
    };
  } catch (err) {
    console.error("Failed to extract server:", err.message);
  }
  return null;
}

module.exports = {
  name: "animekai",
  version: "1.0.6",
  SearchAnime,
  AnimeInfo,
  fetchEpisodeSources,
  processServer,
  fetchRecentEpisodes,
  fetchEpisode,
};
