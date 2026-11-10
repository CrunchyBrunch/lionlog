/* Deploy with the existing read-only Apps Script monitor at cutover; no hosted edit here. */
const LL_MONITOR_REPO = 'CrunchyBrunch/lionlog';
const LL_MONITOR_PATH = '.github/workflows/daily-publication.yml';

/** Normal dispatch collector. The hosted collector supplies its existing signed checkpoint/public proof. */
function collectLionLogMonitorEvidence(now, publicationProof) {
  const props = PropertiesService.getScriptProperties();
  const mode = props.getProperty('LIONLOG_MONITOR_DISPATCH_MODE') || 'schedule';
  if (mode !== 'schedule' && mode !== 'external') throw new Error('Unknown monitor dispatch mode.');
  const token = props.getProperty('LIONLOG_MONITOR_GITHUB_TOKEN');
  if (!token) throw new Error('Read-only monitor token missing.');
  const expectedSha = props.getProperty('LIONLOG_MONITOR_RECEIVER_SHA');
  const botId = Number(props.getProperty('LIONLOG_MONITOR_BOT_USER_ID'));
  const botLogin = props.getProperty('LIONLOG_MONITOR_BOT_LOGIN');
  const discussionId = props.getProperty('LIONLOG_MONITOR_DISCUSSION_NODE_ID');
  const productionSha = props.getProperty('LIONLOG_MONITOR_PRODUCTION_SHA');
  const productionBranch = props.getProperty('LIONLOG_MONITOR_PRODUCTION_BRANCH');
  if (mode === 'external' && (!/^[a-f0-9]{40}$/.test(expectedSha || '')
    || !Number.isSafeInteger(botId) || botId < 1 || !/^[a-f0-9]{40}$/.test(productionSha || '')
    || !/^[-A-Za-z0-9]+\[bot\]$/.test(botLogin || '')
    || !/^D_[A-Za-z0-9_-]+$/.test(discussionId || '')
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(productionBranch || ''))) {
    throw new Error('External monitor pins are incomplete.');
  }
  const day = Utilities.formatDate(now, 'America/New_York', 'yyyy-MM-dd');
  const api = function (route) { return llMonitorGetJson('https://api.github.com/' + route, token); };
  const event = mode === 'schedule' ? 'schedule' : 'discussion_comment';
  const observed = llMonitorRuns(api, event, day, LL_MONITOR_PATH, mode === 'external' ? botLogin : null);
  const runs = mode === 'external' ? observed.filter(function (candidate) {
    if (candidate.actor?.id !== botId || candidate.actor.login !== botLogin) {
      throw new Error('Filtered monitor actor identity changed.');
    }
    return /^LionLog wake [1-9]\d* DC_[A-Za-z0-9_-]+ D_[A-Za-z0-9_-]+ lionlog-dispatch\.v1:\d{4}-\d{2}-\d{2}$/.test(candidate.display_title || '')
      && candidate.display_title.endsWith(' ' + discussionId + ' lionlog-dispatch.v1:' + day);
  }) : observed;
  if (runs.length > 1) throw new Error('Multiple same-day receiver opportunities.');
  const result = Object.assign({}, publicationProof, { date: day, mode: mode,
    dispatchEvidence: 'complete', stage: 'absent', startedAt: null, failed: false,
    terminal: false, admittedBeforeCutoff: publicationProof.admittedBeforeCutoff ?? null, receiverRunId: null,
    candidateRunId: null, promotionRunId: null, checkpointRunId: null });
  if (mode === 'external') {
    result.skippedLegacyRunIds = [];
    for (const old of llMonitorRuns(api, 'schedule', day, LL_MONITOR_PATH)) {
      const readback = api('repos/' + LL_MONITOR_REPO + '/actions/runs/' + old.id);
      if (readback.id !== old.id || readback.path !== LL_MONITOR_PATH || readback.event !== 'schedule'
        || readback.head_sha !== expectedSha || readback.head_branch !== 'main'
        || readback.run_attempt !== 1
        || readback.status !== 'completed' || readback.conclusion !== 'skipped') {
        throw new Error('Legacy schedule may consume the external service day.');
      }
      result.skippedLegacyRunIds.push(old.id);
    }
  }
  if (!runs.length) { result.admittedBeforeCutoff = false; return result; }
  const run = api('repos/' + LL_MONITOR_REPO + '/actions/runs/' + runs[0].id);
  if (run.id !== runs[0].id || run.path !== LL_MONITOR_PATH || run.event !== event
    || run.run_attempt !== 1 || run.head_branch !== 'main'
    || !['queued', 'in_progress', 'completed'].includes(run.status)
    || (run.status === 'completed' && !['success', 'failure', 'cancelled', 'timed_out'].includes(run.conclusion))) {
    throw new Error('Receiver run readback differs from history.');
  }
  result.receiverRunId = run.id;
  result.failed = run.status === 'completed' && run.conclusion !== 'success';
  result.terminal = run.status === 'completed';
  result.startedAt = llMonitorTime(run.run_started_at, day);
  result.stage = run.status === 'queued' ? 'receiver-queued' : 'receiver-running';
  if (mode === 'schedule') {
    result.dispatchEvidence = 'complete';
    return result; // Existing signed producer admission/public proof remains authoritative.
  }
  result.admittedBeforeCutoff = null; // Only the existing producer proof can establish admission.
  if (run.head_sha !== expectedSha || run.actor?.id !== botId || run.actor.login !== botLogin
    || !/^LionLog wake [1-9]\d* DC_[A-Za-z0-9_-]+ D_[A-Za-z0-9_-]+ lionlog-dispatch\.v1:\d{4}-\d{2}-\d{2}$/.test(run.display_title || '')
    || !run.display_title.endsWith(' ' + discussionId + ' lionlog-dispatch.v1:' + day)) {
    throw new Error('Discussion receiver identity differs from monitor pin.');
  }
  const titleCommentId = Number(run.display_title.split(' ')[2]);
  if (!Number.isSafeInteger(titleCommentId)) throw new Error('Receiver comment ID invalid.');
  // Histories offer live stage hints while the receiver is running. They are never admission proof.
  const producer = llMonitorRuns(api, 'workflow_dispatch', day, '.github/workflows/build-live-menu-artifact.yml');
  const promotion = llMonitorRuns(api, 'workflow_dispatch', day, '.github/workflows/deploy-github-pages.yml');
  const writer = llMonitorRuns(api, 'workflow_dispatch', day, '.github/workflows/advance-refresh-checkpoint.yml');
  result.observedUnbound = { producer: producer.map(x => x.id), promotion: promotion.map(x => x.id),
    writer: writer.map(x => x.id) };
  if (writer.length) result.stage = 'writer-observed-unbound';
  else if (promotion.length) result.stage = 'promotion-observed-unbound';
  else if (producer.length) result.stage = 'producer-observed-unbound';
  const listing = api('repos/' + LL_MONITOR_REPO + '/actions/runs/' + run.id + '/artifacts?per_page=100');
  if (!Number.isSafeInteger(listing.total_count) || listing.total_count < 0 || listing.total_count > 100
    || !Array.isArray(listing.artifacts) || listing.artifacts.length !== listing.total_count) {
    throw new Error('Receiver artifact enumeration incomplete.');
  }
  const name = 'lionlog-discussion-binding-' + run.id + '-1';
  const matches = listing.artifacts.filter(x => x.name === name);
  if (matches.length > 1) throw new Error('Ambiguous receiver binding artifact.');
  if (!matches.length) {
    const ended = Date.parse(run.updated_at || '');
    if (run.status !== 'completed' || (Number.isFinite(ended) && now.getTime() < ended + 10 * 60000)) {
      result.dispatchEvidence = 'binding-pending';
      return result;
    }
    result.dispatchEvidence = 'binding-missing';
    return result;
  }
  const item = matches[0];
  if (!Number.isSafeInteger(item.id) || item.id < 1 || item.expired !== false
    || !/^sha256:[a-f0-9]{64}$/.test(item.digest || '')
    || item.workflow_run?.id !== run.id || item.workflow_run?.head_sha !== expectedSha) {
    throw new Error('Receiver binding artifact identity invalid.');
  }
  const binding = llMonitorBinding(item, token, run.id, expectedSha, day, titleCommentId);
  if (run.status === 'completed' && ((run.conclusion === 'success') !== (binding.stage === 'complete'))) {
    throw new Error('Receiver conclusion and retained stage disagree.');
  }
  result.dispatchEvidence = 'bound';
  result.stage = binding.stage;
  result.commentId = binding.commentId;
  result.candidateRunId = binding.candidateRunId || null;
  result.promotionRunId = binding.promotionRunId || null;
  result.checkpointRunId = binding.checkpointRunId || null;
  result.admittedBeforeCutoff = llMonitorPositive(publicationProof.candidateRunId)
    && llMonitorPositive(binding.candidateRunId)
    && publicationProof.candidateRunId === binding.candidateRunId
    ? publicationProof.admittedBeforeCutoff ?? null : null;
  const childRuns = {};
  for (const pair of [[binding.candidateRunId, '.github/workflows/build-live-menu-artifact.yml'],
    [binding.promotionRunId, '.github/workflows/deploy-github-pages.yml'],
    [binding.checkpointRunId, '.github/workflows/advance-refresh-checkpoint.yml']]) {
    if (!pair[0]) continue;
    const child = api('repos/' + LL_MONITOR_REPO + '/actions/runs/' + pair[0]);
    if (child.id !== pair[0] || child.path !== pair[1] || child.event !== 'workflow_dispatch'
      || child.run_attempt !== 1 || child.head_sha !== productionSha
      || child.head_branch !== productionBranch
      || !['queued', 'in_progress', 'completed'].includes(child.status)) {
      throw new Error('Bound downstream run changed identity.');
    }
    childRuns[pair[1]] = child;
    if (child.status === 'completed' && child.conclusion !== 'success') result.failed = true;
  }
  const rank = ['admitted', 'candidate-dispatched', 'candidate-complete',
    'promotion-dispatched', 'promotion-complete', 'checkpoint-dispatched', 'complete'].indexOf(binding.stage);
  const successful = function (workflow) {
    const child = childRuns[workflow];
    return child && child.status === 'completed' && child.conclusion === 'success';
  };
  const conflict = (rank >= 2 && !successful('.github/workflows/build-live-menu-artifact.yml'))
    || (rank >= 4 && !successful('.github/workflows/deploy-github-pages.yml'))
    || (rank >= 6 && !successful('.github/workflows/advance-refresh-checkpoint.yml'))
    || (rank === 6 && publicationProof.completeEvidence === true
      && (!/^[a-f0-9]{64}$/.test(publicationProof.releaseId || '')
        || publicationProof.releaseId !== binding.releaseId));
  if (conflict) {
    result.dispatchEvidence = 'conflict';
    result.stage = 'evidence-conflict';
    result.admittedBeforeCutoff = null;
  }
  return result;
}

/** Keep the monitor's existing alert categories; pending binding is unknown admission, not absence. */
function evaluateLionLogDispatchPoll(e, now, previous) {
  const open = new Set(previous);
  const events = [];
  function transition(key, active) {
    if (active === null) return; // Unknown evidence cannot resolve an existing incident.
    if (active === open.has(key)) return;
    events.push({ key: key, status: active ? 'alert' : 'recovery' });
    if (active) open.add(key); else open.delete(key);
  }
  const minuteText = Utilities.formatDate(now, 'America/New_York', 'HH:mm');
  const minute = Number(minuteText.slice(0, 2)) * 60 + Number(minuteText.slice(3));
  const proofComplete = e.completeEvidence === true;
  const pending = e.dispatchEvidence === 'binding-pending';
  const complete = proofComplete && (e.dispatchEvidence === 'complete' || e.dispatchEvidence === 'bound');
  const success = proofComplete && e.knownGood && e.integrity === 'match' && e.publishedDate === e.date
    && Number.isFinite(e.freshUntil) && now.getTime() < e.freshUntil;
  const started = Number.isFinite(e.startedAt);
  const overdue = started && (now.getTime() >= e.startedAt + 3 * 3600000
    || (Number.isFinite(e.freshUntil) && now.getTime() >= e.freshUntil));
  transition('evidence-unavailable', complete ? false : (pending && proofComplete ? null : true));
  transition('workflow-failure', e.failed === true ? true : (success ? false : null));
  transition('morning-start', started || success ? false
    : (complete && minute >= 600 ? true : null));
  transition('completion-freshness', !success && (e.failed === true || overdue
    || (complete && started && e.terminal)) ? true : (success ? false : null));
  transition('final-admission', success || (complete && e.admittedBeforeCutoff === true) ? false
    : (complete && minute >= 740 && e.admittedBeforeCutoff === false ? true : null));
  transition('publication-integrity', proofComplete && e.integrity === 'mismatch' ? true
    : (proofComplete && e.integrity === 'match' && e.knownGood ? false : null));
  return { open: Array.from(open), events: events };
}

function llMonitorRuns(api, event, day, path, actor) {
  const start = new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  const end = new Date(Date.parse(day + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const out = [], seen = new Set();
  let total;
  for (let page = 1; page <= 10; page++) {
    const workflow = path.slice(path.lastIndexOf('/') + 1);
    const response = api('repos/' + LL_MONITOR_REPO + '/actions/workflows/' + workflow
      + '/runs?event=' + event + (actor ? '&actor=' + encodeURIComponent(actor) : '')
      + '&created=' + encodeURIComponent(start + '..' + end)
      + '&per_page=100&page=' + page);
    if (!Number.isSafeInteger(response.total_count) || response.total_count < 0
      || response.total_count > 1000 || (total !== undefined && total !== response.total_count)
      || !Array.isArray(response.workflow_runs)
      || response.workflow_runs.length !== Math.min(100, response.total_count - out.length)) {
      throw new Error('Monitor run history incomplete.');
    }
    total = response.total_count;
    for (const run of response.workflow_runs) {
      if (!Number.isSafeInteger(run.id) || run.id < 1 || seen.has(run.id)
        || run.path !== path || run.event !== event || !llMonitorPositive(run.run_attempt)
        || !Number.isFinite(Date.parse(run.created_at || ''))) throw new Error('Monitor run history invalid.');
      seen.add(run.id); out.push(run);
    }
    if (out.length === total) break;
  }
  if (out.length !== total) throw new Error('Monitor run history truncated.');
  return out.filter(x => Utilities.formatDate(new Date(x.created_at), 'America/New_York', 'yyyy-MM-dd') === day);
}

function llMonitorBinding(item, token, runId, sha, day, commentId) {
  const route = 'https://api.github.com/repos/' + LL_MONITOR_REPO + '/actions/artifacts/' + item.id + '/zip';
  const first = llMonitorFetch(route, token, false);
  if (![302, 307].includes(first.getResponseCode())) throw new Error('Artifact redirect missing.');
  const signed = first.getHeaders().Location || first.getHeaders().location;
  if (!/^https:\/\/([A-Za-z0-9-]+\.)*blob\.core\.windows\.net\/|^https:\/\/objects\.githubusercontent\.com\//.test(signed || '')) {
    throw new Error('Artifact redirect host invalid.');
  }
  const response = UrlFetchApp.fetch(signed, { method: 'get', muteHttpExceptions: true, followRedirects: false });
  if (response.getResponseCode() !== 200) throw new Error('Artifact ZIP unavailable.');
  const bytes = response.getBlob().getBytes();
  if (!bytes.length || bytes.length > 1048576 || 'sha256:' + llMonitorSha(bytes) !== item.digest) {
    throw new Error('Artifact wrapper digest or size invalid.');
  }
  const files = Utilities.unzip(response.getBlob());
  if (files.length !== 1 || files[0].getName() !== 'discussion-binding.json') throw new Error('Artifact entries invalid.');
  const data = files[0].getDataAsString();
  if (data.length > 8192) throw new Error('Binding JSON too large.');
  const value = JSON.parse(data);
  const stages = ['admitted', 'candidate-dispatched', 'candidate-complete',
    'promotion-dispatched', 'promotion-complete', 'checkpoint-dispatched', 'complete'];
  const stage = stages.indexOf(value.stage);
  if (value.version !== 'lionlog.discussion-binding.v1' || stage < 0 || value.serviceDate !== day
    || value.receiverRunId !== runId || value.receiverSha !== sha || value.commentId !== commentId
    || !/^DC_[A-Za-z0-9_-]+$/.test(value.commentNodeId || '')
    || (stage >= 1 && !llMonitorPositive(value.candidateRunId))
    || (stage < 1 && value.candidateRunId !== undefined)
    || (stage >= 3 && !llMonitorPositive(value.promotionRunId))
    || (stage < 3 && value.promotionRunId !== undefined)
    || (stage >= 5 && !llMonitorPositive(value.checkpointRunId))
    || (stage < 5 && value.checkpointRunId !== undefined)
    || (stage === 6 && !/^[a-f0-9]{64}$/.test(value.releaseId || ''))
    || (stage < 6 && value.releaseId !== undefined)) {
    throw new Error('Binding fields invalid.');
  }
  return value;
}

function llMonitorPositive(value) { return Number.isSafeInteger(value) && value > 0; }
function llMonitorTime(value, day) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time) || Utilities.formatDate(new Date(time), 'America/New_York', 'yyyy-MM-dd') !== day) {
    throw new Error('Receiver start time invalid.');
  }
  return time;
}
function llMonitorSha(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
    .map(x => ('0' + (x & 255).toString(16)).slice(-2)).join('');
}
function llMonitorFetch(url, token, follow) {
  return UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, followRedirects: follow,
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10' } });
}
function llMonitorGetJson(url, token) {
  const response = llMonitorFetch(url, token, false);
  if (response.getResponseCode() !== 200) throw new Error('Monitor GitHub GET failed.');
  return JSON.parse(response.getContentText());
}
