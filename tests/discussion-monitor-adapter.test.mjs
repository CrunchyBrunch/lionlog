import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../monitor/DispatchAdapter.gs', import.meta.url), 'utf8');
const sha = 'a'.repeat(40);
const productionSha = 'b'.repeat(40);
const day = '2026-11-10';
const started = '2026-11-10T10:18:00Z';
const receiver = { id: 77, path: '.github/workflows/daily-publication.yml', event: 'discussion_comment',
  run_attempt: 1, head_branch: 'main', head_sha: sha, actor: { id: 42 },
  display_title: 'LionLog wake 12345', status: 'in_progress', conclusion: null,
  created_at: '2026-11-10T10:17:00Z', run_started_at: started,
  updated_at: '2026-11-10T10:18:00Z' };
const child = (id, path) => ({ id, path, event: 'workflow_dispatch', run_attempt: 1,
  head_sha: productionSha, head_branch: 'production/daily-menus', status: 'completed', conclusion: 'success',
  created_at: '2026-11-10T10:20:00Z' });
const candidate = child(90, '.github/workflows/build-live-menu-artifact.yml');
const promotion = child(91, '.github/workflows/deploy-github-pages.yml');
const writer = child(92, '.github/workflows/advance-refresh-checkpoint.yml');
const binding = { version: 'lionlog.discussion-binding.v1', stage: 'complete', serviceDate: day,
  commentId: 12345, commentNodeId: 'DC_kwABC123', receiverRunId: 77, receiverSha: sha,
  candidateRunId: 90, promotionRunId: 91, checkpointRunId: 92, releaseId: 'c'.repeat(64) };
const proof = { completeEvidence: true, knownGood: false, integrity: 'pending', publishedDate: '2026-10-30',
  freshUntil: Date.parse('2026-11-10T23:00:00Z'), admittedBeforeCutoff: true };

function fixture({ mode = 'external', run = receiver, legacyRun = null, artifact = false, historyGap = false,
  producer = [], promotionRuns = [], writerRuns = [], digestMismatch = false } = {}) {
  const properties = new Map([
    ['LIONLOG_MONITOR_GITHUB_TOKEN', 'read-only-token'], ['LIONLOG_MONITOR_DISPATCH_MODE', mode],
    ['LIONLOG_MONITOR_RECEIVER_SHA', sha], ['LIONLOG_MONITOR_BOT_USER_ID', '42'],
    ['LIONLOG_MONITOR_PRODUCTION_SHA', productionSha],
    ['LIONLOG_MONITOR_PRODUCTION_BRANCH', 'production/daily-menus']
  ]);
  const bytes = Buffer.from('synthetic zip bytes');
  const digest = 'sha256:' + createHash('sha256').update(bytes).digest('hex');
  const item = { id: 500, name: 'lionlog-discussion-binding-77-1', digest: digestMismatch ? 'sha256:' + '0'.repeat(64) : digest,
    expired: false, workflow_run: { id: 77, head_sha: sha } };
  const gets = [];
  const response = (code, value, headers = {}) => ({ getResponseCode: () => code,
    getContentText: () => JSON.stringify(value), getHeaders: () => headers,
    getBlob: () => ({ getBytes: () => Array.from(bytes) }) });
  const context = {
    Date, Number, JSON, Object, Set, Array, Error, encodeURIComponent,
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties.get(key) ?? null }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: (_alg, raw) => Array.from(createHash('sha256').update(Buffer.from(raw)).digest()),
      formatDate: (_date, zone, format) => { assert.equal(zone, 'America/New_York');
        return format === 'yyyy-MM-dd' ? day : '10:20'; },
      unzip: () => [{ getName: () => 'discussion-binding.json', getDataAsString: () => JSON.stringify(binding) }] },
    UrlFetchApp: { fetch: (url, options) => {
      gets.push({ url, options });
      assert.equal(options.method, 'get');
      if (url === 'https://signed.blob.core.windows.net/artifact') return response(200, {});
      assert.equal(options.headers.Authorization, 'Bearer read-only-token');
      if (url.endsWith('/zip')) return response(302, {}, { Location: 'https://signed.blob.core.windows.net/artifact' });
      if (url.includes('/artifacts?')) return response(200,
        { total_count: artifact ? 1 : 0, artifacts: artifact ? [item] : [] });
      if (url.endsWith('/runs/77')) return response(200, run);
      if (url.endsWith('/runs/70')) return response(200, legacyRun);
      if (url.endsWith('/runs/90')) return response(200, candidate);
      if (url.endsWith('/runs/91')) return response(200, promotion);
      if (url.endsWith('/runs/92')) return response(200, writer);
      if (url.includes('/runs?')) {
        let matches = [];
        if (url.includes('/daily-publication.yml/')) matches = url.includes('event=schedule')
          ? (mode === 'schedule' ? (run ? [run] : []) : (legacyRun ? [legacyRun] : []))
          : (mode === 'external' && run ? [run] : []);
        if (url.includes('/build-live-menu-artifact.yml/')) matches = producer;
        if (url.includes('/deploy-github-pages.yml/')) matches = promotionRuns;
        if (url.includes('/advance-refresh-checkpoint.yml/')) matches = writerRuns;
        return response(200, { total_count: historyGap ? matches.length + 1 : matches.length, workflow_runs: matches });
      }
      throw new Error(`Unexpected GET ${url}`);
    } }
  };
  vm.runInNewContext(source, context);
  return { collect: now => vm.runInNewContext(`collectLionLogMonitorEvidence(new Date(${JSON.stringify(now.toISOString())}), ${JSON.stringify(proof)})`, context),
    evaluate: (e, now, previous = []) => { context.fixtureEvidence = e; context.fixturePrevious = previous;
      return vm.runInNewContext(`evaluateLionLogDispatchPoll(fixtureEvidence, new Date(${JSON.stringify(now.toISOString())}), fixturePrevious)`, context); },
    gets, properties };
}

test('normal collector preserves legacy schedule mode and prior admission proof', () => {
  const schedule = { ...receiver, event: 'schedule', display_title: 'LionLog scheduled publication' };
  const f = fixture({ mode: 'schedule', run: schedule });
  const result = f.collect(new Date('2026-11-10T15:20:00Z'));
  assert.equal(result.mode, 'schedule');
  assert.equal(result.dispatchEvidence, 'complete');
  assert.equal(result.admittedBeforeCutoff, true);
  assert.equal(result.receiverRunId, 77);
});

test('normal collector shows live unbound stage and keeps admission unknown until proof', () => {
  const f = fixture({ producer: [candidate] });
  const now = new Date('2026-11-10T15:20:00Z');
  const result = f.collect(now);
  assert.equal(result.stage, 'producer-observed-unbound');
  assert.equal(result.dispatchEvidence, 'binding-pending');
  assert.equal(result.admittedBeforeCutoff, null);
  assert.deepEqual(Array.from(result.observedUnbound.producer), [90]);
  assert.deepEqual(Array.from(f.evaluate(result, now).events), []);
});

test('terminal failure alerts immediately; absent upload becomes missing only after lag', () => {
  const failed = { ...receiver, status: 'completed', conclusion: 'failure',
    updated_at: '2026-11-10T15:19:00Z' };
  const f = fixture({ run: failed });
  const now = new Date('2026-11-10T15:20:00Z');
  const pending = f.collect(now);
  assert.equal(pending.dispatchEvidence, 'binding-pending');
  assert.deepEqual(Array.from(f.evaluate(pending, now).events).map(x => x.key),
    ['workflow-failure', 'completion-freshness']);
  const late = f.collect(new Date('2026-11-10T15:30:00Z'));
  assert.equal(late.dispatchEvidence, 'binding-missing');
  assert.ok(f.evaluate(late, new Date('2026-11-10T15:30:00Z')).events.some(x => x.key === 'evidence-unavailable'));
});

test('normal collector verifies digest, binding and exact downstream run identities', () => {
  const f = fixture({ artifact: true, run: { ...receiver, status: 'completed', conclusion: 'success' } });
  const result = f.collect(new Date('2026-11-10T15:20:00Z'));
  assert.equal(result.dispatchEvidence, 'bound');
  assert.equal(result.stage, 'complete');
  assert.equal(result.checkpointRunId, 92);
  assert.ok(f.gets.every(x => x.options.method === 'get'));
  assert.throws(() => fixture({ artifact: true, digestMismatch: true }).collect(new Date('2026-11-10T15:20:00Z')),
    /digest/);
});

test('normal collector rejects incomplete history before interpreting absence', () => {
  assert.throws(() => fixture({ historyGap: true }).collect(new Date('2026-11-10T15:20:00Z')),
    /history incomplete/);
});

test('external monitor admits only an exact terminal skipped legacy run', () => {
  const skipped = { ...receiver, id: 70, event: 'schedule', status: 'completed', conclusion: 'skipped' };
  const f = fixture({ legacyRun: skipped });
  assert.deepEqual(Array.from(f.collect(new Date('2026-11-10T15:20:00Z')).skippedLegacyRunIds), [70]);
  assert.throws(() => fixture({ legacyRun: { ...skipped, conclusion: 'success' } })
    .collect(new Date('2026-11-10T15:20:00Z')), /Legacy schedule/);
});

test('external mode refuses an unset pin even when no receiver run exists', () => {
  const f = fixture({ run: null });
  f.properties.delete('LIONLOG_MONITOR_RECEIVER_SHA');
  assert.throws(() => f.collect(new Date('2026-11-10T15:20:00Z')), /pins are incomplete/);
});
