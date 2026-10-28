/**
 * StrawVerse Extension - Anime Nexus Scraper
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
 *
 * NOTES
 * -----
 * Anime Nexus is a Cloudflare-fronted SPA backed by a JSON API on
 * api.anime.nexus. The latest feed, search, show details, episode lists,
 * subtitle files and thumbnail sprites all resolve through clean,
 * unauthenticated JSON endpoints, so the browse/search/info/episode flows
 * work fully headlessly.
 *
 * Poster/still images are imgproxy signature-protected: every `resized`
 * path returned by the API must be used EXACTLY as-is (prefixing it with
 * https://anime.delivery). Never rewrite the resize parameters or the
 * signature breaks (403).
 *
 * KNOWN LIMITATION - VIDEO PLAYBACK
 * The HLS manifest (/api/anime/video/{id}/stream/video.m3u8) requires a
 * per-session `token` query parameter that is only issued over the
 * prd-socket.anime.nexus WebSocket after a Cloudflare Turnstile
 * attestation (POST /api/auth/ws-token). Without that token the manifest
 * answers 403 "Invalid", so in-app playback may fail even though this
 * extension returns a correct m3u8 URL and subtitle tracks. No Turnstile
 * bypass is attempted here; re-test if the site changes its token policy.
 * The stream endpoint itself is also aggressively rate-limited (empty
 * {"message":""} response) - a single short retry with a fresh client
 * fingerprint is performed, then the source is reported as unresolved.
 */

const crypto = require("crypto");

const baseUrl = "https://anime.nexus";
const apiBase = "https://api.anime.nexus";
const imageBase = "https://anime.delivery";

const API_HEADERS = {
  Accept: "application/json, text/plain, */*",
  Referer: `${baseUrl}/`,
};

// ---- client fingerprint (X-Client-Fingerprint / x-fingerprint) ----
// The site generates this per browser session; it is not server-validated
// beyond UUIDv4 format, but the stream endpoint expects it.
let cachedFingerprint = null;

function getFingerprint() {
  if (cachedFingerprint) return cachedFingerprint;
  try {
    const b = crypto.randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const hex = b.toString("hex");
    cachedFingerprint =
      `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
      `${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  } catch (_) {
    cachedFingerprint = "4f9c2b7e-8a1d-4e6b-9c3f-1d2e5a7b8c9d";
  }
  return cachedFingerprint;
}

function invalidateFingerprint() {
  cachedFingerprint = null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- helpers ----

function buildQuery(pairs) {
  const parts = [];
  if (Array.isArray(pairs)) {
    for (const [key, value] of pairs) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        for (const v of value) parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
      } else {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      }
    }
  }
  return parts.join("&");
}

async function apiGet(path, pairs) {
  let url = apiBase + path;
  const qs = buildQuery(pairs);
  if (qs) url += `?${qs}`;
  const res = await global.axios.get(url, { headers: API_HEADERS, timeout: 20000 });
  return res?.data;
}

// imgproxy images: exact signed `resized` path + delivery host.
function imgUrl(container, preferred) {
  try {
    if (!container || typeof container !== "object") return null;
    const resized = container.resized && typeof container.resized === "object"
      ? container.resized
      : container;
    const keys = Object.keys(resized);
    if (!keys.length) return null;
    let pick = null;
    if (Array.isArray(preferred)) {
      for (const k of preferred) {
        if (typeof resized[k] === "string" && resized[k]) {
          pick = resized[k];
          break;
        }
      }
    }
    if (!pick && typeof resized[keys[0]] === "string") pick = resized[keys[0]];
    if (!pick) return null;
    if (pick.startsWith("http://") || pick.startsWith("https://")) return pick;
    if (!pick.startsWith("/")) return null;
    return imageBase + pick;
  } catch (_) {
    return null;
  }
}

function pageMeta(payload, page) {
  const meta = payload?.meta || {};
  const links = payload?.links || {};
  const current = meta.current_page || page || 1;
  const totalPages = meta.last_page || 1;
  const hasNextPage =
    links.next != null && links.next !== undefined ? Boolean(links.next) : current < totalPages;
  return { currentPage: current, hasNextPage, totalPages };
}

function durationLabel(seconds) {
  const s = parseInt(seconds, 10);
  if (!s || isNaN(s) || s <= 0) return "Unknown";
  return `${Math.max(1, Math.round(s / 60))} min`;
}

function qualityLabel(videoMeta) {
  try {
    const qualities = videoMeta?.qualities;
    if (!qualities || typeof qualities !== "object") return null;
    let best = 0;
    for (const key of Object.keys(qualities)) {
      const m = String(key).match(/x(\d{3,4})$/i);
      if (m) {
        const h = parseInt(m[1], 10);
        if (h > best) best = h;
      }
    }
    return best ? `${best}p` : null;
  } catch (_) {
    return null;
  }
}

// ---- scraper functions ----

async function fetchRecentEpisodes(filters = {}) {
  try {
    const page = filters?.page || 1;
    const data = await apiGet("/api/anime/latest", [
      ["perPage", 24],
      ["page", page],
    ]);
    const items = Array.isArray(data?.data) ? data.data : [];
    const results = [];
    for (const item of items) {
      if (!item?.id || !item?.name) continue;
      const ep = item.episode;
      const title =
        ep && ep.number != null ? `${item.name} - Ep ${ep.number}` : item.name;
      const image =
        imgUrl(item.poster, ["480x720", "640x960", "240x360"]) ||
        imgUrl(ep?.image, ["640x360", "1280x720"]);
      results.push({
        id: item.id,
        title,
        image: image || null,
        episode: ep?.number != null ? ep.number : null,
      });
    }
    return { ...pageMeta(data, page), results };
  } catch (err) {
    throw new Error(err.message);
  }
}

async function SearchAnime(query, filters = {}) {
  try {
    const page = filters?.page || 1;
    const data = await apiGet("/api/anime/shows", [
      ["search", query],
      ["sortBy", "name asc"],
      ["hasVideos", "true"],
      ["excludeInCollection", "false"],
      ["withCollectionStatus", "false"],
      ["includes[]", ["poster", "genres", "background"]],
      ["page", page],
    ]);
    const items = Array.isArray(data?.data) ? data.data : [];
    const results = [];
    for (const item of items) {
      if (!item?.id || !item?.name) continue;
      results.push({
        id: item.id,
        title: item.name,
        image: imgUrl(item.poster, ["480x720", "640x960", "240x360"]),
      });
    }
    return { ...pageMeta(data, page), results };
  } catch (err) {
    throw new Error(err.message);
  }
}

async function AnimeInfo(id) {
  try {
    const data = await apiGet("/api/anime/details", [
      ["id", id],
      ["includes[]", ["poster", "genres", "background"]],
    ]);
    const d = data?.data;
    if (!d || !d.name) throw new Error("Anime Nexus: show details not found");

    const info = {
      id,
      title: d.name,
      image: imgUrl(d.poster, ["640x960", "480x720", "240x360"]),
      description: d.description || "",
    };
    info.genres = (Array.isArray(d.genres) ? d.genres : [])
      .map((g) => g?.name)
      .filter(Boolean);

    const status = String(d.status || "");
    if (/currently airing/i.test(status)) info.status = "Ongoing";
    else if (/finished airing/i.test(status)) info.status = "Completed";
    else info.status = "Unknown";

    info.type = d.type || "TV";
    const epCount = parseInt(d.episode_count, 10);
    if (!isNaN(epCount)) info.episodes = epCount;
    info.aired = d.release_date || d.start_date || "";
    const year = parseInt(String(info.aired).slice(0, 4), 10);
    if (year > 1900 && year < 2100) info.year = year;
    info.dataId = id;
    return info;
  } catch (error) {
    console.error("Error fetching data from Anime Nexus:", error.message);
    throw error;
  }
}

async function fetchEpisode(dataId, page = 1) {
  try {
    const data = await apiGet("/api/anime/details/episodes", [
      ["id", dataId],
      ["page", page],
      ["perPage", 50],
      ["order", "asc"],
      ["fillers", "true"],
      ["recaps", "true"],
    ]);
    const items = Array.isArray(data?.data) ? data.data : [];
    const episodes = [];
    for (const ep of items) {
      if (!ep?.id) continue;
      const number =
        typeof ep.number === "number" ? ep.number : parseFloat(ep.number) || 0;
      episodes.push({
        id: ep.id,
        number,
        title: ep.title || `Episode ${number}`,
        duration: durationLabel(ep.duration),
        langs: ["sub"],
      });
    }
    const meta = data?.meta || {};
    return {
      episodes,
      totalPages: meta.last_page || 1,
      total: meta.total != null ? meta.total : episodes.length,
      currentPage: meta.current_page || page,
    };
  } catch (err) {
    return { episodes: [], totalPages: 0, total: 0, currentPage: page };
  }
}

// Single soft-sub source; the actual manifest fetch happens in processServer
// so the aggressively rate-limited stream endpoint is hit only once.
async function fetchEpisodeSources(episodeIdStr, category = null) {
  try {
    if (!episodeIdStr) return { sources: [], subtitles: [] };
    const type = "sub";
    return {
      sources: [
        {
          quality: "Auto",
          name: "AnimeNexus",
          linkId: episodeIdStr,
          lang: type,
          type,
          isDub: false,
          isSub: true,
          isHsub: false,
          isUnresolved: true,
          rawServer: { episodeId: episodeIdStr, name: "AnimeNexus", type },
        },
      ],
      subtitles: [],
    };
  } catch (err) {
    console.error("Error fetching sources from Anime Nexus:", err.message || err);
    return { sources: [], subtitles: [] };
  }
}

async function fetchStreamPayload(epId) {
  const url =
    `${apiBase}/api/anime/details/episode/stream` +
    `?id=${encodeURIComponent(epId)}&fillers=true&recaps=true`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fingerprint = getFingerprint();
      const res = await global.axios.get(url, {
        headers: {
          ...API_HEADERS,
          "X-Requested-With": "XMLHttpRequest",
          "X-Client-Fingerprint": fingerprint,
          "x-fingerprint": fingerprint,
          Origin: baseUrl,
          Referer: `${baseUrl}/watch/`,
        },
        timeout: 20000,
      });
      const body = res?.data;
      const payload =
        body && typeof body === "object" ? body.data && typeof body.data === "object" ? body.data : body : null;
      if (payload && typeof payload.hls === "string" && payload.hls) return payload;
      // Empty {"message":""} = rate limit; HTML = Cloudflare block.
      if (attempt === 0) {
        invalidateFingerprint();
        await sleep(3000);
        continue;
      }
      return null;
    } catch (err) {
      if (attempt === 0) {
        invalidateFingerprint();
        await sleep(3000);
        continue;
      }
      throw err;
    }
  }
  return null;
}

async function processServer(server) {
  const epId = server?.rawServer?.episodeId || server?.linkId || server?.id;
  if (!epId) return null;
  try {
    const payload = await fetchStreamPayload(epId);
    if (!payload) return null;
    const subtitles = (Array.isArray(payload.subtitles) ? payload.subtitles : [])
      .filter((s) => s && typeof s.src === "string" && s.src)
      .map((s) => ({
        url: s.src.startsWith("//") ? `https:${s.src}` : s.src,
        lang: s.label || s.srcLang || "English",
      }));
    return {
      url: payload.hls,
      isM3U8: true,
      quality: qualityLabel(payload.video_meta) || server.name || "Auto",
      isDub: server?.type === "dub",
      isSub: true,
      isHsub: server?.type === "hsub",
      type: server?.type || "sub",
      headers: { Referer: `${baseUrl}/watch/`, Origin: baseUrl },
      subtitles,
    };
  } catch (err) {
    console.error(`[AnimeNexus] stream resolve failed: ${err.message}`);
  }
  return null;
}

// ---- Self-healing hooks (v11 marketplace) ----

// True when the bypassed page really is the Anime Nexus app (not a
// Cloudflare interstitial or an error shell).
function isPageLoaded(title, html) {
  try {
    if (!html || typeof html !== "string" || html.length < 2000) return false;
    if (/just a moment|attention required|cf-challenge|challenge-platform/i.test(html)) {
      return false;
    }
    return /anime\.nexus|TanStack|\$_TSR|__TSR/i.test(html);
  } catch (_) {
    return false;
  }
}

// Stale id repair: confirm the id still resolves, else re-search by title.
async function healId({ oldId, malid, title, folderName } = {}) {
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

// Canary: the catalogue API must answer with real JSON.
async function checkCanary(canaryData) {
  try {
    const res = await global.axios.get(`${apiBase}/api/anime/genres`, {
      headers: API_HEADERS,
      timeout: 12000,
    });
    const d = res?.data;
    const list = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : null;
    if (res?.status === 200 && list && list.length > 0) return { ok: true };
    return { ok: false, reason: "genres endpoint unhealthy" };
  } catch (err) {
    return { ok: false, reason: err?.message || "unreachable" };
  }
}

// Info hook kept for forward compatibility (MAL mapping not required).
async function onInfoFetched({ id, info, mappingDb } = {}) {
  return { id, info };
}

module.exports = {
  name: "animenexus",
  version: "1.0.0",
  baseUrl,
  headerRules: [
    {
      match: ["anime.nexus"],
      headers: { Referer: `${baseUrl}/`, Origin: baseUrl },
    },
  ],
  subrequestHeaders: [
    {
      match: ["anime.nexus", "anime.delivery"],
      headers: { Referer: `${baseUrl}/` },
    },
  ],
  bypassDomains: ["anime.nexus"],
  cookieDomains: ["anime.nexus", "api.anime.nexus"],
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
