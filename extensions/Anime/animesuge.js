/**
 * StrawVerse Extension - AnimeSuge (animesuge.cz)
 * Catalogue from the SSR latest-updated/search markup, episodes from the
 * site's ajax/episode/list endpoint, streams from the ajax server chain
 * (server/list -> server?get -> megaplay player -> getSources).
 *
 * Sibling site KotoPlay (kotoplay.to) is not covered: its browse/watch pages
 * are client-side only and expose no server-rendered data endpoint.
 */
const cheerio = require("cheerio");
const axios = global.axios || require("axios");
const crypto = require("crypto");

const baseUrl = "https://animesuge.cz";
const XHR = { Referer: `${baseUrl}/`, "X-Requested-With": "XMLHttpRequest" };

function parseCards(html) {
  const $ = cheerio.load(html);
  const results = [];
  $(".item").each((_, el) => {
    const card = $(el);
    const link = card.is("a[href*='/anime/']")
      ? card
      : card.find("a[href*='/anime/']").first();
    const m = (link.attr("href") || "").match(/\/anime\/([^/?#]+)/);
    if (!m) return;
    const id = m[1];
    if (results.some((r) => r.id === id)) return;
    const img = card.find("img").first();
    const title =
      card.find("[data-jp]").first().attr("data-jp") || img.attr("alt") || "";
    if (!title) return;
    results.push({
      id,
      title,
      image: img.attr("data-src") || img.attr("src") || null,
    });
  });
  return results;
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
  } catch (_) {
    return null;
  }
}

async function SearchAnime(query, filters = {}) {
  const { data } = await axios.get(`${baseUrl}/ajax/anime/search`, {
    params: { keyword: query },
    headers: XHR,
  });
  return {
    currentPage: 1,
    hasNextPage: false,
    totalPages: 1,
    results: parseCards(data?.result?.html || ""),
  };
}

async function fetchRecentEpisodes(filters = {}) {
  // /latest-updated paginates for real (the pager exposes the last page).
  const page = Math.max(1, Number(filters?.page || 1));
  const { data: html } = await axios.get(`${baseUrl}/latest-updated`, {
    params: { page },
  });
  const results = parseCards(html);
  const pages = [...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
  return {
    currentPage: page,
    totalPages: pages.length ? Math.max(...pages, page) : page,
    hasNextPage: results.length > 0,
    results,
  };
}

async function fetchDetail(id) {
  const { data: html } = await axios.get(`${baseUrl}/anime/${id}`);
  const $ = cheerio.load(html);
  const animeId =
    $("[data-manga-id]").first().attr("data-manga-id") ||
    $("[data-id]").first().attr("data-id") ||
    null;

  const meta = {};
  $(".meta > div").each((_, el) => {
    const key = $(el)
      .find("div")
      .first()
      .text()
      .trim()
      .replace(":", "");
    if (key) meta[key] = $(el).find("span").first().text().trim();
  });

  return { $, html, animeId, meta };
}

function mapStatus(text) {
  if (/finished|completed/i.test(text)) return "Completed";
  if (/airing|ongoing/i.test(text)) return "Ongoing";
  if (/not yet|upcoming/i.test(text)) return "Upcoming";
  return "Unknown";
}

async function fetchEpisodeList(animeId) {
  const { data } = await axios.get(`${baseUrl}/ajax/episode/list/${animeId}`, {
    headers: XHR,
  });
  const $ = cheerio.load(data?.result || "");
  const episodes = [];
  $("a[data-slug]").each((i, el) => {
    const slug = $(el).attr("data-slug");
    if (!slug) return;
    episodes.push({
      id: `${animeId}:${slug}`,
      number: i + 1,
      title: $(el).attr("data-num") || `Episode ${i + 1}`,
      duration: null,
    });
  });
  return { $, episodes };
}

async function AnimeInfo(id) {
  const { $, animeId, meta } = await fetchDetail(id);
  const premiered = meta.Premiered || "";
  const year = Number((premiered.match(/\d{4}/) || [])[0]) || null;
  const season = premiered.replace(/\d{4}/, "").trim() || null;
  let totalEpisodes = null;
  if (animeId) {
    try {
      totalEpisodes = (await fetchEpisodeList(animeId)).episodes.length || null;
    } catch (_) {}
  }
  return {
    id,
    title:
      $("h1.title").first().text().trim() ||
      $("h1[data-jp]").first().attr("data-jp") ||
      id,
    image:
      $(".poster img").first().attr("src") ||
      $('meta[property="og:image"]').attr("content") ||
      null,
    type: meta.Type || "TV",
    description:
      $(".description .full").first().text().trim() ||
      $(".description .short").first().text().trim() ||
      "",
    genres: [],
    status: mapStatus(meta.Status || ""),
    year,
    season: season ? season.charAt(0) + season.slice(1).toLowerCase() : null,
    duration: meta.Duration || null,
    totalEpisodes,
  };
}

async function fetchEpisode(id, page = 1) {
  try {
    const { animeId } = await fetchDetail(id);
    if (!animeId) {
      return { episodes: [], totalPages: 0, total: 0, currentPage: page };
    }
    const { episodes } = await fetchEpisodeList(animeId);
    return { episodes, totalPages: 1, total: episodes.length, currentPage: 1 };
  } catch (_) {
    return { episodes: [], totalPages: 0, total: 0, currentPage: page };
  }
}

// Resolves one megaplay server into a playable HLS url + subtitle tracks.
async function resolveServer(linkId, type) {
  const { data: linkRes } = await axios.get(`${baseUrl}/ajax/server`, {
    params: { get: linkId },
    headers: XHR,
  });
  const iframeUrl = linkRes?.result?.url;
  if (!iframeUrl) return null;

  const origin = new URL(iframeUrl).origin;
  // The player page answers 410 without a Referer.
  const { data: playerHtml } = await axios.get(iframeUrl, {
    headers: { Referer: `${baseUrl}/` },
  });
  const playerId = (playerHtml.match(/data-id=["']([^"']+)["']/) || [])[1];
  if (!playerId) return null;
  const playerType = (playerHtml.match(/type\s*:\s*'([^']+)'/) || [])[1];
  const cidu = (playerHtml.match(/cidu\s*:\s*'([^']+)'/) || [])[1];
  const s = new URL(iframeUrl).searchParams.get("s") || "bcdn";

  const { data: srcRes } = await axios.get(`${origin}/stream/getSources`, {
    params: {
      id: playerId,
      type: playerType,
      cidu,
      s,
    },
    headers: { Referer: `${origin}/`, "X-Requested-With": "XMLHttpRequest" },
  });

  let raw = srcRes?.sources;
  if (!raw && srcRes?.enc) raw = decryptMegaplayEnc(srcRes.enc);
  const url =
    typeof raw === "string" ? raw : raw?.file || raw?.url || null;
  if (!url) return null;

  return {
    source: {
      url,
      quality: "default",
      name: `AnimeSuge ${type}`,
      type,
      isM3U8: /\.m3u8/i.test(url),
      headers: { Referer: `${origin}/` },
    },
    subtitles: (srcRes?.tracks || [])
      .filter((t) => t && t.file && t.kind !== "thumbnails")
      .map((t) => ({
        url: t.file,
        lang: t.label || t.language || "English",
      })),
  };
}

async function fetchEpisodeSources(episodeId, category = null) {
  const [animeId, epSlug] = String(episodeId).split(":");
  if (!animeId || !epSlug) return { sources: [], subtitles: [] };

  const wanted = String(category || "").toLowerCase() === "dub" ? "dub" : "sub";
  const { $ } = await fetchEpisodeList(animeId);
  const dataIds = $(`a[data-slug='${epSlug}']`).first().attr("data-ids");
  if (!dataIds) return { sources: [], subtitles: [] };

  const { data: serverRes } = await axios.get(`${baseUrl}/ajax/server/list`, {
    params: { servers: dataIds },
    headers: XHR,
  });
  const $s = cheerio.load(serverRes?.result || "");
  const servers = [];
  $s(".server").each((_, el) => {
    const linkId = $(el).attr("data-link-id");
    if (!linkId) return;
    servers.push({
      linkId,
      type: $(el).closest("[data-type]").attr("data-type") || "sub",
    });
  });

  const sources = [];
  const subtitles = [];
  const ordered = [
    ...servers.filter((s) => s.type === wanted),
    ...servers.filter((s) => s.type !== wanted),
  ];
  for (const server of ordered.slice(0, 4)) {
    try {
      const resolved = await resolveServer(server.linkId, server.type);
      if (!resolved) continue;
      sources.push(resolved.source);
      for (const sub of resolved.subtitles) {
        if (!subtitles.some((x) => x.url === sub.url)) subtitles.push(sub);
      }
      if (sources.length >= 2) break;
    } catch (_) {}
  }
  return { sources, subtitles };
}

module.exports = {
  name: "animesuge",
  version: "1.0.0",
  baseUrl,
  headerRules: [
    { match: ["animesuge.cz"], headers: { Referer: `${baseUrl}/` } },
    { match: ["megaplay.buzz"], headers: { Referer: "https://megaplay.buzz/" } },
  ],
  SearchAnime,
  AnimeInfo,
  fetchEpisode,
  fetchEpisodeSources,
  fetchRecentEpisodes,
};
