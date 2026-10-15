import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  validatePublicationCheckpoint,
  assertCheckpointRunBoundary,
  loadPublicationCheckpoint,
  appendPublicationCheckpoint,
  preparePublicationCheckpoint,
  observeCheckpointPublicProof,
  assertCheckpointPublicProof,
} from "../scripts/publication-checkpoint.ts";
import { collectPagesAttemptHistory } from "../scripts/collect-pages-attempt-history.ts";
import { advanceRefreshCheckpoint } from "../scripts/advance-refresh-checkpoint.ts";

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

test("collector skips expired covered artifacts but blocks a later cancelled attempt", async () => {
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
  await assert.rejects(collectPagesAttemptHistory({
    repository: "CrunchyBrunch/lionlog", currentRunId: 12, token: "fixture",
    incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    checkpoint: validated(), fetchImpl,
  }), /job graph|unsupported terminal/);
  assert.ok(!requested.some((url) => url.includes("/actions/runs/10/artifacts")));
});

test("checkpoint collector fails on later ambiguous receipts and incomplete run pagination", async () => {
  const fixture = publicationFixture({ runId: 11, releaseIdValue: "f".repeat(64) });
  const base: typeof fetch = async (input, init) => String(input).includes("/actions/runs/11/artifacts?")
    ? json({ total_count: 2, artifacts: [
      { id: 31, name: "lionlog-pages-receipt-11-1" }, { id: 32, name: "lionlog-pages-receipt-11-1" },
    ] }) : fixture.fetchImpl(input, init);
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

test("checkpoint manifest remains usable after the candidate artifact expires", async () => {
  const fixture = publicationFixture({ runId: 11, releaseIdValue: "f".repeat(64) });
  const proposal = await preparePublicationCheckpoint({
    token: "fixture", authorizedWriterId: 123, expectedParentSha: state.commitSha,
    previous: validated(), incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes, fetchImpl: fixture.fetchImpl,
  });
  const options = { commitSha: "7".repeat(40), parentSha: state.commitSha,
    checkpointValue: proposal.checkpoint, receiptBytes: proposal.receiptBytes };
  const loaded = await loadPublicationCheckpoint({ token: "fixture", authorizedWriterId: 123,
    fetchImpl: stateFetch({ ...options, manifestBytes: fixture.manifestBytes }) });
  assert.deepEqual(loaded.manifestBytes, fixture.manifestBytes);
  await assert.rejects(loadPublicationCheckpoint({ token: "fixture", authorizedWriterId: 123,
    fetchImpl: stateFetch({ ...options, manifestBytes: Buffer.from("altered") }) }), /manifest.*digest/i);
});

test("state append requires the expected parent and rejects an atomic update race", async () => {
  let updateBody: Record<string, unknown> | null = null;
  const fixture = publicationFixture({ runId: 11, releaseIdValue: "f".repeat(64) });
  const stateApi = stateFetch({ onGraphql(body) { updateBody = body; return json({ errors: [{ message: "expectedHeadOid no longer matches" }] }); } });
  const fetchImpl: typeof fetch = (input, init) => String(input).startsWith("https://crunchybrunch.github.io/") || String(input).includes("/actions/")
    ? fixture.fetchImpl(input, init) : stateApi(input, init);
  await assert.rejects(appendPublicationCheckpoint({
    incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes, expectedParentSha: state.commitSha,
    token: "fixture", authorizedWriterId: 123, fetchImpl,
  }), /expected-parent/i);
  assert.equal(((updateBody! as { variables: { input: { expectedHeadOid: string } } }).variables.input).expectedHeadOid, state.commitSha);
  await assert.rejects(appendPublicationCheckpoint({
    incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes, expectedParentSha: "9".repeat(40),
    token: "fixture", authorizedWriterId: 123, fetchImpl,
  }), /parent/i);
});

test("state append checks public bytes, retains the exact manifest, and rereads the new signed commit", async () => {
  const fixture = publicationFixture({ runId: 11, releaseIdValue: "f".repeat(64) });
  let tip = state.commitSha;
  let parent = state.parentSha;
  let storedCheckpoint: unknown = checkpoint;
  let storedReceipt = receiptBytes;
  let storedManifest: Buffer | undefined;
  let additions: Array<{ path: string; contents: string }> = [];
  const stateApi = stateFetch({ commitSha: () => tip, parentSha: () => parent,
    checkpointValue: () => storedCheckpoint, receiptBytes: () => storedReceipt,
    manifestBytes: () => storedManifest,
    onGraphql(body) {
      const input = (body.variables as { input: { expectedHeadOid: string; fileChanges: { additions: Array<{ path: string; contents: string }> } } }).input;
      assert.equal(input.expectedHeadOid, state.commitSha);
      additions = input.fileChanges.additions;
      storedCheckpoint = JSON.parse(Buffer.from(additions[0].contents, "base64").toString("utf8"));
      storedReceipt = Buffer.from(additions[1].contents, "base64");
      storedManifest = Buffer.from(additions[2].contents, "base64");
      parent = tip;
      tip = "7".repeat(40);
      return json({ data: { createCommitOnBranch: { commit: { oid: tip } } } });
    },
  });
  const fetchImpl: typeof fetch = (input, init) => String(input).startsWith("https://crunchybrunch.github.io/") || String(input).includes("/actions/")
    ? fixture.fetchImpl(input, init) : stateApi(input, init);
  const committed = await appendPublicationCheckpoint({ incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes,
    expectedParentSha: state.commitSha, token: "fixture", authorizedWriterId: 123, fetchImpl });
  assert.equal(committed, "7".repeat(40));
  assert.deepEqual(additions.map((entry) => entry.path), ["checkpoint.json", "receipt.json", "manifest.json"]);
  assert.equal((storedCheckpoint as { boundary: { runId: number } }).boundary.runId, 11);
  assert.deepEqual(Buffer.from(additions[1].contents, "base64"), storedReceipt);
  assert.deepEqual(storedManifest, fixture.manifestBytes);
  await assert.rejects(appendPublicationCheckpoint({ incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes, expectedParentSha: tip, token: "fixture", authorizedWriterId: 123, fetchImpl }),
  /no completed publication attempt|newer distinct|boundary/i);
});

test("post-success writer advances only the exact terminal pinned run", async () => {
  const fixture = publicationFixture({ runId: 11, releaseIdValue: "f".repeat(64), sourceShaValue: sha });
  let tip = state.commitSha;
  let parent = state.parentSha;
  let storedCheckpoint: unknown = checkpoint;
  let storedReceipt = receiptBytes;
  let storedManifest: Buffer | undefined;
  let mutations = 0;
  const stateApi = stateFetch({ commitSha: () => tip, parentSha: () => parent,
    checkpointValue: () => storedCheckpoint, receiptBytes: () => storedReceipt,
    manifestBytes: () => storedManifest,
    onGraphql(body) {
      mutations += 1;
      const additions = (body.variables as { input: { fileChanges: { additions: Array<{ path: string; contents: string }> } } }).input.fileChanges.additions;
      storedCheckpoint = JSON.parse(Buffer.from(additions[0].contents, "base64").toString("utf8"));
      storedReceipt = Buffer.from(additions[1].contents, "base64");
      storedManifest = Buffer.from(additions[2].contents, "base64");
      parent = tip;
      tip = "7".repeat(40);
      return json({ data: { createCommitOnBranch: { commit: { oid: tip } } } });
    } });
  const fetchImpl: typeof fetch = (input, init) => String(input).startsWith("https://crunchybrunch.github.io/") || String(input).includes("/actions/")
    ? fixture.fetchImpl(input, init) : stateApi(input, init);
  const options = { token: "fixture", writerId: 123, productionRef: "refs/heads/lionlog-production",
    productionSha: sha, expectedRunId: 11, manifestBytes: fixture.manifestBytes,
    incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] }, fetchImpl };
  await assert.rejects(advanceRefreshCheckpoint({ ...options, expectedRunId: 12 }), /terminal promotion differs/);
  assert.equal(mutations, 0);
  assert.equal(await advanceRefreshCheckpoint(options), "7".repeat(40));
  assert.equal((storedCheckpoint as { boundary: { runId: number } }).boundary.runId, 11);
  assert.deepEqual(storedManifest, fixture.manifestBytes);
});

test("append rejects a parent changed during the final ref read without posting a mutation", async () => {
  const fixture = publicationFixture({ runId: 11, releaseIdValue: "f".repeat(64) });
  let tip = state.commitSha;
  let refReads = 0;
  let posts = 0;
  const options = { incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes, expectedParentSha: state.commitSha,
    token: "fixture", authorizedWriterId: 123, fetchImpl: undefined as unknown as typeof fetch };
  const stateApi = stateFetch({ commitSha: () => tip, checkpointValue: checkpoint, receiptBytes,
    onGraphql() { posts += 1; tip = "7".repeat(40);
      return json({ data: { createCommitOnBranch: { commit: { oid: tip } } } }); } });
  options.fetchImpl = (input, init) => {
    const url = String(input);
    if (url.includes("/git/ref/heads/lionlog-publication-state") && ++refReads === 3) {
      tip = "9".repeat(40);
      options.expectedParentSha = tip;
    }
    return url.startsWith("https://crunchybrunch.github.io/") || url.includes("/actions/")
      ? fixture.fetchImpl(input, init) : stateApi(input, init);
  };
  await assert.rejects(appendPublicationCheckpoint(options), /parent|state branch|drift|moved/i);
  assert.equal(posts, 0);
});

test("append refuses a caller-edited history digest before any state mutation", async () => {
  const fixture = publicationFixture();
  const proposal = await preparePublicationCheckpoint({
    token: "fixture", authorizedWriterId: 123, expectedParentSha: state.commitSha,
    incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes, fetchImpl: fixture.fetchImpl,
  });
  proposal.checkpoint.history.sha256 = "0".repeat(64);
  let tip = state.commitSha;
  let mutations = 0;
  const stateApi = stateFetch({ commitSha: () => tip, parentSha: state.commitSha,
    checkpointValue: proposal.checkpoint, receiptBytes: proposal.receiptBytes,
    onGraphql() { mutations += 1; tip = "7".repeat(40);
      return json({ data: { createCommitOnBranch: { commit: { oid: tip } } } }); },
  });
  const fetchImpl: typeof fetch = (input, init) => String(input).startsWith("https://crunchybrunch.github.io/")
    ? fixture.fetchImpl(input, init) : stateApi(input, init);
  await assert.rejects(appendPublicationCheckpoint({ ...proposal, manifestBytes: fixture.manifestBytes,
    incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    expectedParentSha: state.commitSha, token: "fixture", authorizedWriterId: 123, fetchImpl }), /history|checkpoint|proposal/i);
  assert.equal(mutations, 0);
});

function stateFetch(options: {
  writerId?: number; repositoryId?: number; receiptBytes?: Buffer | (() => Buffer);
  manifestBytes?: Buffer | (() => Buffer | undefined);
  commitSha?: string | (() => string); parentSha?: string | (() => string); checkpointValue?: unknown | (() => unknown);
  onGraphql?: (body: Record<string, unknown>) => Response;
} = {}): typeof fetch {
  const gitBlobSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  return async (input, init) => {
    const url = String(input);
    const commitSha = typeof options.commitSha === "function" ? options.commitSha() : options.commitSha ?? state.commitSha;
    const parentSha = typeof options.parentSha === "function" ? options.parentSha() : options.parentSha ?? state.parentSha;
    const storedCheckpoint = typeof options.checkpointValue === "function" ? (options.checkpointValue as () => unknown)() : options.checkpointValue ?? checkpoint;
    const storedReceipt = typeof options.receiptBytes === "function" ? options.receiptBytes() : options.receiptBytes ?? receiptBytes;
    const files = new Map([["checkpoint.json", Buffer.from(`${JSON.stringify(storedCheckpoint)}\n`)], ["receipt.json", storedReceipt]]);
    const storedManifest = typeof options.manifestBytes === "function" ? options.manifestBytes() : options.manifestBytes;
    if (storedManifest) files.set("manifest.json", storedManifest);
    if (url.endsWith("/graphql")) return options.onGraphql?.(JSON.parse(String(init?.body))) ?? json({ errors: [{ message: "race" }] });
    if (url.endsWith("/user")) return json({ id: options.writerId ?? 123 });
    if (url.endsWith("/repos/CrunchyBrunch/lionlog")) return json({ id: options.repositoryId ?? 1_346_360_244, full_name: "CrunchyBrunch/lionlog" });
    if (url.endsWith("/git/ref/heads/lionlog-publication-state")) {
      return json({ ref: "refs/heads/lionlog-publication-state", object: { type: "commit", sha: commitSha } });
    }
    if (url.endsWith(`/commits/${commitSha}`)) {
      return json({ sha: commitSha, author: { id: options.writerId ?? 123 }, committer: { id: options.writerId ?? 123 },
        parents: [{ sha: parentSha }], commit: { verification: { verified: true }, tree: { sha: "6".repeat(40) } } });
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

test("public proof is fresh, complete, and bound to the authenticated state commit", async () => {
  const fixture = publicationFixture({ runId: 11, releaseIdValue: "f".repeat(64) });
  const proposal = await preparePublicationCheckpoint({
    token: "fixture", authorizedWriterId: 123, expectedParentSha: state.commitSha,
    previous: validated(), incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes, fetchImpl: fixture.fetchImpl,
  });
  const commitSha = "7".repeat(40);
  const stateApi = stateFetch({ commitSha, parentSha: state.commitSha,
    checkpointValue: proposal.checkpoint, receiptBytes: proposal.receiptBytes });
  const combined = (publicFetch: typeof fetch): typeof fetch => (input, init) =>
    String(input).startsWith("https://crunchybrunch.github.io/") ? publicFetch(input, init) : stateApi(input, init);
  const loaded = await loadPublicationCheckpoint({ token: "fixture", authorizedWriterId: 123, fetchImpl: stateApi });
  assert.throws(() => assertCheckpointPublicProof(loaded.checkpoint, undefined), /fresh.*public inventory/i);
  const proof = await observeCheckpointPublicProof({ checkpoint: loaded.checkpoint, manifestBytes: fixture.manifestBytes,
    token: "fixture", authorizedWriterId: 123, fetchImpl: combined(fixture.fetchImpl) });
  assert.doesNotThrow(() => assertCheckpointPublicProof(loaded.checkpoint, proof));
  assert.throws(() => assertCheckpointPublicProof(loaded.checkpoint, Object.freeze({ ...proof })), /fresh.*public inventory/i);
  await assert.rejects(observeCheckpointPublicProof({ checkpoint: loaded.checkpoint, manifestBytes: fixture.manifestBytes,
    token: "fixture", authorizedWriterId: 123, fetchImpl: combined(publicationFixture({ runId: 11, releaseIdValue: "f".repeat(64), driftPublic: true }).fetchImpl) }),
  /drifted|identity mismatch/);
  const driftedIndex: typeof fetch = async (input, init) => {
    if (String(input).endsWith("/lionlog/index.html")) {
      const response = new Response("changed", { status: 200 });
      Object.defineProperty(response, "url", { value: String(input) });
      return response;
    }
    return fixture.fetchImpl(input, init);
  };
  await assert.rejects(observeCheckpointPublicProof({ checkpoint: loaded.checkpoint, manifestBytes: fixture.manifestBytes,
    token: "fixture", authorizedWriterId: 123, fetchImpl: combined(driftedIndex) }), /drifted|mismatch|sha256|inventory/i);
  await assert.rejects(observeCheckpointPublicProof({ checkpoint: loaded.checkpoint, manifestBytes: fixture.manifestBytes,
    token: "fixture", authorizedWriterId: 123, fetchImpl: stateFetch({ commitSha: "8".repeat(40), parentSha: state.commitSha,
      checkpointValue: proposal.checkpoint, receiptBytes: proposal.receiptBytes }) }), /commit drifted/);
});

test("public proof age starts with observation and includes slow overlapping inventory reads", async () => {
  const fixture = publicationFixture({ runId: 11, releaseIdValue: "f".repeat(64) });
  const proposal = await preparePublicationCheckpoint({ token: "fixture", authorizedWriterId: 123,
    expectedParentSha: state.commitSha, previous: validated(),
    incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes, fetchImpl: fixture.fetchImpl });
  const stateApi = stateFetch({ commitSha: "7".repeat(40), parentSha: state.commitSha,
    checkpointValue: proposal.checkpoint, receiptBytes: proposal.receiptBytes });
  const loaded = await loadPublicationCheckpoint({ token: "fixture", authorizedWriterId: 123, fetchImpl: stateApi });
  const actualNow = Date.now;
  let clock = actualNow();
  let indexObserved = 0;
  let requests = 0;
  Date.now = () => clock;
  try {
    const slowFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const started = clock;
      requests += 1;
      const response = await (url.startsWith("https://crunchybrunch.github.io/")
        ? fixture.fetchImpl(input, init) : stateApi(input, init));
      await Promise.resolve();
      clock = Math.max(clock, started + 14_000);
      if (url.endsWith("/index.html")) indexObserved = clock;
      return response;
    };
    await assert.rejects(observeCheckpointPublicProof({ checkpoint: loaded.checkpoint,
      manifestBytes: fixture.manifestBytes, token: "fixture", authorizedWriterId: 123, fetchImpl: slowFetch }),
    /fresh|stale|expired/i);
    assert(requests > 10);
    assert(clock - indexObserved > 120_000);
  } finally { Date.now = actualNow; }
});

test("public proof accepts the exact freshness limit and rejects one millisecond beyond it", async () => {
  const fixture = publicationFixture({ runId: 11, releaseIdValue: "f".repeat(64) });
  const proposal = await preparePublicationCheckpoint({ token: "fixture", authorizedWriterId: 123,
    expectedParentSha: state.commitSha, previous: validated(),
    incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes, fetchImpl: fixture.fetchImpl });
  const stateApi = stateFetch({ commitSha: "7".repeat(40), parentSha: state.commitSha,
    checkpointValue: proposal.checkpoint, receiptBytes: proposal.receiptBytes });
  const loaded = await loadPublicationCheckpoint({ token: "fixture", authorizedWriterId: 123, fetchImpl: stateApi });
  const actualNow = Date.now;
  const started = actualNow();
  let clock = started;
  Date.now = () => clock;
  try {
    const observeAt = (elapsedMs: number) => {
      clock = started;
      let refReads = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const response = await (url.startsWith("https://crunchybrunch.github.io/")
          ? fixture.fetchImpl(input, init) : stateApi(input, init));
        if (url.includes("/git/ref/heads/lionlog-publication-state") && ++refReads === 4) {
          clock = started + elapsedMs;
        }
        return response;
      };
      return observeCheckpointPublicProof({ checkpoint: loaded.checkpoint, manifestBytes: fixture.manifestBytes,
        token: "fixture", authorizedWriterId: 123, fetchImpl });
    };
    const proof = await observeAt(120_000);
    assert.equal(proof.observedAtMs, started);
    assert.doesNotThrow(() => assertCheckpointPublicProof(loaded.checkpoint, proof));
    clock += 1;
    assert.throws(() => assertCheckpointPublicProof(loaded.checkpoint, proof), /fresh.*public inventory/i);
    await assert.rejects(observeAt(120_001), /expired during observation/i);
  } finally { Date.now = actualNow; }
});

test("checkpoint preparation rejects hidden or contradictory submission graph evidence", async () => {
  const changes: Array<[string, (record: { total_count: number; jobs: Array<Record<string, unknown>> }) => void]> = [
    ["alternate deployment step", (record) => {
      (record.jobs[1].steps as Array<Record<string, unknown>>).push({ number: 5, name: "Deploy exact staged artifact", status: "completed", conclusion: "success" });
    }],
    ["alternate deployment job", (record) => {
      record.jobs.push({ id: 102, name: "alternate-deploy", run_id: 10, run_attempt: 1, head_sha: sha,
        status: "completed", conclusion: "success", steps: [{ number: 1, name: "Deploy exact staged artifact", status: "completed", conclusion: "success" }] });
      record.total_count += 1;
    }],
    ["renamed submission", (record) => {
      (record.jobs[1].steps as Array<Record<string, unknown>>).push({ number: 5, name: "Record official submission boundary (retry)", status: "completed", conclusion: "success" });
    }],
    ["relocated steps", (record) => { record.jobs[1].name = "alternate-deploy"; }],
    ["job outcome contradicts attempt", (record) => { record.jobs[1].conclusion = "failure"; }],
    ["successful staging job skipped a required step", (record) => {
      ((record.jobs[0].steps as Array<Record<string, unknown>>)[5]).conclusion = "skipped";
    }],
  ];
  for (const [label, change] of changes) {
    const fixture = publicationFixture();
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await fixture.fetchImpl(input, init);
      if (!String(input).includes("/attempts/1/jobs?")) return response;
      const record = await response.json() as { total_count: number; jobs: Array<Record<string, unknown>> };
      change(record);
      return json(record);
    };
    await assert.rejects(preparePublicationCheckpoint({
      token: "fixture", authorizedWriterId: 123, expectedParentSha: state.commitSha,
      incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
      manifestBytes: fixture.manifestBytes, fetchImpl,
    }), { name: "Error" }, label);
  }
});

test("checkpoint accepts GitHub's complete staging name for its own run and rejects another run's name", async () => {
  const fixture = publicationFixture();
  const prepareWithName = (stagedRunId: number, stagedAttempt = 1) => preparePublicationCheckpoint({
    token: "fixture", authorizedWriterId: 123, expectedParentSha: state.commitSha,
    incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: fixture.manifestBytes,
    fetchImpl: async (input, init) => {
      const response = await fixture.fetchImpl(input, init);
      if (!String(input).includes("/attempts/1/jobs?")) return response;
      const record = await response.json() as { jobs: Array<Record<string, unknown>> };
      addGitHubDisplaySteps(record.jobs, stagedRunId, stagedAttempt);
      return json(record);
    },
  });
  assert.equal((await prepareWithName(10)).checkpoint.boundary.runId, 10);
  await assert.rejects(prepareWithName(11), /unknown|stage|step/i);
  await assert.rejects(prepareWithName(10, 2), /unknown|stage|step/i);
});

function addGitHubDisplaySteps(jobs: Array<Record<string, unknown>>, stagedRunId: number, stagedAttempt = 1): void {
  const checkout = "Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
  const setup = "Run actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
  for (const job of jobs) {
    const original = job.steps as Array<{ name: string; conclusion: string }>;
    const names = original.map((step) => step.name);
    if (job.name === "validate-and-stage") {
      names.splice(1, 0, `Run echo "staged=lionlog-pages-${stagedRunId}-${stagedAttempt}" >> "$GITHUB_OUTPUT"`);
    }
    job.steps = ["Set up job", checkout, setup, "Run npm ci --ignore-scripts --omit=dev", ...names,
      `Post ${setup}`, `Post ${checkout}`, "Complete job"]
      .map((name, index) => ({ number: index + 1, name, status: "completed",
        conclusion: original.find((step) => step.name === name)?.conclusion ?? "success" }));
  }
}

test("checkpoint accepts an affirmative pre-submission failure before the next publication but rejects its hidden job", async () => {
  const failed = publicationFixture({ runId: 11, releaseIdValue: "e".repeat(64) });
  const published = publicationFixture({ runId: 12, releaseIdValue: "f".repeat(64) });
  const failedReceipt = { ...receipt,
    workflow: { ...receipt.workflow, runId: 11 }, release: { id: "e".repeat(64) },
    official: { submissionStarted: false, result: "failure", pageUrl: "https://crunchybrunch.github.io/lionlog/" },
    public: { markerVerified: false, inventoryVerified: false, browserVerified: false },
    knownGood: false, unresolved: false };
  const failedZip = storedZip("pages-receipt.json", Buffer.from(JSON.stringify(failedReceipt)));
  const failedDigest = `sha256:${createHash("sha256").update(failedZip).digest("hex")}`;
  const fetchFor = (hiddenJob: boolean): typeof fetch => async (input, init) => {
    const url = String(input);
    if (url.includes("/actions/workflows/347992874/runs?")) return json({ total_count: 3,
      workflow_runs: [10, 11, 12].map((id) => ({ id, run_attempt: 1 })) });
    if (url.includes("/actions/artifacts/31/zip")) return new Response(Uint8Array.from(failedZip), { status: 200 });
    if (url.includes("/actions/runs/11/") && !url.includes("/actions/artifacts/")) {
      const response = await failed.fetchImpl(input, init);
      const data = await response.json() as Record<string, unknown>;
      if (url.includes("/artifacts?")) {
        ((data.artifacts as Array<Record<string, unknown>>)[0]).digest = failedDigest;
      } else if (url.endsWith("/attempts/1")) {
        data.conclusion = "failure";
      } else if (url.includes("/jobs?")) {
        const jobs = data.jobs as Array<Record<string, unknown>>;
        const deploy = jobs[1];
        const verify = jobs[2];
        deploy.conclusion = "failure";
        (deploy.steps as Array<Record<string, unknown>>).forEach((step, index) => {
          step.conclusion = index === 1 ? "failure" : index > 1 ? "skipped" : "success";
        });
        verify.conclusion = "failure";
        (verify.steps as Array<Record<string, unknown>>).forEach((step, index) => {
          step.conclusion = index === 4 ? "failure" : index === 1 ? "skipped" : "success";
        });
        if (hiddenJob) {
          jobs.push({ id: 111, name: "alternate-deploy", run_id: 11, run_attempt: 1, head_sha: sha,
            status: "completed", conclusion: "success", steps: [{ number: 1, name: "Deploy exact staged artifact",
              status: "completed", conclusion: "success" }] });
          data.total_count = 4;
        }
        addGitHubDisplaySteps(jobs, 11);
      }
      return json(data);
    }
    const response = await published.fetchImpl(input, init);
    if (!url.includes("/actions/runs/12/attempts/1/jobs?")) return response;
    const data = await response.json() as { jobs: Array<Record<string, unknown>> };
    addGitHubDisplaySteps(data.jobs, 12);
    return json(data);
  };
  const options = { token: "fixture", authorizedWriterId: 123, expectedParentSha: state.commitSha,
    previous: validated(), incidentHistory: { historyVersion: "lionlog.pages-incident-history.v1", incidents: [] },
    manifestBytes: published.manifestBytes };
  const accepted = await preparePublicationCheckpoint({ ...options, fetchImpl: fetchFor(false) });
  assert.equal(accepted.checkpoint.boundary.runId, 12);
  await assert.rejects(preparePublicationCheckpoint({ ...options, fetchImpl: fetchFor(true) }), /graph|unknown|extra job/i);
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

function publicationFixture(options: { driftPublic?: boolean; runId?: number; releaseIdValue?: string; sourceShaValue?: string } = {}) {
  const runId = options.runId ?? 10;
  const publishedReleaseId = options.releaseIdValue ?? releaseId;
  const fixtureSource = options.sourceShaValue ?? source;
  const receiptArtifactId = runId + 20;
  const marker = {
    markerVersion: "lionlog.pages-release-marker.v1", releaseId: publishedReleaseId,
    releaseKind: "first-release-recovery", sourceCommitSha: fixtureSource,
    serviceDate: null, catalogSha256: null, shellRevision: fixtureSource,
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
    source: { commitSha: fixtureSource, workflowPath: ".github/workflows/build-live-menu-artifact.yml",
      workflowId: 347_085_467, workflowRunId: 20, workflowRunAttempt: 1 },
    target: { origin: "https://crunchybrunch.github.io", basePath: "/lionlog/" },
    shellRevision: fixtureSource, menu: null, recovery: null,
    marker: { path: "release.json", sha256: hash(publicFiles.get("release.json")!) },
    site: { tarFile: "site.tar", tarSha256: "3".repeat(64), bytes: 1,
      inventory: [...publicFiles].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })) },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const flatReceipt = {
    ...receipt, workflow: { ...receipt.workflow, runId }, release: { id: publishedReleaseId },
    candidate: { ...receipt.candidate, sourceSha: fixtureSource, manifestSha256: hash(manifestBytes) },
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
    if (url.includes(`/actions/runs/${runId}/attempts/1/jobs?`)) return json({ total_count: 3, jobs: [
      { id: 99, name: "validate-and-stage", run_id: runId, run_attempt: 1, head_sha: sha,
        status: "completed", conclusion: "success", steps: [
          "Validate immutable input shapes", "Read exact GitHub provenance", "Bind the exact public predecessor before approval",
          "Download exact retained inputs", "Validate candidate and extract exact site bytes",
          "Stage exact bytes with official Pages artifact action", "Re-download and verify staged bytes",
          "Retain compact preapproval evidence", "Normalize retained preapproval wrapper digest", "Publish human review summary",
        ].map((name, index) => ({ number: index + 1, name, status: "completed", conclusion: "success" })) },
      { id: 100, name: "deploy", run_id: runId, run_attempt: 1, head_sha: sha,
        status: "completed", conclusion: "success", steps: [
          "Download exact preapproval summary", "Recheck all authority immediately before submission",
          "Record official submission boundary", "Deploy with official Pages action",
        ].map((name, index) => ({ number: index + 1, name, status: "completed", conclusion: "success" })) },
      { id: 101, name: "verify-public", run_id: runId, run_attempt: 1, head_sha: sha,
        status: "completed", conclusion: "success", steps: [
          "Recover exact summary and manifest", "Verify public inventory and mobile PWA behavior",
          "Create one flat retained receipt", "Retain flat receipt", "Require fully verified known-good result",
        ].map((name, index) => ({ number: index + 1, name, status: "completed", conclusion: "success" })) },
    ] });
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
        ? Buffer.from(JSON.stringify({ ...marker, releaseId: publishedReleaseId === "f".repeat(64) ? releaseId : "f".repeat(64) })) : publicFiles.get(path);
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
