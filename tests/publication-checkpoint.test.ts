import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  validatePublicationCheckpoint,
  assertCheckpointRunBoundary,
  loadPublicationCheckpoint,
  appendPublicationCheckpoint,
  preparePublicationCheckpoint,
} from "../scripts/publication-checkpoint.ts";
import { collectPagesAttemptHistory } from "../scripts/collect-pages-attempt-history.ts";

const sha = "a".repeat(40);
const source = "b".repeat(40);
const digest = `sha256:${"c".repeat(64)}`;
const releaseId = "d".repeat(64);
const manifestSha = "e".repeat(64);
const receipt = {
  receiptVersion: "lionlog.pages-flat-receipt.v1",
  workflow: { runId: 10, runAttempt: 1, sha },
  candidate: { sourceSha: source, artifactId: 20, artifactDigest: digest, manifestSha256: manifestSha },
  release: { id: releaseId },
  official: { submissionStarted: true, result: "success", pageUrl: "https://crunchybrunch.github.io/lionlog/" },
  public: { markerVerified: true, inventoryVerified: true, browserVerified: true },
  knownGood: true,
  unresolved: false,
};
const receiptBytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
const state = { commitSha: "f".repeat(40), parentSha: "1".repeat(40), writerId: 123, verified: true };
const checkpoint = {
  checkpointVersion: "lionlog.pages-publication-checkpoint.v1",
  repository: { id: 1_346_360_244, name: "CrunchyBrunch/lionlog" },
  branch: "refs/heads/lionlog-publication-state",
  writerId: 123,
  stateParentSha: state.parentSha,
  boundary: { runId: 10, runAttempt: 1, workflowSha: sha },
  publication: {
    releaseId, sourceSha: source, candidateArtifactId: 20, candidateArtifactDigest: digest,
    manifestSha256: manifestSha, receiptArtifactId: 30, receiptArtifactDigest: digest,
    receiptSha256: createHash("sha256").update(receiptBytes).digest("hex"),
  },
  history: { sha256: "2".repeat(64), coveredReruns: [] },
};

function validated(overrides: Record<string, unknown> = {}, alternateReceipt = receiptBytes) {
  return validatePublicationCheckpoint({
    checkpoint: { ...structuredClone(checkpoint), ...overrides },
    receiptBytes: alternateReceipt,
    state,
    authorizedWriterId: 123,
  });
}

test("checkpoint binds exact writer, repository, source, receipt and Git parent", () => {
  assert.equal(validated().boundary.runId, 10);
  assert.throws(() => validated({ writerId: 124 }), /writer/i);
  assert.throws(() => validated({ repository: { id: 1, name: "other/repo" } }), /repository/i);
  assert.throws(() => validated({ stateParentSha: "3".repeat(40) }), /parent/i);
  assert.throws(() => validated({ publication: { ...checkpoint.publication, sourceSha: "4".repeat(40) } }), /source|receipt/i);
  assert.throws(() => validated({}, Buffer.from(JSON.stringify({ ...receipt, public: { ...receipt.public, browserVerified: false } }))), /receipt/i);
});

test("checkpoint boundary detects later reruns of covered runs and missing boundary", () => {
  const accepted = validated();
  assertCheckpointRunBoundary(accepted, [
    { id: 9, run_attempt: 1 }, { id: 10, run_attempt: 1 }, { id: 11, run_attempt: 1 },
  ]);
  assert.throws(() => assertCheckpointRunBoundary(accepted, [{ id: 9, run_attempt: 1 }, { id: 11, run_attempt: 1 }]), /boundary/i);
  assert.throws(() => assertCheckpointRunBoundary(accepted, [{ id: 10, run_attempt: 2 }]), /rerun|boundary/i);
  assert.throws(() => assertCheckpointRunBoundary(accepted, [{ id: 9, run_attempt: 2 }, { id: 10, run_attempt: 1 }]), /rerun/i);
});

test("collector skips expired covered artifacts but still collects later missing or cancelled attempts", async () => {
  const requested: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/actions/workflows/347992874/runs?")) {
      return json({ total_count: 2, workflow_runs: [{ id: 10, run_attempt: 1 }, { id: 11, run_attempt: 1 }] });
    }
    if (url.includes("/actions/runs/10/attempts/1") && !url.includes("/jobs")) {
      return json({ id: 10, workflow_id: 347_992_874, run_attempt: 1,
        path: ".github/workflows/deploy-github-pages.yml", event: "workflow_dispatch", head_branch: "main",
        head_sha: sha, status: "completed", conclusion: "success" });
    }
    if (url.includes("/actions/runs/10/")) throw new Error("Covered receipt or jobs were fetched");
    if (url.includes("/actions/runs/11/artifacts?")) return json({ total_count: 0, artifacts: [] });
    if (url.includes("/actions/runs/11/attempts/1/jobs?")) return json({ total_count: 1, jobs: [{
      id: 110, name: "deploy", run_id: 11, run_attempt: 1, head_sha: sha,
      status: "completed", conclusion: "cancelled", steps: [],
    }] });
    if (url.includes("/actions/runs/11/attempts/1")) {
      return json({ id: 11, workflow_id: 347_992_874, run_attempt: 1,
        path: ".github/workflows/deploy-github-pages.yml", event: "workflow_dispatch", head_branch: "main",
        head_sha: sha, status: "completed", conclusion: "cancelled" });
    }
    return new Response("missing", { status: 404 });
  };
  const attempts = await collectPagesAttemptHistory({
    repository: "CrunchyBrunch/lionlog", currentRunId: 12, token: "fixture",
    incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    checkpoint: validated(), fetchImpl,
  });
  assert.deepEqual(attempts.map((attempt) => [attempt.runId, attempt.conclusion, attempt.receipt]), [[11, "cancelled", null]]);
  assert.ok(!requested.some((url) => url.includes("/actions/runs/10/artifacts")));
});

test("checkpoint collector fails on later ambiguous receipts and incomplete run pagination", async () => {
  const base: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/actions/workflows/347992874/runs?")) {
      return json({ total_count: 2, workflow_runs: [{ id: 10, run_attempt: 1 }, { id: 11, run_attempt: 1 }] });
    }
    if (url.includes("/actions/runs/10/attempts/1")) return json({ id: 10, workflow_id: 347_992_874,
      run_attempt: 1, path: ".github/workflows/deploy-github-pages.yml", event: "workflow_dispatch",
      head_branch: "main", head_sha: sha, status: "completed", conclusion: "success" });
    if (url.includes("/actions/runs/11/artifacts?")) return json({ total_count: 2, artifacts: [
      { id: 31, name: "lionlog-pages-receipt-11-1" }, { id: 32, name: "lionlog-pages-receipt-11-1" },
    ] });
    if (url.includes("/actions/runs/11/attempts/1/jobs?")) return json({ total_count: 1, jobs: [{
      id: 110, name: "deploy", run_id: 11, run_attempt: 1, head_sha: sha,
      status: "completed", conclusion: "failure", steps: [],
    }] });
    if (url.includes("/actions/runs/11/attempts/1")) return json({ id: 11, workflow_id: 347_992_874,
      run_attempt: 1, path: ".github/workflows/deploy-github-pages.yml", event: "workflow_dispatch",
      head_branch: "main", head_sha: sha, status: "completed", conclusion: "failure" });
    return new Response("missing", { status: 404 });
  };
  const options = { repository: "CrunchyBrunch/lionlog", currentRunId: 12, token: "fixture",
    incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] }, checkpoint: validated() };
  await assert.rejects(collectPagesAttemptHistory({ ...options, fetchImpl: base }), /ambiguous flat receipt/);
  await assert.rejects(collectPagesAttemptHistory({ ...options, fetchImpl: async (input, init) => {
    if (String(input).includes("/actions/workflows/347992874/runs?")) {
      return json({ total_count: 3, workflow_runs: [{ id: 10, run_attempt: 1 }, { id: 11, run_attempt: 1 }] });
    }
    return base(input, init);
  } }), /ended before|history/);
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

test("state reader verifies committed data-only tree, signed writer, and exact receipt bytes", async () => {
  const loaded = await loadPublicationCheckpoint({ token: "fixture", authorizedWriterId: 123, fetchImpl: stateFetch() });
  assert.equal(loaded.commitSha, state.commitSha);
  assert.equal(loaded.checkpoint.publication.releaseId, releaseId);
  await assert.rejects(loadPublicationCheckpoint({ token: "fixture", authorizedWriterId: 123,
    fetchImpl: stateFetch({ writerId: 456 }) }), /writer/i);
  await assert.rejects(loadPublicationCheckpoint({ token: "fixture", authorizedWriterId: 123,
    fetchImpl: stateFetch({ repositoryId: 1 }) }), /repository/i);
  await assert.rejects(loadPublicationCheckpoint({ token: "fixture", authorizedWriterId: 123,
    fetchImpl: stateFetch({ receiptBytes: Buffer.from("{}") }) }), /receipt|blob/i);
});

test("state append requires the expected parent and rejects an atomic update race", async () => {
  let updateBody: Record<string, unknown> | null = null;
  const fixture = publicationFixture();
  const proposal = await preparePublicationCheckpoint({
    token: "fixture", authorizedWriterId: 123, expectedParentSha: state.commitSha,
    incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes, fetchImpl: fixture.fetchImpl,
  });
  const stateApi = stateFetch({ onGraphql(body) { updateBody = body; return json({ errors: [{ message: "expectedHeadOid no longer matches" }] }); } });
  const fetchImpl: typeof fetch = (input, init) => String(input).startsWith("https://crunchybrunch.github.io/")
    ? fixture.fetchImpl(input, init) : stateApi(input, init);
  await assert.rejects(appendPublicationCheckpoint({
    ...proposal, manifestBytes: fixture.manifestBytes, expectedParentSha: state.commitSha,
    token: "fixture", authorizedWriterId: 123, fetchImpl,
  }), /expected-parent/i);
  assert.equal(((updateBody! as { variables: { input: { expectedHeadOid: string } } }).variables.input).expectedHeadOid, state.commitSha);
  await assert.rejects(appendPublicationCheckpoint({
    ...proposal, manifestBytes: fixture.manifestBytes, expectedParentSha: "9".repeat(40),
    token: "fixture", authorizedWriterId: 123, fetchImpl,
  }), /parent/i);
});

test("state append checks public bytes, writes two data files, and rereads the new signed commit", async () => {
  const fixture = publicationFixture();
  const proposal = await preparePublicationCheckpoint({
    token: "fixture", authorizedWriterId: 123, expectedParentSha: state.commitSha,
    incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes, fetchImpl: fixture.fetchImpl,
  });
  let tip = state.commitSha;
  let additions: Array<{ path: string; contents: string }> = [];
  const stateApi = stateFetch({ commitSha: () => tip, parentSha: state.commitSha,
    checkpointValue: proposal.checkpoint, receiptBytes: proposal.receiptBytes,
    onGraphql(body) {
      const input = (body.variables as { input: { expectedHeadOid: string; fileChanges: { additions: Array<{ path: string; contents: string }> } } }).input;
      assert.equal(input.expectedHeadOid, state.commitSha);
      additions = input.fileChanges.additions;
      tip = "7".repeat(40);
      return json({ data: { createCommitOnBranch: { commit: { oid: tip } } } });
    },
  });
  const fetchImpl: typeof fetch = (input, init) => String(input).startsWith("https://crunchybrunch.github.io/")
    ? fixture.fetchImpl(input, init) : stateApi(input, init);
  const committed = await appendPublicationCheckpoint({ ...proposal, manifestBytes: fixture.manifestBytes,
    expectedParentSha: state.commitSha, token: "fixture", authorizedWriterId: 123, fetchImpl });
  assert.equal(committed, "7".repeat(40));
  assert.deepEqual(additions.map((entry) => entry.path), ["checkpoint.json", "receipt.json"]);
  assert.deepEqual(Buffer.from(additions[1].contents, "base64"), proposal.receiptBytes);
});

function stateFetch(options: {
  writerId?: number; repositoryId?: number; receiptBytes?: Buffer;
  commitSha?: string | (() => string); parentSha?: string; checkpointValue?: unknown;
  onGraphql?: (body: Record<string, unknown>) => Response;
} = {}): typeof fetch {
  const checkpointBytes = Buffer.from(`${JSON.stringify(options.checkpointValue ?? checkpoint)}\n`);
  const storedReceipt = options.receiptBytes ?? receiptBytes;
  const files = new Map([["checkpoint.json", checkpointBytes], ["receipt.json", storedReceipt]]);
  const gitBlobSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  return async (input, init) => {
    const url = String(input);
    const commitSha = typeof options.commitSha === "function" ? options.commitSha() : options.commitSha ?? state.commitSha;
    if (url.endsWith("/graphql")) return options.onGraphql?.(JSON.parse(String(init?.body))) ?? json({ errors: [{ message: "race" }] });
    if (url.endsWith("/user")) return json({ id: options.writerId ?? 123 });
    if (url.endsWith("/repos/CrunchyBrunch/lionlog")) return json({ id: options.repositoryId ?? 1_346_360_244, full_name: "CrunchyBrunch/lionlog" });
    if (url.endsWith("/git/ref/heads/lionlog-publication-state")) {
      return json({ ref: "refs/heads/lionlog-publication-state", object: { type: "commit", sha: commitSha } });
    }
    if (url.endsWith(`/commits/${commitSha}`)) {
      return json({ sha: commitSha, author: { id: options.writerId ?? 123 }, committer: { id: options.writerId ?? 123 },
        parents: [{ sha: options.parentSha ?? state.parentSha }], commit: { verification: { verified: true }, tree: { sha: "6".repeat(40) } } });
    }
    if (url.endsWith(`/git/trees/${"6".repeat(40)}`)) {
      return json({ sha: "6".repeat(40), truncated: false, tree: [...files].map(([name, bytes]) =>
        ({ path: name, type: "blob", mode: "100644", sha: gitBlobSha(bytes) })) });
    }
    for (const [name, bytes] of files) {
      if (url.includes(`/contents/${name}?ref=${commitSha}`)) {
        return json({ path: name, type: "file", encoding: "base64", sha: gitBlobSha(bytes),
          size: bytes.length, content: bytes.toString("base64").match(/.{1,60}/g)?.join("\n") });
      }
    }
    return new Response("missing", { status: 404 });
  };
}

test("synthetic bootstrap advances only after terminal receipt and full public inventory", async () => {
  const fixture = publicationFixture();
  const proposal = await preparePublicationCheckpoint({
    token: "fixture", authorizedWriterId: 123, expectedParentSha: state.commitSha,
    incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes, fetchImpl: fixture.fetchImpl,
  });
  assert.equal(proposal.checkpoint.boundary.runId, 10);
  assert.equal(proposal.checkpoint.publication.receiptArtifactDigest, fixture.artifactDigest);
  assert.equal(proposal.checkpoint.publication.releaseId, releaseId);
  await assert.rejects(preparePublicationCheckpoint({
    token: "fixture", authorizedWriterId: 123, expectedParentSha: state.commitSha,
    incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes, fetchImpl: publicationFixture({ driftPublic: true }).fetchImpl,
  }), /drifted|identity mismatch/);
});

test("synthetic migration carries the covered boundary and rejects a stale parent", async () => {
  const nextReleaseId = "f".repeat(64);
  const fixture = publicationFixture({ runId: 11, releaseIdValue: nextReleaseId });
  const proposal = await preparePublicationCheckpoint({
    token: "fixture", authorizedWriterId: 123, expectedParentSha: state.commitSha,
    previous: validated(), incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes, fetchImpl: fixture.fetchImpl,
  });
  assert.equal(proposal.checkpoint.boundary.runId, 11);
  assert.equal(proposal.checkpoint.publication.releaseId, nextReleaseId);
  await assert.rejects(preparePublicationCheckpoint({
    token: "fixture", authorizedWriterId: 123, expectedParentSha: "9".repeat(40),
    previous: validated(), incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes, fetchImpl: fixture.fetchImpl,
  }), /migration parent/);
});

function publicationFixture(options: { driftPublic?: boolean; runId?: number; releaseIdValue?: string } = {}) {
  const runId = options.runId ?? 10;
  const publishedReleaseId = options.releaseIdValue ?? releaseId;
  const receiptArtifactId = runId + 20;
  const marker = {
    markerVersion: "lionlog.pages-release-marker.v1", releaseId: publishedReleaseId,
    releaseKind: "first-release-recovery", sourceCommitSha: source,
    serviceDate: null, catalogSha256: null, shellRevision: source,
    generatedAt: "2026-10-13T12:00:00.000Z",
  };
  const publicFiles = new Map<string, Buffer>([
    [".nojekyll", Buffer.alloc(0)], ["index.html", Buffer.from("ok")],
    ["release.json", Buffer.from(JSON.stringify(marker))], ["robots.txt", Buffer.from("ok")], ["sw.js", Buffer.from("ok")],
  ]);
  const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    manifestVersion: "lionlog.pages-release.v2", releaseId: publishedReleaseId, releaseKind: "first-release-recovery",
    createdAt: "2026-10-13T12:00:00.000Z",
    repository: { id: 1_346_360_244, name: "CrunchyBrunch/lionlog" },
    source: { commitSha: source, workflowPath: ".github/workflows/build-live-menu-artifact.yml",
      workflowId: 347_085_467, workflowRunId: 20, workflowRunAttempt: 1 },
    target: { origin: "https://crunchybrunch.github.io", basePath: "/lionlog/" },
    shellRevision: source, menu: null, recovery: null,
    marker: { path: "release.json", sha256: hash(publicFiles.get("release.json")!) },
    site: { tarFile: "site.tar", tarSha256: "3".repeat(64), bytes: 1,
      inventory: [...publicFiles].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const flatReceipt = {
    ...receipt, workflow: { ...receipt.workflow, runId }, release: { id: publishedReleaseId },
    candidate: { ...receipt.candidate, manifestSha256: hash(manifestBytes) },
  };
  const zippedReceipt = storedZip("pages-receipt.json", Buffer.from(JSON.stringify(flatReceipt)));
  const artifactDigest = `sha256:${hash(zippedReceipt)}`;
  let markerCalls = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/actions/workflows/347992874/runs?")) return json({ total_count: runId === 10 ? 1 : 2,
      workflow_runs: runId === 10 ? [{ id: 10, run_attempt: 1 }] : [{ id: 10, run_attempt: 1 }, { id: runId, run_attempt: 1 }] });
    if (runId !== 10 && url.includes("/actions/runs/10/attempts/1") && !url.includes("/jobs")) {
      return json({ id: 10, workflow_id: 347_992_874, run_attempt: 1,
        path: ".github/workflows/deploy-github-pages.yml", event: "workflow_dispatch", head_branch: "main",
        head_sha: sha, status: "completed", conclusion: "success" });
    }
    if (url.includes(`/actions/runs/${runId}/artifacts?`)) return json({ total_count: 1, artifacts: [{
      id: receiptArtifactId, name: `lionlog-pages-receipt-${runId}-1`, digest: artifactDigest,
      expires_at: "2027-01-01T00:00:00.000Z", expired: false,
      workflow_run: { id: runId, head_sha: sha, head_repository_id: 1_346_360_244 },
    }] });
    if (url.includes(`/actions/runs/${runId}/attempts/1/jobs?`)) return json({ total_count: 1, jobs: [{
      id: 100, name: "deploy", run_id: runId, run_attempt: 1, head_sha: sha,
      status: "completed", conclusion: "success", steps: [
        { number: 1, name: "Recheck all authority immediately before submission", status: "completed", conclusion: "success" },
        { number: 2, name: "Record official submission boundary", status: "completed", conclusion: "success" },
        { number: 3, name: "Deploy with official Pages action", status: "completed", conclusion: "success" },
      ],
    }] });
    if (url.includes(`/actions/runs/${runId}/attempts/1`)) return json({
      id: runId, workflow_id: 347_992_874, run_attempt: 1,
      path: ".github/workflows/deploy-github-pages.yml", event: "workflow_dispatch", head_branch: "main",
      head_sha: sha, status: "completed", conclusion: "success",
    });
    if (url.includes(`/actions/artifacts/${receiptArtifactId}/zip`)) return new Response(Uint8Array.from(zippedReceipt), { status: 200 });
    if (url.startsWith("https://crunchybrunch.github.io/lionlog/")) {
      const path = url.slice("https://crunchybrunch.github.io/lionlog/".length);
      if (path === "release.json") markerCalls += 1;
      const bytes = options.driftPublic && path === "release.json" && markerCalls >= 2
        ? Buffer.from(JSON.stringify({ ...marker, releaseId: "f".repeat(64) })) : publicFiles.get(path);
      if (!bytes) return new Response("missing", { status: 404 });
      const response = new Response(Uint8Array.from(bytes), { status: 200, headers: { "content-type": path === "release.json" ? "application/json" : "text/plain" } });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    return new Response("missing", { status: 404 });
  };
  return { manifestBytes, fetchImpl, artifactDigest };
}

function storedZip(name: string, data: Buffer): Buffer {
  const filename = Buffer.from(name);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(0, 42);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(local.length + filename.length + data.length, 16);
  return Buffer.concat([local, filename, data, central, filename, end]);
}
