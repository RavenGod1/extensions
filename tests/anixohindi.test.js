const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const axios = {
  get: async () => ({ data: "" }),
};
global.axios = axios;

const provider = require(path.join(
  __dirname,
  "..",
  "extensions",
  "Anime",
  "anixohindi.js",
));

const catalogue = `<div class="anime-card">
  <span data-id="108040"></span>
  <a class="anime-card-poster" href="/watch.php?anime=radiant-season-2&ep=1">
    <img src="https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx108040-FYeFAH75GZ0c.jpg" alt="Radiant Season 2">
  </a>
  <div class="card-title"><a href="/watch.php?anime=radiant-season-2&ep=1">Radiant Season 2</a></div>
  <div class="card-ep-count"><span>21 Episodes</span></div>
  <div class="meta-year">2019</div>
  <div class="meta-tag">TV</div>
</div>`;

const watchPage = `<!doctype html><html><head>
  <meta property="og:image" content="https://s4.anilist.co/file/anilistcdn/media/anime/banner/108040-juy2tqQNhiMe.jpg">
</head><body>
  <div class="anime-dossier-card full-width-dossier">
    <div class="dossier-poster-wrap">
      <img class="dossier-poster-img" src="https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx108040-FYeFAH75GZ0c.jpg" alt="Radiant Season 2">
    </div>
    <h1 class="dossier-title">Radiant Season 2</h1>
  </div>
  <script>window.WATCH_TOTAL_EPS = 21;</script>
</body></html>`;

test("AnimeInfo uses the portrait cover instead of the wide banner", async () => {
  axios.get = async (url) => {
    if (url.includes("/browse.php")) return { data: catalogue };
    if (url.includes("/watch.php?anime=radiant-season-2")) {
      return { data: watchPage };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const results = await provider.SearchAnime("Radiant Season 2");
  assert.equal(results.results.length, 1);

  const info = await provider.AnimeInfo(results.results[0].id);
  assert.equal(
    info.image,
    "https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx108040-FYeFAH75GZ0c.jpg",
  );
  // Version parity with marketplace.json (not a literal) so future bumps do
  // not need this test edited; the app only offers the update when they match.
  const marketplace = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "marketplace.json"), "utf8"),
  );
  const entry = marketplace.Anime.find((item) => item.name === "anixohindi");
  assert.equal(provider.version, entry.version);
});
