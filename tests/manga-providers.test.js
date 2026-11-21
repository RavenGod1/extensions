const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const axios = {
  get: async () => ({ data: {} }),
  post: async () => ({ data: {} }),
};
global.axios = axios;

const load = (name) =>
  require(path.join(__dirname, "..", "extensions", "Manga", `${name}.js`));
const atsu = load("atsu");
const manhwatop = load("manhwatop");
const novelping = load("novelping");

test("Atu Moe maps catalogue, metadata, chapters, and CDN pages", async () => {
  axios.get = async (url) => {
    if (url.includes("/collections/manga/documents/search")) {
      return {
        data: {
          found: 1,
          page: 1,
          hits: [
            {
              document: {
                id: "manga-1",
                title: "One Piece",
                poster: "/static/posters/one-piece.jpg",
              },
            },
          ],
        },
      };
    }
    if (url.includes("/manga/manga-1")) {
      return {
        data:
          'window.mangaPage = {"mangaPage":{"id":"manga-1","title":"One Piece","poster":{"image":"posters/one-piece.jpg"},"synopsis":"Pirates.","genres":[{"name":"Action"}],"authors":[{"name":"Oda"}],"otherNames":["OP"],"status":"Ongoing","released":852076800000,"type":"Manga"}};',
      };
    }
    if (url.includes("/api/manga/allChapters")) {
      return {
        data: {
          chapters: [{ id: "chapter-1", number: 1, title: "Chapter 1" }],
        },
      };
    }
    if (url.includes("/api/read/chapter")) {
      return {
        data: {
          readChapter: {
            pages: [{ number: 0, image: "/static/pages/chapter-1/1.avif" }],
          },
        },
      };
    }
    throw new Error(`Unexpected Atu URL: ${url}`);
  };

  const search = await atsu.searchManga("one piece", 1);
  assert.equal(search.results[0].id, "manga-1");
  assert.equal(
    search.results[0].image,
    "https://cdn.atsu.moe/static/posters/one-piece.jpg",
  );

  const info = await atsu.fetchMangaInfo("manga-1");
  assert.equal(info.year, 1997);
  assert.deepEqual(info.genres, ["Action"]);
  // Detail poster fields omit /static (catalogue rows include it) — the CDN
  // 404s without it, which is what left the hero cover blank.
  assert.equal(info.image, "https://cdn.atsu.moe/static/posters/one-piece.jpg");

  const chapters = await atsu.fetchChapters("manga-1");
  assert.equal(chapters.Chapters[0].id, "manga-1::chapter-1");
  const pages = await atsu.fetchChapterPages(chapters.Chapters[0].id);
  assert.equal(pages[0].page, 1);
  assert.equal(
    pages[0].img,
    "https://cdn.atsu.moe/static/pages/chapter-1/1.avif",
  );
});

test("ManhwaTop maps catalogue, AJAX chapters, and CDN reader pages", async () => {
  // Live markup captured from manhwatop.com: listing cards, the search
  // tab shape, the detail page, and the chapters AJAX response.
  const listing = `<div class="page-item-detail">
      <div class="item-thumb c-image-hover" data-post-id="101781">
        <a href="https://manhwatop.com/manga/mood-disorder/" title="Mood Disorder">
          <img width="175" height="238" data-src="https://manhwatop.com/wp-content/uploads/2025/07/Mood-Disorder-cover-175x238.jpg" src="https://manhwatop.com/wp-content/themes/madara/images/dflazy.jpg" alt="Mood Disorder cover">
        </a>
      </div>
      <div class="item-summary"><div class="post-title font-title"><h3 class="h5">
        <span class="manga-title-badges new">NEW</span>
        <a href="https://manhwatop.com/manga/mood-disorder/">Mood Disorder</a>
      </h3></div></div>
    </div>`;

  const search = `<div class="c-tabs-item"><div class="row c-tabs-item__content">
      <div class="col-4 col-md-2"><div class="tab-thumb c-image-hover">
        <a href="https://manhwatop.com/manga/piece-maker-of-flame/" title="Piece Maker of Flame">
          <img width="193" height="278" data-src="https://manhwatop.com/wp-content/uploads/2024/06/manga_84257_image-193x278.jpg" src="https://manhwatop.com/wp-content/themes/madara/images/dflazy.jpg" alt="Piece Maker of Flame">
        </a>
      </div></div>
    </div></div>`;

  const detail = `<meta property="og:image" content="https://manhwatop.com/wp-content/uploads/2025/07/Mood-Disorder-cover.jpg">
    <h1>Mood Disorder</h1>
    <div class="summary_content"><div class="post-content">
      <div class="post-rating">5 Your Rating</div>
      <div class="post-content_item"><div class="summary-heading"><span class="h5">Alternative</span></div>
        <div class="summary-content">Mood Disorder, Emo</div></div>
      <div class="post-content_item"><div class="summary-heading"><span class="h5">Author(s)</span></div>
        <div class="summary-content"><div class="author-content"><a href="/manga-author/x/">Author One</a></div></div></div>
      <div class="post-content_item"><div class="summary-heading"><span class="h5">Genre(s)</span></div>
        <div class="summary-content"><div class="genres-content"><a href="/manga-genre/action/">Action</a>, <a href="/manga-genre/drama/">Drama</a></div></div></div>
      <div class="post-content_item"><div class="summary-heading"><span class="h5">Type</span></div>
        <div class="summary-content">manhua</div></div>
      <div class="post-content_item"><div class="summary-heading"><span class="h5">Release</span></div>
        <div class="summary-content">2025,Updating</div></div>
      <div class="post-content_item"><div class="summary-heading"><span class="h5">Status</span></div>
        <div class="summary-content">OnGoing</div></div>
    </div></div>
    <div class="description-summary"><div class="summary__content show-more">
      <p>Everybody is crazy except me.</p>
    </div></div>`;

  const chapters = `<ul class="main version-chap no-volumn">
      <li class="wp-manga-chapter"><a href="https://manhwatop.com/manga/mood-disorder/chapter-2/">Chapter 2</a>
        <span class="chapter-release-date"><i>2 days ago</i></span></li>
      <li class="wp-manga-chapter"><a href="https://manhwatop.com/manga/mood-disorder/chapter-1/">Chapter 1</a>
        <span class="chapter-release-date"><i>9 days ago</i></span></li>
    </ul>`;

  const chapterPage = `<div class="reading-content">
      <img class="wp-manga-chapter-img img-responsive lazyload" src="https://manhwatop.com/wp-content/themes/madara/images/loading6.svg" data-src="https://c4.manhwatop.com/manga_hash/chapter_1/ch_1_1.jpg">
      <img class="wp-manga-chapter-img img-responsive lazyload" src="https://manhwatop.com/wp-content/themes/madara/images/loading6.svg" data-src="https://c4.manhwatop.com/manga_hash/chapter_1/ch_1_2.jpg">
    </div>`;

  let chaptersUrl = null;
  let latestUrl = null;
  axios.get = async (url) => {
    latestUrl = url;
    if (url.includes("/ajax/chapters/")) throw new Error("must be a POST");
    if (url.includes("post_type=wp-manga")) return { data: search };
    if (url.includes("/manga/mood-disorder/chapter-1")) return { data: chapterPage };
    if (url.includes("/manga/mood-disorder")) return { data: detail };
    if (url.includes("/manga/")) return { data: listing };
    throw new Error(`Unexpected ManhwaTop GET URL: ${url}`);
  };
  axios.post = async (url) => {
    chaptersUrl = url;
    return { data: chapters };
  };

  const latest = await manhwatop.latestManga(1);
  assert.equal(latest.results[0].id, "mood-disorder");
  // The listing serves a -WxH thumbnail; the card needs the full-size cover.
  assert.equal(
    latest.results[0].image,
    "https://manhwatop.com/wp-content/uploads/2025/07/Mood-Disorder-cover.jpg",
  );
  // The default order repeats cards across the page boundary.
  assert.match(latestUrl, /m_orderby=latest/);

  const found = await manhwatop.searchManga("one piece");
  assert.equal(found.results[0].id, "piece-maker-of-flame");
  assert.equal(
    found.results[0].image,
    "https://manhwatop.com/wp-content/uploads/2024/06/manga_84257_image.jpg",
  );

  const info = await manhwatop.fetchMangaInfo("mood-disorder");
  assert.equal(info.title, "Mood Disorder");
  assert.deepEqual(info.genres, ["Action", "Drama"]);
  assert.equal(info.status, "OnGoing");
  assert.equal(info.year, "2025");
  assert.equal(info.author, "Author One");
  assert.match(info.description, /Everybody is crazy except me/);

  const chapterList = await manhwatop.fetchChapters("mood-disorder");
  // The chapter list is AJAX-loaded from the slug endpoint.
  assert.equal(
    chaptersUrl,
    "https://manhwatop.com/manga/mood-disorder/ajax/chapters/",
  );
  assert.equal(chapterList.total, 2);
  assert.equal(chapterList.Chapters[0].number, 2);

  const pages = await manhwatop.fetchChapterPages(
    chapterList.Chapters[1].id,
  );
  assert.equal(pages.length, 2);
  assert.equal(
    pages[0].img,
    "https://c4.manhwatop.com/manga_hash/chapter_1/ch_1_1.jpg",
  );
});

test("NovelPing maps catalogue and renders escaped prose SVG pages", async () => {
  axios.get = async (url) => {
    if (url.includes("/search")) {
      return {
        data: `<div class="row"><img src="https://images.novelping.com/novel_200_89/test.jpg"><h3 class="novel-title"><a href="https://novelping.com/book/test-novel">Test Novel</a></h3></div><a href="https://novelping.com/search?keyword=test&amp;page&#x3D;2">2</a><a href="https://novelping.com/search?keyword=test&amp;page&#x3D;3">3</a>`,
      };
    }
    if (url.includes("/ajax/chapter-archive")) {
      return {
        data: `<li data-chapter-id="chapter-1" class="chapter-list-item"><a href="https://novelping.com/book/test-novel/chapter-1"><span class="nchr-text chapter-title">Chapter 1 Start</span></a></li>`,
      };
    }
    if (url.includes("/book/test-novel/chapter-1")) {
      return {
        data: `<div id="chr-content" class="chr-c"><p>A &#60;script&#62; tag &#38; more prose.</p><p>Second paragraph.</p></div><hr class="chr-end">`,
      };
    }
    if (url.includes("/book/test-novel")) {
      return {
        data: `<meta property="og:title" content="Test Novel | NovelPing"><meta property="og:image" content="https://images.novelping.com/novel/test-novel.jpg"><meta property="og:novel:author" content="Author"><meta property="og:novel:genre" content="ACTION,FANTASY"><meta property="og:novel:status" content="OnGoing"><div id="novel-description-content"><p>Description.</p></div>`,
      };
    }
    throw new Error(`Unexpected NovelPing URL: ${url}`);
  };

  const search = await novelping.searchManga("test", 1);
  assert.equal(search.results[0].id, "test-novel");
  assert.equal(search.totalPages, 3);
  assert.equal(search.hasNextPage, true);
  // The listing serves a 200x89 banner; the card needs the portrait cover.
  assert.equal(
    search.results[0].image,
    "https://images.novelping.com/novel_328_490/test.jpg",
  );

  const info = await novelping.fetchMangaInfo("test-novel");
  assert.equal(info.title, "Test Novel");
  assert.deepEqual(info.genres, ["ACTION", "FANTASY"]);

  const chapters = await novelping.fetchChapters("test-novel");
  assert.equal(chapters.Chapters[0].number, 1);
  const pages = await novelping.fetchChapterPages(chapters.Chapters[0].id);
  assert.match(pages[0].img, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(pages[0].img.split(",", 2)[1], "base64").toString(
    "utf8",
  );
  assert.match(svg, /&#60;script&#62;/);
  assert.match(svg, /Second paragraph\./);
});
