/**
 * StrawVerse Extension - MangaKatana Scraper
 * Copyright (C) 2026 TheYogMehta
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * DISCLAIMER: This extension is intended for research, educational,
 * and developer testing purposes only.
 */

const cheerio = require("cheerio");

const baseUrl = "https://mangakatana.com";

// MangaKatana intermittently answers rapid requests with an empty 200
// body; retry a couple of times before treating the page as empty.
async function fetchHtml(url, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const { data } = await global.axios.get(url);
    if ((data && String(data).length > 0) || attempt >= retries) return data;
    await new Promise((r) => setTimeout(r, 800));
  }
}

// Site genre slugs (from the /genre/ nav). Used to validate filter input
// and to match items client-side after a keyword search.
const GENRE_SLUGS = new Set([
  "4-koma",
  "action",
  "adult",
  "adventure",
  "artbook",
  "award-winning",
  "comedy",
  "cooking",
  "doujinshi",
  "drama",
  "ecchi",
  "erotica",
  "fantasy",
  "gender-bender",
  "gore",
  "harem",
  "historical",
  "horror",
  "isekai",
  "josei",
  "loli",
  "manhua",
  "manhwa",
  "martial-arts",
  "mecha",
  "medical",
  "music",
  "mystery",
  "one-shot",
  "overpowered-mc",
  "psychological",
  "reincarnation",
  "romance",
  "school-life",
  "sci-fi",
  "seinen",
  "sexual-violence",
  "shota",
  "shoujo",
  "shoujo-ai",
  "shounen",
  "shounen-ai",
  "slice-of-life",
  "sports",
  "super-power",
  "supernatural",
  "survival",
  "time-travel",
  "tragedy",
  "webtoon",
  "yaoi",
  "yuri",
]);

// Accepts either the universal GUI label ("Martial Arts", "School") or a
// raw site slug ("martial-arts"); returns a slug or "" when unsupported.
function resolveGenreSlug(genre) {
  if (genre === undefined || genre === null) return "";
  const norm = String(genre).trim().toLowerCase().replace(/\s+/g, "-");
  if (!norm) return "";
  if (GENRE_SLUGS.has(norm)) return norm;
  // GUI label variants that differ from the site slug.
  if (norm === "school") return "school-life";
  return "";
}

// GUI Status dropdown sends airing|completed|upcoming; the site only
// marks items ongoing|completed. "upcoming" matches nothing here.
function resolveStatus(status) {
  if (status === undefined || status === null) return "";
  const s = String(status).trim().toLowerCase().replace(/_/g, "-");
  if (s === "airing" || s === "ongoing" || s === "currently-airing")
    return "ongoing";
  if (s === "completed" || s === "finished") return "completed";
  if (s === "upcoming" || s === "not-yet-published") return "upcoming";
  return "";
}

// Parses a search/latest results grid (div.item blocks) shared by the
// homepage and search results. Skips the "Hot updates"/"Hot Manga"
// sidebar widgets, which repeat the same item markup on every page.
// Items carry extra `status`/`genreSlugs` fields used for client-side
// filter matching; callers map down to the public shape when done.
function parseItems($, detailed = false) {
  const results = [];

  $("div.item[data-id]").each((_, el) => {
    if ($(el).closest("#hot_update, #hot_book").length) return;

    const a = $(el).find("a[href*='/manga/']").first();
    const href = a.attr("href");
    if (!href) return;

    const m = href.match(/\/manga\/([^/?#]+)/);
    if (!m) return;
    const id = m[1];
    if (!id) return;

    const image =
      $(el).find("picture source").attr("srcset") ||
      $(el).find("img").attr("src") ||
      null;

    const title = $(el).find("h3.title a").first().text().trim();

    if (title && !results.some((r) => r.id === id)) {
      const item = {
        id: id,
        title: title,
        image: image,
      };
      if (detailed) {
        const statusClass = $(el).find("div.status").attr("class") || "";
        const sm = statusClass.match(/\b(ongoing|completed)\b/);
        item.status = sm ? sm[1] : "";
        item.genreSlugs = [];
        $(el)
          .find("div.genres a[href*='/genre/']")
          .each((_, g) => {
            const gm = ($(g).attr("href") || "").match(/\/genre\/([^/?#]+)/);
            if (gm && !item.genreSlugs.includes(gm[1])) {
              item.genreSlugs.push(gm[1]);
            }
          });
      }
      results.push(item);
    }
  });

  return results;
}

// Applies Discover filters to already-parsed detailed items. Returns the
// filtered list; unknown/empty filter values are ignored gracefully.
function applyItemFilters(items, filters = {}) {
  const genreSlug = resolveGenreSlug(filters?.genre);
  const status = resolveStatus(filters?.status);
  if (!genreSlug && !status) return items;

  return items.filter((item) => {
    if (genreSlug && !item.genreSlugs.includes(genreSlug)) return false;
    if (status && item.status !== status) return false;
    return true;
  });
}

function toPublicItems(items) {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    image: item.image,
  }));
}

// Metadata rows on the info page: <div class="d-cell-small label">X:</div>
// <div class="d-cell-small value ...">Y</div>
function parseInfoRow($, label) {
  let value = "";
  $("div.d-cell-small.label").each((_, el) => {
    const text = $(el).text().trim();
    if (text.toLowerCase().startsWith(label.toLowerCase())) {
      value =
        $(el).next("div.d-cell-small").text().trim() ||
        $(el).parent().find("div.d-cell-small.value").text().trim();
    }
  });
  return value;
}

// Latest Manga. Genre filters browse the site's /genre/{slug} listing
// server-side (the homepage grid cannot be filtered server-side); status
// is always applied client-side from the per-item div.status class.
async function latestManga(page = 1, filters = {}) {
  try {
    const genreSlug = resolveGenreSlug(filters?.genre);
    const url = genreSlug
      ? page <= 1
        ? `${baseUrl}/genre/${genreSlug}`
        : `${baseUrl}/genre/${genreSlug}/page/${page}`
      : page <= 1
        ? `${baseUrl}/`
        : `${baseUrl}/page/${page}`;
    const data = await fetchHtml(url);
    const $ = cheerio.load(data);
    const results = applyItemFilters(parseItems($, true), filters);

    let totalPages = null;
    $("ul.uk-pagination a.page-numbers").each((_, el) => {
      const m = ($(el).attr("href") || "").match(/\/page\/(\d+)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (!totalPages || n > totalPages) totalPages = n;
      }
    });

    return {
      current_page: page,
      totalPages: totalPages,
      hasNextPage: totalPages ? page < totalPages : results.length > 0,
      results: toPublicItems(results),
    };
  } catch (err) {
    throw err;
  }
}

// Search Manga. The site's search is a single page and cannot be combined
// with a genre URL server-side, so genre/status filters are applied
// client-side to the returned items.
async function searchManga(query, page = 1, filters = {}) {
  try {
    if (!query) return latestManga(page, filters);

    // Server-side search, single page (no pagination on results).
    const data = await fetchHtml(
      `${baseUrl}/?search=${encodeURIComponent(query)}&search_by=m_name`,
    );
    const $ = cheerio.load(data);
    const results = applyItemFilters(parseItems($, true), filters);

    return {
      current_page: 1,
      hasNextPage: false,
      results: toPublicItems(results),
    };
  } catch (err) {
    throw err;
  }
}

async function fetchMangaInfo(mangaId) {
  try {
    const { data } = await global.axios.get(`${baseUrl}/manga/${mangaId}`);
    const $ = cheerio.load(data);

    const title = $("h1.heading").first().text().trim() || "";
    const image =
      $("meta[property='og:image']").attr("content") ||
      $("img[src*='/imgs/cover/']").first().attr("src") ||
      null;

    // No on-page synopsis container; the summary ships in og:description
    // as "Summary: ...&lt;br&gt;..." (entity-encoded HTML).
    const ogDesc = $("meta[property='og:description']").attr("content") || "";
    const description = ogDesc
      .replace(/^Summary:\s*/i, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .trim();

    // Genres only from the labeled info row (the nav menu and the
    // genre sidebar widget also link /genre/ but are not manga genres).
    const genres = [];
    $("div.d-cell-small.label").each((_, el) => {
      if (!$(el).text().trim().toLowerCase().startsWith("genres")) return;
      $(el)
        .next("div.d-cell-small")
        .find("a[href*='/genre/']")
        .each((_, g) => {
          const genre = $(g).text().trim();
          if (genre && !genres.includes(genre)) genres.push(genre);
        });
    });

    const status = parseInfoRow($, "Status") || "Ongoing";
    const author = parseInfoRow($, "Author");
    const altNames = parseInfoRow($, "Alt name");

    return {
      id: mangaId,
      title,
      image,
      description,
      genres,
      author,
      altNames,
      type: "",
      released: "",
      year: null,
      status,
    };
  } catch (err) {
    throw err;
  }
}

async function fetchChapters(mangaId) {
  try {
    const { data } = await global.axios.get(`${baseUrl}/manga/${mangaId}`);
    const $ = cheerio.load(data);
    const chapters = [];

    // Related-manga widgets reuse the same chapter markup with links to
    // OTHER series; only accept chapters whose URL carries this manga's id.
    $("div.chapters a[href*='/manga/']").each((_, el) => {
      const href = $(el).attr("href");
      if (!href) return;
      if (!href.includes(`/${mangaId}/`)) return;

      // Full URL -> path after the domain (site always links absolute).
      let chapId = href.replace(/^https?:\/\/[^/]+/, "").replace(/^\//, "");
      if (!chapId) return;

      const text = $(el).text().trim();
      const numMatch =
        text.match(/chapter\s*([\d.]+)/i) || href.match(/\/c([\d.]+)(?:\/|$)/i);
      const number = numMatch ? parseFloat(numMatch[1]) : 0;

      if (!chapters.some((c) => c.id === chapId)) {
        chapters.push({
          id: chapId,
          number: number,
        });
      }
    });

    return {
      TotalPages: 1,
      total: chapters.length,
      Chapters: chapters,
    };
  } catch (err) {
    return {
      TotalPages: 0,
      total: 0,
      Chapters: [],
    };
  }
}

async function fetchChapterPages(chapterId) {
  try {
    let url = chapterId.startsWith("http")
      ? chapterId
      : `${baseUrl}/${chapterId}`;

    const { data } = await global.axios.get(url);
    const pages = [];

    // Reader images live in JS arrays inside <script> blocks:
    //   var thzq=['https://i1.mangakatana.com/token/.../0.jpg', ...]
    // The <img data-src="#"> placeholders are empty by design.
    const scriptRe = /var\s+[a-zA-Z_$][\w$]*\s*=\s*\[([\s\S]*?)\]/g;
    let m;
    while ((m = scriptRe.exec(data)) !== null) {
      const arr = m[1];
      const urlRe =
        /'(https:\/\/i\d+\.mangakatana\.com\/token\/[^']+\/\d+\.jpg)'/g;
      let u;
      while ((u = urlRe.exec(arr)) !== null) {
        const img = u[1];
        if (!pages.some((p) => p.img === img)) {
          pages.push({
            page: 0,
            img: img,
          });
        }
      }
    }

    // Arrays may arrive out of order (a one-element prefetch array comes
    // first); sort by the trailing /N.jpg index.
    pages.sort((a, b) => {
      const na = parseInt(a.img.match(/\/(\d+)\.jpg$/)[1], 10);
      const nb = parseInt(b.img.match(/\/(\d+)\.jpg$/)[1], 10);
      return na - nb;
    });
    pages.forEach((p, i) => {
      p.page = i + 1;
    });

    return pages;
  } catch (err) {
    return [];
  }
}

module.exports = {
  name: "mangakatana",
  version: "1.1.0",
  baseUrl,
  headerRules: [
    {
      match: ["mangakatana"],
      headers: { Referer: "https://mangakatana.com/" },
    },
  ],
  bypassDomains: ["mangakatana"],
  latestManga,
  searchManga,
  fetchMangaInfo,
  fetchChapters,
  fetchChapterPages,
};
