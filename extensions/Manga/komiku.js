/**
 * StrawVerse Extension - Komiku (komiku.org)
 * Indonesian catalogue; search via the api.komiku.org fragment, detail pages
 * carry schema.org microdata (status/genres/author), reader images are
 * served from img.komiku.org.
 */
const cheerio = require("cheerio");
const axios = global.axios || require("axios");

const baseUrl = "https://komiku.org";
const searchBase = "https://api.komiku.org";

function slugFromHref(href) {
  try {
    const u = new URL(href, baseUrl);
    const m = u.pathname.match(/^\/manga\/([^/]+)\/?$/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

function parseCards(html) {
  const $ = cheerio.load(html);
  const results = [];
  // Homepage uses article.ls4 blocks (title in h4, cover via data-src
  // thumbnail); the legacy .bge markup is kept as a fallback.
  const scope = $("article.ls4").length
    ? $("article.ls4")
    : $(".bge").length
      ? $(".bge")
      : $("body");
  scope.each((_, el) => {
    const root = $(el);
    const a = root.find("h4 a[href*='/manga/'], a[href*='/manga/']").first();
    const id = slugFromHref(a.attr("href") || "");
    if (!id || results.some((r) => r.id === id)) return;
    const img = root.find("img").first();
    const title =
      (img.attr("alt") || "").replace(/^Baca\s+/i, "") ||
      (a.attr("title") || "").replace(/^Baca\s+Komik\s+/i, "") ||
      root.find("h4").text().trim() ||
      a.text().trim();
    if (!title) return;
    results.push({
      id,
      title,
      image: img.attr("data-src") || img.attr("src") || null,
    });
  });
  return results;
}

async function searchManga(query, page = 1, filters = {}) {
  const { data: html } = await axios.get(`${searchBase}/`, {
    params: { post_type: "manga", s: query },
  });
  return { current_page: 1, hasNextPage: false, results: parseCards(html) };
}

async function latestManga(page = 1, filters = {}) {
  // api.komiku.org root now returns an empty 200 body; the homepage's
  // "Baru Ditambahkan" (article.ls4) list is the latest-manga source.
  const { data: html } = await axios.get(`${baseUrl}/`);
  return { current_page: 1, hasNextPage: false, results: parseCards(html) };
}

async function fetchMangaInfo(mangaId) {
  const { data: html } = await axios.get(`${baseUrl}/manga/${mangaId}/`);
  const $ = cheerio.load(html);

  const genres = [];
  $('meta[itemprop="genre"]').each((_, el) => {
    const g = $(el).attr("content");
    if (g && !genres.includes(g)) genres.push(g);
  });

  const statusRaw = $('meta[itemprop="creativeWorkStatus"]').attr("content") || "";
  const author =
    $('span[itemprop="author"] meta[itemprop="name"]').attr("content") ||
    $('meta[itemprop="author"]').attr("content") ||
    null;
  const date = $('meta[itemprop="datePublished"]').attr("content") || "";
  const ogTitle = ($('meta[property="og:title"]').attr("content") || "")
    .replace(/\s*-\s*Komiku\s*$/i, "")
    .replace(/^Komik\s+/i, "")
    .trim();

  return {
    id: mangaId,
    title: ogTitle || mangaId,
    image: $('meta[property="og:image"]').attr("content") || null,
    description: $('meta[name="description"]').attr("content") || "",
    genres,
    status: /ongoing|berjalan|releasing/i.test(statusRaw)
      ? "Ongoing"
      : /completed|tamat|finished|^end$/i.test(statusRaw)
        ? "Completed"
        : "Unknown",
    author,
    year: date ? Number(date.slice(0, 4)) || null : null,
    type: "Manga",
  };
}

async function fetchChapters(mangaId) {
  const { data: html } = await axios.get(`${baseUrl}/manga/${mangaId}/`);
  const $ = cheerio.load(html);
  const chapters = [];
  $("table#Daftar_Chapter a[href], #daftarChapter a[href]").each((_, el) => {
    const href = $(el).attr("href") || "";
    let path = "";
    try {
      path = new URL(href, baseUrl).pathname;
    } catch (_) {
      return;
    }
    const chapterPath = path.replace(/^\//, "").replace(/\/$/, "");
    if (!chapterPath || !chapterPath.startsWith(mangaId)) return;
    if (chapters.some((c) => c.id === chapterPath)) return;
    const text = $(el).text().trim();
    const num =
      (text.match(/(?:chapter|ch)\s*(\d+(?:\.\d+)?)/i) ||
        chapterPath.match(/chapter-(\d+(?:\.\d+)?)/i) ||
        [])[1];
    chapters.push({
      id: chapterPath,
      number: num ? parseFloat(num) : 0,
      title: text || null,
    });
  });
  return { TotalPages: 1, total: chapters.length, Chapters: chapters };
}

async function fetchChapterPages(chapterId) {
  const url = chapterId.startsWith("http") ? chapterId : `${baseUrl}/${chapterId}`;
  const { data: html } = await axios.get(url);
  const $ = cheerio.load(html);
  const pages = [];
  const seen = new Set();
  const push = (...cands) => {
    for (const c of cands) {
      if (c && /img\.komiku\.org/.test(c) && !seen.has(c)) {
        seen.add(c);
        pages.push({ page: pages.length + 1, img: c });
        break;
      }
    }
  };
  const area = $("#readerarea img, .readingcontent img");
  const scope = area.length ? area : $("img");
  scope.each((_, el) =>
    push($(el).attr("src"), $(el).attr("data-src"), $(el).attr("data-lazy-src")),
  );
  return pages;
}

module.exports = {
  name: "komiku",
  version: "1.0.0",
  baseUrl,
  headerRules: [
    {
      match: ["komiku.org", "img.komiku.org"],
      headers: { Referer: `${baseUrl}/` },
    },
  ],
  searchManga,
  latestManga,
  fetchMangaInfo,
  fetchChapters,
  fetchChapterPages,
};
