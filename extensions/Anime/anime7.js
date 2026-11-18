/**
 * StrawVerse Extension - Anime7 (anime7.download)
 * Catalogue via the WordPress REST API; streams via the site's mirror
 * pages (vidara.so file API).
 */
const cheerio = require("cheerio");
const axios = global.axios || require("axios");

const baseUrl = "https://anime7.download";
const apiUrl = `${baseUrl}/wp-json/wp/v2/posts`;
const perPage = 20;
const totals = new Map();

function headerValue(res, name) {
  const headers = res && res.headers;
  if (!headers) return null;
  const key = name.toLowerCase();
  if (typeof headers.get === "function") {
    const value = headers.get(key);
    if (value !== null && value !== undefined) return value;
  }
  if (headers[key] !== undefined) return headers[key];
  if (headers[name] !== undefined) return headers[name];
  for (const k of Object.keys(headers)) if (k.toLowerCase() === key) return headers[k];
  return null;
}

function stripHtml(html) {
  if (!html) return "";
  return cheerio.load(`<div>${html}</div>`)("div").first().text().replace(/\s+/g, " ").trim();
}

function postTerms(post) {
  const cats = [];
  const tags = [];
  for (const group of (post._embedded && post._embedded["wp:term"]) || []) {
    for (const term of group) {
      if (term.taxonomy === "post_tag") tags.push(term.name);
      else cats.push(term.name);
    }
  }
  return { cats, tags };
}

function poster(post) {
  const media =
    (post._embedded && post._embedded["wp:featuredmedia"] && post._embedded["wp:featuredmedia"][0]) || null;
  if (media && media.source_url) return media.source_url;
  const img = cheerio.load(post.content.rendered || "")("img").first();
  return img.attr("data-src") || img.attr("src") || null;
}

function parseEpisodes(content, slug) {
  const episodes = [];
  const seen = new Set();
  const push = (kind, number, code) => {
    if (!code || seen.has(code)) return;
    seen.add(code);
    episodes.push({
      id: `${slug}:${number}`,
      number,
      title: kind.toLowerCase() === "episode" ? `Episode ${number}` : `${kind} ${number}`,
      duration: null,
      code,
    });
  };
  const labelled =
    /(Episode|OVA|ONA|Special|Movie)\s*(\d+)?\s*:?\s*(?:<[^>]*>\s*)*<a\s+[^>]*href=["']https:\/\/dl\.anime7\.download\/([a-z0-9]+)["']/gi;
  let m;
  while ((m = labelled.exec(content))) {
    push(m[1], m[2] ? parseInt(m[2], 10) : episodes.length + 1, m[3]);
  }
  const anchor = /<a\s+[^>]*href=["']https:\/\/dl\.anime7\.download\/([a-z0-9]+)["']/gi;
  while ((m = anchor.exec(content))) {
    if (seen.has(m[1])) continue;
    const before = content.slice(Math.max(0, m.index - 40), m.index);
    const kind = (before.match(/\b(Movie|OVA|ONA|Special)\b/i) || [])[1] || "Episode";
    push(kind, episodes.length + 1, m[1]);
  }
  return episodes;
}

async function getPost(slug) {
  const { data } = await axios.get(apiUrl, { params: { slug, _embed: 1 } });
  const post = Array.isArray(data) ? data[0] : data;
  if (!post) throw new Error(`Anime7: series not found: ${slug}`);
  return post;
}

async function pageExists(params) {
  try {
    await axios.get(apiUrl, { params: { ...params, _fields: "id" } });
    return true;
  } catch (_) {
    return false;
  }
}

async function probeTotalPages(params) {
  let lo = 1;
  let hi = 2;
  while (hi <= 8192 && (await pageExists({ ...params, page: hi }))) {
    lo = hi;
    hi *= 2;
  }
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (await pageExists({ ...params, page: mid })) lo = mid;
    else hi = mid;
  }
  return lo;
}

async function totalPages(res, params, key) {
  const raw = headerValue(res, "x-wp-totalpages");
  if (raw) return Math.max(1, parseInt(raw, 10) || 1);
  const cached = totals.get(key);
  if (cached && Date.now() - cached.at < 300000) return cached.pages;
  const pages = await probeTotalPages(params);
  totals.set(key, { pages, at: Date.now() });
  return pages;
}

function toResult(post) {
  return { id: post.slug, title: stripHtml(post.title.rendered), image: poster(post) };
}

async function listPosts(params, page, key) {
  let res = null;
  try {
    res = await axios.get(apiUrl, { params: { ...params, page, _embed: 1 } });
  } catch (e) {
    // WordPress answers 400 when the requested page is past the last one.
    if (!e.response || e.response.status !== 400) throw e;
  }
  const posts = res && Array.isArray(res.data) ? res.data : [];
  const pages = await totalPages(res, params, key);
  return {
    currentPage: page,
    totalPages: pages,
    hasNextPage: page < pages && posts.length > 0,
    results: posts.map(toResult),
  };
}

async function SearchAnime(query, filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1);
  const params = { search: query, per_page: perPage, orderby: "date", order: "desc" };
  return listPosts(params, page, `search:${query}`);
}

async function fetchRecentEpisodes(filters = {}) {
  const page = Math.max(1, Number(filters.page) || 1);
  const params = { per_page: perPage, orderby: "date", order: "desc" };
  return listPosts(params, page, "recent");
}

async function AnimeInfo(id) {
  const post = await getPost(id);
  const { cats, tags } = postTerms(post);
  const seasonCat = cats.find((c) => /^(spring|summer|fall|winter)\s+\d{4}$/i.test(c)) || "";
  const seasonMatch = seasonCat.match(/^(spring|summer|fall|winter)\s+(\d{4})$/i);
  const typeCat = cats.find((c) => /^(movie|ova|ona|special|tv)$/i.test(c));
  const episodes = parseEpisodes(post.content.rendered, post.slug);
  const $ = cheerio.load(post.content.rendered || "");
  return {
    id: post.slug,
    title: stripHtml(post.title.rendered),
    image: poster(post),
    description: $("p").first().text().replace(/\s+/g, " ").trim() || stripHtml(post.excerpt.rendered),
    genres: tags,
    status: cats.some((c) => /on-?going/i.test(c))
      ? "Ongoing"
      : cats.some((c) => /completed|finished/i.test(c))
        ? "Completed"
        : "Unknown",
    year: seasonMatch ? parseInt(seasonMatch[2], 10) : parseInt((post.date || "").slice(0, 4), 10) || null,
    season: seasonMatch ? seasonMatch[1][0].toUpperCase() + seasonMatch[1].slice(1).toLowerCase() : null,
    type: typeCat ? typeCat.toUpperCase() : "TV",
    totalEpisodes: episodes.length,
  };
}

async function fetchEpisode(id, page = 1) {
  const post = await getPost(id);
  const episodes = parseEpisodes(post.content.rendered, post.slug);
  return {
    episodes: episodes.map((e) => ({ id: e.id, number: e.number, title: e.title, duration: e.duration })),
    totalPages: 1,
    total: episodes.length,
    currentPage: Math.max(1, Number(page) || 1),
  };
}

async function streamInfo(filecode) {
  const body = { filecode, device: "web", codecs: ["av1", "h265"] };
  for (const host of ["https://vidara.so/api/stream", "https://mxzhxco8dft.com/api/stream"]) {
    try {
      const { data } = await axios.request(host, {
        method: "POST",
        data: body,
        headers: { "Content-Type": "application/json" },
      });
      if (data && data.streaming_url) return data;
    } catch (_) {}
  }
  return null;
}

async function fetchEpisodeSources(episodeId, category = null) {
  const s = String(episodeId);
  const cut = s.lastIndexOf(":");
  const slug = cut > 0 ? s.slice(0, cut) : s;
  const number = cut > 0 ? parseInt(s.slice(cut + 1), 10) : 1;
  const post = await getPost(slug);
  const episodes = parseEpisodes(post.content.rendered, post.slug);
  const episode = episodes.find((e) => e.number === number) || episodes[0];
  if (!episode) return { sources: [], subtitles: [] };
  const { data: html } = await axios.get(`https://dl.anime7.download/${episode.code}`);
  const vidara = String(html).match(/vidara\.so\/e\/([A-Za-z0-9_-]+)/i);
  if (!vidara) return { sources: [], subtitles: [] };
  const info = await streamInfo(vidara[1]);
  if (!info) return { sources: [], subtitles: [] };
  const subtitles = [];
  for (const sub of info.subtitles || []) {
    if (sub && sub.file_path) subtitles.push({ lang: sub.language || "English", url: sub.file_path });
  }
  return {
    sources: [
      {
        url: info.streaming_url,
        quality: "default",
        name: "Anime7",
        type: "sub",
        isM3U8: true,
        headers: { Referer: "https://dl.anime7.download/" },
      },
    ],
    subtitles,
  };
}

module.exports = {
  name: "anime7",
  version: "1.0.0",
  baseUrl,
  headerRules: [
    {
      match: ["anime7.download"],
      headers: { Referer: "https://anime7.download/" },
    },
  ],
  SearchAnime,
  AnimeInfo,
  fetchEpisode,
  fetchEpisodeSources,
  fetchRecentEpisodes,
};
