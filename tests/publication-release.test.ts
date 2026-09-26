import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseArtifactZip } from "../scripts/artifact-zip.ts";
import { createPublicationTar, readPublicationFiles } from "../scripts/publication-tar.ts";
import { createPublicationBundle, sha256 } from "../scripts/create-publication-bundle.ts";
import { getPsuHall, getPsuMealPeriod, PSU_PARSER_VERSION, PSU_SNAPSHOT_VERSION, sourceDateFromIso } from "../infrastructure/psu/constants.ts";
import { catalogEntryForSnapshot, PSU_CATALOG_VERSION, validatePsuPublicationCatalog } from "../infrastructure/psu/publication-catalog.ts";
import { PSU_RELEASE_HALL_IDS } from "../infrastructure/psu/release-plan.ts";
import { buildPsuSnapshot } from "../infrastructure/psu/snapshot-schema.ts";
import { preparePagesArtifact, validatePagesArtifact } from "../scripts/prepare-pages-artifact.ts";
import {
  createPreapprovalSummary,
  inspectPagesActionTar,
  verifySupportedCandidate,
  type GithubArtifact,
  type ValidatedRelease,
} from "../scripts/supported-pages-release.ts";
import { createFlatReceipt, verifyFinalState, type PreapprovalSummary, type PriorAttemptEvidence } from "../scripts/supported-pages-control.ts";
import { assertNoBrowserDiagnostics, assertPageState } from "../scripts/verify-public-pwa.mjs";
import { assertExpectedPredecessor, FIRST_PUBLICATION, observePublicRelease } from "../scripts/public-release-state.ts";
import { collectLegacyEvidence, collectPagesAttemptHistory } from "../scripts/collect-pages-attempt-history.ts";
import { selectBrowserVerificationContext } from "../scripts/select-browser-verification-context.ts";
import { assertArtifactDigest, normalizeArtifactDigest } from "../scripts/artifact-digest.ts";

const workflowSha = "a".repeat(40);
const sourceSha = "b".repeat(40);
const hash = "c".repeat(64);
const digest = `sha256:${"d".repeat(64)}`;
const now = new Date("2026-09-17T12:00:00.000Z");
const historicalIncidentHistory = JSON.parse(await readFile("infrastructure/publication/pages-incident-history.json", "utf8"));

test("artifact ZIP parser rejects traversal, symlinks, extras, and header disagreement", () => {
  const valid = createStoredZip([{ path: "artifact.tar", data: Buffer.from("tar") }]);
  assert.equal(parseArtifactZip(valid, ["artifact.tar"])[0].data.toString(), "tar");
  assert.throws(() => parseArtifactZip(createStoredZip([{ path: "../artifact.tar", data: Buffer.from("tar") }]), ["artifact.tar"]), /Unsafe artifact ZIP/);
  assert.throws(() => parseArtifactZip(createStoredZip([{ path: "artifact.tar", data: Buffer.from("tar"), mode: 0o120777 }]), ["artifact.tar"]), /regular files/);
  assert.throws(() => parseArtifactZip(createStoredZip([
    { path: "artifact.tar", data: Buffer.from("tar") },
    { path: "extra", data: Buffer.from("no") },
  ]), ["artifact.tar"]), /file set/);
  const tampered = Buffer.from(valid);
  tampered.writeUInt32LE(99, 18);
  assert.throws(() => parseArtifactZip(tampered, ["artifact.tar"]), /disagree|bounds|overlap/);
});

test("artifact digest normalization accepts GitHub bare hex output without weakening equality", () => {
  const bare = "d".repeat(64);
  assert.equal(normalizeArtifactDigest(bare), `sha256:${bare}`);
  assert.equal(assertArtifactDigest(bare, `sha256:${bare}`), `sha256:${bare}`);
  assert.throws(() => assertArtifactDigest(bare, `sha256:${"e".repeat(64)}`), /mismatch/);
});

test("official Pages tar inspection preserves exact paths, sizes, hashes, and hidden marker", () => {
  const tar = createPublicationTar([
    { path: ".nojekyll", data: Buffer.alloc(0) },
    { path: "index.html", data: Buffer.from("index") },
    { path: "menu-data/v2/catalog.json", data: Buffer.from("{}") },
  ]);
  assert.deepEqual(inspectPagesActionTar(tar).map(({ path: entryPath, bytes }) => ({ path: entryPath, bytes })), [
    { path: ".nojekyll", bytes: 0 },
    { path: "index.html", bytes: 5 },
    { path: "menu-data/v2/catalog.json", bytes: 2 },
  ]);
  const linked = Buffer.from(tar);
  linked[156] = "2".charCodeAt(0);
  rewriteTarChecksum(linked);
  assert.throws(() => inspectPagesActionTar(linked), /prohibited entry type/);
  const trailing = Buffer.concat([tar, Buffer.alloc(512)]);
  trailing[trailing.length - 1] = 1;
  assert.throws(() => inspectPagesActionTar(trailing), /data after its terminator/);
});

test("staged Pages artifact must have unique run identity and exact candidate inventory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-stage-"));
  const tarPath = path.join(root, "artifact.tar");
  const tar = createPublicationTar([
    { path: ".nojekyll", data: Buffer.alloc(0) },
    { path: "index.html", data: Buffer.from("index") },
  ]);
  await writeFile(tarPath, tar);
  const validated = validatedFixture(inspectPagesActionTar(tar));
  const artifact = stagedArtifact();
  const result = await createPreapprovalSummary({ validated, stagedArtifact: artifact, stagedArtifactName: artifact.name, stagedTarPath: tarPath, now });
  assert.equal(result.summaryVersion, "lionlog.pages-preapproval.v1");
  await assert.rejects(createPreapprovalSummary({
    validated,
    stagedArtifact: { ...artifact, name: "github-pages" },
    stagedArtifactName: "github-pages",
    stagedTarPath: tarPath,
    now,
  }), /not unique/);
  await assert.rejects(createPreapprovalSummary({
    validated,
    stagedArtifact: { ...artifact, expires_at: "2026-09-17T12:29:59.999Z" },
    stagedArtifactName: artifact.name,
    stagedTarPath: tarPath,
    now,
  }), /availability headroom/);
  const changed = createPublicationTar([{ path: "index.html", data: Buffer.from("changed") }]);
  await writeFile(tarPath, changed);
  await assert.rejects(createPreapprovalSummary({ validated, stagedArtifact: artifact, stagedArtifactName: artifact.name, stagedTarPath: tarPath, now }), /inventory differs/);
});

test("candidate verification fails closed before touching untrusted bytes when GitHub authority differs", async () => {
  await assert.rejects(verifySupportedCandidate({
    operation: "promote",
    bundleDirectory: "missing",
    extractionDirectory: "missing-output",
    metadata: {
      repository: { id: 1, full_name: "fork/lionlog" },
      main: { sha: workflowSha },
      workflowRun: currentWorkflowRun(),
      candidateRun: candidateRun(),
      candidateArtifact: candidateArtifact(),
      ciRun: ciRun(),
      ciJobs: [{ name: "verify", head_sha: sourceSha, status: "completed", conclusion: "success" }],
    },
    workflowSha,
    workflowRunId: 100,
    candidateRunId: 200,
    candidateArtifactId: 300,
    candidateArtifactDigest: digest,
    candidateManifestSha256: hash,
    expectedReleaseId: hash,
    expectedSourceSha: sourceSha,
    expectedServiceDate: "2026-09-17",
    approvalExpiresAt: "2026-09-17T13:00:00.000Z",
    expectedPredecessorReleaseId: FIRST_PUBLICATION,
    publicPredecessor: { state: "absent", releaseId: null },
    now,
  }), /Repository identity mismatch/);
});

test("candidate verification enforces canonical approval expiry with preapproval headroom", async () => {
  const options = {
    operation: "promote" as const,
    bundleDirectory: "missing",
    extractionDirectory: "missing-output",
    metadata: {
      repository: { id: 1_346_360_244, full_name: "CrunchyBrunch/lionlog" },
      main: { sha: workflowSha },
      workflowRun: currentWorkflowRun(),
      candidateRun: candidateRun(),
      candidateArtifact: candidateArtifact(),
      ciRun: ciRun(),
      ciJobs: [{ name: "verify", head_sha: sourceSha, status: "completed", conclusion: "success" }],
    },
    workflowSha,
    workflowRunId: 100,
    candidateRunId: 200,
    candidateArtifactId: 300,
    candidateArtifactDigest: digest,
    candidateManifestSha256: hash,
    expectedReleaseId: hash,
    expectedSourceSha: sourceSha,
    expectedServiceDate: "2026-09-17",
    expectedPredecessorReleaseId: FIRST_PUBLICATION,
    publicPredecessor: { state: "absent" as const, releaseId: null },
    now,
  };
  await assert.rejects(verifySupportedCandidate({ ...options, approvalExpiresAt: "2026-09-17T12:29:59.999Z" }), /headroom/);
  await assert.rejects(verifySupportedCandidate({ ...options, approvalExpiresAt: "2026-09-17T13:00:00Z" }), /invalid/);
});

test("supported candidate verifier accepts a complete frozen live bundle and exact provenance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-supported-candidate-"));
  const recoverySite = path.join(root, "recovery-site");
  const recoveryBundle = path.join(root, "recovery-bundle");
  await writeShellSite(recoverySite);
  await createPublicationBundle({
    site: recoverySite, output: recoveryBundle, releaseKind: "first-release-recovery",
    commitSha: sourceSha, runId: 200, runAttempt: 1, createdAt: "2026-09-17T11:50:00.000Z",
  });
  const liveSite = path.join(root, "live-site");
  const liveBundle = path.join(root, "live-bundle");
  await writeLiveSite(liveSite);
  const manifest = await createPublicationBundle({
    site: liveSite, output: liveBundle, releaseKind: "live", commitSha: sourceSha, runId: 200, runAttempt: 1,
    createdAt: "2026-09-17T11:55:00.000Z", recoveryManifest: path.join(recoveryBundle, "release-manifest.json"),
    recoveryArtifactId: 299, recoveryArtifactDigest: `sha256:${"9".repeat(64)}`,
  });
  const manifestSha256 = sha256(await readFile(path.join(liveBundle, "release-manifest.json")));
  const validated = await verifySupportedCandidate({
    operation: "promote", bundleDirectory: liveBundle, extractionDirectory: path.join(root, "site-extracted"),
    metadata: {
      repository: { id: 1_346_360_244, full_name: "CrunchyBrunch/lionlog" }, main: { sha: workflowSha },
      workflowRun: currentWorkflowRun(), candidateRun: candidateRun(), candidateArtifact: candidateArtifact(), ciRun: ciRun(),
      ciJobs: [{ name: "verify", head_sha: sourceSha, status: "completed", conclusion: "success" }],
    },
    workflowSha, workflowRunId: 100, candidateRunId: 200, candidateArtifactId: 300, candidateArtifactDigest: digest,
    candidateManifestSha256: manifestSha256, expectedReleaseId: manifest.releaseId, expectedSourceSha: sourceSha,
    expectedServiceDate: "2026-09-17", approvalExpiresAt: "2026-09-17T13:00:00.000Z",
    expectedPredecessorReleaseId: FIRST_PUBLICATION, publicPredecessor: { state: "absent", releaseId: null }, now,
  });
  assert.equal(validated.release.coverage, "complete");
  assert.equal(validated.site.inventory.length > 5, true);
  assert.deepEqual(await selectBrowserVerificationContext(liveBundle), {
    contextVersion: "lionlog.pages-browser-context.v1",
    releaseId: manifest.releaseId,
    shellRevision: sourceSha,
    serviceDate: "2026-09-17",
    hallId: PSU_RELEASE_HALL_IDS[0],
    mealPeriodId: "lunch",
    snapshotId: catalogSnapshotId(await readFile(path.join(liveSite, "menu-data", "v2", "catalog.json"), "utf8")),
    expectedItemCount: 1,
    expectedFirstFoodName: "Fixture Food",
  });
});

test("protected final check rejects main drift, artifact drift, expiration, and unresolved prior submissions", () => {
  const summary = summaryFixture();
  const emptyHistory = { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] };
  assert.equal(verifyFinalState({ summary, state: finalState(), incidents: emptyHistory, now }).release.id, hash);
  assert.throws(() => verifyFinalState({ summary, state: { ...finalState(), main: { sha: "f".repeat(40) } }, incidents: emptyHistory, now }), /main drifted/);
  assert.throws(() => verifyFinalState({
    summary,
    state: { ...finalState(), stagedArtifacts: [{ ...finalState().stagedArtifacts[0], digest: `sha256:${"e".repeat(64)}` }] },
    incidents: emptyHistory,
    now,
  }), /Staged Pages artifact/);
  assert.throws(() => verifyFinalState({
    summary: { ...summary, release: { ...summary.release, earliestRetainUntil: "2026-09-17T11:59:00.000Z" } },
    state: finalState(), incidents: emptyHistory, now,
  }), /retention.*headroom/);
  const fixtureIncidentEvidence = {
    workflowId: 347_992_874,
    workflowPath: ".github/workflows/deploy-github-pages.yml",
    event: "workflow_dispatch",
    headBranch: "main",
    status: "completed",
    conclusion: "failure",
    jobs: [{
      jobId: 901, runId: 99, runAttempt: 1, headSha: workflowSha, jobName: "deploy", jobStatus: "completed", jobConclusion: "failure",
      steps: [{ stepNumber: 1, stepName: "Deploy fixture", stepStatus: "completed", stepConclusion: "failure" }],
    }],
  };
  const unresolved = priorAttempt({ runId: 99, conclusion: "failure", deploymentConclusion: "failure", incidentEvidence: fixtureIncidentEvidence });
  assert.throws(() => verifyFinalState({ summary, state: { ...finalState(), priorAttempts: [unresolved] }, incidents: emptyHistory, now }), /unknown or unresolved/);
  assert.doesNotThrow(() => verifyFinalState({
    summary,
    state: { ...finalState(), priorAttempts: [unresolved] },
    incidents: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [{
      runId: 99, runAttempt: 1, workflowSha, candidateArtifactId: 1, stagedArtifactId: 2, repositoryDeploymentId: 3,
      collectorEvidence: fixtureIncidentEvidence,
      outcome: "resolved-unknown-no-publication", publicReleaseId: "NONE_404", checkedAt: "2026-09-17T11:00:00.000Z",
      note: "Reviewed fixture incident with no publication.",
    }] },
    now,
  }));
});

test("flat receipt becomes known-good only after official success and all public checks", () => {
  const good = createFlatReceipt({
    summary: summaryFixture(),
    recordedAt: now.toISOString(),
    official: { submissionStarted: true, result: "success", pageUrl: "https://crunchybrunch.github.io/lionlog/", deploymentId: null },
    publicChecks: { markerVerified: true, inventoryVerified: true, browserVerified: true },
  });
  assert.equal(good.knownGood, true);
  assert.equal(good.unresolved, false);
  const failed = createFlatReceipt({
    summary: summaryFixture(),
    recordedAt: now.toISOString(),
    official: { submissionStarted: true, result: "failure", pageUrl: null, deploymentId: null },
    publicChecks: { markerVerified: false, inventoryVerified: false, browserVerified: false },
  });
  assert.equal(failed.knownGood, false);
  assert.equal(failed.unresolved, true);
});

test("mobile PWA verifier requires attribution, no overflow, and zero warnings/errors", () => {
  const expected = browserContext();
  const page = {
    url: "https://crunchybrunch.github.io/lionlog/",
    title: "Build a meal | LionLog",
    text: "LionLog Retrieved one minute ago. LionLog is independent and is not affiliated with or endorsed by Penn State.",
    scrollWidth: 390,
    clientWidth: 390,
    shellRevision: workflowSha,
    publicReleaseId: hash,
    selectedHall: "east",
    selectedPeriod: "lunch",
    selectedDate: "2026-09-17",
    itemNames: ["Fixture Food"],
    sourceState: "Live PSU snapshots",
    livePressed: true,
    samplePressed: false,
  };
  assert.doesNotThrow(() => assertPageState(page, expected));
  assert.doesNotThrow(() => assertPageState({ ...page, publicReleaseId: undefined }, expected, { offline: true }));
  assert.throws(() => assertPageState({ ...page, scrollWidth: 391 }, expected), /overflows/);
  assert.throws(() => assertPageState({ ...page, text: "LionLog" }, expected), /retrieval time/);
  assert.throws(() => assertPageState({ ...page, itemNames: [] }, expected), /identity\/count/);
  assert.throws(() => assertPageState({ ...page, samplePressed: true, livePressed: false }, expected), /sample/);
  assert.doesNotThrow(() => assertNoBrowserDiagnostics([{ kind: "console", type: "log" }]));
  assert.throws(() => assertNoBrowserDiagnostics([{ kind: "console", type: "warning" }]), /diagnostics/);
  assert.throws(() => assertNoBrowserDiagnostics([{ kind: "service-worker", text: "install failed" }]), /diagnostics/);
});

test("public predecessor authorization is exact and fail-closed", async () => {
  assert.deepEqual(assertExpectedPredecessor(FIRST_PUBLICATION, { state: "absent", releaseId: null }), { state: "absent", releaseId: null });
  assert.deepEqual(assertExpectedPredecessor(hash, { state: "present", releaseId: hash }), { state: "present", releaseId: hash });
  assert.throws(() => assertExpectedPredecessor(FIRST_PUBLICATION, { state: "present", releaseId: hash }), /already exists/);
  assert.throws(() => assertExpectedPredecessor(hash, { state: "absent", releaseId: null }), /absent or differs/);
  assert.throws(() => assertExpectedPredecessor(hash, { state: "present", releaseId: "e".repeat(64) }), /absent or differs/);
  await assert.rejects(observePublicRelease(async () => new Response("unavailable", { status: 503 })), /unavailable or ambiguous/);
  await assert.rejects(observePublicRelease(async () => new Response("not json", {
    status: 200,
    headers: { "content-type": "text/plain" },
  })), /unavailable or ambiguous|content type/);
});

test("final gate requires exact predecessor and time headroom", () => {
  const summary = summaryFixture();
  const incidents = { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] };
  assert.throws(() => verifyFinalState({
    summary,
    state: { ...finalState(), publicPredecessor: { state: "present", releaseId: hash } },
    incidents,
    now,
  }), /already exists/);
  assert.throws(() => verifyFinalState({
    summary: { ...summary, authorization: { ...summary.authorization, approvalExpiresAt: "2026-09-17T12:14:59.999Z" } },
    state: finalState(), incidents, now,
  }), /approval expired|headroom/);
  assert.throws(() => verifyFinalState({
    summary: { ...summary, release: { ...summary.release, earliestFreshUntil: "2026-09-17T12:14:59.999Z" } },
    state: finalState(), incidents, now,
  }), /freshness/);
  assert.throws(() => verifyFinalState({
    summary,
    state: {
      ...finalState(),
      candidateArtifact: { ...finalState().candidateArtifact, expires_at: "2026-09-17T12:14:59.999Z" },
    },
    incidents,
    now,
  }), /Candidate artifact state drifted/);
});

test("only known-good or affirmative pre-submission failures clear attempt history", () => {
  const summary = summaryFixture();
  const incidents = { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] };
  const knownGood = priorAttempt({
    conclusion: "success",
    finalGateConclusion: "success",
    submissionBoundaryConclusion: "success",
    deploymentConclusion: "success",
    receipt: receiptEvidence({ submissionStarted: true, result: "success", knownGood: true, unresolved: false, publicVerified: true }),
  });
  const preSubmission = priorAttempt({
    runId: 98,
    conclusion: "failure",
    finalGateConclusion: "failure",
    submissionBoundaryConclusion: "skipped",
    deploymentConclusion: "skipped",
    receipt: receiptEvidence({ runId: 98, submissionStarted: false, result: "failure", knownGood: false, unresolved: false, publicVerified: false }),
  });
  assert.doesNotThrow(() => verifyFinalState({ summary, state: { ...finalState(), priorAttempts: [knownGood, preSubmission] }, incidents, now }));
  const unsafe = [
    priorAttempt({ status: "completed", conclusion: "cancelled", receipt: null }),
    priorAttempt({ conclusion: "failure", receipt: null }),
    priorAttempt({ status: "in_progress", conclusion: null, jobsComplete: false }),
    priorAttempt({ runAttempt: 2, conclusion: "failure", finalGateConclusion: "failure", submissionBoundaryConclusion: "skipped", deploymentConclusion: "skipped", receipt: null }),
  ];
  for (const attempt of unsafe) {
    assert.throws(() => verifyFinalState({ summary, state: { ...finalState(), priorAttempts: [attempt] }, incidents, now }), /incomplete|unknown or unresolved/);
  }
});

test("real legacy pre-submission identities reconcile only against exact affirmative evidence", async () => {
  const incidents = JSON.parse(await readFile("infrastructure/publication/pages-incident-history.json", "utf8"));
  const attempts = [legacyAttempt346(), legacyAttempt348(), legacyAttempt352()];
  assert.doesNotThrow(() => verifyFinalState({
    summary: summaryFixture(), state: { ...finalState(), priorAttempts: attempts }, incidents, now,
  }));

  const altered = structuredClone(attempts[0]);
  altered.legacyEvidence.deploymentBoundary!.stepConclusion = "success";
  const missing = structuredClone(attempts[0]);
  missing.legacyEvidence.validationFailure = null;
  const incomplete = { ...attempts[0], jobsComplete: false };
  const mismatched = { ...attempts[0], workflowSha: "f".repeat(40) };
  const changedIncidentEvidence = structuredClone(attempts[2]);
  changedIncidentEvidence.incidentEvidence!.jobs[1].steps[9].stepConclusion = "success";
  const wrongWorkflowId = { ...attempts[0], workflowId: 1 };
  const wrongWorkflowPath = { ...attempts[0], workflowPath: ".github/workflows/other.yml" };
  const wrongEvent = { ...attempts[0], event: "push" };
  const wrongBranch = { ...attempts[0], headBranch: "feature" };
  const missingIncidentEvidence = { ...attempts[2], incidentEvidence: null };
  const outerStateMutations = attempts.flatMap((attempt) => [
    { ...attempt, status: undefined as unknown as string },
    { ...attempt, status: "in_progress" },
    { ...attempt, status: "completed", conclusion: "success" },
    { ...attempt, status: "completed", conclusion: null },
    { ...attempt, status: "queued", conclusion: "failure" },
    { ...attempt, status: "unexpected", conclusion: "failure" },
  ]);
  for (const attempt of [altered, missing, incomplete, mismatched, changedIncidentEvidence, wrongWorkflowId, wrongWorkflowPath, wrongEvent, wrongBranch, missingIncidentEvidence, ...outerStateMutations]) {
    assert.throws(() => verifyFinalState({
      summary: summaryFixture(), state: { ...finalState(), priorAttempts: [attempt] }, incidents, now,
    }), /incomplete|unknown or unresolved/);
  }

  const duplicate = { ...incidents, incidents: [...incidents.incidents, structuredClone(incidents.incidents[0])] };
  assert.throws(() => verifyFinalState({
    summary: summaryFixture(), state: { ...finalState(), priorAttempts: attempts }, incidents: duplicate, now,
  }), /invalid or duplicate/);
  assert.throws(() => verifyFinalState({
    summary: summaryFixture(), state: { ...finalState(), priorAttempts: [...attempts, structuredClone(attempts[1])] }, incidents, now,
  }), /duplicate run\/attempt/);
});

test("legacy collector selects exact incident-bound evidence without fuzzy-name ambiguity", () => {
  const job = {
    id: 103295384726, name: "deploy", status: "completed", conclusion: "failure",
    steps: [
      { number: 7, name: "Perform final provenance, state, deadline, and freshness checks", status: "completed", conclusion: "failure" },
      { number: 8, name: "Deploy exact staged artifact", status: "completed", conclusion: "skipped" },
    ],
  };
  const successfulOverlappingName = {
    id: 103295186583,
    name: "verify-and-stage",
    status: "completed",
    conclusion: "success",
    steps: [{ number: 11, name: "Verify current attempt separately from the known-good rollback target", status: "completed", conclusion: "success" }],
  };
  assert.deepEqual(collectLegacyEvidence([successfulOverlappingName, job], legacyAttempt346().legacyEvidence), legacyAttempt346().legacyEvidence);
  const jobs348 = [{
    id: 104100073427,
    name: "verify-and-stage",
    status: "completed",
    conclusion: "failure",
    steps: [{ number: 11, name: "Verify current attempt separately from the known-good rollback target", status: "completed", conclusion: "failure" }],
  }, {
    id: 104100243029,
    name: "deploy",
    status: "completed",
    conclusion: "skipped",
    steps: [],
  }];
  assert.deepEqual(collectLegacyEvidence(jobs348, legacyAttempt348().legacyEvidence), legacyAttempt348().legacyEvidence);
  assert.throws(() => collectLegacyEvidence([job, { ...job, id: job.id + 1 }], legacyAttempt346().legacyEvidence), /ambiguous/);
});

test("attempt history binds every completed job and step to the exact requested attempt", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes(`/actions/workflows/347992874/runs?`)) {
      return jsonResponse({ total_count: 1, workflow_runs: [{ id: 77, run_attempt: 2 }] });
    }
    if (url.includes("/actions/runs/77/artifacts?")) return jsonResponse({ total_count: 0, artifacts: [] });
    const attempt = url.match(/\/actions\/runs\/77\/attempts\/(\d+)(?:\?|$)/)?.[1];
    if (attempt) return jsonResponse({
      id: 77,
      workflow_id: 347_992_874,
      run_attempt: Number(attempt),
      path: ".github/workflows/deploy-github-pages.yml",
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: workflowSha,
        status: "completed", conclusion: "failure",
    });
    const jobsAttempt = url.match(/\/actions\/runs\/77\/attempts\/(\d+)\/jobs\?/)?.[1];
    if (jobsAttempt) return jsonResponse({
      total_count: 1,
      jobs: [{
        id: 700 + Number(jobsAttempt),
        name: "deploy",
        run_id: 77,
        run_attempt: Number(jobsAttempt),
        head_sha: workflowSha,
        status: "completed",
        conclusion: "failure",
        steps: [{ number: 1, name: "Recheck all authority immediately before submission", status: "completed", conclusion: "failure" }],
      }],
    });
    return new Response("not found", { status: 404 });
  };
  const evidence = await collectPagesAttemptHistory({
    repository: "CrunchyBrunch/lionlog",
    currentRunId: 88,
    token: "fixture-token",
    incidentHistory: emptyIncidentHistory(),
    fetchImpl,
  });
  assert.equal(evidence.length, 2);
  assert.equal(evidence[0].jobsComplete, true);
  assert.equal(evidence[1].jobsComplete, true);
  assert.ok(requested.some((url) => url.includes("/attempts/1/jobs?")));
  assert.ok(requested.some((url) => url.includes("/attempts/2/jobs?")));
  assert.ok(!requested.some((url) => /\/actions\/runs\/77\/jobs\?/.test(url)));
});

test("all three real historical attempts collect and reconcile only with exact incident contracts", async () => {
  const incidents = JSON.parse(await readFile("infrastructure/publication/pages-incident-history.json", "utf8"));
  const evidence = await collectPagesAttemptHistory({
    repository: "CrunchyBrunch/lionlog",
    currentRunId: 999,
    token: "fixture-token",
    incidentHistory: incidents,
    fetchImpl: historicalAttemptFetch(),
  });
  assert.deepEqual(evidence.map((attempt) => [attempt.runId, attempt.runAttempt]), [
    [34609219734, 1], [34881025561, 1], [35221481720, 1],
  ]);
  assert.doesNotThrow(() => verifyFinalState({
    summary: summaryFixture(), state: { ...finalState(), priorAttempts: evidence }, incidents, now,
  }));

  const mutations: Array<(jobs: Array<Record<string, unknown>>, runId: number) => void> = [
    (jobs, runId) => { if (runId === 34609219734) jobs[1].run_id = 1; },
    (jobs, runId) => { if (runId === 34609219734) jobs[1].run_attempt = 2; },
    (jobs, runId) => { if (runId === 34609219734) jobs[1].head_sha = "f".repeat(40); },
    (jobs, runId) => { if (runId === 34609219734) { jobs[1].status = "in_progress"; jobs[1].conclusion = null; } },
    (jobs, runId) => { if (runId === 34609219734) (jobs[1].steps as Array<Record<string, unknown>>)[6].status = "in_progress"; },
    (jobs, runId) => { if (runId === 34609219734) (jobs[1].steps as Array<Record<string, unknown>>)[6].conclusion = "success"; },
    (jobs, runId) => { if (runId === 34609219734) (jobs[1].steps as Array<Record<string, unknown>>).splice(6, 1); },
    (jobs, runId) => { if (runId === 34609219734) (jobs[1].steps as Array<Record<string, unknown>>).push(structuredClone((jobs[1].steps as Array<Record<string, unknown>>)[6])); },
    (jobs, runId) => { if (runId === 34609219734) jobs.push(structuredClone(jobs[1])); },
  ];
  for (const mutate of mutations) {
    await assert.rejects(() => collectPagesAttemptHistory({
      repository: "CrunchyBrunch/lionlog",
      currentRunId: 999,
      token: "fixture-token",
      incidentHistory: incidents,
      fetchImpl: historicalAttemptFetch(mutate),
    }), /invalid|missing|ambiguous|duplicate|nonterminal|contract/);
  }

  const attemptMutations: Array<(attempt: Record<string, unknown>) => void> = [
    (attempt) => { attempt.workflow_id = 1; },
    (attempt) => { attempt.path = ".github/workflows/other.yml"; },
    (attempt) => { attempt.head_sha = "f".repeat(40); },
    (attempt) => { attempt.status = "in_progress"; attempt.conclusion = null; },
  ];
  for (const mutateAttempt of attemptMutations) {
    await assert.rejects(() => collectPagesAttemptHistory({
      repository: "CrunchyBrunch/lionlog",
      currentRunId: 999,
      token: "fixture-token",
      incidentHistory: incidents,
      fetchImpl: historicalAttemptFetch(undefined, mutateAttempt),
    }), /invalid|terminal|match/);
  }
});

test("incident collection rejects every unknown or altered job and step before projection", async () => {
  const incidents = JSON.parse(await readFile("infrastructure/publication/pages-incident-history.json", "utf8"));
  const collect = (mutate: (jobs: Array<Record<string, unknown>>, runId: number) => void) => collectPagesAttemptHistory({
    repository: "CrunchyBrunch/lionlog",
    currentRunId: 999,
    token: "fixture-token",
    incidentHistory: incidents,
    fetchImpl: historicalAttemptFetch(mutate),
  });
  const extraStep = (name: string, status = "completed", conclusion: string | null = "success", number = 999) =>
    ({ number, name, status, conclusion });
  const appendToValidation = (jobs: Array<Record<string, unknown>>, runId: number, step: Record<string, unknown>) => {
    if (runId === 34881025561) (jobs[0].steps as Array<Record<string, unknown>>).push(step);
  };
  const unknownJob = (id = 104100999999) => ({
    id, run_id: 34881025561, run_attempt: 1,
    head_sha: "d9e3eedec058bad2bc1c9cc8078d7bb0e30f4e64", name: "release-production",
    status: "completed", conclusion: "success",
    steps: [extraStep("Run actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346")],
  });
  const mutations: Array<(jobs: Array<Record<string, unknown>>, runId: number) => void> = [
    (jobs, runId) => appendToValidation(jobs, runId, extraStep("Run actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346")),
    (jobs, runId) => appendToValidation(jobs, runId, extraStep("Run node scripts/submit-production-release.mjs --now")),
    (jobs, runId) => appendToValidation(jobs, runId, extraStep("Dеploy exact staged artifact")),
    (jobs, runId) => appendToValidation(jobs, runId, extraStep("Write harmless summary")),
    (jobs, runId) => appendToValidation(jobs, runId, extraStep("Unknown failed validation", "completed", "failure")),
    (jobs, runId) => appendToValidation(jobs, runId, extraStep("Unknown skipped validation", "completed", "skipped")),
    (jobs, runId) => appendToValidation(jobs, runId, extraStep("Unknown queued validation", "queued", null)),
    (jobs, runId) => appendToValidation(jobs, runId, extraStep("Unknown active validation", "in_progress", null)),
    (jobs, runId) => { if (runId === 34881025561) jobs.push(unknownJob()); },
    (jobs, runId) => { if (runId === 34881025561) jobs.push(unknownJob(), structuredClone(unknownJob())); },
    (jobs, runId) => appendToValidation(jobs, runId, extraStep("Step-number collision", "completed", "success", 11)),
    (jobs, runId) => {
      if (runId === 34881025561) {
        const steps = jobs[0].steps as Array<Record<string, unknown>>;
        [steps[9], steps[10]] = [steps[10], steps[9]];
      }
    },
    (jobs, runId) => {
      if (runId === 34881025561) (jobs[0].steps as Array<Record<string, unknown>>)[10].name = "Verify current attempt (renamed)";
    },
    (jobs, runId) => {
      if (runId === 34881025561) (jobs[0].steps as Array<Record<string, unknown>>)[10].status = "in_progress";
    },
    (jobs, runId) => {
      if (runId === 34881025561) (jobs[0].steps as Array<Record<string, unknown>>)[10].conclusion = "success";
    },
    (jobs, runId) => {
      if (runId === 34881025561) {
        const steps = jobs[0].steps as Array<Record<string, unknown>>;
        const unknown = extraStep("Duplicated unknown evidence");
        steps.push(unknown, structuredClone(unknown));
      }
    },
  ];
  for (const mutate of mutations) {
    await assert.rejects(() => collect(mutate), /graph|nonterminal|duplicate|contract|invalid/);
  }

  const evidence = await collect(() => undefined);
  assert.equal(evidence.length, 3);
  assert.equal(evidence[1].incidentEvidence?.jobs.length, 3);
  assert.ok(evidence[1].incidentEvidence?.jobs[0].steps.some((step) => step.stepName === "Validate immutable input shapes"));
  assert.ok(evidence[1].incidentEvidence?.jobs[0].steps.some((step) => step.stepName === "Stage exact Pages tar for protected deployment"));
});

test("incident collection rejects later-page additions, incomplete pagination, and conflicting page copies", async () => {
  const incidents = JSON.parse(await readFile("infrastructure/publication/pages-incident-history.json", "utf8"));
  const original = historicalJobs(34881025561, "d9e3eedec058bad2bc1c9cc8078d7bb0e30f4e64");
  const filler = (index: number) => ({
    id: 104101000000 + index, run_id: 34881025561, run_attempt: 1,
    head_sha: "d9e3eedec058bad2bc1c9cc8078d7bb0e30f4e64", name: `validation-${index}`,
    status: "completed", conclusion: "success", steps: [],
  });
  const firstPage = [...original, ...Array.from({ length: 97 }, (_, index) => filler(index))];
  const extraJob = {
    id: 104101999999, run_id: 34881025561, run_attempt: 1,
    head_sha: "d9e3eedec058bad2bc1c9cc8078d7bb0e30f4e64", name: "release-production",
    status: "completed", conclusion: "success",
    steps: [{ number: 999, name: "Run actions/deploy-pages@368f82528645a54fb793d4d04e342629a3f51346", status: "completed", conclusion: "success" }],
  };
  const pageVariants: Array<(page: string | null) => { total_count: number; jobs: Array<Record<string, unknown>> }> = [
    (page) => page === "1" ? { total_count: 101, jobs: firstPage } : { total_count: 101, jobs: [extraJob] },
    (page) => page === "1" ? { total_count: 101, jobs: firstPage } : { total_count: 101, jobs: [] },
    (page) => page === "1" ? { total_count: 101, jobs: firstPage } : { total_count: 101, jobs: [structuredClone(original[0])] },
  ];
  for (const pages of pageVariants) {
    const baseFetch = historicalAttemptFetch();
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/actions/runs/34881025561/attempts/1/jobs")) return jsonResponse(pages(url.searchParams.get("page")));
      return baseFetch(input, init);
    };
    await assert.rejects(() => collectPagesAttemptHistory({
      repository: "CrunchyBrunch/lionlog", currentRunId: 999, token: "fixture-token", incidentHistory: incidents, fetchImpl,
    }), /graph|duplicate evidence|ended before/);
  }
});

test("workflow-run pagination rejects duplicate run/attempt evidence across pages", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: 1_000 + index, run_attempt: 1 }));
  firstPage[0] = { id: 34881025561, run_attempt: 1 };
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.searchParams.get("page") === "1") return jsonResponse({ total_count: 101, workflow_runs: firstPage });
    if (url.searchParams.get("page") === "2") return jsonResponse({ total_count: 101, workflow_runs: [{ id: 34881025561, run_attempt: 1 }] });
    return new Response("not found", { status: 404 });
  };
  await assert.rejects(() => collectPagesAttemptHistory({
    repository: "CrunchyBrunch/lionlog",
    currentRunId: 999,
    token: "fixture-token",
    incidentHistory: emptyIncidentHistory(),
    fetchImpl,
  }), /duplicate evidence/);
});

test("representative 22-file Pages candidate preserves the exact candidate-to-stage inventory bytewise", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-real-stage-"));
  const source = path.join(root, "source");
  const prepared = path.join(root, "prepared");
  await writeShellSite(source);
  for (let index = 0; index < 16; index += 1) {
    await writeFile(path.join(source, "_next", "static", `chunk-${String(index).padStart(2, "0")}.js`), `export default ${index};\n`);
  }
  await preparePagesArtifact(source, prepared);
  const paths = await validatePagesArtifact(prepared);
  assert.equal(paths.length, 22);
  const entries = await readPublicationFiles(prepared, paths);
  const candidateInventory = entries
    .map((entry) => ({ path: entry.path, bytes: entry.data.byteLength, sha256: sha256(entry.data) }))
    .sort(bytewisePathOrder);
  const stagedInventory = inspectPagesActionTar(createPublicationTar(entries));
  assert.deepEqual(stagedInventory, candidateInventory);
  assert.equal(stagedInventory[0].path, ".nojekyll");
});

function browserContext() {
  return {
    contextVersion: "lionlog.pages-browser-context.v1",
    releaseId: hash,
    shellRevision: workflowSha,
    serviceDate: "2026-09-17",
    hallId: "east",
    mealPeriodId: "lunch",
    expectedItemCount: 1,
    expectedFirstFoodName: "Fixture Food",
  };
}

function priorAttempt(overrides: Partial<PriorAttemptEvidence> = {}): PriorAttemptEvidence {
  return {
    runId: 99,
    workflowId: 347_992_874,
    workflowPath: ".github/workflows/deploy-github-pages.yml",
    workflowSha,
    event: "workflow_dispatch",
    headBranch: "main",
    runAttempt: 1,
    status: "completed",
    conclusion: "failure",
    jobsComplete: true,
    finalGateConclusion: null,
    submissionBoundaryConclusion: null,
    deploymentConclusion: null,
    incidentEvidence: null,
    legacyEvidence: { validationFailure: null, deploymentBoundary: null },
    receipt: null,
    ...overrides,
  };
}

function legacyAttempt346(): PriorAttemptEvidence {
  return priorAttempt({
    runId: 34609219734,
    workflowSha: "3d5181c962486aa25345f4f16fbdd75932e0d831",
    incidentEvidence: incidentEvidence346(),
    legacyEvidence: {
      validationFailure: {
        jobId: 103295384726,
        jobName: "deploy",
        jobStatus: "completed",
        jobConclusion: "failure",
        stepNumber: 7,
        stepName: "Perform final provenance, state, deadline, and freshness checks",
        stepStatus: "completed",
        stepConclusion: "failure",
      },
      deploymentBoundary: {
        jobId: 103295384726,
        jobName: "deploy",
        jobStatus: "completed",
        jobConclusion: "failure",
        stepNumber: 8,
        stepName: "Deploy exact staged artifact",
        stepStatus: "completed",
        stepConclusion: "skipped",
      },
    },
  });
}

function legacyAttempt348(): PriorAttemptEvidence {
  return priorAttempt({
    runId: 34881025561,
    workflowSha: "d9e3eedec058bad2bc1c9cc8078d7bb0e30f4e64",
    incidentEvidence: incidentEvidence348(),
    legacyEvidence: {
      validationFailure: {
        jobId: 104100073427,
        jobName: "verify-and-stage",
        jobStatus: "completed",
        jobConclusion: "failure",
        stepNumber: 11,
        stepName: "Verify current attempt separately from the known-good rollback target",
        stepStatus: "completed",
        stepConclusion: "failure",
      },
      deploymentBoundary: {
        jobId: 104100243029,
        jobName: "deploy",
        jobStatus: "completed",
        jobConclusion: "skipped",
        stepNumber: null,
        stepName: null,
        stepStatus: "completed",
        stepConclusion: "skipped",
      },
    },
  });
}

function legacyAttempt352(): PriorAttemptEvidence {
  return priorAttempt({
    runId: 35221481720,
    workflowSha: "4a91cda0de93b920607f2aa37163790bb4b662f2",
    incidentEvidence: incidentEvidence352(),
  });
}

function incidentEvidence346() {
  return incidentEvidenceForRun(34609219734);
}

function incidentEvidence348() {
  return incidentEvidenceForRun(34881025561);
}

function incidentEvidence352() {
  return incidentEvidenceForRun(35221481720);
}

function incidentEvidenceForRun(runId: number) {
  const incident = historicalIncidentHistory.incidents.find((candidate: { runId: number }) => candidate.runId === runId);
  if (!incident) throw new Error(`Missing historical incident fixture: ${runId}`);
  return structuredClone(incident.collectorEvidence);
}

function receiptEvidence(options: {
  runId?: number;
  submissionStarted: boolean;
  result: string;
  knownGood: boolean;
  unresolved: boolean;
  publicVerified: boolean;
}) {
  return {
    artifactId: 600,
    artifactDigest: digest,
    artifactExpiresAt: "2026-12-01T00:00:00.000Z",
    content: {
      receiptVersion: "lionlog.pages-flat-receipt.v1",
      workflow: { runId: options.runId ?? 99, runAttempt: 1 },
      official: { submissionStarted: options.submissionStarted, result: options.result },
      public: {
        markerVerified: options.publicVerified,
        inventoryVerified: options.publicVerified,
        browserVerified: options.publicVerified,
      },
      knownGood: options.knownGood,
      unresolved: options.unresolved,
    },
  };
}

function emptyIncidentHistory() {
  return { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] };
}

function historicalAttemptFetch(
  mutateJobs?: (jobs: Array<Record<string, unknown>>, runId: number) => void,
  mutateAttempt?: (attempt: Record<string, unknown>, runId: number) => void,
): typeof fetch {
  const identities = new Map([
    [34609219734, "3d5181c962486aa25345f4f16fbdd75932e0d831"],
    [34881025561, "d9e3eedec058bad2bc1c9cc8078d7bb0e30f4e64"],
    [35221481720, "4a91cda0de93b920607f2aa37163790bb4b662f2"],
  ]);
  return async (input) => {
    const url = String(input);
    if (url.includes(`/actions/workflows/347992874/runs?`)) {
      return jsonResponse({ total_count: 3, workflow_runs: [...identities.keys()].map((id) => ({ id, run_attempt: 1 })) });
    }
    const artifactRun = Number(url.match(/\/actions\/runs\/(\d+)\/artifacts\?/)?.[1]);
    if (identities.has(artifactRun)) return jsonResponse({ total_count: 0, artifacts: [] });
    const jobsRun = Number(url.match(/\/actions\/runs\/(\d+)\/attempts\/1\/jobs\?/)?.[1]);
    if (identities.has(jobsRun)) {
      const jobs = historicalJobs(jobsRun, identities.get(jobsRun)!);
      mutateJobs?.(jobs, jobsRun);
      return jsonResponse({ total_count: jobs.length, jobs });
    }
    const attemptRun = Number(url.match(/\/actions\/runs\/(\d+)\/attempts\/1(?:\?|$)/)?.[1]);
    const headSha = identities.get(attemptRun);
    if (headSha) {
      const attempt: Record<string, unknown> = {
      id: attemptRun,
      workflow_id: 347_992_874,
      run_attempt: 1,
      path: ".github/workflows/deploy-github-pages.yml",
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: headSha,
      status: "completed",
      conclusion: "failure",
      };
      mutateAttempt?.(attempt, attemptRun);
      return jsonResponse(attempt);
    }
    return new Response("not found", { status: 404 });
  };
}

function historicalJobs(runId: number, headSha: string): Array<Record<string, unknown>> {
  const evidence = incidentEvidenceForRun(runId);
  return evidence.jobs.map((job: {
    jobId: number; runId: number; runAttempt: number; headSha: string; jobName: string;
    jobStatus: string; jobConclusion: string;
    steps: Array<{ stepNumber: number; stepName: string; stepStatus: string; stepConclusion: string }>;
  }) => {
    assert.equal(job.headSha, headSha);
    return {
      id: job.jobId,
      run_id: job.runId,
      run_attempt: job.runAttempt,
      head_sha: job.headSha,
      name: job.jobName,
      status: job.jobStatus,
      conclusion: job.jobConclusion,
      steps: job.steps.map((step) => ({
        number: step.stepNumber,
        name: step.stepName,
        status: step.stepStatus,
        conclusion: step.stepConclusion,
      })),
    };
  });
}

function bytewisePathOrder(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function validatedFixture(inventory: Array<{ path: string; bytes: number; sha256: string }>): ValidatedRelease {
  return {
    summaryVersion: "lionlog.pages-validated-release.v1",
    operation: "promote",
    workflow: { sha: workflowSha, runId: 100, runAttempt: 1 },
    candidate: {
      runId: 200, sourceSha, artifactId: 300, artifactName: "lionlog-live-fixture", artifactDigest: digest,
      artifactExpiresAt: "2026-12-01T00:00:00.000Z", manifestSha256: hash,
    },
    ci: { runId: 400 },
    release: {
      id: hash, kind: "live", serviceDate: "2026-09-17", coverage: "complete", omissions: { "invalid-name": 0 },
      earliestFreshUntil: "2026-09-17T14:00:00.000Z", earliestRetainUntil: "2026-09-24T00:00:00.000Z",
    },
    site: { tarFile: "site.tar", tarSha256: hash, bytes: 1, inventory },
    rollbackReceipt: null,
    authorization: { approvalExpiresAt: "2026-09-17T13:00:00.000Z", predecessorReleaseId: FIRST_PUBLICATION },
  };
}

function summaryFixture(): PreapprovalSummary {
  return {
    ...validatedFixture([{ path: "index.html", bytes: 5, sha256: hash }]),
    summaryVersion: "lionlog.pages-preapproval.v1",
    staged: {
      artifactId: 500, artifactName: "lionlog-pages-100-1", artifactDigest: digest,
      artifactExpiresAt: "2026-12-01T00:00:00.000Z", tarSha256: hash,
    },
  };
}

function stagedArtifact(): GithubArtifact {
  return {
    id: 500, name: "lionlog-pages-100-1", digest, size_in_bytes: 100, expired: false,
    expires_at: "2026-12-01T00:00:00.000Z",
    workflow_run: { id: 100, head_sha: workflowSha, head_branch: "main", head_repository_id: 1_346_360_244 },
  };
}

function finalState() {
  return {
    repository: { id: 1_346_360_244, full_name: "CrunchyBrunch/lionlog" },
    main: { sha: workflowSha },
    workflowRun: currentWorkflowRun(),
    candidateRun: candidateRun(),
    candidateArtifact: { id: 300, digest, expired: false, expires_at: "2026-12-01T00:00:00.000Z" },
    stagedArtifacts: [{ id: 500, name: "lionlog-pages-100-1", digest, expired: false, expires_at: "2026-12-01T00:00:00.000Z" }],
    ciRun: ciRun(),
    priorAttempts: [],
    publicPredecessor: { state: "absent" as const, releaseId: null },
    rollbackReceiptArtifact: null,
    rollbackReceiptRun: null,
  };
}

function currentWorkflowRun() {
  return { id: 100, workflow_id: 347_992_874, path: ".github/workflows/deploy-github-pages.yml", event: "workflow_dispatch", head_sha: workflowSha, head_branch: "main", run_attempt: 1, status: "in_progress", conclusion: null } as const;
}

function candidateRun() {
  return { id: 200, workflow_id: 347_085_467, path: ".github/workflows/build-live-menu-artifact.yml", event: "workflow_dispatch", head_sha: sourceSha, head_branch: "main", run_attempt: 1, status: "completed", conclusion: "success" } as const;
}

function ciRun() {
  return { id: 400, workflow_id: 346_680_782, path: ".github/workflows/ci.yml", event: "push", head_sha: sourceSha, head_branch: "main", run_attempt: 1, status: "completed", conclusion: "success" } as const;
}

function candidateArtifact(): GithubArtifact {
  return { id: 300, name: "lionlog-live-fixture", digest, size_in_bytes: 100, expired: false, expires_at: "2026-12-01T00:00:00.000Z", workflow_run: { id: 200, head_sha: sourceSha, head_branch: "main", head_repository_id: 1_346_360_244 } };
}

function rewriteTarChecksum(archive: Buffer): void {
  archive.fill(0x20, 148, 156);
  const checksum = archive.subarray(0, 512).reduce((sum, value) => sum + value, 0);
  archive.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  archive[154] = 0;
  archive[155] = 0x20;
}

async function writeShellSite(root: string): Promise<void> {
  await mkdir(path.join(root, "_next", "static"), { recursive: true });
  await mkdir(path.join(root, "icons"), { recursive: true });
  await writeFile(path.join(root, ".nojekyll"), "\n");
  await writeFile(path.join(root, "index.html"), `<html data-lionlog-shell="${sourceSha}"><link href="/lionlog/_next/static/app.js"><link href="./manifest.webmanifest"></html>`);
  await writeFile(path.join(root, "_next", "static", "app.js"), "console.log('shell');");
  await writeFile(path.join(root, "icons", "icon-192.png"), "icon");
  await writeFile(path.join(root, "manifest.webmanifest"), JSON.stringify({ id: "./", start_url: "./", scope: "./", icons: [{ src: "./icons/icon-192.png" }] }));
  await writeFile(path.join(root, "sw.js"), `const SHELL_REVISION = "${sourceSha}"; const CACHE='lionlog-shell-${sourceSha}'; const EXCLUDED='menu-data';`);
}

async function writeLiveSite(root: string): Promise<void> {
  await writeShellSite(root);
  const retrievedAt = new Date("2026-09-17T11:20:00.000Z");
  const cachedAt = new Date("2026-09-17T11:30:00.000Z");
  const snapshots = PSU_RELEASE_HALL_IDS.map((hallId, index) => {
    const hall = getPsuHall(hallId);
    const period = getPsuMealPeriod("lunch");
    const hasItem = index === 0;
    return buildPsuSnapshot(
      { serviceDate: "2026-09-17", hallId, mealPeriodId: period.id, venueIds: [] },
      {
        context: { sourceCampusId: hall.sourceCampusId, sourceDate: sourceDateFromIso("2026-09-17"), sourceMeal: period.sourceValue },
        stations: hasItem ? [{ displayName: "Fixture Station", items: [{ name: "Fixture Food", nameIssue: null, sourceHandle: "900000001", dietaryTraits: ["vegan" as const] }] }] : [],
        empty: !hasItem,
      },
      hasItem ? new Map([["900000001", fixtureNutrition()]]) : new Map(),
      { retrievedAt, cachedAt, freshForMs: 18 * 60 * 60_000, retainForMs: 48 * 60 * 60_000 },
    );
  });
  const catalog = validatePsuPublicationCatalog({
    catalogVersion: PSU_CATALOG_VERSION, snapshotSchemaVersion: PSU_SNAPSHOT_VERSION, parserVersion: PSU_PARSER_VERSION,
    generatedAt: cachedAt.toISOString(),
    publication: {
      mode: "field-release", sourceKind: "psu-public-menu-html", commitSha: sourceSha, serviceDate: "2026-09-17",
      hallIds: [...PSU_RELEASE_HALL_IDS], retrievalStartedAt: "2026-09-17T11:00:00.000Z", retrievalCompletedAt: cachedAt.toISOString(),
      expectedSnapshotCount: 5, publishedSnapshotCount: 5, recognizedEmptySnapshotCount: 4, itemCount: 1,
      coverage: "complete", sourceObservationCount: 1, publishedObservationCount: 1, omissions: { "invalid-name": 0 },
      requestCount: 10, nutritionRequests: 0, nutritionCacheHits: 0,
    },
    serviceDates: ["2026-09-17"],
    halls: PSU_RELEASE_HALL_IDS.map((id) => ({ id, displayName: getPsuHall(id).displayName })),
    mealPeriods: [{ id: "lunch", displayName: getPsuMealPeriod("lunch").displayName }],
    snapshots: snapshots.map((snapshot) => catalogEntryForSnapshot(snapshot, `./snapshots/${snapshot.query.serviceDate}/${snapshot.query.sourceCampusId}/lunch.json`)),
  });
  for (const snapshot of snapshots) {
    const file = path.join(root, "menu-data", "v2", "snapshots", snapshot.query.serviceDate, snapshot.query.sourceCampusId, "lunch.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  await mkdir(path.join(root, "menu-data", "v2"), { recursive: true });
  await writeFile(path.join(root, "menu-data", "v2", "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`);
}

function fixtureNutrition() {
  return {
    name: "Fixture Food",
    nameIssue: null,
    servingLabel: "1 plate",
    sourceQuantity: 1,
    sourceUnit: "plate",
    calories: 420,
    proteinG: 18,
    carbsG: 52,
    fatG: 14,
    additional: {
      saturatedFatG: null,
      transFatG: null,
      cholesterolMg: null,
      sodiumMg: 480,
      fiberG: null,
      sugarsG: null,
      addedSugarsG: null,
      vitaminDMcg: null,
      calciumMg: null,
      ironMg: null,
      potassiumMg: null,
    },
    ingredients: "Fixture ingredients.",
    allergens: [],
  } as const;
}

function catalogSnapshotId(catalogText: string): string {
  const catalog = JSON.parse(catalogText) as { snapshots: Array<{ snapshotId: string }> };
  return catalog.snapshots[0].snapshotId;
}

function createStoredZip(entries: Array<{ path: string; data: Buffer; mode?: number }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(entry.data.length, 18); local.writeUInt32LE(entry.data.length, 22); local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(entry.data.length, 20); central.writeUInt32LE(entry.data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + entry.data.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, end]);
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
