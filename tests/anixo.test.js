const test = require("node:test");
const assert = require("node:assert/strict");
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
  "anixo.js",
));

const master = `#EXTM3U
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=2300316,RESOLUTION=1920x1080,FRAME-RATE=23.974
https://anixo.buzz/api/stream/m3u8?t=variant`;

function stubApi(overrides = {}) {
  axios.get = async (url, config = {}) => {
    const target = String(url);
    if (target.includes("/index.php")) {
      const params = config.params || {};
      const rows = [
        {
          mal_id: 16498,
          anilist_id: 16498,
          title_english: "Attack on Titan",
          format: "TV",
          status: params.status || "FINISHED",
          year: 2013,
          average_score: 85,
          popularity: 1081173,
          anikoto_sub: 25,
          anikoto_dub: 25,
          cover_image: { large: "https://example.test/cover.jpg" },
        },
      ];
      return { data: { results: rows, total: rows.length, pages: 1 } };
    }
    if (target.includes("/embed/ani/")) {
      return {
        data: `<script>const ticket = "TICKET"; const malId = "16498"; const animeTitle = "Attack on Titan";</script>`,
      };
    }
    if (target.includes("/api/stream/resolve")) {
      return {
        data: {
          success: true,
          server: "Server 1 (Sora Edge)",
          streamUrl: "https://anixo.buzz/api/stream/m3u8?t=primary",
          fallbackStreams: ["https://anixo.buzz/api/stream/m3u8?t=backup"],
          subtitles: [
            { url: "https://anixo.buzz/api/stream/vtt?t=en", label: "English" },
          ],
        },
      };
    }
    if (target.includes("/api/stream/m3u8")) {
      return { data: master };
    }
    throw new Error(`Unexpected URL: ${target}`);
  };
}

test("sources report the real HLS resolution and the server name", async () => {
  stubApi();
  const result = await provider.fetchEpisodeSources("16498:1", "sub");

  assert.equal(result.sources.length, 2);
  assert.equal(result.sources[0].quality, "1080p");
  assert.equal(result.sources[0].name, "Server 1 (Sora Edge)");
  assert.equal(result.sources[1].quality, "1080p");
  assert.equal(result.sources[1].name, "Server 1 (Sora Edge) (backup 1)");
  assert.equal(result.sources[0].type, "sub");
  assert.equal(result.sources[0].isM3U8, true);
  assert.equal(result.subtitles[0].lang, "English");
});

test("a master without a resolution falls back to the default quality", async () => {
  stubApi();
  const originalGet = axios.get;
  axios.get = async (url, config = {}) => {
    if (String(url).includes("/api/stream/m3u8")) {
      return { data: "#EXTM3U\n#EXTINF:10,\nsegment.ts\n" };
    }
    return originalGet(url, config);
  };

  const result = await provider.fetchEpisodeSources("16498:1", "sub");
  assert.equal(result.sources[0].quality, "default");
});

test("catalogue filters use the API status vocabulary", async () => {
  stubApi();
  const ongoing = await provider.fetchRecentEpisodes({
    status: "currently-airing",
  });
  assert.equal(ongoing.results.length, 1);

  const movies = await provider.fetchRecentEpisodes({ type: "Movie" });
  assert.equal(movies.results.length, 0);

  const dubbed = await provider.fetchRecentEpisodes({ language: "dub" });
  assert.equal(dubbed.results.length, 1);
});
