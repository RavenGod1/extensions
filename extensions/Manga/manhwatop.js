/**
 * StrawVerse Extension - ManhwaTop Scraper
 * Cloudflare-gated WordPress "Madara" manga site.
 */
const cheerio = require("cheerio");

const baseUrl = "https://manhwatop.com";
const imageCdn = "https://c4.manhwatop.com";
const mobileUserAgent =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/138.0.0.0 Mobile Safari/537.36";
const retryDelays = [400, 1000];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(method, url, data = null, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    const config = {
      ...options,
      timeout: options.timeout || 15000,
      skipBypass: true,
      validateStatus: () => true,
      headers: {
        "User-Agent": mobileUserAgent,
        ...(options.headers || {}),
      },
    };
    try {
      const response =
        method === "post"
          ? await global.axios.post(url, data, config)
          : await global.axios.get(url, config);
      if (response.status >= 200 && response.status < 300) return response;
      lastError = new Error(`ManhwaTop request failed (${response.status})`);
      lastError.response = response;
    } catch (err) {
      lastError = err;
    }

    const status =
      lastError?.response?.status || lastError?.response?.statusCode || 0;
    if (
      attempt >= retryDelays.length ||
      ![403, 429, 500, 502, 503, 504].includes(status)
    ) {
      throw lastError;
    }
    await wait(retryDelays[attempt]);
  }
  throw lastError;
}

// WordPress serves a size-suffixed thumbnail in the markup
// (.../Mood-Disorder-cover-175x238.jpg). Dropping the -WxH suffix
// yields the full-size original, which is what keeps covers sharp.
function fullSizeImage(url) {
  if (!url) return null;
  return url.replace(/-\d+x\d+(\.\w+)$/, "$1");
}

async function fetchHtml(url, options = {}) {
  const { data } = await request("get", url, null, options);
  return typeof data === "string" ? data : String(data || "");
}

// The summary table labels each row in .summary-heading and holds the
// value in .summary-content ("Author(s)", "Genre(s)", "Status", ...).
function summaryRow($, label) {
  let value = "";
  $("div.summary_content div.post-content_item").each((_, el) => {
    const row = $(el);
    const key = row
      .find(".summary-heading .h5")
      .first()
      .text()
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\(s\)$/i, "")
      .trim();
    if (key.toLowerCase() === label.toLowerCase()) {
      value = row.find(".summary-content").first().text().replace(/\s+/g, " ").trim();
    }
  });
  return value;
}

// Listing cards (div.page-item-detail) and search cards
// (div.c-tabs-item > div.tab-thumb) use different markup, so both
// container shapes are scanned for the same fields.
function parseCards($) {
  const results = [];
  const seen = new Set();

  const push = (id, title, image) => {
    if (!id || !title || seen.has(id)) return;
    seen.add(id);
    results.push({ id, title, image: fullSizeImage(image) });
  };

  $("div.page-item-detail").each((_, el) => {
    const card = $(el);
    const link = card.find("a[href*='/manga/']").first();
    const href = link.attr("href") || "";
    const m = href.match(/\/manga\/([a-z0-9-]+)\/?$/i);
    if (!m) return;
    const title = card.find("h3.h5 a").first().text().trim() || link.attr("title") || "";
    const image = card.find("img[data-src]").first().attr("data-src") || null;
    push(m[1], title, image);
  });

  $("div.tab-thumb").each((_, el) => {
    const card = $(el);
    const link = card.find("a[href*='/manga/']").first();
    const href = link.attr("href") || "";
    const m = href.match(/\/manga\/([a-z0-9-]+)\/?$/i);
    if (!m) return;
    const title = link.attr("title") || card.find("img").first().attr("alt") || "";
    const image = card.find("img[data-src]").first().attr("data-src") || null;
    push(m[1], title.trim(), image);
  });

  return results;
}

async function latestManga(page = 1, filters = {}) {
  // m_orderby=latest gives a stable, non-overlapping order. The default
  // order repeats the last 4 cards of page N at the top of page N+1.
  const url = `${baseUrl}/manga/page/${page}/?m_orderby=latest`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const results = parseCards($);

  return {
    current_page: page,
    currentPage: page,
    totalPages: null,
    hasNextPage: results.length > 0,
    results,
  };
}

async function searchManga(query, page = 1, filters = {}) {
  if (!query) return latestManga(page, filters);

  // The server-rendered search page is challenged by Cloudflare. Madara's
  // AJAX search endpoint returns the matching manga slugs directly.
  const body = new URLSearchParams({
    action: "wp-manga-search-manga",
    title: String(query).trim(),
  }).toString();
  const { data } = await request("post", `${baseUrl}/wp-admin/admin-ajax.php`, body, {
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
  });
  const payload = typeof data === "string" ? JSON.parse(data) : data;
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const seen = new Set();
  const results = [];
  for (const row of rows) {
    const match = String(row?.url || "").match(/\/manga\/([a-z0-9-]+)\/?$/i);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    results.push({
      id: match[1],
      title: String(row.title || match[1]).trim(),
      image: null,
    });
  }

  return {
    current_page: 1,
    currentPage: 1,
    totalPages: 1,
    hasNextPage: false,
    results,
  };
}

function parseSummaryRow($, label) {
  return summaryRow($, label);
}

async function fetchMangaInfo(mangaId) {
  const html = await fetchHtml(`${baseUrl}/manga/${mangaId}/`);
  const $ = cheerio.load(html);

  const title = $("h1").first().text().trim() || mangaId;
  const image =
    $("meta[property='og:image']").attr("content") ||
    $("div.summary_content img[data-src]").first().attr("data-src") ||
    null;

  // The synopsis lives in its own block, below the summary table.
  const description = $("div.description-summary .summary__content")
    .first()
    .text()
    .replace(/\s+/g, " ")
    .trim();

  const genreText = parseSummaryRow($, "Genre");
  const genres = genreText
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);

  const author = parseSummaryRow($, "Author");
  const artist = parseSummaryRow($, "Artist");
  const alternative = parseSummaryRow($, "Alternative");
  const type = parseSummaryRow($, "Type");
  const release = parseSummaryRow($, "Release");
  const status = parseSummaryRow($, "Status");

  const authors = [];
  for (const name of [author, artist]) {
    if (name && !authors.includes(name)) authors.push(name);
  }

  return {
    id: mangaId,
    title,
    image: fullSizeImage(image),
    description,
    genres,
    author: authors.join(", "),
    altNames: alternative,
    type,
    released: release || null,
    year: (release || "").match(/\d{4}/)?.[0] || null,
    status,
  };
}

async function fetchChapters(mangaId) {
  try {
    // The chapter list is not in the detail HTML; it is AJAX-loaded
    // from this endpoint (slug identifies the manga, no body needed).
    const { data } = await request(
      "post",
      `${baseUrl}/manga/${mangaId}/ajax/chapters/`,
      "",
      { headers: { "X-Requested-With": "XMLHttpRequest" } },
    );
    const html = typeof data === "string" ? data : String(data || "");
    const $ = cheerio.load(html);

    const chapters = [];
    $("li.wp-manga-chapter").each((_, el) => {
      const link = $(el).find("a[href*='/chapter-']").first();
      const href = link.attr("href") || "";
      const m = href.match(/\/chapter-([\d.]+)\/?$/i);
      if (!m) return;

      const id = href.replace(/^https?:\/\/[^/]+/, "");
      const number = parseFloat(m[1]) || 0;
      const text = link.text().trim();
      const title =
        text && !/^chapter\s*[\d.]*$/i.test(text)
          ? text
          : `Chapter ${number}`;

      if (!chapters.some((c) => c.id === id)) {
        chapters.push({ id, number, title });
      }
    });

    chapters.sort((a, b) => b.number - a.number);

    return {
      TotalPages: 1,
      total: chapters.length,
      Chapters: chapters,
    };
  } catch (_) {
    return { TotalPages: 0, total: 0, Chapters: [] };
  }
}

async function fetchChapterPages(chapterId) {
  try {
    const url = chapterId.startsWith("http")
      ? chapterId
      : `${baseUrl}/${chapterId}`;
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);

    const pages = [];
    $("img.wp-manga-chapter-img").each((_, el) => {
      const img =
        $(el).attr("data-src") || $(el).attr("data-lazy-src") || $(el).attr("src");
      if (!img || /loading6\.svg|dflazy/i.test(img)) return;
      if (!/^https?:\/\//i.test(img)) return;
      if (pages.some((p) => p.img === img)) return;
      pages.push({ page: 0, img });
    });

    pages.forEach((p, i) => {
      p.page = i + 1;
    });
    return pages;
  } catch (_) {
    return [];
  }
}

module.exports = {
  name: "manhwatop",
  version: "1.0.1",
  baseUrl,
  headerRules: [
    {
      match: ["manhwatop.com", "c4.manhwatop.com"],
      headers: { Referer: `${baseUrl}/`, "User-Agent": mobileUserAgent },
    },
  ],
  bypassDomains: ["manhwatop.com", "c4.manhwatop.com"],
  cookieDomains: ["manhwatop.com", "c4.manhwatop.com"],
  latestManga,
  searchManga,
  fetchMangaInfo,
  fetchChapters,
  fetchChapterPages,
};
