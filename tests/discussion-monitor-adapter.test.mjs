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
  run_attempt: 1, head_branch: 'main', head_sha: sha, actor: { id: 42, login: 'lionlog-dispatch[bot]' },
  display_title: `LionLog wake 12345 DC_kwABC123 D_kwABC123 lionlog-dispatch.v1:${day}`,
  status: 'in_progress', conclusion: null,
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
  freshUntil: Date.parse('2026-11-10T23:00:00Z'), admittedBeforeCutoff: true,
  candidateRunId: 90, releaseId: 'c'.repeat(64) };

function fixture({ mode = 'external', run = receiver, legacyRun = null, artifact = false, historyGap = false,
  producer = [], promotionRuns = [], writerRuns = [], digestMismatch = false,
  bindingValue = binding, proofValue = proof, candidateRun = candidate, promotionRun = promotion,
  writerRun = writer } = {}) {
  const properties = new Map([
    ['LIONLOG_MONITOR_GITHUB_TOKEN', 'read-only-token'], ['LIONLOG_MONITOR_DISPATCH_MODE', mode],
    ['LIONLOG_MONITOR_RECEIVER_SHA', sha], ['LIONLOG_MONITOR_BOT_USER_ID', '42'],
    ['LIONLOG_MONITOR_BOT_LOGIN', 'lionlog-dispatch[bot]'],
    ['LIONLOG_MONITOR_DISCUSSION_NODE_ID', 'D_kwABC123'],
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
        return format === 'yyyy-MM-dd' ? day : new Intl.DateTimeFormat('en-US', {
          timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).format(_date); },
      unzip: () => [{ getName: () => 'discussion-binding.json', getDataAsString: () => JSON.stringify(bindingValue) }] },
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
      if (url.endsWith('/runs/90')) return response(200, candidateRun);
      if (url.endsWith('/runs/91')) return response(200, promotionRun);
      if (url.endsWith('/runs/92')) return response(200, writerRun);
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
  return { collect: now => vm.runInNewContext(`collectLionLogMonitorEvidence(new Date(${JSON.stringify(now.toISOString())}), ${JSON.stringify(proofValue)})`, context),
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
  const now = new Date('2026-11-10T11:20:00Z');
  const result = f.collect(now);
  assert.equal(result.stage, 'producer-observed-unbound');
  assert.equal(result.dispatchEvidence, 'binding-pending');
  assert.equal(result.admittedBeforeCutoff, null);
  assert.deepEqual(Array.from(result.observedUnbound.producer), [90]);
  assert.ok(f.gets.some(x => x.url.includes('actor=lionlog-dispatch%5Bbot%5D')));
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
  const invalid = fixture({ artifact: true, digestMismatch: true }).collect(new Date('2026-11-10T15:20:00Z'));
  assert.equal(invalid.dispatchEvidence, 'unavailable');
  assert.equal(invalid.admittedBeforeCutoff, null);
});

test('incomplete dispatch history retains independent integrity and freshness alerts', () => {
  const now = new Date('2026-11-10T15:20:00Z');
  const f = fixture({ historyGap: true, proofValue: { ...proof, integrity: 'mismatch',
    freshUntil: Date.parse('2026-11-10T15:00:00Z') } });
  const evidence = f.collect(now);
  assert.equal(evidence.dispatchEvidence, 'unavailable');
  const events = f.evaluate(evidence, now).events;
  assert.ok(events.some(x => x.key === 'evidence-unavailable' && x.status === 'alert'));
  assert.ok(events.some(x => x.key === 'publication-integrity' && x.status === 'alert'));
  assert.ok(events.some(x => x.key === 'completion-freshness' && x.status === 'alert'));
});

test('external monitor admits only an exact terminal skipped legacy run', () => {
  const skipped = { ...receiver, id: 70, event: 'schedule', status: 'completed', conclusion: 'skipped' };
  const f = fixture({ legacyRun: skipped });
  assert.deepEqual(Array.from(f.collect(new Date('2026-11-10T15:20:00Z')).skippedLegacyRunIds), [70]);
  const invalid = fixture({ legacyRun: { ...skipped, conclusion: 'success' } })
    .collect(new Date('2026-11-10T15:20:00Z'));
  assert.equal(invalid.dispatchEvidence, 'unavailable');
  assert.equal(invalid.admittedBeforeCutoff, null);
});

test('external mode refuses an unset pin even when no receiver run exists', () => {
  const f = fixture({ run: null });
  f.properties.delete('LIONLOG_MONITOR_RECEIVER_SHA');
  assert.throws(() => f.collect(new Date('2026-11-10T15:20:00Z')), /pins are incomplete/);
});

test('bot activity on another Discussion does not become the monitored wake', () => {
  const other = { ...receiver,
    display_title: `LionLog wake 12345 DC_kwABC123 D_kwOTHER lionlog-dispatch.v1:${day}` };
  const f = fixture({ run: other });
  const result = f.collect(new Date('2026-11-10T15:20:00Z'));
  assert.equal(result.receiverRunId, null);
  assert.equal(result.stage, 'absent');
});

test('342-minute running receiver remains overdue with pending binding and no false recovery', () => {
  const now = new Date('2026-11-10T16:00:00Z');
  const aged = { ...receiver, run_started_at: '2026-11-10T10:18:00Z' };
  const f = fixture({ run: aged });
  const evidence = f.collect(now);
  assert.equal(evidence.dispatchEvidence, 'binding-pending');
  const fresh = f.evaluate(evidence, now).events;
  assert.ok(fresh.some(x => x.key === 'completion-freshness' && x.status === 'alert'));
  const prior = f.evaluate(evidence, now, ['completion-freshness']).events;
  assert.ok(!prior.some(x => x.key === 'completion-freshness' && x.status === 'recovery'));
});

test('queued receiver raises the 10:00 warning even with a workflow timestamp', () => {
  const now = new Date('2026-11-10T15:20:00Z');
  const f = fixture({ run: { ...receiver, status: 'queued' } });
  const evidence = f.collect(now);
  assert.equal(evidence.dispatchEvidence, 'binding-pending');
  assert.equal(evidence.startedAt, null);
  assert.ok(f.evaluate(evidence, now).events.some(x =>
    x.key === 'morning-start' && x.status === 'alert'));
});

test('independent public mismatch alerts while binding is pending', () => {
  const f = fixture({ proofValue: { ...proof, integrity: 'mismatch' } });
  const now = new Date('2026-11-10T15:20:00Z');
  assert.ok(f.evaluate(f.collect(now), now).events.some(x =>
    x.key === 'publication-integrity' && x.status === 'alert'));
});

test('unknown binding and pending public proof never recover open incidents', () => {
  const f = fixture();
  const now = new Date('2026-11-10T11:20:00Z');
  const evidence = f.collect(now);
  const prior = ['evidence-unavailable', 'completion-freshness', 'publication-integrity'];
  const events = f.evaluate(evidence, now, prior).events;
  assert.ok(!events.some(x => x.status === 'recovery' && prior.includes(x.key)));
});

test('admission needs two positive matching candidate IDs', () => {
  const admitted = { version: binding.version, stage: 'admitted', serviceDate: day,
    commentId: binding.commentId, commentNodeId: binding.commentNodeId,
    receiverRunId: binding.receiverRunId, receiverSha: binding.receiverSha };
  const f = fixture({ artifact: true, run: { ...receiver, status: 'completed', conclusion: 'failure' },
    bindingValue: admitted, proofValue: { ...proof, candidateRunId: undefined } });
  assert.equal(f.collect(new Date('2026-11-10T15:20:00Z')).admittedBeforeCutoff, null);
  const mismatch = fixture({ artifact: true, run: { ...receiver, status: 'completed', conclusion: 'success' },
    proofValue: { ...proof, candidateRunId: 999 } });
  assert.equal(mismatch.collect(new Date('2026-11-10T15:20:00Z')).admittedBeforeCutoff, null);
});

test('candidate mismatch cannot recover evidence or admission on a fresh public release', () => {
  const now = new Date('2026-11-10T17:30:00Z');
  const f = fixture({ artifact: true,
    run: { ...receiver, status: 'completed', conclusion: 'success' },
    proofValue: { ...proof, candidateRunId: 999, knownGood: true,
      integrity: 'match', publishedDate: day } });
  const evidence = f.collect(now);
  assert.equal(evidence.dispatchEvidence, 'conflict');
  const events = f.evaluate(evidence, now, ['evidence-unavailable', 'final-admission']).events;
  assert.ok(!events.some(x => x.status === 'recovery'));
});

test('wrong bound comment node cannot recover evidence or admission', () => {
  const now = new Date('2026-11-10T17:30:00Z');
  const f = fixture({ artifact: true,
    run: { ...receiver, status: 'completed', conclusion: 'success' },
    bindingValue: { ...binding, commentNodeId: 'DC_kwOTHER' },
    proofValue: { ...proof, knownGood: true, integrity: 'match', publishedDate: day } });
  const evidence = f.collect(now);
  assert.notEqual(evidence.dispatchEvidence, 'bound');
  assert.equal(evidence.admittedBeforeCutoff, null);
  const events = f.evaluate(evidence, now, ['evidence-unavailable', 'final-admission']).events;
  assert.ok(!events.some(x => x.status === 'recovery'));
});

test('matching bound candidate and comment recover evidence and admission', () => {
  const now = new Date('2026-11-10T17:30:00Z');
  const f = fixture({ artifact: true,
    run: { ...receiver, status: 'completed', conclusion: 'success' },
    proofValue: { ...proof, knownGood: true, integrity: 'match', publishedDate: day } });
  const evidence = f.collect(now);
  assert.equal(evidence.admittedBeforeCutoff, true);
  assert.equal(evidence.dispatchEvidence, 'bound');
  const events = f.evaluate(evidence, now, ['evidence-unavailable', 'final-admission']).events;
  assert.deepEqual(Array.from(events, x => [x.key, x.status]),
    [['evidence-unavailable', 'recovery'], ['final-admission', 'recovery']]);
});

test('receiver failure and contradictory complete binding still expose public mismatch', () => {
  const now = new Date('2026-11-10T15:20:00Z');
  const f = fixture({ artifact: true,
    run: { ...receiver, status: 'completed', conclusion: 'failure' },
    proofValue: { ...proof, integrity: 'mismatch' } });
  const evidence = f.collect(now);
  assert.equal(evidence.failed, true);
  const events = f.evaluate(evidence, now).events;
  assert.ok(events.some(x => x.key === 'workflow-failure' && x.status === 'alert'));
  assert.ok(events.some(x => x.key === 'publication-integrity' && x.status === 'alert'));
});

test('failed writer and claimed complete stage become explicit conflict and failure', () => {
  const f = fixture({ artifact: true, run: { ...receiver, status: 'completed', conclusion: 'success' },
    writerRun: { ...writer, conclusion: 'failure' },
    proofValue: { ...proof, knownGood: true, integrity: 'match', publishedDate: day } });
  const now = new Date('2026-11-10T15:20:00Z');
  const evidence = f.collect(now);
  assert.equal(evidence.dispatchEvidence, 'conflict');
  assert.equal(evidence.stage, 'evidence-conflict');
  assert.equal(evidence.failed, true);
  assert.ok(f.evaluate(evidence, now).events.some(x => x.key === 'workflow-failure'));
  assert.ok(!f.evaluate(evidence, now, ['workflow-failure', 'evidence-unavailable']).events.some(x =>
    x.status === 'recovery'));
});
