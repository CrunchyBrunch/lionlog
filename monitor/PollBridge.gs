/* Called only by the external branch of the hosted dryRunPoll. */
function pollLionLogMonitorDispatch(now, day, token, previous) {
  requireEvidence(typeof token === 'string' && token.trim(), 'Monitor credential missing');
  let proof;
  try {
    proof = releaseProof(token, true);
  } catch {
    // The adapter can still detect a failed receiver when independent proof is unavailable.
    proof = null;
  }
  const complete = proof?.externalBound === true;
  const current = complete && proof.date === day;
  const evidence = collectLionLogMonitorEvidence(new Date(now), {
    completeEvidence: complete,
    knownGood: complete && proof.coverage === 'complete' && proof.omitted === 0,
    integrity: complete ? (proof.match ? 'match' : 'mismatch') : null,
    publishedDate: complete ? proof.date : null,
    freshUntil: complete ? proof.fresh : null,
    candidateRunId: current ? proof.candidate : null,
    promotionRunId: current && proof.externalPromotionMatchesSource ? proof.promotion : null,
    publicationSourceSha: current ? proof.sourceSha : null,
    releaseId: current ? proof.release : null,
  }, {
    token,
    readAdmission: run => readLionLogMonitorAdmission(run, token, day, now),
  });
  requireEvidence(evidence.mode === 'external' && evidence.date === day, 'Monitor poll mode or date changed');

  // A successful completed receiver without production binding may have only run the inert job.
  if (evidence.terminal && !evidence.failed && evidence.dispatchEvidence !== 'bound'
    && evidence.dispatchEvidence !== 'conflict') {
    evidence.startedAt = null;
  }

  const evaluated = evaluateLionLogDispatchPoll(evidence, new Date(now),
    Object.keys(previous).filter(key => previous[key] === true));
  // An omitted key leaves the existing incident in place in dryRunPoll.
  const alerts = Object.fromEntries(evaluated.events.map(event => [event.key, event.status === 'alert']));
  return { alerts, detail: evidence };
}

function readLionLogMonitorAdmission(run, token, day, now) {
  let result;
  try {
    result = readGithub('actions/runs/' + run.id + '/attempts/1/jobs?per_page=100', token);
  } catch {
    return null;
  }
  if (!Array.isArray(result.jobs) || result.jobs.length !== result.total_count
    || !result.jobs.every(job => job.run_id === run.id)) return null;
  const matches = result.jobs.flatMap(job => job.steps || []).filter(step =>
    step.name === 'Verify automatic due date, publication state, complete run accounting, and remaining budget');
  if (matches.length !== 1 || matches[0].status !== 'completed') return null;
  const step = matches[0];
  if (step.conclusion === 'failure') return false;
  if (step.conclusion !== 'success') return null;
  const start = Date.parse(step.started_at);
  const end = Date.parse(step.completed_at);
  const runStart = Date.parse(run.run_started_at);
  if (!Number.isFinite(runStart) || !Number.isFinite(start) || !Number.isFinite(end)
    || start < runStart || end < start || end > now || dayOf(start) !== day) return null;
  return minuteOf(start) < '12:15';
}

// The hosted releaseProof already binds the bytes and public marker to the signed state.
// Require strict receipt provenance and manifest identity before mapping external proof.
function isLionLogMonitorReleaseBound(commit, cp, receipt, manifest) {
  const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const positive = value => Number.isSafeInteger(value) && value > 0;
  const repositoryMatches = repo => repo?.id === 1346360244 && repo.name === 'CrunchyBrunch/lionlog';
  return commit.commit.verification.verified === true && sha(commit.sha) && sha(cp.stateParentSha)
    && cp.checkpointVersion === 'lionlog.pages-publication-checkpoint.v1'
    && cp.branch === 'lionlog-publication-state' && repositoryMatches(cp.repository)
    && receipt.receiptVersion === 'lionlog.pages-flat-receipt.v1'
    && receipt.workflow.sha === cp.boundary.workflowSha && sha(receipt.workflow.sha)
    && positive(receipt.workflow.runId) && positive(receipt.workflow.runAttempt)
    && receipt.official?.submissionStarted === true && receipt.official.result === 'success'
    && receipt.official.pageUrl === 'https://crunchybrunch.github.io/lionlog/'
    && receipt.public.inventoryVerified === true && receipt.public.browserVerified === true
    && receipt.public.markerVerified === true
    && positive(cp.publication.candidateArtifactId)
    && receipt.candidate.artifactId === cp.publication.candidateArtifactId
    && /^sha256:[a-f0-9]{64}$/.test(cp.publication.candidateArtifactDigest || '')
    && receipt.candidate.artifactDigest === cp.publication.candidateArtifactDigest
    && receipt.candidate.manifestSha256 === cp.publication.manifestSha256
    && manifest.manifestVersion === 'lionlog.pages-release.v2' && manifest.releaseKind === 'live'
    && repositoryMatches(manifest.repository) && hash(manifest.releaseId)
    && sha(manifest.source.commitSha) && manifest.source.workflowPath === '.github/workflows/build-live-menu-artifact.yml'
    && manifest.source.workflowId === 347085467
    && positive(manifest.source.workflowRunId) && manifest.source.workflowRunAttempt === 1
    && receipt.candidate.runId === manifest.source.workflowRunId
    && manifest.marker.path === 'release.json'
    && /^\d{4}-\d{2}-\d{2}$/.test(manifest.menu.serviceDate || '')
    && Number.isFinite(Date.parse(manifest.menu.earliestFreshUntil));
}
