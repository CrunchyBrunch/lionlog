/** Dormant post-success checkpoint writer. Dispatch selects the approved production workflow revision. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LIONLOG_REPOSITORY } from "../infrastructure/publication/release-contract.ts";
import { appendPublicationCheckpoint, loadPublicationCheckpoint, preparePublicationCheckpoint } from "./publication-checkpoint.ts";
import { branchFromProductionRef } from "./supported-pages-release.ts";

export function assertTrustedWriterEnvironment(value: {
  repository: string; eventName: string; workflowRef: string; ref: string; sha: string;
  runAttempt: number; activation: string; productionRef: string; productionSha: string;
  writerId: number; expectedRunId: number;
}): void {
  if (value.repository !== LIONLOG_REPOSITORY || value.eventName !== "workflow_dispatch"
    || value.activation !== "ENABLE_AUTOMATIC_LIONLOG_REFRESH"
    || value.runAttempt !== 1 || !Number.isSafeInteger(value.writerId) || value.writerId <= 0
    || !Number.isSafeInteger(value.expectedRunId) || value.expectedRunId <= 0
    || !/^[a-f0-9]{40}$/.test(value.productionSha)) {
    throw new Error("Checkpoint writer workflow authority is inactive or invalid.");
  }
  branchFromProductionRef(value.productionRef);
  if (value.ref !== value.productionRef || value.sha !== value.productionSha
    || value.workflowRef !== `${LIONLOG_REPOSITORY}/.github/workflows/advance-refresh-checkpoint.yml@${value.productionRef}`) {
    throw new Error("Checkpoint writer workflow differs from the approved production pin.");
  }
}

export async function advanceRefreshCheckpoint(options: {
  token: string; writerId: number; productionRef: string; productionSha: string;
  expectedRunId: number; manifestBytes: Buffer; incidentHistory: unknown;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  if (!Buffer.isBuffer(options.manifestBytes)) throw new Error("Checkpoint manifest bytes are invalid.");
  const authority = { token: options.token, writerId: options.writerId,
    productionRef: options.productionRef, productionSha: options.productionSha,
    expectedRunId: options.expectedRunId, manifestBytes: Buffer.from(options.manifestBytes),
    incidentHistory: structuredClone(options.incidentHistory), fetchImpl: options.fetchImpl };
  if (!authority.token || !Number.isSafeInteger(authority.writerId) || authority.writerId <= 0
    || !Number.isSafeInteger(authority.expectedRunId) || authority.expectedRunId <= 0
    || !/^[a-f0-9]{40}$/.test(authority.productionSha)) {
    throw new Error("Checkpoint advancement authority is invalid.");
  }
  branchFromProductionRef(authority.productionRef);
  const previous = await loadPublicationCheckpoint({ token: authority.token,
    authorizedWriterId: authority.writerId, fetchImpl: authority.fetchImpl });
  const proposal = await preparePublicationCheckpoint({ token: authority.token,
    authorizedWriterId: authority.writerId, expectedParentSha: previous.commitSha,
    manifestBytes: authority.manifestBytes, incidentHistory: authority.incidentHistory,
    previous: previous.checkpoint, productionRef: authority.productionRef, fetchImpl: authority.fetchImpl });
  if (proposal.checkpoint.boundary.runId !== authority.expectedRunId
    || proposal.checkpoint.boundary.runAttempt !== 1
    || proposal.checkpoint.boundary.workflowSha !== authority.productionSha
    || proposal.checkpoint.publication.sourceSha !== authority.productionSha) {
    throw new Error("The terminal promotion differs from the approved production pin or expected run.");
  }
  const commitSha = await appendPublicationCheckpoint({ token: authority.token,
    authorizedWriterId: authority.writerId, expectedParentSha: previous.commitSha,
    manifestBytes: authority.manifestBytes, incidentHistory: authority.incidentHistory,
    productionRef: authority.productionRef, fetchImpl: authority.fetchImpl,
    expectedPublication: { runId: authority.expectedRunId, runAttempt: 1,
      workflowSha: authority.productionSha, sourceSha: authority.productionSha,
      manifestSha256: proposal.checkpoint.publication.manifestSha256,
      releaseId: proposal.checkpoint.publication.releaseId,
      candidateArtifactId: proposal.checkpoint.publication.candidateArtifactId,
      candidateArtifactDigest: proposal.checkpoint.publication.candidateArtifactDigest } });
  const after = await loadPublicationCheckpoint({ token: authority.token,
    authorizedWriterId: authority.writerId, fetchImpl: authority.fetchImpl });
  if (after.commitSha !== commitSha || after.checkpoint.boundary.runId !== authority.expectedRunId
    || after.checkpoint.publication.sourceSha !== authority.productionSha
    || !after.manifestBytes?.equals(authority.manifestBytes)) {
    throw new Error("Checkpoint advancement did not retain the exact terminal publication and manifest.");
  }
  return commitSha;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = new Map(process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.split("="); return [key, value.join("=")];
  }));
  const required = (key: string): string => {
    const value = args.get(key); if (!value) throw new Error(`Missing ${key}.`); return value;
  };
  const expectedRunId = Number(required("--expected-run-id"));
  assertTrustedWriterEnvironment({ repository: process.env.GITHUB_REPOSITORY ?? "",
    eventName: process.env.GITHUB_EVENT_NAME ?? "", workflowRef: process.env.GITHUB_WORKFLOW_REF ?? "",
    ref: process.env.GITHUB_REF ?? "", sha: process.env.GITHUB_SHA ?? "",
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), activation: process.env.LIONLOG_REFRESH_ACTIVATION ?? "",
    productionRef: process.env.LIONLOG_PRODUCTION_REF ?? "", productionSha: process.env.LIONLOG_PRODUCTION_SHA ?? "",
    writerId: Number(process.env.LIONLOG_PUBLICATION_WRITER_ID), expectedRunId });
  const commitSha = await advanceRefreshCheckpoint({
    token: process.env.LIONLOG_PUBLICATION_WRITER_TOKEN ?? "",
    writerId: Number(process.env.LIONLOG_PUBLICATION_WRITER_ID),
    productionRef: process.env.LIONLOG_PRODUCTION_REF ?? "",
    productionSha: process.env.LIONLOG_PRODUCTION_SHA ?? "",
    expectedRunId,
    manifestBytes: await readFile(required("--manifest")),
    incidentHistory: JSON.parse(await readFile(required("--incidents"), "utf8")),
  });
  process.stdout.write(`${commitSha}\n`);
}
