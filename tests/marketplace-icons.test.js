const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const marketplace = JSON.parse(
  fs.readFileSync(path.join(root, "marketplace.json"), "utf8"),
);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function iconHeader(file) {
  const buf = fs.readFileSync(file);
  assert.ok(buf.length > 6, "icon is empty");
  assert.notDeepEqual(
    buf.subarray(0, 4),
    PNG_MAGIC,
    "icon is a renamed PNG; GitHub serves .ico with nosniff so it renders broken",
  );
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  assert.equal(reserved, 0, "ICO header reserved must be 0");
  assert.equal(type, 1, "ICO header type must be 1 (icon)");
  assert.ok(count > 0, "ICO header must list at least one image");
  assert.ok(
    6 + count * 16 <= buf.length,
    "ICO directory is truncated (count does not fit the file)",
  );
  return { count, bytes: buf.length };
}

test("every marketplace entry ships a real .ico", () => {
  for (const [category, entries] of Object.entries(marketplace)) {
    for (const entry of entries) {
      const icon = path.join(root, "ico", `${entry.name}.ico`);
      assert.ok(
        fs.existsSync(icon),
        `${category}/${entry.name} has no ico/${entry.name}.ico`,
      );
      const { count, bytes } = iconHeader(icon);
      assert.ok(bytes > 100, `${entry.name}.ico looks empty`);
      assert.ok(count >= 1, `${entry.name}.ico has no image entries`);
    }
  }
});

test("every marketplace entry ships its extension file at the same version", () => {
  for (const [category, entries] of Object.entries(marketplace)) {
    for (const entry of entries) {
      const source = path.join(
        root,
        "extensions",
        category,
        `${entry.name}.js`,
      );
      assert.ok(
        fs.existsSync(source),
        `${category}/${entry.name} has no extensions/${category}/${entry.name}.js`,
      );
      const text = fs.readFileSync(source, "utf8");
      const match = text.match(/version:\s*"([^"]+)"/);
      assert.ok(match, `${entry.name}.js has no version field`);
      assert.equal(
        match[1],
        entry.version,
        `${entry.name}.js version differs from marketplace.json`,
      );
    }
  }
});

test("no icon is left behind for a removed extension", () => {
  const published = new Set(
    Object.values(marketplace).flat().map((entry) => `${entry.name}.ico`),
  );
  const icons = fs
    .readdirSync(path.join(root, "ico"))
    .filter((name) => name.toLowerCase().endsWith(".ico"));
  for (const icon of icons) {
    assert.ok(
      published.has(icon),
      `ico/${icon} has no marketplace entry; delete it with the extension`,
    );
  }
});
