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
  assert.match(source, /--validate-run=work\/refresh-checkpoint\/run\.json/);
  assert.doesNotMatch(source, /\.head_branch == \$branch/);
});

test("default-branch discussion receiver checks out its audited commit and separately pins production", async () => {
  const source = await workflow("daily-publication.yml");
  assert.match(source, /discussion_comment:\r?\n\s+types: \[created\]/);
  assert.match(source, /schedule:\r?\n\s+- cron: '17 5 \* \* \*'/);
  assert.match(source, /github\.event_name == 'schedule' && vars\.LIONLOG_DISPATCH_MODE != 'external'/);
  assert.match(source, /github\.event_name == 'discussion_comment' && vars\.LIONLOG_DISPATCH_MODE == 'external'/);
  assert.match(source, /vars\.LIONLOG_EXTERNAL_DISPATCH_ACTIVATION == 'ENABLE_LIONLOG_EXTERNAL_DISPATCH'/);
  assert.match(source, /vars\.LIONLOG_DISPATCH_PROBE_ACTIVATION != 'ENABLE_LIONLOG_DISPATCH_PROBE'/);
  assert.match(source, /vars\.LIONLOG_EXTERNAL_DISPATCH_ACTIVATION != 'ENABLE_LIONLOG_EXTERNAL_DISPATCH'/);
  assert.match(source, /github\.event\.sender\.id == vars\.LIONLOG_DISPATCHER_BOT_USER_ID/);
  assert.match(source, /github\.event\.comment\.user\.id == vars\.LIONLOG_DISPATCHER_BOT_USER_ID/);
  assert.match(source, /github\.event\.discussion\.node_id == vars\.LIONLOG_DISPATCH_DISCUSSION_NODE_ID/);
  assert.match(source, /github\.event\.comment\.updated_at == github\.event\.comment\.created_at/);
  assert.match(source, /jobs:\r?\n(?:.|\r?\n)*? {2}publish:\r?\n(?:.|\r?\n)*? {4}concurrency:\r?\n\s+group: lionlog-daily-dispatch/);
  assert.match(source, /group: lionlog-daily-dispatch\r?\n\s+queue: max\r?\n\s+cancel-in-progress: false/);
  assert.match(source, /node --experimental-strip-types receiver\/scripts\/shared-opportunity\.ts/g);
  assert.equal((source.match(/node --experimental-strip-types receiver\/scripts\/shared-opportunity\.ts/g) ?? []).length, 2);
  assert.match(source, /lionlog-day-reservation-\$\{\{ steps\.opportunity\.outputs\.service_date \}\}/);
  assert.match(source, /if-no-files-found: error/);
  assert.ok(source.indexOf('Persist the day reservation before any producer request')
    < source.indexOf('Recheck the shared day before producer dispatch'));
  assert.ok(source.indexOf('Recheck the shared day before producer dispatch')
    < source.indexOf('Dispatch and verify the one pinned daily sequence'));
  assert.match(source, /vars\.LIONLOG_DISPATCH_RECEIVER_SHA == github\.sha/);
  assert.match(source, /ref: \$\{\{ github\.event_name == 'schedule' && vars\.LIONLOG_PRODUCTION_SHA \|\| github\.sha \}\}/);
  assert.match(source, /discussions: read/);
  assert.match(source, /git\/ref\/\$\{PRODUCTION_REF#refs\/\}/);
  assert.match(source, /git -C production rev-parse HEAD/);
  assert.match(source, /path: receiver/);
  assert.match(source, /path: production/);
  assert.match(source, /working-directory: production/);
  assert.match(source, /npm ci --ignore-scripts --omit=dev/);
  assert.match(source, /node --experimental-strip-types scripts\/run-daily-publication\.ts/);
  assert.match(source, /lionlog-discussion-binding-\$\{\{ github\.run_id \}\}-1/);
  assert.doesNotMatch(source, /persist-credentials: true/);
});
