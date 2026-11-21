/**
 * StrawVerse Extension - Atu Moe Scraper
 * JSON catalogue, metadata, chapter list, and reader API.
 */
const axios = global.axios || require("axios");

const baseUrl = "https://atsu.moe";
const cdnUrl = "https://cdn.atsu.moe";
const PAGE_SIZE = 20;

function chapterPreference(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim().toLowerCase();
  if (typeof value === "object") {
    return String(
      value.id || value.name || value.scanlationMangaId || "",
    )
      .trim()
      .toLowerCase();
  }
  return "";
}

function selectChapterRows(chapters, metadata = {}) {
  const manga = metadata?.mangaPage || metadata || {};
  const scanlators = new Map(
    (manga.scanlators || []).map((scanlator) => [
      String(scanlator.id || ""),
      {
        name: String(scanlator.name || "").toLowerCase(),
        score: Number(scanlator.score || 0),
      },
    ]),
  );
  const preferred = chapterPreference(manga.sourcePreference);
  const selected = new Map();

  for (const chapter of chapters || []) {
    if (!chapter?.id) continue;
    const number = Number(chapter.number);
    const title = String(chapter.title || "").trim();
    const key = Number.isFinite(number) && number > 0 ? String(number) : title;
    if (!key) continue;

    const scanlator = scanlators.get(String(chapter.scanlationMangaId || ""));
    const isPreferred = preferred
      ? String(chapter.scanlationMangaId || "").toLowerCase() === preferred ||
        scanlator?.name === preferred
      : false;
    const candidate = {
      chapter,
      number: Number.isFinite(number) ? number : 0,
      isPreferred,
      score: scanlator?.score ?? 0,
      createdAt: Number(chapter.createdAt || 0),
    };
    const current = selected.get(key);
    if (
      !current ||
      Number(candidate.isPreferred) > Number(current.isPreferred) ||
      (candidate.isPreferred === current.isPreferred &&
        (candidate.score > current.score ||
          (candidate.score === current.score &&
            candidate.createdAt > current.createdAt)))
    ) {
      selected.set(key, candidate);
    }
  }

  return [...selected.values()]
    .sort((a, b) => b.number - a.number)
    .map(({ chapter, number }) => ({
      id: String(chapter.id),
      number,
      title: number > 0 ? `Chapter ${number}` : String(chapter.title || "Special"),
    }));
}

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
    const [chapterResponse, metadataResponse] = await Promise.all([
      axios.get(`${baseUrl}/api/manga/allChapters`, {
        params: { mangaId },
      }),
      axios.get(`${baseUrl}/api/manga/page`, {
        params: { id: mangaId },
      }).catch(() => ({ data: {} })),
    ]);
    const rows = parseData(chapterResponse.data).chapters || [];
    const metadata = parseData(metadataResponse.data);
    const chapters = selectChapterRows(rows, metadata).map((chapter) => ({
      id: `${mangaId}::${chapter.id}`,
      number: chapter.number,
      title: chapter.title,
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
  version: "1.0.2",
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
