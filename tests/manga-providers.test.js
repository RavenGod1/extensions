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
const kagane = load("kagane");
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

  const chapters = await atsu.fetchChapters("manga-1");
  assert.equal(chapters.Chapters[0].id, "manga-1::chapter-1");
  const pages = await atsu.fetchChapterPages(chapters.Chapters[0].id);
  assert.equal(pages[0].page, 1);
  assert.equal(
    pages[0].img,
    "https://cdn.atsu.moe/static/pages/chapter-1/1.avif",
  );
});

test("Kagane resolves English series and integrity-protected pages", async () => {
  let searchBody;
  let integrityHeaders;
  axios.post = async (url, body, config = {}) => {
    if (url.includes("/api/v2/search/series")) {
      searchBody = body;
      return {
        data: {
          page: 0,
          total_pages: 1,
          content: [
            {
              series_id: "series-1",
              title: "ONE PIECE",
              cover_image_id: "cover-1",
            },
          ],
        },
      };
    }
    if (url.endsWith("/api/integrity")) {
      return { data: { token: "integrity-token", exp: 4102444800 } };
    }
    if (url.includes("/api/v2/books/book-1")) {
      integrityHeaders = config.headers;
      return {
        data: {
          cache_url: "https://kstatic.to",
          access_token: "access-token",
          manifest: {
            pages: [{ page_no: 1, page_id: "page-1", ext: "jxl" }],
          },
        },
      };
    }
    throw new Error(`Unexpected Kagane POST URL: ${url}`);
  };
  axios.get = async (url) => {
    if (url.includes("/api/v2/series/series-1/books/index")) {
      return {
        data: {
          fields: [
            "book_id",
            "sort_no",
            "chapter_no",
            "title",
            "page_count",
          ],
          books: [["book-1", 1, "1", "Chapter 1", 20]],
        },
      };
    }
    throw new Error(`Unexpected Kagane GET URL: ${url}`);
  };

  const search = await kagane.searchManga("one piece", 1);
  assert.deepEqual(searchBody.content_lang, ["en"]);
  assert.equal(search.results[0].image, "https://kagane.moe/api/v2/image/cover-1");

  const chapters = await kagane.fetchChapters("series-1");
  assert.equal(chapters.Chapters[0].id, "book-1");
  const pages = await kagane.fetchChapterPages("book-1");
  assert.equal(integrityHeaders["X-Integrity-Token"], "integrity-token");
  assert.equal(
    pages[0].img,
    "https://kstatic.to/api/v2/books/page/original/book-1/page-1.jxl?token=access-token",
  );
});

test("NovelPing maps catalogue and renders escaped prose SVG pages", async () => {
  axios.get = async (url) => {
    if (url.includes("/search")) {
      return {
        data: `<div class="row"><img src="https://images.novelping.com/novel/test.jpg"><h3 class="novel-title"><a href="https://novelping.com/book/test-novel">Test Novel</a></h3></div><a href="https://novelping.com/search?keyword=test&page=2">2</a>`,
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
  assert.equal(search.totalPages, 2);

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
