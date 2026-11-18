/**
 * StrawVerse Extension - Shonen (shonen.to)
 * Catalogue via shonen.to SSR pages; streams via the site's own
 * /sources/shonen JSON endpoint (requires the X-Shonen-Fast header).
 */
const cheerio = require("cheerio");
const axios = global.axios || require("axios");

const baseUrl = "https://shonen.to";

function abs(src) {
  if (!src) return null;
  try {
    return new URL(src, baseUrl).href;
  } catch (_) {
    return src;
  }
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const results = [];
  $("a.card").each((_, el) => {
    const m = ($(el).attr("href") || "").match(/^\/anime\/(.+)$/);
    if (!m) return;
    const title = $(el).attr("title") || $(el).find(".ct").text().trim();
    if (!title || results.some((r) => r.id === m[1])) return;
    const meta = $(el).find(".cm").text().trim();
    const year = (meta.match(/\d{4}/) || [])[0];
    results.push({
      id: m[1],
      title,
      image: abs($(el).find("img").attr("src")),
      year: year || null,
    });
  });
  return results;
}

async function SearchAnime(query, filters = {}) {
  const { data: html } = await axios.get(`${baseUrl}/browse`, {
    params: { q: query },
  });
  return { currentPage: 1, hasNextPage: false, totalPages: 1, results: parseCards(html) };
}

async function fetchRecentEpisodes(filters = {}) {
  const { data: html } = await axios.get(`${baseUrl}/browse`, {
    params: { sort: "TRENDING_DESC" },
  });
  return { currentPage: 1, hasNextPage: false, totalPages: 1, results: parseCards(html) };
}

async function AnimeInfo(id) {
  const { data: html } = await axios.get(`${baseUrl}/anime/${id}`);
  const $ = cheerio.load(html);

  const facts = {};
  $("dl.facts > div").each((_, el) => {
    const k = $(el).find("dt").text().trim();
    const v = $(el).find("dd").text().trim();
    if (k) facts[k] = v;
  });

  const genres = [];
  $("a.chip[href*='/genre/']").each((_, el) => {
    const g = $(el).text().trim();
    if (g && !genres.includes(g)) genres.push(g);
  });

  const seasonRaw = (facts.Season || "").trim();
  const statusText = facts.Status || "";
  return {
    id,
    title:
      $("h1").first().text().trim() ||
      $('meta[property="og:title"]').attr("content") ||
      id,
    image: abs($('meta[property="og:image"]').attr("content")),
    type: facts.Format || "TV",
    description:
      $("p.desc").text().trim() ||
      $('meta[name="description"]').attr("content") ||
      "",
    genres,
    status: /finished|completed/i.test(statusText)
      ? "Completed"
      : /airing|releasing/i.test(statusText)
        ? "Ongoing"
        : "Unknown",
    year: Number((seasonRaw.match(/\d{4}/) || [])[0]) || null,
    season: seasonRaw.replace(/\d{4}/, "").trim() || null,
    duration: facts.Duration || null,
    studio: facts.Studio || null,
    totalEpisodes:
      parseInt(facts.Episodes, 10) ||
      parseInt($("[data-eps]").attr("data-eps") || "", 10) ||
      null,
  };
}

async function fetchEpisode(id, page = 1) {
  let total = 0;
  try {
    total = (await AnimeInfo(id)).totalEpisodes || 0;
  } catch (_) {}
  if (!total) return { episodes: [], totalPages: 0, total: 0, currentPage: page };
  const episodes = [];
  for (let n = 1; n <= total; n++) {
    episodes.push({ id: `${id}:${n}`, number: n, title: `Episode ${n}`, duration: null });
  }
  return { episodes, totalPages: 1, total, currentPage: 1 };
}

async function fetchEpisodeSources(episodeId, category = null) {
  const s = String(episodeId);
  const idx = s.lastIndexOf(":");
  const id = idx > 0 ? s.slice(0, idx) : s;
  const episode = idx > 0 ? s.slice(idx + 1) : "1";
  const wanted = String(category || "").toLowerCase() === "dub" ? "dub" : "sub";
  const attempts = wanted === "dub" ? ["dub", "sub"] : ["sub", "dub"];

  for (const language of attempts) {
    try {
      const { data } = await axios.get(`${baseUrl}/sources/shonen`, {
        params: { id, episode, language },
        headers: { "X-Shonen-Fast": "1" },
      });
      const d = data && data.data ? data.data : data;
      const list = (d && d.sources) || [];
      const hls = list.find((x) => x && x.type === "hls") || {};
      const url = (d && d.source) || hls.file;
      if (!url) continue;

      const subtitles = [];
      for (const src of list) {
        for (const t of (src && src.tracks) || []) {
          const file = t && (t.file || t.url);
          if (file && (/\.vtt/i.test(file) || (t.kind || "") === "subtitles")) {
            subtitles.push({ lang: t.label || t.language || "unknown", url: abs(file) });
          }
        }
      }

      return {
        sources: [
          {
            // API sometimes rotates to a relative proxy path (/api/v1/...)
            url: abs(url),
            quality: "default",
            name: `Shonen ${language}`,
            type: language,
            isM3U8: true,
            headers: { Referer: `${baseUrl}/` },
          },
        ],
        subtitles,
      };
    } catch (_) {}
  }
  return { sources: [], subtitles: [] };
}

module.exports = {
  name: "shonen",
  version: "1.0.1",
  baseUrl,
  headerRules: [
    {
      match: ["shonen.to"],
      headers: { Referer: `${baseUrl}/` },
    },
  ],
  SearchAnime,
  AnimeInfo,
  fetchEpisode,
  fetchEpisodeSources,
  fetchRecentEpisodes,
};
