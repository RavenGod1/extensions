/**
 * StrawVerse Extension - MangaWorld (mangaworld.mx)
 * Italian catalogue; search/detail/chapters from SSR pages, reader pages
 * ship a "pages" JSON plus the chapter CDN base in the first rendered image.
 */
const cheerio = require("cheerio");
const axios = global.axios || require("axios");

const baseUrl = "https://www.mangaworld.mx";

function mangaIdFromHref(href) {
  try {
    const u = new URL(href, baseUrl);
    const m = u.pathname.match(/^\/manga\/(\d+\/[^/]+)\/?$/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

function mapStatus(text) {
  if (/finito|completat|completed|finished/i.test(text)) return "Completed";
  if (/in corso|ongoing|airing/i.test(text)) return "Ongoing";
  return null;
}

function parseEntries(html) {
  const $ = cheerio.load(html);
  const results = [];
  $("div.entry").each((_, el) => {
    const a = $(el).find("a[href*='/manga/']").first();
    const id = mangaIdFromHref(a.attr("href") || "");
    if (!id || results.some((r) => r.id === id)) return;
    const img = $(el).find("img").first();
    const title =
      a.attr("title") || img.attr("alt") || $(el).find("a.manga-title").text().trim();
    if (!title) return;
    results.push({
      id,
      title,
      image: img.attr("src") || null,
      status: mapStatus($(el).find(".status").text()),
    });
  });
  return results;
}

async function searchManga(query, page = 1, filters = {}) {
  const { data: html } = await axios.get(`${baseUrl}/archive`, {
    params: { keyword: query },
  });
  return { current_page: 1, hasNextPage: false, results: parseEntries(html) };
}

async function latestManga(page = 1, filters = {}) {
  const { data: html } = await axios.get(`${baseUrl}/archive`);
  return { current_page: 1, hasNextPage: false, results: parseEntries(html) };
}

// Info grid rows are "<span>Stato: </span> <a>...</a>" pairs.
function labeled($, label) {
  let v = "";
  $("span").each((_, el) => {
    if (v) return;
    const txt = $(el).text().trim();
    if (txt.toLowerCase().startsWith(label.toLowerCase())) {
      const next = $(el).next("a, span").text().trim();
      if (next) v = next;
    }
  });
  return v;
}

async function fetchMangaInfo(mangaId) {
  const { data: html } = await axios.get(`${baseUrl}/manga/${mangaId}`);
  const $ = cheerio.load(html);
  const yearRaw = labeled($, "Anno");
  return {
    id: mangaId,
    title:
      $("h1").first().text().trim() ||
      $('meta[property="og:title"]').attr("content") ||
      mangaId,
    image: $('meta[property="og:image"]').attr("content") || null,
    description: $('meta[name="description"]').attr("content") || "",
    // The detail page only carries the site-wide genre menu, no per-manga genres.
    genres: [],
    status: mapStatus(labeled($, "Stato")) || "Unknown",
    author: labeled($, "Autore") || null,
    year: Number((yearRaw.match(/\d{4}/) || [])[0]) || null,
    type: "Manga",
  };
}

async function fetchChapters(mangaId) {
  const { data: html } = await axios.get(`${baseUrl}/manga/${mangaId}`);
  const $ = cheerio.load(html);
  const chapters = [];
  $("a[href*='/read/']").each((_, el) => {
    const href = $(el).attr("href") || "";
    const m = href.match(/\/manga\/([^/]+\/[^/]+)\/read\/([0-9a-z]+)/i);
    if (!m || m[1] !== mangaId) return;
    const chapterId = `manga/${m[1]}/read/${m[2]}`;
    if (chapters.some((c) => c.id === chapterId)) return;
    const text = $(el).text().trim();
    const num = (text.match(/(\d+(?:[.,]\d+)?)/) || [])[1];
    chapters.push({
      id: chapterId,
      number: num ? parseFloat(num.replace(",", ".")) : 0,
      title: text || null,
    });
  });
  return { TotalPages: 1, total: chapters.length, Chapters: chapters };
}

async function fetchChapterPages(chapterId) {
  const url = chapterId.startsWith("http") ? chapterId : `${baseUrl}/${chapterId}`;
  const { data: html } = await axios.get(url);
  const pages = [];

  const pm = html.match(/"pages":\[([^\]]*)\]/);
  const bm = html.match(/https:\/\/cdn\.mangaworld\.mx\/chapters\/[^"'\s\\<>]+/);
  if (pm && bm) {
    const base = bm[0].replace(/\/[^/]+$/, "");
    let names = [];
    try {
      names = JSON.parse("[" + pm[1] + "]");
    } catch (_) {}
    names.forEach((n, i) => pages.push({ page: i + 1, img: `${base}/${n}` }));
  }

  if (!pages.length) {
    const re = /https:\/\/cdn\.mangaworld\.mx\/chapters\/[^"'\s\\<>]+/g;
    const seen = new Set();
    let m;
    while ((m = re.exec(html)) !== null) {
      if (seen.has(m[0])) continue;
      seen.add(m[0]);
      pages.push({ page: pages.length + 1, img: m[0] });
    }
  }
  return pages;
}

module.exports = {
  name: "mangaworld",
  version: "1.0.0",
  baseUrl,
  headerRules: [
    {
      match: ["mangaworld.mx"],
      headers: { Referer: `${baseUrl}/` },
    },
  ],
  searchManga,
  latestManga,
  fetchMangaInfo,
  fetchChapters,
  fetchChapterPages,
};
