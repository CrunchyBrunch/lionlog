/** Dormant post-success checkpoint writer. The workflow_run gate supplies the exact terminal run. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LIONLOG_REPOSITORY } from "../infrastructure/publication/release-contract.ts";
import { appendPublicationCheckpoint, loadPublicationCheckpoint, preparePublicationCheckpoint } from "./publication-checkpoint.ts";
import { branchFromProductionRef } from "./supported-pages-release.ts";

export async function advanceRefreshCheckpoint(options: {
  token: string; writerId: number; productionRef: string; productionSha: string;
  expectedRunId: number; manifestBytes: Buffer; incidentHistory: unknown;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  if (!options.token || !Number.isSafeInteger(options.writerId) || options.writerId <= 0
    || !Number.isSafeInteger(options.expectedRunId) || options.expectedRunId <= 0
    || !/^[a-f0-9]{40}$/.test(options.productionSha) || !Buffer.isBuffer(options.manifestBytes)) {
    throw new Error("Checkpoint advancement authority is invalid.");
  }
  branchFromProductionRef(options.productionRef);
  const previous = await loadPublicationCheckpoint({ token: options.token,
    authorizedWriterId: options.writerId, fetchImpl: options.fetchImpl });
  const proposal = await preparePublicationCheckpoint({ token: options.token,
    authorizedWriterId: options.writerId, expectedParentSha: previous.commitSha,
    manifestBytes: options.manifestBytes, incidentHistory: options.incidentHistory,
    previous: previous.checkpoint, productionRef: options.productionRef, fetchImpl: options.fetchImpl });
  if (proposal.checkpoint.boundary.runId !== options.expectedRunId
    || proposal.checkpoint.boundary.runAttempt !== 1
    || proposal.checkpoint.boundary.workflowSha !== options.productionSha
    || proposal.checkpoint.publication.sourceSha !== options.productionSha) {
    throw new Error("The terminal promotion differs from the approved production pin or expected run.");
  }
  const commitSha = await appendPublicationCheckpoint({ token: options.token,
    authorizedWriterId: options.writerId, expectedParentSha: previous.commitSha,
    manifestBytes: options.manifestBytes, incidentHistory: options.incidentHistory,
    productionRef: options.productionRef, fetchImpl: options.fetchImpl });
  const after = await loadPublicationCheckpoint({ token: options.token,
    authorizedWriterId: options.writerId, fetchImpl: options.fetchImpl });
  if (after.commitSha !== commitSha || after.checkpoint.boundary.runId !== options.expectedRunId
    || after.checkpoint.publication.sourceSha !== options.productionSha
    || !after.manifestBytes?.equals(options.manifestBytes)) {
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
  if (process.env.GITHUB_REPOSITORY !== LIONLOG_REPOSITORY) throw new Error("Checkpoint repository is invalid.");
  const commitSha = await advanceRefreshCheckpoint({
    token: process.env.LIONLOG_PUBLICATION_WRITER_TOKEN ?? "",
    writerId: Number(process.env.LIONLOG_PUBLICATION_WRITER_ID),
    productionRef: process.env.LIONLOG_PRODUCTION_REF ?? "",
    productionSha: process.env.LIONLOG_PRODUCTION_SHA ?? "",
    expectedRunId: Number(required("--expected-run-id")),
    manifestBytes: await readFile(required("--manifest")),
    incidentHistory: JSON.parse(await readFile(required("--incidents"), "utf8")),
  });
  process.stdout.write(`${commitSha}\n`);
}
