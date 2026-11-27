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
  "piratexplay.js",
));

// Verbatim from https://piratexplay.cc/category/latest
const catalogue = `<li class="post series">

  <article class="post dfx fcl series">

    <header class="entry-header">

      <h2 class="entry-title">
          JoJo&#039;s Bizarre Adventure                        </h2>

      <div class="entry-meta">

        <span class="vote">
          <span>TMDB</span>
          8.6                                                            </span>

      </div>

    </header>

    <div class="post-thumbnail or-1">

      <figure>

        <img
          loading="lazy"
          src="https://image.tmdb.org/t/p/w500/co0K9FS9rQPxPoKADs4nuGckk3A.jpg"
          alt="Image JoJo&#039;s Bizarre Adventure"
        >

      </figure>

      <span class="watch btn sm">
        View Series                                                        </span>

      <span class="play fa-play"></span>

    </div>

    <a href="/series/jojo-s-bizarre-adventure-season-1-45790" class="lnk-blk"></a>

  </article>

</li>`;

// Verbatim from https://piratexplay.cc/series/one-piece-season-1-37854
const seriesPage = `<article class="post single">
  <div class="dfxb alg-cr">
    <div style="text-align: center;">
      <img style="height:14rem;border-radius:5%;" loading="lazy" src="https://image.tmdb.org/t/p/w185/2rmK7mnchw9Xr3XdiTFSxTTLXqv.jpg" alt="Image One Piece">
      <h1 class="entry-title" style="padding-top:10px;font-weight:100;margin-bottom:0;">
          One Piece            </h1>
      [ <span>61 Episodes</span> ]
    </div>
    <aside class="fg1">
      <div class="entry-meta" style="padding-top:20px;">
        <div class="description" style="overflow-x:hidden; max-height:6rem;">
          <p>Years ago, the fearsome Pirate King, Gol D. Roger was executed leaving a huge pile of treasure.</p>
        </div>
      </div>
      <ul class="cast-lst dfx fwp">
        <li>
          <span>Genres</span>
          <p class="genres" style="display:inline-block;width:100%;">
            <a href="https://piratexplay.cc/genre/fantasy/">fantasy</a>, <a href="https://piratexplay.cc/genre/comedy/">comedy</a>                </p>
        </li>
        <li>
          <span>Languages</span>
          <p class="loadactor" style="display:inline-block;width:100%;">
            <a href="https://piratexplay.cc/language/hindi/">Hindi</a>, <a href="https://piratexplay.cc/language/english/">English</a>, <a href="https://piratexplay.cc/language/japanese/">Japanese</a>, More
            </p>
        </li>
      </ul>
      <div class="entry-meta" style="width: 100%;display: flex;justify-content: space-between;">
        <span class="year fa-calendar far">
          <span class="overviewCss" style="margin-left:-10px;">
            1999                    </span>
          </span>
      </div>
    </aside>
  </div>
  <ul id="episode_by_temp" class="post-lst rw sm rcl2 rcl3a rcl4b rcl3c rcl4d rcl8e eqcl">
    <li>
      <article class="post dfx fcl episodes fa-play-circle">
        <div class="post-thumbnail">
          <figure>
            <img loading="lazy" src="https://image.tmdb.org/t/p/w185/2rmK7mnchw9Xr3XdiTFSxTTLXqv.jpg" alt="Episode 1">
          </figure>
          <span class="play fa-play"></span>
        </div>
        <header class="entry-header">
          <span class="num-epi">
              1x1                        </span>
          <h2 class="entry-title">
              One Piece                            1x1                        </h2>
        </header>
        <a href="/episode/one-piece-season-1-37854-1x1/" class="lnk-blk"></a>
      </article>
    </li>
    <li>
      <article class="post dfx fcl episodes fa-play-circle">
        <header class="entry-header">
          <span class="num-epi">
              1x2                        </span>
          <h2 class="entry-title">
              One Piece                            1x2                        </h2>
        </header>
        <a href="/episode/one-piece-season-1-37854-1x2/" class="lnk-blk"></a>
      </article>
    </li>
  </ul>
</article>`;

// Current episode-page iframe shape.
const episodePage = `<iframe src="https://piratexplay.cc/proxy/play.php?url=https://ravok.buzz/video/8757150decbd89b0f5442ca3db4d0e0e"></iframe>
<iframe data-src="https://rubystm.com/e/3hklgq1uj9i6.html"></iframe>
<iframe data-src="https://piratexplay.cc/proxy/multi.php?data=W3sibGFuZ3VhZ2UiOiJIaW5kaSIsImxpbmsiOiJodHRwczovL2FieXNzcGxheWVyLmNvbS9zUDdOLTNCcnIifV0="></iframe>
<iframe data-src="https://vidmoly.biz/embed-vz1m7a4x988b.html"></iframe>`;

// The episode page also lists every server of the site with its player.
const multiRows = [
  { language: "Hindi", link: "http://player.abyssplayer.com/hindiSlug" },
  { language: "Japanese", link: "http://player.abyssplayer.com/jpnSlug" },
  { language: "English", link: "http://player.abyssplayer.com/engSlug" },
];
const multiData = Buffer.from(JSON.stringify(multiRows)).toString("base64");
const episodePageWithServers = `<aside class="video-player aa-cn" id="aa-options">
  <div id="options-0" class="video aa-tb hdd on"><iframe src="https://piratexplay.cc/proxy/play.php?url=https://ravok.buzz/video/8757150decbd89b0f5442ca3db4d0e0e"></iframe></div>
  <div id="options-1" class="video aa-tb hdd"><iframe data-src="https://rubystm.com/e/3hklgq1uj9i6.html"></iframe></div>
  <div id="options-2" class="video aa-tb hdd"><iframe data-src="https://piratexplay.cc/proxy/multi.php?data=${multiData}"></iframe></div>
  <div id="options-3" class="video aa-tb hdd"><iframe data-src="https://vidmoly.biz/embed-vz1m7a4x988b.html"></iframe></div>
</aside>
<ul class="aa-tbs aa-tbs-video" data-tbs="aa-options">
  <li><a class="btn on" href="#options-0">Server <span>1</span><span class="server">Ravok - Multi Audio</span></a></li>
  <li><a class="btn" href="#options-1">Server <span>2</span><span class="server">Rubystm - Multi Audio</span></a></li>
  <li><a class="btn" href="#options-2">Server <span>3</span><span class="server">Multi Audio - Multi Audio</span></a></li>
  <li><a class="btn" href="#options-3">Server <span>4</span><span class="server">Vidmoly - Multi Audio</span></a></li>
</ul>`;

const rubystmLandingPage = `<form action="/dl" method="post">
  <input name="op" value="embed">
  <input name="file_code" value="">
  <input name="auto" value="1">
  <input name="referer" value="">
</form>`;

const rubystmPlayerPage = `<script>
  jwplayer("vplayer").setup({
    sources: [{file:"https://rap7c5roebejl0.streamruby.net/hls2/01/00116/szgmsvygk9vs_,l,n,h,.urlset/master.m3u8?t=token"}]
  });
</script>`;

const masterUrl =
  "https://rap7c5roebejl0.streamruby.net/hls2/01/00116/szgmsvygk9vs_,l,n,h,.urlset/master.m3u8?t=token";
const finalUrl = "https://nuvorel.top/e/3hklgq1uj9i6.html";

const masterWithHindi = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="English",LANGUAGE="en",AUTOSELECT=YES,DEFAULT=YES,URI="https://rap7c5roebejl0.streamruby.net/hls2/01/00116/szgmsvygk9vs_l/index-a1.m3u8?t=token"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="Hindi",LANGUAGE="hi",AUTOSELECT=NO,DEFAULT=NO,URI="https://rap7c5roebejl0.streamruby.net/hls2/01/00116/szgmsvygk9vs_l/index-a2.m3u8?t=token"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio0",NAME="Japanese",LANGUAGE="ja",AUTOSELECT=NO,DEFAULT=NO,URI="https://rap7c5roebejl0.streamruby.net/hls2/01/00116/szgmsvygk9vs_l/index-a5.m3u8?t=token"
#EXT-X-STREAM-INF:BANDWIDTH=486096,RESOLUTION=472x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="audio0"
https://rap7c5roebejl0.streamruby.net/hls2/01/00116/szgmsvygk9vs_l/index-v1-a2.m3u8?t=token
#EXT-X-STREAM-INF:BANDWIDTH=1372629,RESOLUTION=944x720,CODECS="avc1.640020,mp4a.40.2",AUDIO="audio0"
https://rap7c5roebejl0.streamruby.net/hls2/01/00116/szgmsvygk9vs_h/index-v1-a2.m3u8?t=token`;

// The "Multi Audio" player page carries its file list base64 encoded.
function abyssPlayerPage(slug, sources) {
  const payload = {
    slug,
    md5_id: 24631525,
    user_id: 359459,
    media: { mp4: { domains: ["cdn.example.com"], sources } },
  };
  return `<script>const datas = "${Buffer.from(JSON.stringify(payload)).toString("base64")}";</script>`;
}


test("catalogue cards become series entries with TMDB artwork", async () => {
  axios.get = async (url) => {
    if (url.includes("/category/latest")) {
      return { data: `<ul class="post-lst">${catalogue}</ul>` };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const page = await provider.fetchRecentEpisodes({ page: 1 });
  assert.equal(page.results.length, 1);
  assert.equal(page.results[0].id, "jojo-s-bizarre-adventure-season-1-45790");
  assert.equal(page.results[0].title, "JoJo's Bizarre Adventure");
  assert.equal(
    page.results[0].image,
    "https://image.tmdb.org/t/p/w500/co0K9FS9rQPxPoKADs4nuGckk3A.jpg",
  );
});

test("search uses the site API and drops movies", async () => {
  axios.get = async (url) => {
    if (url.includes("/api/search-ajax.php?keyword=one%20piece")) {
      return {
        data: {
          status: "success",
          data: [
            {
              tmdb: {
                type: "series",
                url: "one-piece-season-1-37854",
                poster: "/9hW62RDq5Dno8vLABXscddjEq9M.jpg",
                title: "One Piece",
                release_year: 1999,
              },
            },
            {
              tmdb: {
                type: "movies",
                url: "one-piece-film-z-2012-176983",
                poster: "/oP568qNH1LLEsoqGiZmf8deTOWc.jpg",
                title: "One Piece Film: Z (2012)",
              },
            },
          ],
        },
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const found = await provider.SearchAnime("one piece");
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].id, "one-piece-season-1-37854");
  assert.equal(
    found.results[0].image,
    "https://image.tmdb.org/t/p/w500/9hW62RDq5Dno8vLABXscddjEq9M.jpg",
  );
});

test("AnimeInfo reports the languages and episodes of a series", async () => {
  axios.get = async (url) => {
    if (url.includes("/series/one-piece-season-1-37854")) {
      return { data: seriesPage };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const info = await provider.AnimeInfo("one-piece-season-1-37854");
  assert.equal(info.title, "One Piece");
  assert.equal(info.year, 1999);
  assert.equal(info.hasDub, true);
  assert.equal(info.subOrDub, "both");
  assert.equal(info.totalEpisodes, 2);
  assert.deepEqual(info.genres, ["fantasy", "comedy"]);

  const episodes = await provider.fetchEpisode("one-piece-season-1-37854");
  assert.equal(episodes.episodes.length, 2);
  assert.equal(episodes.episodes[0].id, "one-piece-season-1-37854-1x1");
  assert.equal(episodes.episodes[0].number, 1);
  assert.equal(episodes.episodes[1].number, 2);
  assert.deepEqual(episodes.episodes[0].langs, ["sub", "dub"]);
});

test("fetchEpisodeSources exposes every language and resolution of the Rubystm mirror", async () => {
  axios.get = async (url) => {
    if (url.includes("/episode/one-piece-season-1-37854-1x1/")) {
      return { data: episodePageWithServers };
    }
    if (url === "https://rubystm.com/e/3hklgq1uj9i6.html") {
      return {
        data: rubystmLandingPage,
        request: { responseUrl: finalUrl },
      };
    }
    if (url === masterUrl) {
      return { data: masterWithHindi };
    }
    if (url.startsWith("https://player.abyssplayer.com/")) {
      const slug = url.split("/").pop();
      return {
        data: abyssPlayerPage(slug, [
          { label: "1080p", size: 354878911, res_id: 5, status: true },
          { label: "720p", size: 233830327, res_id: 4, status: true },
        ]),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  axios.post = async (url) => {
    assert.equal(url, "https://nuvorel.top/dl");
    return { data: rubystmPlayerPage };
  };

  const result = await provider.fetchEpisodeSources(
    "one-piece-season-1-37854-1x1",
  );

  // Every language of the master, every resolution of the master.
  const rubystm = result.sources.filter((source) => source.server === "Rubystm");
  assert.equal(rubystm.length, 6);
  assert.deepEqual(
    [...new Set(rubystm.map((source) => source.quality))].sort(),
    ["360p", "720p"],
  );
  assert.deepEqual(
    [...new Set(rubystm.map((source) => source.lang))].sort(),
    ["English", "Hindi", "Japanese"],
  );

  // The server is the mirror, the language is the audio track inside it.
  const japanese = rubystm.find((source) => source.lang === "Japanese");
  assert.equal(japanese.quality, "720p");
  assert.equal(
    japanese.url,
    "https://rap7c5roebejl0.streamruby.net/hls2/01/00116/szgmsvygk9vs_h/index-v1-a5.m3u8?t=token",
  );
  assert.equal(japanese.name, "Rubystm · Japanese");
  assert.equal(japanese.language, "ja");
  assert.equal(japanese.type, "sub");
  assert.equal(japanese.isM3U8, true);
  assert.equal(japanese.headers.Referer, finalUrl);

  const english = rubystm.find((source) => source.lang === "English");
  assert.equal(english.type, "dub");
  assert.equal(english.language, "en");

  // The "Multi Audio" mirror adds one direct file per language and resolution.
  const multi = result.sources.filter((source) => source.server === "Multi Audio");
  assert.equal(multi.length, 6);
  assert.deepEqual(
    [...new Set(multi.map((source) => source.lang))].sort(),
    ["English", "Hindi", "Japanese"],
  );
  assert.deepEqual(
    [...new Set(multi.map((source) => source.quality))].sort(),
    ["1080p", "720p"],
  );
  assert.equal(multi.find((source) => source.lang === "Japanese").type, "sub");
  assert.equal(multi.find((source) => source.lang === "English").type, "dub");
  assert.equal(multi[0].isM3U8, false);
  assert.match(multi[0].url, /^https:\/\/cdn\.example\.com\/sora\/\d+\//);
});

test("an episode page without the server list still resolves the Rubystm mirror", async () => {
  axios.get = async (url) => {
    if (url.includes("/episode/one-piece-season-1-37854-1x1/")) {
      return { data: episodePage };
    }
    if (url === "https://rubystm.com/e/3hklgq1uj9i6.html") {
      return {
        data: rubystmLandingPage,
        request: { responseUrl: finalUrl },
      };
    }
    if (url === masterUrl) {
      return { data: masterWithHindi };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  axios.post = async () => ({ data: rubystmPlayerPage });

  const result = await provider.fetchEpisodeSources(
    "one-piece-season-1-37854-1x1",
    "sub",
  );
  assert.equal(result.sources.length, 2);
  assert.ok(result.sources.every((source) => source.server === "Rubystm"));
  assert.ok(result.sources.every((source) => source.type === "sub"));
  assert.deepEqual(
    result.sources.map((source) => source.quality).sort(),
    ["360p", "720p"],
  );
});

test("a sub request only answers with the Japanese track, a dub request with the English one", async () => {
  axios.get = async (url) => {
    if (url.includes("/episode/one-piece-season-1-37854-1x1/")) {
      return { data: episodePageWithServers };
    }
    if (url === "https://rubystm.com/e/3hklgq1uj9i6.html") {
      return {
        data: rubystmLandingPage,
        request: { responseUrl: finalUrl },
      };
    }
    if (url === masterUrl) {
      return { data: masterWithHindi };
    }
    if (url.startsWith("https://player.abyssplayer.com/")) {
      const slug = url.split("/").pop();
      return {
        data: abyssPlayerPage(slug, [
          { label: "1080p", size: 354878911, res_id: 5, status: true },
        ]),
      };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  axios.post = async () => ({ data: rubystmPlayerPage });

  const sub = await provider.fetchEpisodeSources(
    "one-piece-season-1-37854-1x1",
    "sub",
  );
  assert.ok(sub.sources.length > 0);
  assert.ok(sub.sources.every((source) => source.type === "sub"));
  assert.ok(sub.sources.every((source) => source.lang === "Japanese"));
  assert.ok(
    sub.sources.every((source) => !source.url.includes("index-v1-a1.m3u8")),
  );

  const dub = await provider.fetchEpisodeSources(
    "one-piece-season-1-37854-1x1",
    "dub",
  );
  assert.ok(dub.sources.length > 0);
  assert.ok(dub.sources.every((source) => source.type === "dub"));
  assert.ok(dub.sources.every((source) => source.lang === "English"));
});
