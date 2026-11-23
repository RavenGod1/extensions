const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const axios = {
  get: async () => ({ data: "" }),
  post: async () => ({ data: "" }),
};
global.axios = axios;

const provider = require(path.join(
  __dirname,
  "..",
  "extensions",
  "Anime",
  "animeworldindia.js",
));

const kunonSeries = `<article class="post single">
  <div class="dfxb alg-cr">
    <div style="text-align: center;">
      <img style="height: 14rem; border-radius: 5%;" loading="lazy" src="//image.tmdb.org/t/p/w185/kGGdMa1fEwMiyyFB1AnUox5cshy.jpg" alt="Image Kunon the Sorcerer Can See">
      <h1 class="entry-title">Kunon the Sorcerer Can See</h1>
    </div>
    <aside class="fg1">
      <p class="genres"><a href="https://watchanimeworld.one/category/genre/action/">Action</a></p>
      <p class="loadactor"><a href="https://watchanimeworld.one/category/language/hindi/">Hindi</a>, <a href="https://watchanimeworld.one/category/language/japanese/">Japanese</a>, <a href="https://watchanimeworld.one/category/language/tamil/">Tamil</a>, <a href="https://watchanimeworld.one/category/language/telugu/">Telugu</a></p>
    </aside>
  </div>
</article>
<section class="section episodes">
  <a href="https://watchanimeworld.one/episode/kunon-the-sorcerer-can-see-1x1/" class="lnk-blk"></a>
  <a href="https://watchanimeworld.one/episode/kunon-the-sorcerer-can-see-1x2/" class="lnk-blk"></a>
</section>`;

const radiantSeries = `<article class="post single">
  <div class="dfxb alg-cr">
    <div style="text-align: center;">
      <img style="height: 14rem; border-radius: 5%;" loading="lazy" src="//image.tmdb.org/t/p/w185/yPeqnwD63wf23ZHlzEFeQLnZD3K.jpg" alt="Image RADIANT">
      <h1 class="entry-title">RADIANT</h1>
    </div>
    <aside class="fg1">
      <p class="genres"><a href="https://watchanimeworld.one/category/genre/action/">Action</a></p>
      <p class="loadactor"><a href="https://watchanimeworld.one/category/language/english/">English</a>, <a href="https://watchanimeworld.one/category/language/hindi/">Hindi</a>, <a href="https://watchanimeworld.one/category/language/japanese/">Japanese</a>, <a href="https://watchanimeworld.one/category/language/tamil/">Tamil</a>, <a href="https://watchanimeworld.one/category/language/telugu/">Telugu</a></p>
    </aside>
  </div>
</article>
<section class="section episodes">
  <a href="https://watchanimeworld.one/episode/radiant-2x1/" class="lnk-blk"></a>
  <a href="https://watchanimeworld.one/episode/radiant-2x2/" class="lnk-blk"></a>
</section>`;

const masterWithEnglish = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="jpn",NAME="Japanese",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/japanese"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="eng",NAME="English",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/english"
#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=640x360
master.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4096000,RESOLUTION=1920x1080
master-1080.m3u8`;

const masterWithoutEnglish = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="jpn",NAME="Japanese",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/japanese"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="hin",NAME="Hindi",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/hindi"
#EXT-X-STREAM-INF:BANDWIDTH=1200000
master.m3u8`;

const masterWithSubtitle = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="eng",NAME="English",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/english"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="eng",NAME="English",DEFAULT=NO,AUTOSELECT=YES,URI="/hls/subtitles.vtt"
#EXT-X-STREAM-INF:BANDWIDTH=1200000
master.m3u8`;

const onePieceSubtitle = `1
0:00:02.74 --> 0:00:04.82
Wealth, fame, power...

2
0:00:04.82 --> 0:00:06.74
Gold Roger, the King of the Pirates,
`;

test("AnimeInfo reports real language flags and uses the portrait poster", async () => {
  axios.get = async (url) => {
    if (url.includes("/series/kunon-the-sorcerer-can-see/")) {
      return { data: kunonSeries };
    }
    if (url.includes("/series/radiant/")) {
      return { data: radiantSeries };
    }
    throw new Error(`Unexpected series URL: ${url}`);
  };

  const kunon = await provider.AnimeInfo("kunon-the-sorcerer-can-see");
  assert.equal(kunon.hasSub, true);
  assert.equal(kunon.hasDub, false);
  assert.equal(kunon.subOrDub, "sub");
  assert.equal(
    kunon.image,
    "https://image.tmdb.org/t/p/w500/kGGdMa1fEwMiyyFB1AnUox5cshy.jpg",
  );

  const kunonEpisodes = await provider.fetchEpisode("kunon-the-sorcerer-can-see");
  assert.deepEqual(kunonEpisodes.episodes[0].langs, ["sub"]);

  const radiant = await provider.AnimeInfo("radiant");
  assert.equal(radiant.hasSub, true);
  assert.equal(radiant.hasDub, true);
  assert.equal(radiant.subOrDub, "both");
  assert.equal(
    radiant.image,
    "https://image.tmdb.org/t/p/w500/yPeqnwD63wf23ZHlzEFeQLnZD3K.jpg",
  );

  const radiantEpisodes = await provider.fetchEpisode("radiant");
  assert.deepEqual(radiantEpisodes.episodes[0].langs, ["sub", "dub"]);
});

test("fetchEpisodeSources exposes English subtitles as valid WebVTT", async () => {
  const token = "8757150decbd89b0f5442ca3db4d0e0e";
  const playerUrl = `https://play.zephyrix.org/video/${token}`;
  const masterUrl = "https://stream.example.test/master.m3u8?token=abc";
  const subtitleUrl =
    "https://s11.zn-grid05.top/f/D4qcbsujdl194gk4Jr1pq8S36lZ1L5pxzPuu8_49X8CdjBxeG43gOpkCF7fal3wf1TCbgErwX5z4mdSOeQbyXG4sgoZhQ7mD-g_TQQbo2mw.html";

  axios.get = async (url) => {
    if (url.includes("/episode/one-piece-1x1/")) {
      return {
        data: `<iframe src="${playerUrl}" data-src="${playerUrl}" frameborder="0"></iframe>`,
      };
    }
    if (url === playerUrl) {
      return {
        data: `<script>var playerjsSubtitle = "[English]${subtitleUrl}";</script>`,
      };
    }
    if (url === masterUrl) {
      return { data: masterWithEnglish };
    }
    if (url === subtitleUrl) {
      return { data: onePieceSubtitle };
    }
    throw new Error(`Unexpected source URL: ${url}`);
  };
  axios.post = async (url, body, config) => {
    assert.equal(
      url,
      `https://play.zephyrix.org/player/index.php?data=${token}&do=getVideo`,
    );
    assert.equal(body, `hash=${token}&r=https%3A%2F%2Fwatchanimeworld.one%2F`);
    assert.equal(config.headers.Referer, playerUrl);
    return { data: JSON.stringify({ hls: true, securedLink: masterUrl }) };
  };

  const result = await provider.fetchEpisodeSources("ep:one-piece-1x1");
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].type, "dub");
  assert.equal(result.sources[0].url, masterUrl);
  // The quality comes from the master's highest rendition, not "default".
  assert.equal(result.sources[0].quality, "1080p");
  assert.equal(result.subtitles.length, 1);
  assert.equal(result.subtitles[0].lang, "English");
  assert.match(result.subtitles[0].url, /^data:text\/vtt;base64,/);

  const vtt = Buffer.from(result.subtitles[0].url.split(",")[1], "base64").toString(
    "utf8",
  );
  assert.match(vtt, /^WEBVTT\n\n/);
  assert.match(vtt, /00:00:02\.740 --> 00:00:04\.820/);
  assert.match(vtt, /00:00:04\.820 --> 00:00:06\.740/);
  assert.doesNotMatch(vtt, /^1\n/m);
});

test("fetchEpisodeSources exposes HLS subtitle tracks when present", async () => {
  const token = "516341c3e8f4543c8d465b0c514a6f92";
  const playerUrl = `https://play.zephyrix.org/video/${token}`;
  const masterUrl = "https://stream.example.test/with-subs/master.m3u8";
  const subtitleUrl = "https://stream.example.test/hls/subtitles.vtt";

  axios.get = async (url) => {
    if (url.includes("/episode/radiant-2x1/")) {
      return { data: `<iframe src="${playerUrl}"></iframe>` };
    }
    if (url === playerUrl) {
      return { data: `<script>var playerjsSubtitle = "";</script>` };
    }
    if (url === masterUrl) {
      return { data: masterWithSubtitle };
    }
    if (url === subtitleUrl) {
      return { data: "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n" };
    }
    throw new Error(`Unexpected source URL: ${url}`);
  };
  axios.post = async () => ({
    data: JSON.stringify({ hls: true, securedLink: masterUrl }),
  });

  const result = await provider.fetchEpisodeSources("ep:radiant-2x1");
  assert.equal(result.subtitles.length, 1);
  assert.equal(result.subtitles[0].lang, "English");
  assert.match(result.subtitles[0].url, /^data:text\/vtt;base64,/);
});

test("fetchEpisodeSources keeps Kunon sub-only and finds its English subtitle", async () => {
  const token = "dba1dab580065e4db9defb2cfc74f65d";
  const playerUrl = `https://play.zephyrix.org/video/${token}`;
  const masterUrl = "https://stream.example.test/kunon-master.m3u8";
  const ravokToken = "f928b521c5648ee6d6ece6d143bf232d";
  const ravokPlayerUrl = `https://ravok.buzz/video/${ravokToken}`;
  const animeSaltEpisodeUrl =
    "https://animesalt.cx/episode/kunon-the-sorcerer-can-see-1x1/";
  const subtitleUrl = "https://as-cdn30.top/p/kunon-episode-1.jpg";

  axios.get = async (url) => {
    if (
      url ===
      "https://watchanimeworld.one/episode/kunon-the-sorcerer-can-see-1x1/"
    ) {
      return { data: `<iframe src="${playerUrl}"></iframe>` };
    }
    if (url === playerUrl) {
      return { data: `<script>var playerjsSubtitle = "";</script>` };
    }
    if (url === masterUrl) {
      return { data: masterWithoutEnglish };
    }
    if (url === animeSaltEpisodeUrl) {
      return { data: `<iframe src="${ravokPlayerUrl}"></iframe>` };
    }
    if (url === ravokPlayerUrl) {
      return {
        data: `<script>var playerjsSubtitle = "[English]${subtitleUrl}";</script>`,
      };
    }
    if (url === subtitleUrl) {
      return {
        data: `1\n00:00:02,740 --> 00:00:04,820\nI can see again.\n`,
      };
    }
    throw new Error(`Unexpected source URL: ${url}`);
  };
  axios.post = async () => ({
    data: JSON.stringify({ hls: true, securedLink: masterUrl }),
  });

  const result = await provider.fetchEpisodeSources(
    "ep:kunon-the-sorcerer-can-see-1x1",
  );
  assert.equal(result.sources[0].type, "sub");
  assert.equal(result.subtitles.length, 1);
  assert.equal(result.subtitles[0].lang, "English");
  assert.match(result.subtitles[0].url, /^data:text\/vtt;base64,/);
  const vtt = Buffer.from(result.subtitles[0].url.split(",")[1], "base64").toString(
    "utf8",
  );
  assert.match(vtt, /00:00:02\.740 --> 00:00:04\.820/);
  assert.match(vtt, /I can see again\./);
});
