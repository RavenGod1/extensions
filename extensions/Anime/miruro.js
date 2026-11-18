/**
 * StrawVerse Extension - Miruro (miruro.cx)
 * Catalogue via SSR search/info pages (AniList-backed ids); streams from the
 * watch page, which server-renders each server's headers and m3u8 URLs.
 */
const cheerio = require("cheerio");
const axios = global.axios || require("axios");

const baseUrl = "https://miruro.cx";

function parseCards(html) {
  const $ = cheerio.load(html);
  const scope = $(".browse-grid").length ? $(".browse-grid") : $("body");
  const results = [];
  scope.find("a[href^='/info/']").each((_, el) => {
    const href = ($(el).attr("href") || "").split("?")[0];
    const m = href.match(/^\/info\/([^?#]+)$/);
    if (!m) return;
    // Search cards nest the img in the link; /trending cards use an empty
    // overlay link with the poster + title (aria-label) on the parent article.
    const own = $(el).find("img").first();
    const img = own.length ? own : $(el).closest("article").find("img").first();
    const title =
      own.attr("alt") || $(el).attr("aria-label") || img.attr("alt") || "";
    if (!title || results.some((r) => r.id === m[1])) return;
    results.push({ id: m[1], title, image: img.attr("src") || null });
  });
  return results;
}

async function fetchInfoPage(id) {
  const { data: html } = await axios.get(`${baseUrl}/info/${id}`, {
    headers: { Referer: `${baseUrl}/` },
  });
  return html;
}

async function SearchAnime(query, filters = {}) {
  const { data: html } = await axios.get(`${baseUrl}/search`, {
    params: { q: query },
  });
  return { currentPage: 1, hasNextPage: false, totalPages: 1, results: parseCards(html) };
}

async function fetchRecentEpisodes(filters = {}) {
  // The homepage is a client-rendered landing page (SSR yields ~1 card);
  // /trending is the route that server-renders the catalogue grid.
  const { data: html } = await axios.get(`${baseUrl}/trending`);
  return { currentPage: 1, hasNextPage: false, totalPages: 1, results: parseCards(html) };
}

function parseInfo(html, id) {
  const $ = cheerio.load(html);
  let ld = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const j = JSON.parse($(el).text());
      if (!ld && j && (j["@type"] === "TVSeries" || j["@type"] === "Movie" || j.name)) {
        ld = j;
      }
    } catch (_) {}
  });

  const pick = (re) => {
    const m = html.match(re);
    return m ? m[1] : null;
  };

  const statusRaw = pick(/\bstatus:"([A-Z_]+)"/) || (ld && ld.status) || "";
  const format = pick(/\bformat:"([A-Z]+)"/) || "";
  const seasonRaw = pick(/\bseason:"([A-Z]+)"/) || "";
  const year =
    pick(/\bseason_year:(\d{4})/) || ((ld && ld.datePublished) || "").slice(0, 4) || null;

  let genres = [];
  const gm = html.match(/\bgenres:\[([^\]]*)\]/);
  if (gm) {
    try {
      genres = JSON.parse("[" + gm[1] + "]");
    } catch (_) {}
  }
  if (!genres.length && ld && Array.isArray(ld.genre)) genres = ld.genre;

  const image =
    pick(/https:\/\/s\d+\.anilist\.co\/file\/anilistcdn\/media\/anime\/cover\/[^"'\\\s]+/) ||
    (ld && typeof ld.image === "string" ? ld.image : null);

  const description =
    (ld && ld.description) || pick(/description\\?":\\?"([^"\\]{30,})/) || "";

  return {
    id,
    title: $("h1").first().text().trim() || (ld && ld.name) || id,
    image,
    type: format === "MOVIE" ? "Movie" : format || "TV",
    description: String(description).replace(/<[^>]+>/g, " ").trim(),
    genres,
    status:
      statusRaw === "FINISHED"
        ? "Completed"
        : statusRaw === "RELEASING"
          ? "Ongoing"
          : statusRaw === "NOT_YET_RELEASED"
            ? "Upcoming"
            : "Unknown",
    year: year ? Number(year) || null : null,
    season: seasonRaw
      ? seasonRaw.charAt(0) + seasonRaw.slice(1).toLowerCase()
      : null,
  };
}

async function AnimeInfo(id) {
  return parseInfo(await fetchInfoPage(id), id);
}

async function fetchEpisode(id, page = 1) {
  let total = 0;
  try {
    const html = await fetchInfoPage(id);
    const m = html.match(/\bepisode_count:(\d+)/);
    total = m ? parseInt(m[1], 10) : 0;
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
  const infoId = idx > 0 ? s.slice(0, idx) : s;
  const ep = idx > 0 ? s.slice(idx + 1) : "1";

  const { data: html } = await axios.get(`${baseUrl}/watch/${infoId}`, {
    params: { ep },
    headers: { Referer: `${baseUrl}/info/${infoId}` },
  });

  const sources = [];
  const seen = new Set();
  const serverRe =
    /\{server:"([^"]*)",headers:\{([^{}]*)\}[\s\S]*?streams:\[([\s\S]*?)\]\}/g;
  let m;
  while ((m = serverRe.exec(html)) !== null) {
    const server = m[1];
    const headerRaw = m[2];
    const streamsRaw = m[3];
    const origin = (headerRaw.match(/Origin:"([^"]*)"/) || [])[1] || "";
    const referer = (headerRaw.match(/Referer:"([^"]*)"/) || [])[1] || "";

    // The track (sub/dub/raw) wraps the server blocks; the closest one above wins.
    const before = html.slice(Math.max(0, m.index - 6000), m.index);
    const tracks = before.match(/track:"([^"]*)"/g) || [];
    const track = tracks.length ? tracks[tracks.length - 1].replace(/track:"|"/g, "") : "";
    const type = /dub/i.test(track) ? "dub" : "sub";

    const streamRe = /\{url:"([^"]+)",format:"([^"]*)"/g;
    let sm;
    while ((sm = streamRe.exec(streamsRaw)) !== null) {
      const url = sm[1];
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({
        url,
        quality: server || "default",
        name: server || "Server",
        type,
        isM3U8: sm[2] !== "dash",
        headers: referer ? { Referer: referer, Origin: origin } : {},
      });
    }
  }

  let filtered = sources;
  const wanted = String(category || "").toLowerCase();
  if (wanted === "sub" || wanted === "dub") {
    const byType = sources.filter((x) => x.type === wanted);
    if (byType.length) filtered = byType;
  }
  return { sources: filtered, subtitles: [] };
}

module.exports = {
  name: "miruro",
  version: "1.0.0",
  baseUrl,
  headerRules: [
    {
      match: ["miruro.cx"],
      headers: { Referer: `${baseUrl}/` },
    },
  ],
  SearchAnime,
  AnimeInfo,
  fetchEpisode,
  fetchEpisodeSources,
  fetchRecentEpisodes,
};
