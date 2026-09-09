import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseVersion = "0.2.0-alpha.4";

async function pngDimensions(relativePath) {
  const data = await readFile(path.join(projectRoot, relativePath));
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

test("manifest defines a relative standalone application shell", async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "public/manifest.webmanifest"), "utf8"));

  assert.equal(manifest.id, "./");
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
  assert.match(source, /__LIONLOG_SHELL_REVISION__/);
  assert.match(source, /Promise\.all\(/);
  assert.doesNotMatch(source, /Promise\.allSettled\(/);
  assert.match(source, /caches\.delete/);
  assert.match(source, /request\.mode === "navigate"/);
  assert.match(source, /cache\.match\(SCOPE_URL\)/);
  assert.match(source, /SKIP_WAITING/);
  assert.match(source, /menu-data/);
});

test("service worker refuses redirected, cross-origin, or unmarked navigation documents", async () => {
  const source = await readFile(path.join(projectRoot, "public/sw.js"), "utf8");

  assert.match(source, /isExpectedApplicationDocument/);
  assert.match(source, /response\.redirected/);
  assert.match(source, /response\.type === "opaqueredirect"/);
  assert.match(source, /!isWithinApplicationScope\(responseUrl\)/);
  assert.match(source, /contentType\.includes\("text\/html"\)/);
  assert.match(source, /data-lionlog-shell="\$\{SHELL_REVISION\}"/);
  assert.match(source, /if \(await isExpectedApplicationDocument\(response\)\)/);
});

test("application-document verification accepts only the marked LionLog response", async () => {
  const shellRevision = "a".repeat(40);
  const source = (await readFile(path.join(projectRoot, "public/sw.js"), "utf8"))
    .replaceAll("__LIONLOG_SHELL_REVISION__", shellRevision);
  const context = {
    URL,
    TextEncoder,
    self: {
      addEventListener() {},
      location: { origin: "https://lionlog.example" },
      registration: { scope: "https://lionlog.example/" },
    },
  };
  vm.runInNewContext(source, context);

  function documentResponse({
    body = `<html data-lionlog-shell="${shellRevision}"></html>`,
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

test("service-worker installation fails when any offline startup asset is unavailable", async () => {
  const shellRevision = "a".repeat(40);
  const source = (await readFile(path.join(projectRoot, "public/sw.js"), "utf8"))
    .replaceAll("__LIONLOG_SHELL_REVISION__", shellRevision);
  const cached = [];
  const cache = { put: async (url) => cached.push(String(url)), match: async () => null };
  const context = {
    URL,
    TextEncoder,
    Response,
    caches: { open: async () => cache, keys: async () => [] },
    fetch: async (url) => {
      const href = String(url);
      if (href === "https://lionlog.example/lionlog/") {
        const body = `<html data-lionlog-shell="${shellRevision}"><script src="/lionlog/_next/app.js"></script></html>`;
        return {
          ok: true,
          redirected: false,
          type: "basic",
          url: href,
          headers: new Headers({ "content-type": "text/html" }),
          clone: () => ({ text: async () => body }),
          text: async () => body,
        };
      }
      return {
        ok: !href.includes("_next/app.js"),
        redirected: false,
        type: "basic",
        url: href,
        clone: () => ({}),
      };
    },
    self: {
      addEventListener() {},
      clients: { claim: async () => {} },
      location: { origin: "https://lionlog.example" },
      registration: { scope: "https://lionlog.example/lionlog/" },
    },
  };
  vm.runInNewContext(source, context);
  await assert.rejects(context.cacheApplicationShell(), /asset was unavailable/);
  assert.ok(cached.includes("https://lionlog.example/lionlog/"));
});

test("service-worker lifecycle scopes caches and preserves the active shell across interrupted update and rollback", async () => {
  const sourceTemplate = await readFile(path.join(projectRoot, "public/sw.js"), "utf8");
  const cacheName = (scope, revision) => `lionlog-shell-v2-${Buffer.from(scope).toString("hex")}-${revision}`;
  const foreignCaches = [
    cacheName("/lionlog-other/", "c".repeat(40)),
    cacheName("/", "d".repeat(40)),
    cacheName("/root/", "e".repeat(40)),
    "lionlog-shell-unrelated-a",
  ];
  const cacheNames = new Set(foreignCaches);
  const cacheContents = new Map();
  const deleted = [];
  const caches = {
    async open(name) {
      cacheNames.add(name);
      if (!cacheContents.has(name)) cacheContents.set(name, new Map());
      const values = cacheContents.get(name);
      return {
        async put(key, response) { values.set(String(key), response); },
        async match(key) { return values.get(String(key)) ?? null; },
      };
    },
    async keys() { return [...cacheNames]; },
    async delete(name) { deleted.push(name); cacheNames.delete(name); cacheContents.delete(name); return true; },
  };

  async function runLifecycle(revision, { failAsset = false, scopePath = "/lionlog/" } = {}) {
    const handlers = {};
    const source = sourceTemplate.replaceAll("__LIONLOG_SHELL_REVISION__", revision);
    const context = {
      URL,
      TextEncoder,
      Response,
      caches,
      fetch: async (input) => {
        const href = String(input);
        const isShell = href === `https://lionlog.example${scopePath}`;
        const body = isShell
          ? `<html data-lionlog-shell="${revision}"><script src="${scopePath}_next/app.js"></script><script src="/other/app.js"></script></html>`
          : "asset";
        return {
          ok: !(failAsset && href.includes("_next/app.js")),
          redirected: false,
          type: "basic",
          url: href,
          headers: new Headers({ "content-type": isShell ? "text/html" : "text/javascript" }),
          clone: () => ({ text: async () => body }),
          text: async () => body,
        };
      },
      self: {
        addEventListener(name, handler) { handlers[name] = handler; },
        clients: { claim: async () => {} },
        location: { origin: "https://lionlog.example" },
        registration: { scope: `https://lionlog.example${scopePath}` },
        skipWaiting: async () => {},
      },
    };
    vm.runInNewContext(source, context);
    let installation;
    handlers.install({ waitUntil(value) { installation = value; } });
    await installation;
    let activation;
    handlers.activate({ waitUntil(value) { activation = value; } });
    await activation;
    return handlers;
  }

  const revisionA = "a".repeat(40);
  const revisionB = "b".repeat(40);
  const handlersA = await runLifecycle(revisionA);
  assert.ok(cacheNames.has(cacheName("/lionlog/", revisionA)));
  assert.ok(foreignCaches.every((name) => cacheNames.has(name)));
  assert.ok(!cacheContents.get(cacheName("/lionlog/", revisionA)).has("https://lionlog.example/other/app.js"));
  for (const requestUrl of ["https://lionlog.example/lionlog/api", "https://lionlog.example/lionlog/api/menu", "https://lionlog.example/other/app.js"]) {
    let responded = false;
    handlersA.fetch({
      request: { method: "GET", mode: "cors", url: requestUrl },
      respondWith() { responded = true; },
    });
    assert.equal(responded, false, `service worker must ignore ${requestUrl}`);
  }

  await assert.rejects(runLifecycle(revisionB, { failAsset: true }), /asset was unavailable/);
  assert.ok(cacheNames.has(cacheName("/lionlog/", revisionA)), "the old active shell survives interrupted installation");
  assert.ok(foreignCaches.every((name) => cacheNames.has(name)));

  await runLifecycle(revisionB);
  assert.ok(!cacheNames.has(cacheName("/lionlog/", revisionA)));
  assert.ok(cacheNames.has(cacheName("/lionlog/", revisionB)));
  assert.ok(foreignCaches.every((name) => cacheNames.has(name)));

  await runLifecycle(revisionA);
  assert.ok(cacheNames.has(cacheName("/lionlog/", revisionA)));
  assert.ok(!cacheNames.has(cacheName("/lionlog/", revisionB)));
  assert.ok(foreignCaches.every((name) => cacheNames.has(name)));

  const rootOld = cacheName("/", "f".repeat(40));
  cacheNames.add(rootOld);
  await runLifecycle(revisionA, { scopePath: "/" });
  assert.ok(!cacheNames.has(rootOld));
  assert.ok(cacheNames.has(cacheName("/", revisionA)));
  assert.ok(cacheNames.has(cacheName("/root/", "e".repeat(40))));
  assert.ok(deleted.every((name) => [cacheName("/lionlog/", revisionA), cacheName("/lionlog/", revisionB), cacheName("/", "d".repeat(40)), rootOld].includes(name)));
});

test("release version and brand colors stay consistent across the PWA surface", async () => {
  const [packageJson, manifest, layout, mealBuilder, pwaRegister, serviceWorker, styles] = await Promise.all([
    readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "public/manifest.webmanifest"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "app/layout.tsx"), "utf8"),
    readFile(path.join(projectRoot, "app/meal-builder.tsx"), "utf8"),
    readFile(path.join(projectRoot, "app/pwa-register.tsx"), "utf8"),
    readFile(path.join(projectRoot, "public/sw.js"), "utf8"),
    readFile(path.join(projectRoot, "app/globals.css"), "utf8"),
  ]);

  assert.equal(packageJson.version, releaseVersion);
  assert.match(layout, /data-lionlog-shell=\{process\.env\.LIONLOG_SHELL_REVISION/);
  assert.match(mealBuilder, new RegExp(`v${releaseVersion.replaceAll(".", "\\.")}`));
  assert.match(mealBuilder, /snapshot is partial/i);
  assert.match(mealBuilder, /trustworthy display name/i);
  assert.match(serviceWorker, /CACHE_NAME = `\$\{CACHE_PREFIX\}\$\{SCOPE_KEY\}-\$\{SHELL_REVISION\}`/);
  assert.match(pwaRegister, /retained validated menus remain available when saved/i);
  assert.doesNotMatch(pwaRegister, /installed sample menu remains available/i);
  assert.equal(manifest.theme_color, "#001E44");
  assert.equal(manifest.background_color, "#FFFFFF");
  for (const color of ["#001E44", "#1E407C", "#FFFFFF", "#96BEE6"]) {
    assert.match(styles, new RegExp(color, "i"));
  }
  for (const retiredColor of ["#255d49", "#e86b35", "#deede3", "#97b6a9", "#f3f9f5"]) {
    assert.doesNotMatch(styles, new RegExp(retiredColor, "i"));
  }
});

test("production builds are static and accept only a bounded root or single-segment application base path", async () => {
  const [layout, nextConfig, packageJson, normalizer, worker] = await Promise.all([
    readFile(path.join(projectRoot, "app/layout.tsx"), "utf8"),
    readFile(path.join(projectRoot, "next.config.ts"), "utf8"),
    readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "scripts/normalize-build-base-path.ts"), "utf8"),
    readFile(path.join(projectRoot, "worker/index.ts"), "utf8"),
  ]);
  assert.match(nextConfig, /process\.env\.LIONLOG_BASE_PATH/);
  assert.match(nextConfig, /assetPrefix: publicBasePath/);
  assert.match(nextConfig, /output: "export"/);
  assert.doesNotMatch(nextConfig, /\n\s*basePath[,\s:]/);
  assert.match(nextConfig, /absolute single path segment/);
  assert.match(layout, /process\.env\.LIONLOG_PUBLIC_ORIGIN/);
  assert.match(layout, /metadataBase/);
  assert.doesNotMatch(layout, /next\/headers|x-forwarded-host|requestHeaders/);
  assert.match(packageJson.scripts.build, /normalize-build-base-path/);
  assert.match(normalizer, /nestedFrameworkAssets/);
  assert.match(normalizer, /rename\(nestedFrameworkAssets, frameworkAssets\)/);
  assert.match(normalizer, /html\.includes\(`\$\{basePath\}\/_next\//);
  assert.match(worker, /APPLICATION_BASE_PATH/);
  assert.match(worker, /\/_next\//);
});

test("browser bundle contains static delivery but no PSU retrieval or Node-only ingestion code", async () => {
  const clientDirectory = path.join(projectRoot, "dist", "client");
  const files = await javascriptFiles(clientDirectory);
  const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assert.match(source, /lionlog-menu-data-v2/);
  for (const forbidden of [
    "PsuHttpRetriever",
    "parsePsuMenuHtml",
    "retrieveNutrition",
    "minimumIntervalMs",
    "node:fs",
    "node:crypto",
  ]) assert.doesNotMatch(source, new RegExp(forbidden));
});

test("live and Pages workflows are explicit, bounded, and ordinary CI cannot invoke ingestion or deployment", async () => {
  const [manualWorkflow, pagesWorkflow, deploymentWorkflow, ciWorkflow] = await Promise.all([
    readFile(path.join(projectRoot, ".github/workflows/build-live-menu-artifact.yml"), "utf8"),
    readFile(path.join(projectRoot, ".github/workflows/build-pages-artifact.yml"), "utf8"),
    readFile(path.join(projectRoot, ".github/workflows/deploy-github-pages.yml"), "utf8"),
    readFile(path.join(projectRoot, ".github/workflows/ci.yml"), "utf8"),
  ]);
  assert.match(manualWorkflow, /workflow_dispatch:/);
  assert.match(manualWorkflow, /PREPARE_LIVE_PAGES_FIELD_RELEASE/);
  assert.match(manualWorkflow, /github\.repository == 'CrunchyBrunch\/lionlog'/);
  assert.match(manualWorkflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(manualWorkflow, /expected_source_sha/);
  assert.match(manualWorkflow, /expected_run_attempt/);
  assert.match(manualWorkflow, /validate:psu-release-cache/);
  assert.doesNotMatch(manualWorkflow, /deploy-pages|pages:\s*write|id-token:\s*write/);
  assert.match(manualWorkflow, /actions\/upload-artifact@/);
  assert.match(manualWorkflow, /name: lionlog-live-/);
  assert.match(manualWorkflow, /name: lionlog-first-release-recovery-/);
  assert.match(manualWorkflow, /create-publication-bundle\.ts/);
  assert.match(manualWorkflow, /create-candidate-receipt\.ts/);
  assert.match(manualWorkflow, /retention-days: 90/);
  assert.doesNotMatch(manualWorkflow, /^\s*(?:schedule|push|pull_request):/m);
  assert.doesNotMatch(ciWorkflow, /ingest:psu|LIONLOG_ALLOW_PSU_NETWORK/);
  assert.match(pagesWorkflow, /workflow_dispatch:/);
  assert.match(pagesWorkflow, /LIONLOG_BASE_PATH: \/lionlog/);
  assert.match(pagesWorkflow, /LIONLOG_PUBLIC_ORIGIN: https:\/\/crunchybrunch\.github\.io/);
  assert.match(pagesWorkflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(pagesWorkflow, /name: github-pages-review/);
  assert.match(pagesWorkflow, /prepare-pages-artifact\.ts/);
  assert.match(pagesWorkflow, /round-trip/);
  assert.match(pagesWorkflow, /grep -c '\^\.\/\.nojekyll\$'/);
  assert.doesNotMatch(pagesWorkflow, /actions\/upload-pages-artifact/);
  assert.doesNotMatch(pagesWorkflow, /ingest:psu|LIONLOG_ALLOW_PSU_NETWORK|deploy-pages|pages:\s*write|id-token:\s*write/);
  assert.doesNotMatch(pagesWorkflow, /^\s*(?:schedule|push|pull_request):/m);

  assert.match(deploymentWorkflow, /workflow_dispatch:/);
  assert.match(deploymentWorkflow, /^permissions: \{\}$/m);
  assert.match(deploymentWorkflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(deploymentWorkflow, /permissions:\r?\n\s+contents: read/);
  assert.match(deploymentWorkflow, /pages: write/);
  assert.match(deploymentWorkflow, /id-token: write/);
  assert.match(deploymentWorkflow, /environment:\r?\n\s+name: github-pages/);
  assert.match(deploymentWorkflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(deploymentWorkflow, /source_artifact_id/);
  assert.match(deploymentWorkflow, /source_artifact_digest/);
  assert.match(deploymentWorkflow, /source_manifest_digest/);
  assert.match(deploymentWorkflow, /expected_current_attempt_release_id/);
  assert.match(deploymentWorkflow, /rollback_target_receipt_artifact_id/);
  assert.match(deploymentWorkflow, /deployments: write/);
  assert.match(deploymentWorkflow, /final-promotion-gate\.mjs/);
  assert.match(deploymentWorkflow, /verify-publication-bundle\.ts/);
  assert.match(deploymentWorkflow, /deploy-exact-pages-artifact\.mjs/);
  assert.match(deploymentWorkflow, /cancel-in-progress: false/);
  assert.doesNotMatch(deploymentWorkflow, /npm run build|vinext build|prepare:psu-field-release/);
  assert.doesNotMatch(deploymentWorkflow, /ingest:psu|LIONLOG_ALLOW_PSU_NETWORK|LIVE_PSU_INGESTION/);
  assert.doesNotMatch(deploymentWorkflow, /^\s*(?:schedule|push|pull_request):/m);
});

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(filePath) : entry.name.endsWith(".js") ? [filePath] : [];
  }));
  return nested.flat();
}
