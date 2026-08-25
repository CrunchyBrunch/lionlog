import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

async function pngDimensions(relativePath) {
  const data = await readFile(path.join(projectRoot, relativePath));
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

test("manifest defines a relative standalone application shell", async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "public/manifest.webmanifest"), "utf8"));

  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.theme_color, "#f7f5ee");
  assert.equal(manifest.background_color, "#f7f5ee");
  assert.deepEqual(
    manifest.icons.map(({ src, sizes }) => ({ src, sizes })),
    [
      { src: "./icons/icon-192.png", sizes: "192x192" },
      { src: "./icons/icon-512.png", sizes: "512x512" },
    ],
  );
});

test("install icons have the declared PNG dimensions", async () => {
  assert.deepEqual(await pngDimensions("public/icons/icon-192.png"), { width: 192, height: 192 });
  assert.deepEqual(await pngDimensions("public/icons/icon-512.png"), { width: 512, height: 512 });
  assert.deepEqual(await pngDimensions("public/icons/apple-touch-icon.png"), { width: 180, height: 180 });
});

test("service worker versions the shell and supports safe activation", async () => {
  const source = await readFile(path.join(projectRoot, "public/sw.js"), "utf8");

  assert.match(source, /lionlog-shell-/);
  assert.match(source, /v0\.1\.0-alpha\.2/);
  assert.match(source, /caches\.delete/);
  assert.match(source, /request\.mode === "navigate"/);
  assert.match(source, /caches\.match\(SCOPE_URL\)/);
  assert.match(source, /SKIP_WAITING/);
});
