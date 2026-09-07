import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { publicationReleaseManifestSchema } from "../infrastructure/publication/release-contract.ts";
import { createPublicationBundle, sha256 } from "../scripts/create-publication-bundle.ts";
import { deployExactPagesArtifact } from "../scripts/deploy-exact-pages-artifact.mjs";
import { createPublicationTar, parsePublicationTar } from "../scripts/publication-tar.ts";
import { verifyCurrentPublication } from "../scripts/verify-current-publication.mjs";
import { validateApprovalAndProvenance, verifyPublicationBundle } from "../scripts/verify-publication-bundle.ts";

const sourceSha = "a".repeat(40);
const artifactDigest = `sha256:${"b".repeat(64)}`;
const now = new Date("2026-09-07T12:00:00.000Z");

test("recovery release bundle round-trips and rejects identity tampering", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-publication-"));
  const site = path.join(root, "site");
  const bundle = path.join(root, "bundle");
  await writeRecoverySite(site);
  const manifest = await createPublicationBundle({
    site,
    output: bundle,
    releaseKind: "first-release-recovery",
    commitSha: sourceSha,
    runId: 123,
    runAttempt: 1,
    createdAt: now.toISOString(),
  });
  const manifestBytes = await readFile(path.join(bundle, "release-manifest.json"));
  const metadata = githubMetadata(manifest, now);
  const verified = await verifyPublicationBundle({
    bundleDirectory: bundle,
    extractionDirectory: path.join(root, "extracted"),
    metadata,
    operation: "first-release-recovery",
    expectedSourceSha: sourceSha,
    expectedRunId: 123,
    expectedRunAttempt: 1,
    expectedArtifactId: 456,
    expectedArtifactDigest: artifactDigest,
    expectedManifestSha256: sha256(manifestBytes),
    expectedServiceDate: "NONE",
    approvalExpiresAt: "2026-09-07T13:00:00.000Z",
    partialApproval: "COMPLETE_ONLY",
    expiredRollbackApproval: "NONE",
    workflowSha: sourceSha,
    now,
  });
  assert.equal(verified.releaseId, manifest.releaseId);
  const manifestPath = path.join(bundle, "release-manifest.json");
  const changedIdentity = JSON.parse(manifestBytes.toString("utf8"));
  changedIdentity.releaseId = "0".repeat(64);
  const changedManifestBytes = Buffer.from(`${JSON.stringify(changedIdentity, null, 2)}\n`);
  await writeFile(manifestPath, changedManifestBytes);
  await assert.rejects(verifyPublicationBundle({
    bundleDirectory: bundle,
    metadata,
    operation: "first-release-recovery",
    expectedSourceSha: sourceSha,
    expectedRunId: 123,
    expectedRunAttempt: 1,
    expectedArtifactId: 456,
    expectedArtifactDigest: artifactDigest,
    expectedManifestSha256: sha256(changedManifestBytes),
    expectedServiceDate: "NONE",
    approvalExpiresAt: "2026-09-07T13:00:00.000Z",
    partialApproval: "COMPLETE_ONLY",
    expiredRollbackApproval: "NONE",
    workflowSha: sourceSha,
    now,
  }), /Release identity/);
  await writeFile(manifestPath, manifestBytes);
  const tarPath = path.join(bundle, "site.tar");
  const tampered = Buffer.from(await readFile(tarPath));
  tampered[600] ^= 1;
  await writeFile(tarPath, tampered);
  await assert.rejects(verifyPublicationBundle({
    bundleDirectory: bundle,
    metadata,
    operation: "first-release-recovery",
    expectedSourceSha: sourceSha,
    expectedRunId: 123,
    expectedRunAttempt: 1,
    expectedArtifactId: 456,
    expectedArtifactDigest: artifactDigest,
    expectedManifestSha256: sha256(manifestBytes),
    expectedServiceDate: "NONE",
    approvalExpiresAt: "2026-09-07T13:00:00.000Z",
    partialApproval: "COMPLETE_ONLY",
    expiredRollbackApproval: "NONE",
    workflowSha: sourceSha,
    now,
  }), /tar identity/);
});

test("publication tar rejects traversal, duplicate entries, links, and corrupt headers", () => {
  assert.throws(() => createPublicationTar([{ path: "../escape", data: Buffer.from("x") }]), /Unsafe publication path/);
  assert.throws(() => createPublicationTar([
    { path: "index.html", data: Buffer.from("a") },
    { path: "index.html", data: Buffer.from("b") },
  ]), /Duplicate/);
  const archive = createPublicationTar([{ path: "index.html", data: Buffer.from("a") }]);
  const link = Buffer.from(archive);
  link[156] = "2".charCodeAt(0);
  rewriteTarChecksum(link);
  assert.throws(() => parsePublicationTar(link), /only regular files/);
  const corrupt = Buffer.from(archive);
  corrupt[0] ^= 1;
  assert.throws(() => parsePublicationTar(corrupt), /checksum/);
  const hiddenPadding = Buffer.from(archive);
  hiddenPadding[513] = 1;
  assert.throws(() => parsePublicationTar(hiddenPadding), /non-zero padding/);
});

test("partial live approval is bound to the exact manifest and omission count", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lionlog-approval-"));
  const site = path.join(root, "site");
  await writeRecoverySite(site);
  const recovery = await createPublicationBundle({
    site,
    output: path.join(root, "bundle"),
    releaseKind: "first-release-recovery",
    commitSha: sourceSha,
    runId: 123,
    runAttempt: 1,
    createdAt: now.toISOString(),
  });
  const catalogEntry = { path: "menu-data/v2/catalog.json", bytes: 2, sha256: "c".repeat(64) };
  const live = publicationReleaseManifestSchema.parse({
    ...recovery,
    releaseKind: "live",
    menu: {
      serviceDate: "2026-09-07",
      catalogPath: "menu-data/v2/catalog.json",
      catalogSha256: "c".repeat(64),
      catalogVersion: "lionlog.psu-catalog.v3",
      snapshotSchemaVersion: "lionlog.psu-menu.v2",
      parserVersion: "psu-html.v2",
      generatedAt: "2026-09-07T12:00:00.000Z",
      retrievalStartedAt: "2026-09-07T11:00:00.000Z",
      retrievalCompletedAt: "2026-09-07T11:30:00.000Z",
      earliestFreshUntil: "2026-09-07T14:00:00.000Z",
      earliestRetainUntil: "2026-09-09T12:00:00.000Z",
      coverage: "partial",
      sourceObservationCount: 101,
      publishedObservationCount: 100,
      omissions: { "invalid-name": 1 },
      snapshotCount: 5,
    },
    site: {
      ...recovery.site,
      inventory: [...recovery.site.inventory, catalogEntry].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    },
  });
  const metadata = githubMetadata(live, now);
  const base = {
    metadata,
    operation: "promote" as const,
    expectedSourceSha: sourceSha,
    expectedRunId: 123,
    expectedRunAttempt: 1,
    expectedArtifactId: 456,
    expectedArtifactDigest: artifactDigest,
    expectedManifestSha256: "d".repeat(64),
    expectedServiceDate: "2026-09-07",
    approvalExpiresAt: "2026-09-07T13:00:00.000Z",
    partialApproval: "COMPLETE_ONLY",
    expiredRollbackApproval: "NONE",
    workflowSha: sourceSha,
    now,
  };
  assert.throws(() => validateApprovalAndProvenance(live, base), /Partial coverage/);
  assert.doesNotThrow(() => validateApprovalAndProvenance(live, {
    ...base,
    partialApproval: `APPROVE_PARTIAL:${"d".repeat(64)}:1`,
  }));
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    partialApproval: `APPROVE_PARTIAL:${"e".repeat(64)}:1`,
  }), /Partial coverage/);
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    partialApproval: `APPROVE_PARTIAL:${"d".repeat(64)}:1`,
    approvalExpiresAt: "2026-09-07T11:59:59.000Z",
  }), /expired/);
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    partialApproval: `APPROVE_PARTIAL:${"d".repeat(64)}:1`,
    approvalExpiresAt: "not-a-date",
  }), /invalid/);

  const exactPartialApproval = `APPROVE_PARTIAL:${"d".repeat(64)}:1`;
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    expectedArtifactId: 457,
    partialApproval: exactPartialApproval,
  }), /artifact provenance/);
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    expectedArtifactDigest: `sha256:${"e".repeat(64)}`,
    partialApproval: exactPartialApproval,
  }), /artifact provenance/);
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    expectedSourceSha: "e".repeat(40),
    partialApproval: exactPartialApproval,
  }), /producer run provenance/);

  const expiredMetadata = structuredClone(metadata);
  expiredMetadata.artifact.expired = true;
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    metadata: expiredMetadata,
    partialApproval: exactPartialApproval,
  }), /artifact provenance/);

  const rerunMetadata = structuredClone(metadata);
  rerunMetadata.run.run_attempt = 2;
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    metadata: rerunMetadata,
    partialApproval: exactPartialApproval,
  }), /producer run provenance/);

  const movedMainMetadata = structuredClone(metadata);
  movedMainMetadata.main.sha = "e".repeat(40);
  assert.throws(() => validateApprovalAndProvenance(live, {
    ...base,
    metadata: movedMainMetadata,
    partialApproval: exactPartialApproval,
  }), /Main moved/);

  const stale = publicationReleaseManifestSchema.parse({
    ...live,
    menu: { ...live.menu!, earliestFreshUntil: "2026-09-07T12:14:59.000Z" },
  });
  assert.throws(() => validateApprovalAndProvenance(stale, {
    ...base,
    partialApproval: exactPartialApproval,
  }), /freshness margin/);
  assert.doesNotThrow(() => validateApprovalAndProvenance(stale, {
    ...base,
    operation: "rollback",
    partialApproval: exactPartialApproval,
  }));

  const expiredRollback = publicationReleaseManifestSchema.parse({
    ...stale,
    menu: { ...stale.menu!, earliestRetainUntil: "2026-09-07T11:59:59.000Z" },
  });
  assert.throws(() => validateApprovalAndProvenance(expiredRollback, {
    ...base,
    operation: "rollback",
    partialApproval: exactPartialApproval,
  }), /Expired rollback/);
  assert.doesNotThrow(() => validateApprovalAndProvenance(expiredRollback, {
    ...base,
    operation: "rollback",
    partialApproval: exactPartialApproval,
    expiredRollbackApproval: `ALLOW_EXPIRED_ROLLBACK:${"d".repeat(64)}`,
  }));
});

test("current publication checks first deployment and exact deployed identity", async () => {
  const first = await verifyCurrentPublication({
    expectedReleaseId: "NONE_FIRST_DEPLOYMENT",
    expectedDeploymentId: "NONE_FIRST_DEPLOYMENT",
    token: "token",
    fetchImpl: async () => new Response(null, { status: 404 }),
  });
  assert.equal(first.state, "first-deployment");
  const releaseId = "f".repeat(64);
  const matched = await verifyCurrentPublication({
    expectedReleaseId: releaseId,
    expectedDeploymentId: "deployment-1",
    token: "token",
    fetchImpl: async (input) => String(input).includes("release.json")
      ? Response.json({ releaseId })
      : Response.json({ status: "succeed" }),
  });
  assert.equal(matched.state, "matched");
  await assert.rejects(verifyCurrentPublication({
    expectedReleaseId: releaseId,
    expectedDeploymentId: "deployment-1",
    token: "token",
    fetchImpl: async () => Response.json({ releaseId: "0".repeat(64) }),
  }), /changed/);
});

test("exact Pages adapter submits once, returns the deployment ID, and never retries uncertainty", async () => {
  const requests: string[] = [];
  const result = await deployExactPagesArtifact({
    artifactId: 456,
    buildVersion: sourceSha,
    githubToken: "token",
    oidcToken: "oidc",
    wait: async () => {},
    fetchImpl: async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return init?.method === "POST"
        ? Response.json({
          id: "deployment-1",
          status_url: "https://api.github.com/repos/CrunchyBrunch/lionlog/pages/deployments/deployment-1/status",
          page_url: "https://crunchybrunch.github.io/lionlog/",
        })
        : Response.json({ status: "succeed" });
    },
  });
  assert.equal(result.deploymentId, "deployment-1");
  assert.equal(requests.filter((request) => request.startsWith("POST ")).length, 1);
  let attempts = 0;
  await assert.rejects(deployExactPagesArtifact({
    artifactId: 456,
    buildVersion: sourceSha,
    githubToken: "token",
    oidcToken: "oidc",
    fetchImpl: async () => { attempts += 1; throw new Error("connection reset"); },
  }), /uncertain/);
  assert.equal(attempts, 1);
  await assert.rejects(deployExactPagesArtifact({
    artifactId: 456,
    buildVersion: sourceSha,
    githubToken: "token",
    oidcToken: "oidc",
    wait: async () => {},
    fetchImpl: async (_input, init) => init?.method === "POST"
      ? Response.json({
        id: "deployment-2",
        status_url: "https://api.github.com/repos/CrunchyBrunch/lionlog/pages/deployments/deployment-2/status",
        page_url: "https://crunchybrunch.github.io/lionlog-lookalike/",
      })
      : Response.json({ status: "succeed" }),
  }), /unexpected public URL/);
});

async function writeRecoverySite(root: string): Promise<void> {
  await mkdir(path.join(root, "_next", "static"), { recursive: true });
  await mkdir(path.join(root, "icons"), { recursive: true });
  await writeFile(path.join(root, ".nojekyll"), "\n");
  await writeFile(path.join(root, "index.html"), `<html data-lionlog-shell="${sourceSha}"><link href="/lionlog/_next/static/app.js"><link href="./manifest.webmanifest"></html>`);
  await writeFile(path.join(root, "_next", "static", "app.js"), "console.log('shell');");
  await writeFile(path.join(root, "icons", "icon-192.png"), "icon");
  await writeFile(path.join(root, "manifest.webmanifest"), JSON.stringify({
    id: "./", start_url: "./", scope: "./", icons: [{ src: "./icons/icon-192.png" }],
  }));
  await writeFile(path.join(root, "sw.js"), `const SHELL_REVISION = "${sourceSha}"; const CACHE='lionlog-shell-${sourceSha}'; const EXCLUDED='menu-data';`);
}

function githubMetadata(manifest: { releaseKind: "live" | "first-release-recovery" }, current: Date) {
  return {
    repository: { id: 1_346_360_244, full_name: "CrunchyBrunch/lionlog" },
    main: { sha: sourceSha },
    artifact: {
      id: 456,
      name: manifest.releaseKind === "live" ? "lionlog-live-fixture" : "lionlog-first-release-recovery-fixture",
      digest: artifactDigest,
      size_in_bytes: 1_024,
      expired: false,
      expires_at: new Date(current.getTime() + 60_000).toISOString(),
      workflow_run: { id: 123, head_sha: sourceSha, head_branch: "main", head_repository_id: 1_346_360_244 },
    },
    run: {
      id: 123,
      event: "workflow_dispatch",
      head_sha: sourceSha,
      head_branch: "main",
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/build-live-menu-artifact.yml",
    },
    checkRuns: [{ name: "verify", head_sha: sourceSha, status: "completed", conclusion: "success" }],
  };
}

function rewriteTarChecksum(archive: Buffer): void {
  archive.fill(0x20, 148, 156);
  const checksum = archive.subarray(0, 512).reduce((total, value) => total + value, 0);
  archive.write(checksum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  archive[154] = 0;
  archive[155] = 0x20;
}
