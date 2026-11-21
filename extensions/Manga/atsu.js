/**
 * StrawVerse Extension - Atu Moe Scraper
 * JSON catalogue, metadata, chapter list, and reader API.
 */
const axios = global.axios || require("axios");

const baseUrl = "https://atsu.moe";
const cdnUrl = "https://cdn.atsu.moe";
const PAGE_SIZE = 20;

function parseData(data) {
  if (data && typeof data === "object") return data;
  return JSON.parse(String(data));
}

function assetUrl(path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  const rel = path.startsWith("/") ? path : `/${path}`;
  // Catalogue rows carry /static/posters/... but the detail page's poster
  // fields omit the /static segment the CDN requires (posters/x -> 404).
  return `${cdnUrl}${rel.startsWith("/static/") ? rel : `/static${rel}`}`;
}

function parseEmbeddedJson(html, variable) {
  const marker = `window.${variable}`;
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Missing ${variable} data`);

  const start = html.indexOf("{", markerIndex + marker.length);
  if (start < 0) throw new Error(`Invalid ${variable} data`);

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      return JSON.parse(html.slice(start, i + 1));
    }
  }

  throw new Error(`Invalid ${variable} data`);
}

async function fetchDocuments(query, page, latest) {
  const params = {
    q: latest ? "*" : String(query || "").trim(),
    query_by: "title,otherNames,authors",
    filter_by: "isAdult:=false",
    page: Math.max(1, Number(page || 1)),
    per_page: PAGE_SIZE,
  };
  if (latest) params.sort_by = "trending:desc";

  const { data } = await axios.get(
    `${baseUrl}/collections/manga/documents/search`,
    { params },
  );
  return parseData(data);
}

function mapDocument(document) {
  if (!document?.id || !document?.title) return null;
  return {
    id: String(document.id),
    title: String(document.title),
    image: assetUrl(document.posterMedium || document.poster || document.posterSmall),
  };
}

async function latestManga(page = 1, filters = {}) {
  const data = await fetchDocuments("", page, true);
  const totalPages = Math.max(
    1,
    Math.ceil(Number(data.found || 0) / PAGE_SIZE),
  );
  const currentPage = Number(data.page || page || 1);

  return {
    current_page: currentPage,
    currentPage,
    totalPages,
    hasNextPage: currentPage < totalPages,
    results: (data.hits || [])
      .map((hit) => mapDocument(hit.document))
      .filter(Boolean),
  };
}

async function searchManga(query, page = 1, filters = {}) {
  if (!String(query || "").trim()) return latestManga(page, filters);

  const data = await fetchDocuments(query, page, false);
  const totalPages = Math.max(
    1,
    Math.ceil(Number(data.found || 0) / PAGE_SIZE),
  );
  const currentPage = Number(data.page || page || 1);

  return {
    current_page: currentPage,
    currentPage,
    totalPages,
    hasNextPage: currentPage < totalPages,
    results: (data.hits || [])
      .map((hit) => mapDocument(hit.document))
      .filter(Boolean),
  };
}

async function fetchMangaInfo(mangaId) {
  const { data: html } = await axios.get(`${baseUrl}/manga/${mangaId}`);
  const embedded = parseEmbeddedJson(String(html), "mangaPage");
  const manga = embedded.mangaPage || embedded;

  const poster = manga.poster || {};
  const released = Number(manga.released || 0);
  const authors = (manga.authors || [])
    .map((author) => author.name)
    .filter(Boolean);

  return {
    id: mangaId,
    title: manga.title || mangaId,
    image: assetUrl(poster.largeImage || poster.image || poster.mediumImage),
    description: manga.synopsis || "",
    genres: (manga.genres || []).map((genre) => genre.name).filter(Boolean),
    author: authors.join(", "),
    altNames: (manga.otherNames || []).join(", "),
    type: manga.type || manga.medium || "Manga",
    released: released || null,
    year: released ? new Date(released).getUTCFullYear() : null,
    status: manga.status || "Unknown",
  };
}

async function fetchChapters(mangaId) {
  try {
    const { data } = await axios.get(
      `${baseUrl}/api/manga/allChapters`,
      { params: { mangaId } },
    );
    const chapters = (parseData(data).chapters || [])
      .filter((chapter) => chapter?.id)
      .map((chapter) => ({
        id: `${mangaId}::${chapter.id}`,
        number: Number(chapter.number || 0),
        title: chapter.title || `Chapter ${chapter.number || ""}`.trim(),
      }));

    return { TotalPages: 1, total: chapters.length, Chapters: chapters };
  } catch (_) {
    return { TotalPages: 0, total: 0, Chapters: [] };
  }
}

async function fetchChapterPages(chapterId) {
  const [mangaId, id] = String(chapterId).split("::");
  if (!mangaId || !id) return [];

  const { data } = await axios.get(`${baseUrl}/api/read/chapter`, {
    params: { mangaId, chapterId: id },
  });
  const payload = parseData(data);
  const pages = payload.readChapter?.pages || payload.pages || [];

  return pages.map((page, index) => ({
    page: Number(page.number ?? index) + 1,
    img: assetUrl(page.image),
  }));
}

module.exports = {
  name: "atsu",
  version: "1.0.1",
  baseUrl,
  headerRules: [
    {
      match: ["atsu.moe", "cdn.atsu.moe"],
      headers: { Referer: `${baseUrl}/` },
    },
  ],
  latestManga,
  searchManga,
  fetchMangaInfo,
  fetchChapters,
  fetchChapterPages,
};
