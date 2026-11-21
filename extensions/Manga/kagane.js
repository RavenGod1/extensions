/**
 * StrawVerse Extension - Kagane Scraper
 * Uses Kagane's v2 JSON API and its integrity-token reader flow.
 */
const axios = global.axios || require("axios");

const baseUrl = "https://kagane.moe";
const apiUrl = `${baseUrl}/api/v2`;
const PAGE_SIZE = 35;
let integrityToken = null;
let integrityExpiresAt = 0;

function parseData(data) {
  if (data && typeof data === "object") return data;
  return JSON.parse(String(data));
}

function coverUrl(imageId) {
  return imageId ? `${apiUrl}/image/${encodeURIComponent(imageId)}` : null;
}

async function searchSeries(query, page, latest) {
  const body = {
    source_type: ["Official", "Unofficial", "Mixed"],
    content_lang: ["en"],
  };
  if (query) body.title = String(query).trim();

  const params = {
    page: Math.max(0, Number(page || 1) - 1),
    size: PAGE_SIZE,
  };
  if (latest) params.sort = "updated_at,desc";

  const { data } = await axios.post(`${apiUrl}/search/series`, body, { params });
  return parseData(data);
}

function mapSeries(series) {
  if (!series?.series_id || !series?.title) return null;
  return {
    id: String(series.series_id),
    title: String(series.title),
    image: coverUrl(series.cover_image_id),
  };
}

async function latestManga(page = 1, filters = {}) {
  const data = await searchSeries("", page, true);
  const currentPage = Number(data.page ?? Math.max(0, Number(page || 1) - 1));
  const totalPages = Math.max(1, Number(data.total_pages || 1));

  return {
    current_page: currentPage + 1,
    currentPage: currentPage + 1,
    totalPages,
    hasNextPage: currentPage + 1 < totalPages,
    results: (data.content || []).map(mapSeries).filter(Boolean),
  };
}

async function searchManga(query, page = 1, filters = {}) {
  const data = await searchSeries(query, page, false);
  const currentPage = Number(data.page ?? Math.max(0, Number(page || 1) - 1));
  const totalPages = Math.max(1, Number(data.total_pages || 1));

  return {
    current_page: currentPage + 1,
    currentPage: currentPage + 1,
    totalPages,
    hasNextPage: currentPage + 1 < totalPages,
    results: (data.content || []).map(mapSeries).filter(Boolean),
  };
}

async function fetchMangaInfo(mangaId) {
  const { data } = await axios.get(`${apiUrl}/series/${mangaId}`);
  const manga = parseData(data);
  const cover =
    (manga.series_covers || []).find((item) => item.is_main) || {};
  const staff = (manga.series_staff || [])
    .map((person) => person.name)
    .filter(Boolean);

  return {
    id: mangaId,
    title: manga.title || mangaId,
    image: coverUrl(cover.image_id || manga.main_cover_id),
    description: manga.description || "",
    genres: (manga.genres || []).map((genre) => genre.genre_name).filter(Boolean),
    author: staff.join(", ") || manga.owner_group_name || "",
    altNames: (manga.series_alternate_titles || [])
      .map((title) => title.title)
      .filter(Boolean)
      .join(", "),
    type: manga.format || "Manga",
    released: manga.start_year || null,
    year: manga.start_year || null,
    status: manga.publication_status || manga.upload_status || "Unknown",
  };
}

async function fetchChapters(mangaId) {
  try {
    const { data } = await axios.get(
      `${apiUrl}/series/${mangaId}/books/index`,
      { params: { fields: "List" } },
    );
    const payload = parseData(data);
    const fields = payload.fields || [];
    const indexes = Object.fromEntries(
      fields.map((field, index) => [field, index]),
    );

    const chapters = (payload.books || [])
      .map((row) => {
        const id = row[indexes.book_id];
        if (!id) return null;
        const number = Number(
          row[indexes.chapter_no] ?? row[indexes.sort_no] ?? 0,
        );
        const title = row[indexes.title] || `Chapter ${number || ""}`.trim();
        return { id: String(id), number, title };
      })
      .filter(Boolean);

    return { TotalPages: 1, total: chapters.length, Chapters: chapters };
  } catch (_) {
    return { TotalPages: 0, total: 0, Chapters: [] };
  }
}

async function getIntegrityToken() {
  const now = Math.floor(Date.now() / 1000);
  if (integrityToken && integrityExpiresAt > now) return integrityToken;

  const { data } = await axios.post(`${baseUrl}/api/integrity`, "");
  const payload = parseData(data);
  if (!payload.token) throw new Error("Kagane integrity token missing");

  integrityToken = String(payload.token);
  integrityExpiresAt = Number(payload.exp || 0);
  return integrityToken;
}

async function fetchChapterPages(chapterId) {
  const token = await getIntegrityToken();
  const { data } = await axios.post(
    `${apiUrl}/books/${encodeURIComponent(chapterId)}?intent=Read`,
    "",
    { headers: { "X-Integrity-Token": token } },
  );
  const payload = parseData(data);
  const cacheUrl = String(payload.cache_url || "https://kstatic.to").replace(
    /\/$/,
    "",
  );
  const accessToken = String(payload.access_token || "");
  const pages = payload.manifest?.pages || [];

  return pages.map((page, index) => ({
    page: Number(page.page_no ?? index + 1),
    img: `${cacheUrl}/api/v2/books/page/original/${encodeURIComponent(
      chapterId,
    )}/${encodeURIComponent(page.page_id)}.${page.ext || "jxl"}?token=${encodeURIComponent(
      accessToken,
    )}`,
  }));
}

module.exports = {
  name: "kagane",
  version: "1.0.0",
  baseUrl,
  headerRules: [
    {
      match: ["kagane.moe", "kstatic.to"],
      headers: {
        Referer: `${baseUrl}/`,
        Origin: baseUrl,
      },
    },
  ],
  bypassDomains: ["kagane.moe"],
  cookieDomains: ["kagane.moe"],
  latestManga,
  searchManga,
  fetchMangaInfo,
  fetchChapters,
  fetchChapterPages,
};
