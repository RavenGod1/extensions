/**
 * StrawVerse Extension - NovelPing Scraper
 * NovelPing is a prose source; chapters are rendered as self-contained SVG pages.
 */
const axios = global.axios || require("axios");

const baseUrl = "https://novelping.com";
const SVG_LINES_PER_PAGE = 42;
const SVG_LINE_CHARS = 72;

function decodeEntities(text) {
  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return String(text || "").replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (entity, code) => {
      const lower = code.toLowerCase();
      if (lower.startsWith("#x")) {
        const value = parseInt(lower.slice(2), 16);
        return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
      }
      if (lower.startsWith("#")) {
        const value = parseInt(lower.slice(1), 10);
        return Number.isFinite(value) ? String.fromCodePoint(value) : entity;
      }
      return named[lower] ?? entity;
    },
  );
}

function stripTags(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function collapseText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function parseAttributes(tag) {
  const attributes = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(tag)) !== null) {
    attributes[match[1].toLowerCase()] = decodeEntities(
      match[2] ?? match[3] ?? "",
    );
  }
  return attributes;
}

function metaContent(html, key) {
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    if (
      String(attributes.property || "").toLowerCase() === key.toLowerCase() ||
      String(attributes.name || "").toLowerCase() === key.toLowerCase()
    ) {
      return attributes.content || "";
    }
  }
  return "";
}

function parseNovelRows(html) {
  const source = String(html || "");
  const results = [];
  const seen = new Set();
  const pattern =
    /<h3\b[^>]*class=["'][^"']*\bnovel-title\b[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*href=["'](https?:\/\/novelping\.com\/book\/([a-z0-9][a-z0-9-]*))["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;

  for (const match of source.matchAll(pattern)) {
    const slug = match[2];
    if (!slug || seen.has(slug)) continue;

    const before = source.slice(Math.max(0, match.index - 1500), match.index);
    const images = before.match(/<img\b[^>]*>/gi) || [];
    const imageAttributes = images.length
      ? parseAttributes(images[images.length - 1])
      : {};

    const title = collapseText(stripTags(match[3]));
    if (!title) continue;

    // The listing serves novel_200_89/<slug>.jpg — a 200x89 banner that
    // smears across the portrait card. novel_328_490 is the real cover
    // (328x490, present for every slug tested).
    const rawImage = imageAttributes.src || null;
    const image = rawImage
      ? rawImage.replace("/novel_200_89/", "/novel_328_490/")
      : null;

    seen.add(slug);
    results.push({
      id: slug,
      title,
      image,
    });
  }

  return results;
}

function pagination(html, page) {
  // Pagination hrefs arrive entity-encoded (page&#x3D;2, keyword&#x3D;x&amp;page&#x3D;2),
  // so the literal "page=" never matches unless we decode first.
  const decoded = String(html)
    .replace(/&#x3D;/gi, "=")
    .replace(/&#0*61;/g, "=")
    .replace(/&amp;/gi, "&")
    .replace(/&#0*38;/g, "&");
  let totalPages = 1;
  for (const match of decoded.matchAll(/[?&]page=(\d+)/g)) {
    totalPages = Math.max(totalPages, Number(match[1]));
  }
  const currentPage = Math.max(1, Number(page || 1));
  return {
    current_page: currentPage,
    currentPage,
    totalPages,
    hasNextPage: currentPage < totalPages,
  };
}

async function latestManga(page = 1, filters = {}) {
  const currentPage = Math.max(1, Number(page || 1));
  const { data: html } = await axios.get(`${baseUrl}/sort/updates`, {
    params: { page: currentPage },
  });
  return {
    ...pagination(html, currentPage),
    results: parseNovelRows(html),
  };
}

async function searchManga(query, page = 1, filters = {}) {
  if (!String(query || "").trim()) return latestManga(page, filters);

  const currentPage = Math.max(1, Number(page || 1));
  const { data: html } = await axios.get(`${baseUrl}/search`, {
    params: { keyword: String(query).trim(), page: currentPage },
  });
  return {
    ...pagination(html, currentPage),
    results: parseNovelRows(html),
  };
}

async function fetchMangaInfo(mangaId) {
  const { data: html } = await axios.get(`${baseUrl}/book/${mangaId}`);
  const source = String(html);
  const descriptionMatch = source.match(
    /<div\b[^>]*id=["']novel-description-content["'][^>]*>([\s\S]*?)<\/div>/i,
  );
  const yearMatch = source.match(
    /Year of publishing:[\s\S]{0,300}?(\d{4})/i,
  );
  const status = metaContent(source, "og:novel:status");
  const genres = metaContent(source, "og:novel:genre")
    .split(",")
    .map((genre) => collapseText(genre))
    .filter(Boolean);

  return {
    id: mangaId,
    title: collapseText(metaContent(source, "og:title")).replace(
      /\s*\|\s*NovelPing\s*$/i,
      "",
    ),
    image: metaContent(source, "og:image") || null,
    description: descriptionMatch
      ? stripTags(descriptionMatch[1])
      : metaContent(source, "description"),
    genres,
    author: collapseText(metaContent(source, "og:novel:author")),
    altNames: "",
    type: "Novel",
    released: yearMatch ? Number(yearMatch[1]) : null,
    year: yearMatch ? Number(yearMatch[1]) : null,
    status: status
      ? status.replace(/ing$/i, "ing").replace(/^OnGoing$/i, "Ongoing")
      : "Unknown",
  };
}

async function fetchChapters(mangaId) {
  try {
    const { data: html } = await axios.get(
      `${baseUrl}/ajax/chapter-archive`,
      { params: { novelId: mangaId } },
    );
    const source = String(html);
    const chapters = [];
    const seen = new Set();

    for (const match of source.matchAll(
      /<li\b[^>]*data-chapter-id=["']([^"']+)["'][^>]*>([\s\S]*?)<\/li>/gi,
    )) {
      const chapterSlug = match[1];
      const block = match[2];
      const hrefMatch = block.match(
        /<a\b[^>]*href=["']([^"']*\/book\/[^"']+\/[^"']+)["']/i,
      );
      if (!chapterSlug || seen.has(chapterSlug)) continue;

      const titleMatch = block.match(
        /<span\b[^>]*class=["'][^"']*\bchapter-title\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
      );
      const title = collapseText(stripTags(titleMatch?.[1] || chapterSlug));
      const numberMatch = title.match(/\bchapter\s*(\d+(?:\.\d+)?)/i);
      const id = hrefMatch
        ? new URL(decodeEntities(hrefMatch[1]), baseUrl).href
        : `${baseUrl}/book/${mangaId}/${chapterSlug}`;

      seen.add(chapterSlug);
      chapters.push({
        id,
        number: numberMatch ? Number(numberMatch[1]) : 0,
        title,
      });
    }

    return { TotalPages: 1, total: chapters.length, Chapters: chapters };
  } catch (_) {
    return { TotalPages: 0, total: 0, Chapters: [] };
  }
}

function wrapParagraph(text) {
  const words = collapseText(text).split(" ").filter(Boolean);
  const lines = [];
  let line = "";

  for (const word of words) {
    if (!line) {
      line = word;
    } else if (`${line} ${word}`.length <= SVG_LINE_CHARS) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }

    while (line.length > SVG_LINE_CHARS) {
      lines.push(line.slice(0, SVG_LINE_CHARS));
      line = line.slice(SVG_LINE_CHARS);
    }
  }

  if (line) lines.push(line);
  return lines;
}

function escapeXml(text) {
  return String(text || "")
    .replace(/&/g, "&#38;")
    .replace(/</g, "&#60;")
    .replace(/>/g, "&#62;")
    .replace(/"/g, "&#34;")
    .replace(/'/g, "'");
}

function renderSvgPage(lines) {
  const height = Math.max(120, 64 + lines.length * 30 + 40);
  const spans = lines
    .map(
      (line, index) =>
        `<text x="56" y="${64 + index * 30}" fill="#111827" font-family="Arial, sans-serif" font-size="20">${escapeXml(
          line,
        )}</text>`,
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}"><rect width="900" height="${height}" fill="#ffffff"/>${spans}</svg>`;
}

async function fetchChapterPages(chapterId) {
  const url = String(chapterId).startsWith("http")
    ? String(chapterId)
    : `${baseUrl}/book/${chapterId}`;
  const { data: html } = await axios.get(url);
  const source = String(html);
  const startMatch = source.match(
    /<div\b[^>]*id=["']chr-content["'][^>]*>/i,
  );
  if (!startMatch) return [];

  const start = startMatch.index + startMatch[0].length;
  const end = source.indexOf('<hr class="chr-end"', start);
  const content = source.slice(start, end > start ? end : undefined);
  const paragraphs = [...content.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => stripTags(match[1]))
    .filter(Boolean);

  const lines = [];
  for (const paragraph of paragraphs.length ? paragraphs : [stripTags(content)]) {
    if (!paragraph) continue;
    if (lines.length) lines.push("");
    lines.push(...wrapParagraph(paragraph));
  }

  const pages = [];
  for (let offset = 0; offset < lines.length; offset += SVG_LINES_PER_PAGE) {
    const pageLines = lines.slice(offset, offset + SVG_LINES_PER_PAGE);
    const svg = renderSvgPage(pageLines);
    pages.push({
      page: pages.length + 1,
      img: `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString(
        "base64",
      )}`,
    });
  }

  return pages;
}

module.exports = {
  name: "novelping",
  version: "1.0.2",
  baseUrl,
  headerRules: [
    {
      match: ["novelping.com"],
      headers: { Referer: `${baseUrl}/` },
    },
  ],
  latestManga,
  searchManga,
  fetchMangaInfo,
  fetchChapters,
  fetchChapterPages,
};
