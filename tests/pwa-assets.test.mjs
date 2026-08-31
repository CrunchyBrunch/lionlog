import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseVersion = "0.2.0-alpha.2";

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
  assert.equal(manifest.theme_color, "#001E44");
  assert.equal(manifest.background_color, "#FFFFFF");
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
  assert.deepEqual(await pngDimensions("public/og.png"), { width: 1731, height: 909 });
});

test("service worker versions the shell and supports safe activation", async () => {
  const source = await readFile(path.join(projectRoot, "public/sw.js"), "utf8");

  assert.match(source, /lionlog-shell-/);
  assert.match(source, /v0\.2\.0-alpha\.2/);
  assert.match(source, /caches\.delete/);
  assert.match(source, /request\.mode === "navigate"/);
  assert.match(source, /caches\.match\(SCOPE_URL\)/);
  assert.match(source, /SKIP_WAITING/);
});

test("service worker refuses redirected, cross-origin, or unmarked navigation documents", async () => {
  const source = await readFile(path.join(projectRoot, "public/sw.js"), "utf8");

  assert.match(source, /isExpectedApplicationDocument/);
  assert.match(source, /response\.redirected/);
  assert.match(source, /response\.type === "opaqueredirect"/);
  assert.match(source, /responseUrl\.origin !== self\.location\.origin/);
  assert.match(source, /contentType\.includes\("text\/html"\)/);
  assert.match(source, /data-lionlog-shell="v0\.2\.0-alpha\.2"/);
  assert.match(source, /if \(await isExpectedApplicationDocument\(response\)\)/);
});

test("application-document verification accepts only the marked LionLog response", async () => {
  const source = await readFile(path.join(projectRoot, "public/sw.js"), "utf8");
  const context = {
    URL,
    self: {
      addEventListener() {},
      location: { origin: "https://lionlog.example" },
      registration: { scope: "https://lionlog.example/" },
    },
  };
  vm.runInNewContext(source, context);

  function documentResponse({
    body = '<html data-lionlog-shell="v0.2.0-alpha.2"></html>',
    contentType = "text/html; charset=utf-8",
    redirected = false,
    type = "basic",
    url = "https://lionlog.example/",
  } = {}) {
    return {
      ok: true,
      redirected,
      type,
      url,
      headers: new Headers({ "content-type": contentType }),
      clone: () => ({ text: async () => body }),
    };
  }

  assert.equal(await context.isExpectedApplicationDocument(documentResponse()), true);
  assert.equal(await context.isExpectedApplicationDocument(documentResponse({ redirected: true })), false);
  assert.equal(await context.isExpectedApplicationDocument(documentResponse({ type: "opaqueredirect" })), false);
  assert.equal(await context.isExpectedApplicationDocument(documentResponse({ url: "https://signin.example/" })), false);
  assert.equal(await context.isExpectedApplicationDocument(documentResponse({ body: "<html>Sign in</html>" })), false);
  assert.equal(await context.isExpectedApplicationDocument(documentResponse({ contentType: "application/json" })), false);
});

test("release version and brand colors stay consistent across the PWA surface", async () => {
  const [packageJson, manifest, layout, mealBuilder, serviceWorker, styles] = await Promise.all([
    readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "public/manifest.webmanifest"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "app/layout.tsx"), "utf8"),
    readFile(path.join(projectRoot, "app/meal-builder.tsx"), "utf8"),
    readFile(path.join(projectRoot, "public/sw.js"), "utf8"),
    readFile(path.join(projectRoot, "app/globals.css"), "utf8"),
  ]);

  assert.equal(packageJson.version, releaseVersion);
  assert.match(layout, new RegExp(`data-lionlog-shell="v${releaseVersion.replaceAll(".", "\\.")}"`));
  assert.match(mealBuilder, new RegExp(`v${releaseVersion.replaceAll(".", "\\.")}`));
  assert.match(serviceWorker, new RegExp(`CACHE_NAME = .*v${releaseVersion.replaceAll(".", "\\.")}`));
  assert.equal(manifest.theme_color, "#001E44");
  assert.equal(manifest.background_color, "#FFFFFF");
  for (const color of ["#001E44", "#1E407C", "#FFFFFF", "#96BEE6"]) {
    assert.match(styles, new RegExp(color, "i"));
  }
  for (const retiredColor of ["#255d49", "#e86b35", "#deede3", "#97b6a9", "#f3f9f5"]) {
    assert.doesNotMatch(styles, new RegExp(retiredColor, "i"));
  }
});
