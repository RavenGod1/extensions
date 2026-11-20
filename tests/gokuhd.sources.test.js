const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function loadGokuHd() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "axios" || request === "cheerio") return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require("../extensions/Anime/gokuhd");
  } finally {
    Module._load = originalLoad;
  }
}

const { isSupportedSourceUrl } = loadGokuHd();

test("gokuhd accepts HLS and direct media sources", () => {
  assert.equal(isSupportedSourceUrl("https://cdn.test/master.m3u8"), true);
  assert.equal(isSupportedSourceUrl("https://cdn.test/movie.mp4"), true);
  assert.equal(isSupportedSourceUrl("https://cdn.test/signed/media"), true);
});

test("gokuhd rejects DASH and non-media documents", () => {
  assert.equal(isSupportedSourceUrl("https://cdn.test/manifest.mpd"), false);
  assert.equal(isSupportedSourceUrl("https://cdn.test/manifest.MPD?token=1"), false);
  assert.equal(isSupportedSourceUrl("https://cdn.test/source.json"), false);
  assert.equal(isSupportedSourceUrl("javascript:alert(1)"), false);
  assert.equal(isSupportedSourceUrl(null), false);
});
