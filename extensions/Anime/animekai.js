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
const crypto = require("crypto");

// Self-healing mirror pool: primary first, fallbacks next. Dead hosts are
// cooled down so one bad mirror can't stall every call.
const baseUrls = ["https://animekai.ro"];
let baseUrl = baseUrls[0];

const mirrorCooldownUntil = {};
const MIRROR_COOLDOWN_MS = 5 * 60 * 1000;

function markMirrorDown(base) {
  try {
    mirrorCooldownUntil[String(base)] = Date.now() + MIRROR_COOLDOWN_MS;
  } catch (_) {}
}

function markMirrorOk(base) {
  try {
    delete mirrorCooldownUntil[String(base)];
  } catch (_) {}
}

function orderedBases() {
  const now = Date.now();
  const fresh = [];
  const cooling = [];
  for (const b of [baseUrl, ...baseUrls]) {
    const list = mirrorCooldownUntil[b] && mirrorCooldownUntil[b] > now ? cooling : fresh;
    if (!fresh.includes(b) && !cooling.includes(b)) list.push(b);
  }
  return [...fresh, ...cooling];
}

function swapBase(url, base) {
  return String(url).replace(/https:\/\/animekai\.[a-z]+/i, base);
}

function getBaseVariants(url) {
  if (!/animekai/i.test(String(url))) return [String(url)];
  const seen = new Set();
  const out = [];
  for (const b of orderedBases()) {
    const v = swapBase(url, b);
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

// GET across mirror variants: first shape-valid response wins. Self-heals
// around dead mirrors and transient network failures.
async function resilientGet(url, { headers = {}, timeout = 15000, triesPerMirror = 2 } = {}) {
  let lastErr = null;
  for (const tryUrl of getBaseVariants(url)) {
    const tryBase = (/https:\/\/animekai\.[a-z]+/i.exec(tryUrl) || [])[0] || baseUrl;
    for (let attempt = 1; attempt <= triesPerMirror; attempt++) {
      try {
        const res = await global.axios.get(tryUrl, {
          headers: { Referer: tryBase + "/", "X-Requested-With": "XMLHttpRequest", ...headers },
          timeout,
        });
        if (res?.status === 200 || res?.data) {
          baseUrl = tryBase;
          markMirrorOk(tryBase);
          return res;
        }
        lastErr = new Error(`HTTP ${res?.status} from ${tryBase}`);
      } catch (err) {
        lastErr = err;
        const retryable =
          !err?.response?.status ||
          [429, 502, 503, 504].includes(err.response.status);
        if (!retryable) break;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    markMirrorDown(tryBase);
  }
  throw lastErr || new Error("All AnimeKai mirrors failed");
}

function parsePagination($, defaultPage) {
  let totalPages = 1;
  $(".pagination a").each((i, el) => {
    const href = $(el).attr("href");
    if (href) {
      const match = href.match(/page=(\d+)/);
      if (match) {
        const pageNum = parseInt(match[1]);
        if (pageNum > totalPages) totalPages = pageNum;
      }
    }
  });
  let hasNextPage = false;
  $(".pagination a").each((i, el) => {
    if ($(el).attr("rel") === "next") hasNextPage = true;
  });
  const activePageText = $(".pagination li.active").text().trim();
  return {
    currentPage: parseInt(activePageText) || defaultPage || 1,
    hasNextPage,
    totalPages,
  };
}

function parseAitemCards($) {
  const results = [];
  // Search suggest uses <a class="aitem">, /filter uses <div class="aitem"><a>.
  $(".aitem").each((i, el) => {
    const $el = $(el);
    const aTag = $el.is("a") ? $el : $el.find("a").first();
    const title =
      aTag.find(".d-title").text().trim() ||
      aTag.find("h6.title").text().trim() ||
      $el.find(".d-title").first().text().trim() ||
      aTag.attr("title") ||
      "";
    const href = aTag.attr("href");
    if (!href || !title) return;
    const match = href.match(/\/anime\/([^\/\?#]+)/);
    if (!match) return;
    const image =
      $el.find("img").attr("src") || $el.find("img").attr("data-src") || null;
    results.push({ id: match[1], title: title.trim(), image });
  });
  return results;
}

async function SearchAnime(query, filters = {}) {
  try {
    const page = filters?.page || 1;
    // Suggest endpoint returns { status, result: { html } } with a.aitem cards.
    const { data } = await resilientGet(
      `${baseUrl}/ajax/anime/search?keyword=${encodeURIComponent(query)}&page=${page}`,
    );
    const html = data?.result?.html || data?.result || data || "";
    const $ = cheerio.load(typeof html === "string" ? html : "");
    const results = parseAitemCards($);
    return { currentPage: page, hasNextPage: false, totalPages: 1, results };
  } catch (err) {
    throw new Error(err.message);
  }
}

async function fetchRecentEpisodes(filters = {}) {
  try {
    const page = filters?.page || 1;
    const params = new URLSearchParams();
    if (filters?.keyword) params.append("keyword", String(filters.keyword));
    params.append("page", String(page));
    const { data: html } = await resilientGet(`${baseUrl}/filter?${params.toString()}`);
    const $ = cheerio.load(html);
    const results = parseAitemCards($);
    const pagination = parsePagination($, page);
    return {
      currentPage: pagination.currentPage,
      hasNextPage: pagination.hasNextPage,
      totalPages: pagination.totalPages,
      results,
    };
  } catch (err) {
    throw new Error(err.message);
  }
}

async function AnimeInfo(id) {
  const animeInfo = { id, title: "" };
  try {
    const variants = getBaseVariants(`${baseUrl}/anime/${id}`);
    let html = "";
    for (const u of variants) {
      try {
        const res = await global.axios.get(u, {
          headers: { Referer: baseUrl + "/" },
          timeout: 15000,
        });
        if (res?.data && typeof res.data === "string" && res.data.length > 5000) {
          html = res.data;
          baseUrl = (/https:\/\/animekai\.[a-z]+/i.exec(u) || [])[0] || baseUrl;
          break;
        }
      } catch (_) {}
    }
    if (!html) throw new Error("AnimeKai detail page unreachable on all mirrors");
    const $ = cheerio.load(html);
    const dataId =
      $("#watch-main").attr("data-id") || $("[data-id]").first().attr("data-id") || null;
    animeInfo.title =
      $("h1").first().text().trim() ||
      $('meta[property="og:title"]').attr("content")?.trim() ||
      id;
    animeInfo.image =
      $(".poster img").first().attr("src") ||
      $(".ani.poster img").first().attr("src") ||
      $('meta[property="og:image"]').attr("content") ||
      null;
    animeInfo.description =
      $(".desc").text().trim() ||
      $(".synopsis").text().trim() ||
      $(".description").text().trim() ||
      "";
    const genres = [];
    // Show genres only — exclude the site nav-menu genre list.
    $("a[href*='/genre/'], a[href*='/genres/']").each((i, el) => {
      if ($(el).closest(".nav-menu, nav, header, footer").length > 0) return;
      const g = $(el).text().trim();
      if (g && !genres.includes(g)) genres.push(g);
    });
    animeInfo.genres = genres;
    animeInfo.status = "Unknown";
    const bodyText = $.text();
    if (/Currently Airing|Ongoing/i.test(bodyText)) animeInfo.status = "Ongoing";
    else if (/Finished Airing|Completed/i.test(bodyText)) animeInfo.status = "Completed";
    animeInfo.dataId = dataId;
    return animeInfo;
  } catch (error) {
    console.error("Error fetching data from AnimeKai:", error.message);
    throw error;
  }
}

async function fetchEpisode(dataId, page = 1) {
  try {
    let numericId = dataId;
    if (!/^\d+$/.test(String(dataId))) {
      try {
        const info = await AnimeInfo(dataId);
        numericId = info.dataId;
      } catch (e) {}
    }
    if (!numericId) return { episodes: [], totalPages: 0, total: 0, currentPage: page };
    const { data } = await resilientGet(`${baseUrl}/ajax/episode/list/${numericId}`, {
      headers: { "X-Requested-With": "XMLHttpRequest" },
    });
    const $ = cheerio.load(data.result || data || "");
    const episodes = [];
    $("a[data-id][data-ids]").each((i, el) => {
      const epNum = $(el).attr("data-num") || $(el).attr("data-number") || String(i + 1);
      const epId = $(el).attr("data-id");
      const dataIds = $(el).attr("data-ids");
      const title = $(el).attr("title") || $(el).find(".d-title").text().trim() || `Episode ${epNum}`;
      if (epId && dataIds) {
        const langs = [];
        if ($(el).attr("data-sub") === "1") langs.push("sub");
        if ($(el).attr("data-dub") === "1") langs.push("dub");
        episodes.push({
          id: `${epId}|${dataIds}`,
          number: parseFloat(epNum),
          title,
          duration: "Unknown",
          langs,
        });
      }
    });
    return { episodes, totalPages: 1, total: episodes.length, currentPage: 1 };
  } catch (err) {
    return { episodes: [], totalPages: 0, total: 0, currentPage: page };
  }
}

function decryptMegaplayEnc(encStr) {
  if (!encStr || typeof encStr !== "string") return null;
  try {
    const key = Buffer.alloc(32);
    Buffer.from("i?LMTAx0Q6,:}50U", "utf8").copy(key, 0, 0, 16);
    const iv = Buffer.alloc(16);
    Buffer.from("W0;27ToaUpl_P%'c", "utf8").copy(iv, 0, 0, 16);
    let base64 = encStr.replace(/-/g, "+").replace(/_/g, "/");
    const pad = base64.length % 4;
    if (pad) base64 += "====".slice(pad);
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(base64, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(decrypted);
  } catch (e) {
    return null;
  }
}

async function processServer(server) {
  if (!server || !server.linkId) return null;
  try {
    const linkRes = await resilientGet(`${baseUrl}/ajax/server?get=${server.linkId}`, {
      headers: { "X-Requested-With": "XMLHttpRequest" },
      timeout: 7000,
    });
    let iframeUrl =
      linkRes.data?.result?.url ||
      linkRes.data?.url ||
      (typeof linkRes.data?.result === "string" ? linkRes.data.result : null);
    if (!iframeUrl && typeof linkRes.data?.result === "string") {
      const match = linkRes.data.result.match(/src=["']([^"']+)["']/);
      if (match) iframeUrl = match[1];
    }
    if (!iframeUrl || typeof iframeUrl !== "string") return null;
    if (iframeUrl.startsWith("//")) iframeUrl = "https:" + iframeUrl;

    const iframeRes = await global.axios.get(iframeUrl, {
      headers: { "X-Requested-With": "XMLHttpRequest", Referer: baseUrl },
      timeout: 7000,
    });

    // Megavid-style iframe: <script type="application/json" id="player-payload">
    // carries { sourceUrl } resolving straight to { source, tracks, chapters }.
    try {
      const $p = cheerio.load(iframeRes.data);
      const payloadRaw =
        $p("#player-payload").html() || $p('script[type="application/json"]').first().html() || "";
      const payload = payloadRaw ? JSON.parse(payloadRaw) : null;
      if (payload?.sourceUrl) {
        const iframeOrigin = new URL(iframeUrl).origin + "/";
        const srcUrl = new URL(payload.sourceUrl, iframeUrl).href;
        const srcRes = await global.axios.get(srcUrl, {
          headers: { "X-Requested-With": "XMLHttpRequest", Referer: iframeUrl },
          timeout: 10000,
        });
        const body = srcRes.data;
        const streamFile = typeof body === "object" ? body.source : null;
        if (streamFile) {
          try {
            const cdnDomain = new URL(streamFile).hostname;
            if (global.setDynamicReferer) {
              global.setDynamicReferer(cdnDomain, iframeOrigin);
              global.setFallbackReferer(iframeOrigin);
            }
          } catch (e) {}
          const subtitles = (body.tracks || [])
            .filter((t) => t.file && (!t.kind || t.kind.toLowerCase() !== "thumbnails"))
            .map((t) => ({ url: t.file, lang: t.label || t.language || "English" }));
          const chapters = Array.isArray(body.chapters) ? body.chapters : [];
          return {
            url: streamFile,
            isM3U8: true,
            quality: server.name || "auto",
            isDub: server.type === "dub",
            isHsub: server.type === "hsub",
            type: server.type,
            headers: { Referer: iframeOrigin },
            subtitles,
            intro: chapters.find((c) => /intro|op/i.test(c.title || "")) || null,
            outro: chapters.find((c) => /outro|ed|ending/i.test(c.title || "")) || null,
          };
        }
      }
    } catch (e) {
      console.error(
        `AnimeKai payload source failed for ${server.name}, trying megaplay flow:`,
        e.message,
      );
    }
    const $iframe = cheerio.load(iframeRes.data);
    let playerDbId =
      $iframe("#megaplay-player").attr("data-id") || $iframe("[data-id]").attr("data-id");
    if (!playerDbId) {
      const match = iframeRes.data.match(/data-id=["']([^"']+)["']/);
      if (match) playerDbId = match[1];
    }
    if (!playerDbId) return null;

    const typeMatch =
      iframeRes.data.match(/type\s*:\s*'([^']+)'/) || iframeUrl.match(/\/stream\/[^\/]+\/([^\/\?]+)/);
    const type = typeMatch ? typeMatch[1] : "";
    const ciduMatch = iframeRes.data.match(/cidu\s*:\s*'([^']+)'/);
    const cidu = ciduMatch ? ciduMatch[1] : "";
    let sParam = "";
    try {
      sParam = new URL(iframeUrl).searchParams.get("s") || "";
    } catch (_) {}
    if (!sParam) sParam = "bcdn";

    const domainName = new URL(iframeUrl).origin;
    const playerReferer = domainName + "/";
    const sourcesRes = await global.axios.get(
      `${domainName}/stream/getSources?id=${playerDbId}${type ? `&type=${encodeURIComponent(type)}` : ""}${cidu ? `&cidu=${encodeURIComponent(cidu)}` : ""}${sParam ? `&s=${encodeURIComponent(sParam)}` : ""}`,
      { headers: { "X-Requested-With": "XMLHttpRequest", Referer: playerReferer }, timeout: 7000 },
    );

    let rawSrc = sourcesRes.data?.sources;
    if (!rawSrc && sourcesRes.data?.enc) rawSrc = decryptMegaplayEnc(sourcesRes.data.enc);

    if (rawSrc) {
      let m3u8Url =
        typeof rawSrc === "string"
          ? rawSrc
          : rawSrc.file ||
            rawSrc.url ||
            (Array.isArray(rawSrc)
              ? rawSrc[0]?.file || rawSrc[0]?.url || (typeof rawSrc[0] === "string" ? rawSrc[0] : null)
              : null);
      if (m3u8Url) {
        try {
          const cdnDomain = new URL(m3u8Url).hostname;
          if (global.setDynamicReferer) {
            global.setDynamicReferer(cdnDomain, playerReferer);
            global.setFallbackReferer(playerReferer);
          }
        } catch (e) {}
        const subtitles = (sourcesRes.data.tracks || [])
          .filter((t) => t.file && (!t.kind || t.kind.toLowerCase() !== "thumbnails"))
          .map((t) => {
            let sUrl = t.file;
            if (sUrl.startsWith("//")) sUrl = "https:" + sUrl;
            else if (!sUrl.startsWith("http://") && !sUrl.startsWith("https://")) {
              try {
                sUrl = new URL(sUrl, iframeUrl).href;
              } catch (e) {}
            }
            return { url: sUrl, lang: t.label || t.language || "English" };
          });
        return {
          url: m3u8Url,
          isM3U8: true,
          quality: server.name || "auto",
          isDub: server.type === "dub",
          isHsub: server.type === "hsub",
          type: server.type,
          headers: { Referer: playerReferer },
          subtitles,
        };
      }
    }
  } catch (err) {
    console.error(`Failed to process server ${server.name}:`, err.message);
  }
  return null;
}

async function fetchEpisodeSources(episodeIdStr, category = null) {
  try {
    const parts = episodeIdStr.split("|");
    const epId = parts[0];
    const dataIds = parts[1];
    const serverRes = await resilientGet(
      `${baseUrl}/ajax/server/list?servers=${dataIds}`,
      { headers: { "X-Requested-With": "XMLHttpRequest" }, timeout: 7000 },
    );
    const $ = cheerio.load(serverRes.data.result);
    const servers = [];
    $(
      ".psps-links .item, .psps-links li, .type-server li, [data-type] li, li[data-link-id], li[data-id], .server-item",
    ).each((i, el) => {
      const parentWithType = $(el).closest("[data-type]");
      let type =
        $(el).attr("data-type") ||
        (parentWithType.length ? parentWithType.attr("data-type") : "");
      if (!type) {
        const parentClass =
          ($(el).attr("class") || "") +
          " " +
          ($(el).parent().attr("class") || "") +
          " " +
          ($(el).closest("[class]").attr("class") || "");
        if (parentClass.includes("dub")) type = "dub";
        else if (parentClass.includes("hsub")) type = "hsub";
        else if (parentClass.includes("sub")) type = "sub";
      }
      const linkId = $(el).attr("data-link-id") || $(el).attr("data-id");
      const name = $(el).text().trim() || $(el).find("a").text().trim();
      if (linkId) {
        servers.push({ type: (type || "sub").toLowerCase(), linkId, name: name || "Server" });
      }
    });

    let targetServers = servers;
    if (category) {
      const catLower = category.toLowerCase();
      targetServers = servers.filter((s) => {
        const typeLower = (s.type || "").toLowerCase();
        if (catLower === "hsub" || catLower === "hardsub")
          return typeLower === "hsub" || typeLower === "hardsub";
        else if (catLower === "sub" || catLower === "softsub")
          return typeLower === "sub" || typeLower === "softsub";
        else if (catLower === "dub") return typeLower === "dub";
        return typeLower === catLower;
      });
      const score = (n) => {
        n = (n || "").toLowerCase();
        if (n.includes("ani-hd") || n.includes("megaplay") || n.includes("hd-1")) return 10;
        if (n.includes("vidplay")) return 8;
        return 3;
      };
      targetServers.sort((a, b) => score(b.name) - score(a.name));
    }

    if (targetServers.length === 0) return { sources: [], subtitles: [] };
    const requestedCategory = (category || "sub").toLowerCase();
    return {
      sources: targetServers.map((s) => ({
        quality: s.name,
        name: s.name,
        linkId: s.linkId,
        lang: s.type || requestedCategory,
        type: s.type || requestedCategory,
        isDub: (s.type || requestedCategory) === "dub",
        isSub: (s.type || requestedCategory) === "sub",
        isHsub: (s.type || requestedCategory) === "hsub",
        isUnresolved: true,
        rawServer: s,
      })),
      subtitles: [],
    };
  } catch (err) {
    console.error("Error fetching data from AnimeKai:", err);
    return { sources: [], subtitles: [] };
  }
}

// ---- Self-healing hooks (v11 marketplace) ----

// True when the scraper backend answers with real catalogue data.
async function isPageLoaded(title, html) {
  try {
    if (!html || typeof html !== "string" || html.length < 2000) return false;
    if (/just a moment|attention required|cf-challenge|challenge-platform/i.test(html)) return false;
    return /aitem|animekai/i.test(html);
  } catch (_) {
    return false;
  }
}

// Stale watch-id repair: confirm the id still resolves, else re-search by
// title and hand back a fresh id so history/downloads heal themselves.
async function healId({ oldId, malid, title, folderName }) {
  try {
    if (oldId) {
      try {
        const info = await AnimeInfo(oldId);
        if (info && info.title) return { id: oldId, title: info.title };
      } catch (_) {}
    }
    const q = title || folderName;
    if (q) {
      const res = await SearchAnime(String(q).slice(0, 80));
      const hit = res?.results?.[0];
      if (hit?.id) return { id: hit.id, title: hit.title };
    }
  } catch (_) {}
  return null;
}

// Canary: homepage + suggest endpoint must answer with catalogue markers.
async function checkCanary(canaryData) {
  try {
    const res = await resilientGet(`${baseUrl}/`, { timeout: 12000, triesPerMirror: 1 });
    const html = res?.data;
    if (typeof html === "string" && html.includes("AnimeKai") && html.length > 10000) {
      return { ok: true };
    }
    return { ok: false, reason: "homepage markers missing" };
  } catch (err) {
    return { ok: false, reason: err?.message || "unreachable" };
  }
}

// Info hook kept for forward compatibility (no mapping endpoint for kai yet).
async function onInfoFetched({ id, info, mappingDb }) {
  return { id, info };
}

module.exports = {
  name: "animekai",
  version: "1.0.0",
  baseUrl,
  headerRules: [
    {
      match: ["animekai"],
      headers: { Referer: "https://animekai.ro/" },
    },
    {
      match: ["megavid", "megaplay", "vidplay", "vidstream"],
      headers: { Referer: "https://megavid.buzz/" },
    },
  ],
  subrequestHeaders: [
    {
      match: ["megavid", "megaplay"],
      headers: { Referer: "https://megavid.buzz/" },
    },
  ],
  bypassDomains: ["animekai"],
  cookieDomains: ["animekai.ro"],
  isPageLoaded,
  healId,
  checkCanary,
  onInfoFetched,
  SearchAnime,
  AnimeInfo,
  fetchEpisodeSources,
  processServer,
  fetchRecentEpisodes,
  fetchEpisode,
};
