import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { canonicalEvidenceDigest, validatePublishedIncidentRecord, verifyPublishedDecision } from "../scripts/published-incident.ts";
import { readBoundArtifact, verifyExternalPublishedEvidence, verifyParsedPublishedArtifacts } from "../scripts/published-incident-collection.ts";
import { readPublicPredecessor } from "../scripts/published-final-predecessor.ts";
import { collectPagesAttemptHistory } from "../scripts/collect-pages-attempt-history.ts";

const fixturePath = new URL("./fixtures/published-incident-record.json", import.meta.url);
const atDecision = new Date("2026-10-06T12:13:25.513Z");

// Fixture mutations exercise invalid JSON shapes that do not share one static type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function fixture(): Promise<Record<string, any>> {
  const value = JSON.parse(await readFile(fixturePath, "utf8"));
  value.decision.evidenceDigest = canonicalEvidenceDigest(value);
  return value;
}

test("published incident canonical digest has a stable nested key-order vector", () => {
  assert.equal(
    canonicalEvidenceDigest({ z: [3, 2], a: { y: 1, x: 2 } }),
    "sha256:59f532e1560c60044a66d501dfa9a41c4386e87f9fdd67815e41bc8b03110f8a",
  );
});

test("exact published incident fixture parses without creating an effective history entry", async () => {
  const incident = await fixture();
  assert.equal(validatePublishedIncidentRecord(incident, atDecision).runId, 36900859358);
  assert.equal(incident.collectorEvidence.jobs.flatMap((job: { steps: unknown[] }) => job.steps).length, 41);
  assert.equal(incident.evidence.release.inventory.length, 51);
});

test("published incident rejects malformed fields, swapped identities and digest mutation", async () => {
  const original = await fixture();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mutate = (change: (copy: Record<string, any>) => void) => {
    const copy = structuredClone(original);
    change(copy);
    assert.throws(() => validatePublishedIncidentRecord(copy, atDecision));
  };
  mutate((copy) => { copy.extra = true; });
  mutate((copy) => { copy.evidence.officialPages.deploymentId = String(copy.evidence.repositoryEnvironment.deploymentId); });
  mutate((copy) => { copy.evidence.repositoryEnvironment.deploymentId = Number(copy.evidence.officialPages.deploymentId.slice(0, 12)); });
  mutate((copy) => { copy.evidence.release.inventory[0].sha256 = "f".repeat(64); });
  mutate((copy) => { copy.decision.actorId = 1; });
  mutate((copy) => { copy.evidence.predecessor.observedAt = "2026-10-06T11:30:00.000Z"; });
  mutate((copy) => { copy.evidence.predecessor.completedAt = "2026-10-06T12:14:00.000Z"; });
});

test("PM decision requires the exact unedited comment and a complete comment listing", async () => {
  const incident = validatePublishedIncidentRecord(await fixture(), atDecision);
  incident.decision.decidedAt = "2026-10-06T12:13:25.000Z";
  const body = `Approve factual reconciliation only for CrunchyBrunch/lionlog 36900859358/1, evidence ${incident.decision.evidenceDigest}; no release authorization.`;
  const comment = {
    id: incident.decision.commentId, body, user: { id: 296610507 },
    issue_url: `https://api.github.com/repos/CrunchyBrunch/lionlog/issues/${incident.decision.pullRequestNumber}`,
    created_at: "2026-10-06T12:13:25Z", updated_at: "2026-10-06T12:13:25Z",
  };
  const responses = new Map<string, unknown>([
    [`/repos/CrunchyBrunch/lionlog/pulls/${incident.decision.pullRequestNumber}`, {
      number: incident.decision.pullRequestNumber, merged_at: "2026-10-06T12:20:00Z", merge_commit_sha: "b".repeat(40),
      base: { ref: "main", repo: { id: 1346360244 } }, head: { sha: "c".repeat(40), repo: { id: 1346360244 } },
    }],
    [`/repos/CrunchyBrunch/lionlog/pulls/${incident.decision.pullRequestNumber}/reviews?per_page=100&page=1`, [
      { state: "APPROVED", commit_id: "c".repeat(40), submitted_at: "2026-10-06T12:19:00Z", user: { id: 42 } },
    ]],
    [`/repos/CrunchyBrunch/lionlog/pulls/${incident.decision.pullRequestNumber}/reviews?per_page=100&page=2`, []],
    [`/repos/CrunchyBrunch/lionlog/pulls/${incident.decision.pullRequestNumber}/files?per_page=100&page=1`, [
      { filename: "infrastructure/publication/pages-incident-history.json" },
    ]],
    [`/repos/CrunchyBrunch/lionlog/pulls/${incident.decision.pullRequestNumber}/files?per_page=100&page=2`, []],
    [`/repos/CrunchyBrunch/lionlog/compare/${"b".repeat(40)}...main`, { status: "ahead" }],
    [`/repos/CrunchyBrunch/lionlog/contents/infrastructure/publication/pages-incident-history.json?ref=${"b".repeat(40)}`, {
      encoding: "base64", content: Buffer.from(JSON.stringify({ incidents: [incident] })).toString("base64"),
    }],
    [`/repos/CrunchyBrunch/lionlog/contents/infrastructure/publication/pages-incident-history.json?ref=main`, {
      encoding: "base64", content: Buffer.from(JSON.stringify({ incidents: [incident] })).toString("base64"),
    }],
    [`/repos/CrunchyBrunch/lionlog/issues/comments/${comment.id}`, comment],
    [`/repos/CrunchyBrunch/lionlog/issues/${incident.decision.pullRequestNumber}/comments?per_page=100&page=1`, [comment]],
    [`/repos/CrunchyBrunch/lionlog/issues/${incident.decision.pullRequestNumber}/comments?per_page=100&page=2`, []],
  ]);
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const value = responses.get(`${url.pathname}${url.search}`);
    return value === undefined ? new Response("missing", { status: 404 }) : new Response(JSON.stringify(value), { status: 200 });
  };
  assert.equal((await verifyPublishedDecision(incident, fetchImpl)).commentId, comment.id);
  responses.set(`/repos/CrunchyBrunch/lionlog/issues/${incident.decision.pullRequestNumber}/comments?per_page=100&page=2`, [{ ...comment, id: comment.id + 1 }]);
  await assert.rejects(() => verifyPublishedDecision(incident, fetchImpl), /duplicate|conflicting/i);
  responses.set(`/repos/CrunchyBrunch/lionlog/issues/${incident.decision.pullRequestNumber}/comments?per_page=100&page=2`, []);
  responses.set(`/repos/CrunchyBrunch/lionlog/issues/comments/${comment.id}`, { ...comment, updated_at: "2026-10-06T12:14:00Z" });
  await assert.rejects(() => verifyPublishedDecision(incident, fetchImpl), /edited|changed/i);
});

test("artifact evidence checks numeric metadata, wrapper digest and exact ZIP member bytes", async () => {
  const content = Buffer.from("fixture evidence");
  const zip = createStoredZip([{ path: "evidence.json", data: content }]);
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const binding = {
    id: 123, name: "fixture-artifact", wrapperDigest: `sha256:${sha(zip)}`,
    expiresAt: "2026-12-30T12:17:25.000Z", producerRunId: 321, producerAttempt: 1 as const,
    headSha: "a".repeat(40), entries: [{ path: "evidence.json", bytes: content.length, sha256: sha(content) }],
  };
  const metadata = {
    id: 123, name: "fixture-artifact", digest: binding.wrapperDigest, expired: false,
    expires_at: "2026-12-30T12:17:25Z",
    workflow_run: { id: 321, head_repository_id: 1346360244, head_sha: binding.headSha, head_branch: "main" },
  };
  const fetchImpl: typeof fetch = async () => new Response(new Uint8Array(zip));
  const result = await readBoundArtifact(binding, metadata, "fixture-token", fetchImpl, new Date("2026-10-07T12:00:00Z"));
  assert.equal(result.get("evidence.json")?.toString(), "fixture evidence");
  await assert.rejects(() => readBoundArtifact(binding, { ...metadata, id: 124 }, "fixture-token", fetchImpl, new Date("2026-10-07T12:00:00Z")));
  await assert.rejects(() => readBoundArtifact(binding, { ...metadata, expired: true }, "fixture-token", fetchImpl, new Date("2026-10-07T12:00:00Z")));
  await assert.rejects(() => readBoundArtifact({ ...binding, wrapperDigest: `sha256:${"f".repeat(64)}` }, metadata, "fixture-token", fetchImpl, new Date("2026-10-07T12:00:00Z")));
  await assert.rejects(() => readBoundArtifact({ ...binding, entries: [{ ...binding.entries[0], sha256: "f".repeat(64) }] }, metadata, "fixture-token", fetchImpl, new Date("2026-10-07T12:00:00Z")));
});

test("parsed historical manifest, preapproval, receipt and both tar inventories agree exactly", async () => {
  const incident = validatePublishedIncidentRecord(await fixture(), atDecision);
  const parsed = JSON.parse(await readFile(new URL("./fixtures/published-incident-parsed.json", import.meta.url), "utf8"));
  const inventory = incident.evidence.release.inventory;
  assert.doesNotThrow(() => verifyParsedPublishedArtifacts(incident, parsed, inventory, inventory));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mutate = (change: (copy: Record<string, any>) => void) => {
    const copy = structuredClone(parsed);
    change(copy);
    assert.throws(() => verifyParsedPublishedArtifacts(incident, copy, inventory, inventory));
  };
  mutate((copy) => { copy.receipt.knownGood = true; });
  mutate((copy) => { copy.receipt.unresolved = false; });
  mutate((copy) => { copy.receipt.official.deploymentId = incident.evidence.officialPages.deploymentId; });
  mutate((copy) => { copy.preapproval.authorization.predecessorReleaseId = incident.evidence.release.id; });
  mutate((copy) => { copy.manifest.releaseId = "f".repeat(64); });
  assert.throws(() => verifyParsedPublishedArtifacts(incident, parsed, inventory, inventory.slice(1)));
});

test("official Pages and repository environment identities remain separate and bind to action and failure logs", async () => {
  const incident = validatePublishedIncidentRecord(await fixture(), atDecision);
  const sourceRun = (id: number) => ({ id, head_sha: incident.workflowSha, run_attempt: 1, status: "completed", conclusion: "success" });
  const env = incident.evidence.repositoryEnvironment;
  const value = {
    candidateRun: sourceRun(incident.evidence.release.candidateProducerRunId),
    ciRun: sourceRun(incident.evidence.release.exactSourceCiRunId),
    pagesStatus: { status: "succeed" },
    deployment: {
      id: env.deploymentId, task: "deploy", environment: "github-pages", sha: incident.workflowSha,
      ref: "main", created_at: "2026-10-01T17:38:44Z",
      repository_url: "https://api.github.com/repos/CrunchyBrunch/lionlog",
    },
    statuses: [{
      id: env.successStatusId, state: "success", environment: "github-pages",
      log_url: env.statusLogUrl, target_url: env.statusLogUrl, environment_url: env.targetUrl,
      created_at: "2026-10-01T17:45:57Z",
    }],
    statusesNext: [],
    deployLog: [
      '"artifact_id": 11181496634',
      `"pages_build_version": "${incident.workflowSha}"`,
      `${incident.evidence.officialPages.createdAt} Created deployment for ${incident.workflowSha}, ID: ${incident.evidence.officialPages.deploymentId}`,
    ].join("\n"),
    verifyLog: `{"verifiedFiles":51,"releaseId":"${incident.evidence.release.id}"}\n${incident.evidence.browserFailure.error}`,
  };
  assert.doesNotThrow(() => verifyExternalPublishedEvidence(incident, value));
  assert.throws(() => verifyExternalPublishedEvidence(incident, { ...value, pagesStatus: { status: "failed" } }), /Pages/);
  assert.throws(() => verifyExternalPublishedEvidence(incident, { ...value, deployment: { ...value.deployment, id: incident.evidence.officialPages.deploymentId } }), /environment/);
  assert.throws(() => verifyExternalPublishedEvidence(incident, { ...value, deployLog: value.deployLog.replace("11181496634", "11181496635") }), /action/);
  assert.throws(() => verifyExternalPublishedEvidence(incident, { ...value, verifyLog: value.verifyLog.replace("shell asset", "shell file") }), /browser/);
});

test("first corrective read hashes every file before rereading the canonical marker", async () => {
  const incident = validatePublishedIncidentRecord(await fixture(), atDecision);
  const marker = incident.evidence.predecessor.marker;
  const bytes = Buffer.from("review fixture");
  const inventory = [{ path: "index.html", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }];
  const fileUrl = "https://crunchybrunch.github.io/lionlog/index.html";
  const markerUrl = "https://crunchybrunch.github.io/lionlog/release.json";
  const reads: string[] = [];
  const response = (url: string, body: Uint8Array, contentType: string) => {
    const value = new Response(new Uint8Array(body), { status: 200, headers: { "content-type": contentType } });
    Object.defineProperty(value, "url", { value: url });
    return value;
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    reads.push(url);
    assert.equal(init?.redirect, "error");
    assert.equal(init?.cache, "no-store");
    if (url === fileUrl) return response(url, new Uint8Array(bytes), "text/html");
    if (url === markerUrl) return response(url, new TextEncoder().encode(JSON.stringify(marker)), "application/json");
    return new Response("missing", { status: 404 });
  };
  let tick = 0;
  const clock = () => new Date(1_780_000_000_000 + (tick++ * 1_000));
  const result = await readPublicPredecessor({
    expectedReleaseId: marker.releaseId, expectedMarker: marker, inventory,
    evidenceDigest: incident.decision.evidenceDigest, fetchImpl, clock,
  });
  assert.deepEqual(reads, [fileUrl, markerUrl]);
  assert.equal(result.check.fileCount, 1);
  assert.ok(Date.parse(result.check.inventoryCompletedAt!) < Date.parse(result.check.markerObservedAt));
  reads.length = 0;
  await assert.rejects(readPublicPredecessor({
    expectedReleaseId: "f".repeat(64), expectedMarker: marker, inventory,
    evidenceDigest: incident.decision.evidenceDigest, fetchImpl, clock,
  }), /changed/);
  assert.deepEqual(reads, [fileUrl, markerUrl]);
  reads.length = 0;
  const later = await readPublicPredecessor({
    expectedReleaseId: marker.releaseId, expectedMarker: null, inventory: [],
    evidenceDigest: incident.decision.evidenceDigest, fetchImpl, clock,
  });
  assert.deepEqual(reads, [markerUrl]);
  assert.equal(later.check.phase, "later-known-good");
});

test("published attempt collector checks all 41 ordered steps and rejects a conflicting jobs continuation", async () => {
  const incident = validatePublishedIncidentRecord(await fixture(), atDecision);
  const root = `/repos/CrunchyBrunch/lionlog`;
  const attempt = {
    id: incident.runId, workflow_id: incident.collectorEvidence.workflowId, run_attempt: 1,
    path: incident.collectorEvidence.workflowPath, event: "workflow_dispatch", head_branch: "main",
    head_sha: incident.workflowSha, status: "completed", conclusion: "failure",
  };
  const jobs = incident.collectorEvidence.jobs.map((job) => ({
    id: job.jobId, run_id: job.runId, run_attempt: 1, head_sha: job.headSha,
    name: job.jobName, status: job.jobStatus, conclusion: job.jobConclusion,
    steps: job.steps.map((step) => ({
      number: step.stepNumber, name: step.stepName, status: step.stepStatus, conclusion: step.stepConclusion,
    })),
  }));
  assert.equal(jobs.flatMap((job) => job.steps).length, 41);
  const responses = new Map<string, unknown>([
    [`${root}/actions/workflows/347992874/runs?per_page=100&page=1`, { total_count: 1, workflow_runs: [{ id: incident.runId, run_attempt: 1 }] }],
    [`${root}/actions/runs/${incident.runId}/artifacts?per_page=100&page=1`, { total_count: 0, artifacts: [] }],
    [`${root}/actions/runs/${incident.runId}/attempts/1`, attempt],
    [`${root}/actions/runs/${incident.runId}/attempts/1/jobs?per_page=100&page=1`, { total_count: 3, jobs }],
    [`${root}/actions/runs/${incident.runId}/attempts/1/jobs?per_page=100&page=2`, { total_count: 3, jobs: [jobs[0]] }],
  ]);
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const value = responses.get(`${url.pathname}${url.search}`);
    return value === undefined ? new Response("missing", { status: 404 }) : new Response(JSON.stringify(value), { status: 200 });
  };
  const options = {
    repository: "CrunchyBrunch/lionlog", currentRunId: incident.runId + 1,
    token: "fixture-token", incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [incident] },
    fetchImpl, now: atDecision,
  };
  await assert.rejects(() => collectPagesAttemptHistory(options), /continuation/);
  responses.set(`${root}/actions/runs/${incident.runId}/attempts/1/jobs?per_page=100&page=2`, { total_count: 3, jobs: [] });
  const changed = structuredClone(jobs);
  changed[2].steps[5].name = "Wrong browser step";
  responses.set(`${root}/actions/runs/${incident.runId}/attempts/1/jobs?per_page=100&page=1`, { total_count: 3, jobs: changed });
  await assert.rejects(() => collectPagesAttemptHistory(options), /graph|step evidence/);
});

function createStoredZip(entries: Array<{ path: string; data: Buffer }>): Buffer {
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
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
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
