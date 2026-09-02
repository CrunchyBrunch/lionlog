import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the unavailable live shell without a sample fallback", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Build a meal \| LionLog<\/title>/i);
  assert.match(html, /A practical plate, built around your target/i);
  assert.match(html, /Whole dining hall/i);
  assert.match(html, /PSU snapshots/i);
  assert.match(html, /No validated live or saved menu is available/i);
  assert.doesNotMatch(html, /Herb roasted chicken/i);
  assert.match(html, /rel="manifest" href="\.\/manifest\.webmanifest"/i);
  assert.match(html, /rel="apple-touch-icon"[^>]+href="\.\/icons\/apple-touch-icon\.png"/i);
  assert.match(html, /name="theme-color" content="#001E44"/i);
  assert.match(html, /<html[^>]+data-lionlog-shell="v0\.2\.0-alpha\.4"/i);
  const viewportTag = html.match(/<meta[^>]+name="viewport"[^>]*>/i)?.[0] ?? "";
  assert.match(viewportTag, /width=device-width/i);
  assert.match(viewportTag, /initial-scale=1/i);
  assert.match(viewportTag, /viewport-fit=cover/i);
  assert.match(html, /v0\.2\.0-alpha\.4/i);
  assert.match(html, /apple-mobile-web-app-status-bar-style" content="black-translucent"/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});
