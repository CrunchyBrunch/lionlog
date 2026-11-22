import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const repoFile = path => new URL('../' + path, import.meta.url);
const read = path => readFileSync(repoFile(path), 'utf8').replace(/\r\n/g, '\n');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const day = '2026-11-21';
const state = 'a'.repeat(40);
const parent = 'b'.repeat(40);
const productionSha = 'c'.repeat(40);
const receiverSha = 'd'.repeat(40);
const releaseId = 'e'.repeat(64);
const workflowPath = '.github/workflows/daily-publication.yml';
const prodBranch = 'production/daily-menus';
const when = '2026-11-21T13:00:00Z';
const recipient = 'fixture-recipient@example.invalid';
const dateFmt = (d, zone, format) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map(p => [p.type, p.value]));
  return format === 'yyyy-MM-dd' ? [parts.year, parts.month, parts.day].join('-')
    : parts.hour + ':' + parts.minute;
};

function patchedHost() {
  const dir = mkdtempSync(join(tmpdir(), 'lionlog-monitor-test-'));
  try {
    const source = read('tests/fixtures/hosted-monitor-Code.gs');
    assert.equal(hash(source), '6b8827f77d50341260be37415f904034033445875810bf3d9c7fce1598d535ea');
    writeFileSync(join(dir, 'Code.gs'), source.replace('monitor-recipient@example.invalid', recipient));
    execFileSync('git', ['apply', '--no-index', fileURLToPath(repoFile('monitor/hosted-Code.gs.patch'))], { cwd: dir });
    return readFileSync(join(dir, 'Code.gs'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const receiver = { id: 77, path: workflowPath, event: 'discussion_comment', run_attempt: 1,
  head_branch: 'main', head_sha: receiverSha, status: 'completed', conclusion: 'success',
  actor: { id: 42, login: 'lionlog-dispatch[bot]' },
  display_title: 'LionLog wake 123 DC_fixture D_fixture lionlog-dispatch.v1:' + day,
  created_at: '2026-11-21T12:58:00Z', run_started_at: when, updated_at: '2026-11-21T13:10:00Z' };
const child = (id, file) => ({ id, path: '.github/workflows/' + file, event: 'workflow_dispatch',
  run_attempt: 1, head_branch: prodBranch, head_sha: productionSha, status: 'completed',
  conclusion: 'success', created_at: '2026-11-21T13:01:00Z', run_started_at: '2026-11-21T13:02:00Z' });
const candidate = child(90, 'build-live-menu-artifact.yml');
const promotion = child(91, 'deploy-github-pages.yml');
const writer = child(92, 'advance-refresh-checkpoint.yml');
const admission = { name: 'Verify automatic due date, publication state, complete run accounting, and remaining budget',
  status: 'completed', conclusion: 'success', started_at: '2026-11-21T13:03:00Z', completed_at: '2026-11-21T13:04:00Z' };
const binding = { version: 'lionlog.discussion-binding.v1', stage: 'complete', serviceDate: day,
  commentId: 123, commentNodeId: 'DC_fixture', receiverRunId: 77, receiverSha,
  candidateRunId: 90, promotionRunId: 91, checkpointRunId: 92, releaseId };
const zip = Buffer.from('synthetic binding archive');
const publicBody = JSON.stringify({ releaseId });

function fixture({ mode = 'external', run = receiver, proofDate = day, proofPromotion = 91, proofCandidate = 90,
  signed = true, verified = true, tamperedManifest = false, step = admission, bound = binding,
  brokenCollector = false, mailThrows = false, previous = {}, now = '2026-11-21T17:28:00Z',
  writerRun = writer, observedMarker = publicBody, originalHost = false } = {}) {
  const props = new Map(Object.entries({
    MONITOR_TOKEN: 'synthetic-read-only-token',
    TOKEN_EXPIRES_UTC: '2026-11-22T00:00:00Z',
    LIONLOG_MONITOR_DISPATCH_MODE: mode,
    LIONLOG_MONITOR_RECEIVER_SHA: receiverSha,
    LIONLOG_MONITOR_PRODUCTION_SHA: productionSha,
    LIONLOG_MONITOR_PRODUCTION_BRANCH: prodBranch,
    LIONLOG_MONITOR_BOT_USER_ID: '42',
    LIONLOG_MONITOR_BOT_LOGIN: 'lionlog-dispatch[bot]',
    LIONLOG_MONITOR_DISCUSSION_NODE_ID: 'D_fixture',
    ['production-incidents-' + day]: JSON.stringify(previous),
  }));
  const manifest = { releaseId, releaseKind: 'live', manifestVersion: 'lionlog.pages-release.v2',
    repository: { id: 1346360244, name: 'CrunchyBrunch/lionlog' },
    source: { commitSha: productionSha, workflowPath: candidate.path, workflowId: 347085467,
      workflowRunId: proofCandidate, workflowRunAttempt: 1 },
    menu: { serviceDate: proofDate, earliestFreshUntil: '2026-11-21T19:00:00Z',
      coverage: 'complete', omissions: { 'invalid-name': 0 } }, marker: { sha256: hash(publicBody), path: 'release.json' } };
  const bytes = x => Buffer.from(JSON.stringify(x));
  const manifestDigest = hash(bytes(manifest));
  const artifactDigest = 'sha256:' + '9'.repeat(64);
  const receipt = { receiptVersion: 'lionlog.pages-flat-receipt.v1',
    release: { id: releaseId }, workflow: { runId: proofPromotion, runAttempt: 1, sha: productionSha },
    candidate: { runId: proofCandidate, sourceSha: productionSha, manifestSha256: manifestDigest,
      artifactId: 501, artifactDigest },
    knownGood: true, unresolved: false, official: { submissionStarted: true, result: 'success', pageUrl: 'https://crunchybrunch.github.io/lionlog/' },
    public: { inventoryVerified: verified, browserVerified: true, markerVerified: true } };
  const checkpoint = { checkpointVersion: 'lionlog.pages-publication-checkpoint.v1',
    repository: { id: 1346360244, name: 'CrunchyBrunch/lionlog' },
    branch: 'lionlog-publication-state', writerId: 349336648, stateParentSha: parent,
    publication: { receiptSha256: hash(bytes(receipt)), manifestSha256: manifestDigest,
      releaseId, sourceSha: productionSha, candidateArtifactId: 501, candidateArtifactDigest: artifactDigest },
    boundary: { runId: proofPromotion, runAttempt: 1, workflowSha: productionSha } };
  if (tamperedManifest) manifest.source.workflowRunId = 444;
  const mails = [], urls = [], logs = [];
  let locked = false;
  const urlRoot = 'https://api.github.com/repos/CrunchyBrunch/lionlog/';
  const response = (status, value, headers = {}) => ({
    getResponseCode: () => status, getHeaders: () => headers,
    getContentText: () => typeof value === 'string' ? value : JSON.stringify(value),
    getContent: () => Array.from(Buffer.from(value)),
    getBlob: () => ({ getBytes: () => Array.from(zip) }),
  });
  const context = {
    Date: class extends Date { static now() { return Date.parse(now); } },
    LockService: { getScriptLock: () => ({
      waitLock: () => { assert.equal(locked, false); locked = true; },
      releaseLock: () => { assert.equal(locked, true); locked = false; },
    }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => props.get(key) ?? null,
      setProperty: (key, val) => { assert.ok(locked); props.set(key, val); },
      setProperties: obj => { assert.ok(locked); Object.entries(obj).forEach(([k, v]) => props.set(k, v)); },
      deleteProperty: key => { assert.ok(locked); props.delete(key); },
    }) },
    Utilities: { formatDate: dateFmt, DigestAlgorithm: { SHA_256: 'SHA_256' },
      computeDigest: (_type, body) => Array.from(createHash('sha256').update(Buffer.from(body)).digest()),
      base64Decode: text => Array.from(Buffer.from(text, 'base64')),
      newBlob: raw => ({ getDataAsString: () => Buffer.from(raw).toString() }),
      unzip: () => [{ getName: () => 'discussion-binding.json', getDataAsString: () => JSON.stringify(bound) }] },
    MailApp: { sendEmail: (...args) => {
      assert.ok(locked);
      assert.ok(props.has('production-mail-pending'));
      if (mailThrows) throw Error('uncertain mail');
      mails.push(args);
    } },
    console: { log: text => logs.push(text) },
    UrlFetchApp: { fetch: (url, options) => {
      assert.ok(locked);
      urls.push(url);
      assert.equal(options.method ?? 'get', 'get');
      if (url === 'https://crunchybrunch.github.io/lionlog/release.json') return response(200, observedMarker);
      if (url === 'https://signed.blob.core.windows.net/binding') {
        assert.equal(options.headers, undefined);
        return response(200, '{}');
      }
      assert.ok(url.startsWith(urlRoot));
      assert.equal(options.headers.Authorization, 'Bearer synthetic-read-only-token');
      const route = url.slice(urlRoot.length);
      if (route === 'git/ref/heads/lionlog-publication-state') return response(200, { object: { sha: state } });
      if (route === 'commits/' + state) return response(200, { sha: state, commit: { verification: { verified: signed } },
        author: { id: 349336648 }, parents: [{ sha: parent }] });
      if (route.startsWith('contents/')) {
        assert.ok(route.endsWith('?ref=' + state));
        const obj = { checkpoint, receipt, manifest }[route.split('/')[1].split('.')[0]];
        return response(200, { content: bytes(obj).toString('base64') });
      }
      if (route.endsWith('/zip')) return response(302, {}, { Location: 'https://signed.blob.core.windows.net/binding' });
      if (route.includes('/artifacts?')) return response(200, {
        total_count: bound ? 1 : 0, artifacts: bound ? [{ id: 500, name: 'lionlog-discussion-binding-77-1',
          digest: 'sha256:' + hash(zip), expired: false, workflow_run: { id: 77, head_sha: receiverSha } }] : [],
      });
      if (route.endsWith('/jobs?per_page=100')) return response(200, { total_count: 1, jobs: [{
        run_id: route.includes('/90/') ? 90 : 77, steps: route.includes('/90/') ? (step ? [step] : []) : [admission],
      }] });
      if (route.endsWith('/runs/77')) return response(200, run);
      for (const row of [candidate, promotion, writerRun]) {
        if (route.endsWith('/runs/' + row.id)) return response(200, row);
      }
      if (route.includes('/runs?')) {
        if (brokenCollector && route.includes('event=discussion_comment')) return response(500, {});
        const rows = route.includes('daily-publication.yml') ? (route.includes('event=discussion_comment')
          ? [run] : (mode === 'external' ? [] : [{ ...run, event: 'schedule' }]))
          : [candidate, promotion, writerRun].filter(row => route.includes(row.path.split('/').at(-1)));
        return response(200, { total_count: rows.length, workflow_runs: rows });
      }
      throw Error('Unexpected GET ' + url);
    } },
  };
  const host = originalHost ? read('tests/fixtures/hosted-monitor-Code.gs').replace('monitor-recipient@example.invalid', recipient)
    : patchedHost();
  vm.runInNewContext(read('monitor/DispatchAdapter.gs') + '\n' + read('monitor/PollBridge.gs') + '\n' + host, context);
  return {
    props, mails, urls, logs,
    poll() {
      try { vm.runInNewContext('dryRunPoll()', context); }
      finally { assert.equal(locked, false); }
      return JSON.parse(props.get('production-last-poll'));
    },
  };
}

test('actual poll retains the native schedule route and existing recipient', () => {
  for (const mode of ['schedule', null]) {
    const options = { mode, previous: { 'workflow-failure': true } };
    const f = fixture(options);
    const baseline = fixture({ ...options, originalHost: true });
    assert.deepEqual(f.poll(), baseline.poll());
    assert.deepEqual(f.props, baseline.props);
    assert.deepEqual(f.mails, baseline.mails);
    assert.deepEqual(f.urls, baseline.urls);
    assert.ok(f.urls.some(url => url.includes('event=schedule')));
    assert.ok(!f.urls.some(url => url.includes('event=discussion_comment')));
    assert.equal(f.mails[0][0], recipient);
  }
});

test('actual external poll recovers once after bound admission and signed current release', () => {
  const f = fixture({ previous: {
    'morning-start': true, 'final-admission': true, 'completion-freshness': true, 'evidence-unavailable': true,
  } });
  const result = f.poll();
  assert.equal(result.detail.admittedBeforeCutoff, true);
  assert.equal(result.detail.sequenceComplete, true);
  assert.equal(result.detail.checkpointRunId, 92);
  assert.ok(f.urls.some(url => url.includes('event=discussion_comment')));
  assert.ok(f.urls.some(url => url.includes('/90/attempts/1/jobs')));
  assert.match(f.mails[0][1], /RECOVERY morning-start/);
  assert.match(f.mails[0][1], /RECOVERY final-admission/);
  assert.match(f.mails[0][1], /RECOVERY completion-freshness/);
  assert.equal(f.props.has('production-mail-pending'), false);
  const incidents = JSON.parse(f.props.get('production-incidents-' + day));
  assert.equal(incidents['morning-start'], false);
  assert.equal(incidents['final-admission'], false);
  f.poll();
  assert.equal(f.mails.length, 1);
});

test('external poll preserves prior incidents for incomplete proof or collector failure', () => {
  for (const option of [{ signed: false }, { verified: 'true' }, { tamperedManifest: true }, { brokenCollector: true }]) {
    const f = fixture({ ...option, previous: { 'final-admission': true, 'completion-freshness': true } });
    const result = f.poll();
    assert.equal(result.alerts['evidence-unavailable'], true);
    const state = JSON.parse(f.props.get('production-incidents-' + day));
    assert.equal(state['final-admission'], true);
    assert.equal(state['completion-freshness'], true);
  }
});

test('old proof, a different signed promotion, or an unverified admission never recover completion', () => {
  for (const option of [{ proofDate: '2026-11-20' }, { proofPromotion: 140 },
    { step: { ...admission, conclusion: 'skipped' } }, { step: null }]) {
    const f = fixture({ ...option, previous: { 'completion-freshness': true } });
    f.poll();
    assert.equal(JSON.parse(f.props.get('production-incidents-' + day))['completion-freshness'], true);
    assert.ok(!f.mails.some(([, subject]) => subject.includes('RECOVERY completion-freshness')));
  }
});

test('a conflicting signed candidate or a preflight at the cutoff cannot recover admission', () => {
  for (const option of [{ proofCandidate: 140 }, { step: { ...admission,
    started_at: '2026-11-21T17:15:00Z', completed_at: '2026-11-21T17:16:00Z' } }]) {
    const f = fixture({ ...option, previous: { 'final-admission': true, 'completion-freshness': true } });
    f.poll();
    assert.equal(JSON.parse(f.props.get('production-incidents-' + day))['final-admission'], true);
    assert.ok(!f.mails.some(([, subject]) => subject.includes('RECOVERY final-admission')));
  }
});

test('unknown monitor mode records unavailable evidence without a route fallback', () => {
  const f = fixture({ mode: 'typo', previous: { 'final-admission': true } });
  assert.equal(f.poll().alerts['evidence-unavailable'], true);
  assert.deepEqual(f.urls, []);
  assert.equal(JSON.parse(f.props.get('production-incidents-' + day))['final-admission'], true);
});

test('probe-only receiver cannot prove production admission or clear production incidents', () => {
  const run = { ...receiver, status: 'in_progress', conclusion: null };
  const f = fixture({ run, bound: null, previous: {
    'morning-start': true, 'final-admission': true,
  }, now: '2026-11-21T15:20:00Z' });
  const running = f.poll();
  assert.equal(running.detail.dispatchEvidence, 'binding-pending');
  assert.equal(running.detail.startedAt, Date.parse(when));
  assert.equal(JSON.parse(f.props.get('production-incidents-' + day))['morning-start'], true);
  assert.equal(f.mails.length, 0);
  Object.assign(run, receiver);
  const completed = f.poll();
  assert.equal(completed.detail.dispatchEvidence, 'binding-missing');
  assert.equal(completed.detail.admittedBeforeCutoff, null);
  assert.equal(completed.detail.sequenceComplete, false);
  const incidents = JSON.parse(f.props.get('production-incidents-' + day));
  assert.equal(incidents['morning-start'], true);
  assert.equal(incidents['final-admission'], true);
  assert.ok(!f.urls.some(url => url.includes('/90/attempts/1/jobs')));
  assert.ok(!f.mails.some(([, subject]) => subject.includes('RECOVERY final-admission')));
  assert.ok(!f.mails.some(([, subject]) => subject.includes('RECOVERY morning-start')));
});

test('previous-day signed candidate cannot recover current final admission on repeated polls', () => {
  const f = fixture({ proofDate: '2026-11-20', proofCandidate: 140, previous: {
    'final-admission': true, 'completion-freshness': true,
  } });
  for (let i = 0; i < 2; i++) {
    const result = f.poll();
    assert.equal(result.detail.dispatchEvidence, 'conflict');
    assert.equal(result.detail.candidateCorrelated, false);
    assert.equal(result.detail.admittedBeforeCutoff, null);
    const incidents = JSON.parse(f.props.get('production-incidents-' + day));
    assert.equal(incidents['final-admission'], true);
    assert.equal(incidents['completion-freshness'], true);
  }
  assert.equal(f.mails.length, 1);
  assert.match(f.mails[0][1], /ALERT evidence-unavailable/);
  assert.doesNotMatch(f.mails[0][1], /RECOVERY final-admission/);
});

test('verified current admission survives a later writer failure and independent marker mismatch', () => {
  const f = fixture({ run: { ...receiver, conclusion: 'failure' },
    bound: { ...binding, stage: 'checkpoint-dispatched', releaseId: undefined },
    writerRun: { ...writer, conclusion: 'failure' }, observedMarker: JSON.stringify({ releaseId: 'f'.repeat(64) }),
    previous: { 'final-admission': true, 'completion-freshness': true } });
  const result = f.poll();
  assert.equal(result.detail.admittedBeforeCutoff, true);
  assert.equal(result.detail.sequenceComplete, false);
  assert.equal(result.alerts['final-admission'], false);
  assert.equal(result.alerts['workflow-failure'], true);
  assert.equal(result.alerts['publication-integrity'], true);
  assert.equal(JSON.parse(f.props.get('production-incidents-' + day))['completion-freshness'], true);
  assert.match(f.mails[0][1], /RECOVERY final-admission/);
  assert.doesNotMatch(f.mails[0][1], /RECOVERY completion-freshness/);
  f.poll();
  assert.equal(f.mails.length, 1);
});

test('uncertain email retains the pending marker and does not advance incident state', () => {
  const f = fixture({ mailThrows: true, previous: { 'completion-freshness': true } });
  assert.throws(() => f.poll(), /uncertain mail/);
  assert.equal(JSON.parse(f.props.get('production-incidents-' + day))['completion-freshness'], true);
  assert.ok(f.props.has('production-mail-pending'));
  assert.throws(() => f.poll(), /Prior email outcome requires investigation/);
});

test('November 21 readback verifies only the pinned inert attempt and rejects a publish job', () => {
  const source = read('monitor/InertReadback.gs');
  for (const publish of ['skipped', 'success']) {
    const requests = [];
    const run = { id: 44906581005, run_attempt: 1, event: 'discussion_comment', status: 'completed',
      conclusion: 'success', head_branch: 'main', path: workflowPath, created_at: '2026-11-21T12:59:24Z',
      repository: { id: 1346360244, full_name: 'CrunchyBrunch/lionlog' },
      head_sha: '2027557e6d81ceb4f123f9f6c1194ae5392ea32c',
      actor: { id: 356656801, login: 'lionlog-daily-menu-dispatcher[bot]' },
      display_title: 'LionLog wake 19794925 DC_kwDOUD_TtM4BLgvt D_kwDOUD_TtM4ArH9U lionlog-dispatch.v1:2026-11-21' };
    const jobs = { total_count: 2, jobs: [
      { run_id: run.id, name: 'probe', status: 'completed', conclusion: 'success' },
      { run_id: run.id, name: 'publish', status: 'completed', conclusion: publish },
    ] };
    const context = {
      Date: class extends Date { static now() { return Date.parse(when); } },
      Utilities: { formatDate: dateFmt },
      PropertiesService: { getScriptProperties: () => ({
        getProperty: name => ({ MONITOR_TOKEN: 'synthetic-read-only-token',
          TOKEN_EXPIRES_UTC: '2026-11-22T00:00:00Z' })[name],
      }) },
      console: { log() {} },
      UrlFetchApp: { fetch(url, opts) {
        requests.push(url);
        assert.equal(opts.method, 'get');
        assert.equal(opts.followRedirects, false);
        assert.equal(opts.headers.Authorization, 'Bearer synthetic-read-only-token');
        return { getResponseCode: () => 200, getContentText: () => JSON.stringify(
          url.endsWith('/jobs?per_page=100') ? jobs : run) };
      } },
    };
    vm.runInNewContext(read('monitor/DispatchAdapter.gs') + '\n' + source, context);
    const verify = () => vm.runInNewContext('verifyLionLogNovember21InertReadback()', context);
    if (publish === 'success') assert.throws(verify, /Probe identity or jobs mismatch/);
    else {
      const result = verify();
      assert.equal(result.mode, 'probe-only');
      assert.equal(result.runId, 44906581005);
      assert.equal(result.publish, 'skipped');
      assert.equal(result.admittedBeforeCutoff, undefined);
    }
    const route = 'https://api.github.com/repos/CrunchyBrunch/lionlog/actions/runs/44906581005/attempts/1';
    assert.deepEqual(requests, [route, route + '/jobs?per_page=100']);
  }
});
