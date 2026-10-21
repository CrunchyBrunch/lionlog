import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = (name) => readFile(path.join(root, ".github", "workflows", name), "utf8");

test("writer credential is bound to a production-restricted environment", async () => {
  const source = await workflow("advance-refresh-checkpoint.yml");
  assert.match(source, /advance:\r?\n(?:.|\r?\n)*?environment:\r?\n\s+name: lionlog-publication-writer/);
  assert.match(source, /actions\/create-github-app-token@[a-f0-9]{40}/);
  assert.match(source, /client-id: \$\{\{ vars\.LIONLOG_PUBLICATION_APP_CLIENT_ID \}\}/);
  assert.match(source, /private-key: \$\{\{ secrets\.LIONLOG_PUBLICATION_APP_PRIVATE_KEY \}\}/);
  assert.match(source, /permission-contents: write/);
  assert.match(source, /permission-actions: read/);
  assert.match(source, /LIONLOG_PUBLICATION_WRITER_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  assert.match(source, /LIONLOG_PUBLICATION_APP_SLUG: \$\{\{ steps\.app-token\.outputs\.app-slug \}\}/);
  assert.doesNotMatch(source, /secrets\.LIONLOG_PUBLICATION_WRITER_TOKEN/);
  assert.match(source, /github\.ref == vars\.LIONLOG_PRODUCTION_REF/);
  assert.match(source, /github\.sha == vars\.LIONLOG_PRODUCTION_SHA/);
});

test("preactivation bootstrap requires the same protected App environment and exact identities", async () => {
  const source = await workflow("bootstrap-publication-checkpoint.yml");
  assert.match(source, /name: lionlog-publication-writer/);
  assert.match(source, /vars\.LIONLOG_REFRESH_ACTIVATION != 'ENABLE_AUTOMATIC_LIONLOG_REFRESH'/);
  assert.match(source, /github\.sha == vars\.LIONLOG_PRODUCTION_SHA/);
  assert.match(source, /github\.workflow_ref == format\('\{0\}\/\.github\/workflows\/bootstrap-publication-checkpoint\.yml@\{1\}'/);
  assert.match(source, /permission-contents: write/);
  assert.match(source, /LIONLOG_PUBLICATION_WRITER_TOKEN: \$\{\{ steps\.app-token\.outputs\.token \}\}/);
  assert.match(source, /--expected-root-sha="\$ROOT_SHA"/);
  assert.match(source, /--expected-source-sha="\$SOURCE_SHA"/);
});

test("default-branch scheduler only checks out and installs the immutable production revision", async () => {
  const source = await workflow("daily-publication.yml");
  assert.match(source, /ref: \$\{\{ vars\.LIONLOG_PRODUCTION_SHA \}\}/);
  assert.match(source, /git\/ref\/\$\{PRODUCTION_REF#refs\/\}/);
  assert.match(source, /git rev-parse HEAD/);
  assert.match(source, /npm ci --ignore-scripts --omit=dev/);
  assert.match(source, /node --experimental-strip-types scripts\/run-daily-publication\.ts/);
  assert.doesNotMatch(source, /persist-credentials: true/);
});
