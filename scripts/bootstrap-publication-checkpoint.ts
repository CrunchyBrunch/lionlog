/** One-time preactivation seed from a proven terminal Pages publication. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LIONLOG_REPOSITORY } from "../infrastructure/publication/release-contract.ts";
import { bootstrapPublicationCheckpoint } from "./publication-checkpoint.ts";
import { branchFromProductionRef } from "./supported-pages-release.ts";

export function assertTrustedBootstrapEnvironment(value: {
  repository: string; eventName: string; workflowRef: string; ref: string; sha: string;
  runAttempt: number; activation: string; productionRef: string; productionSha: string;
  writerId: number; expectedRunId: number; expectedRootSha: string; expectedSourceSha: string;
}): void {
  if (value.repository !== LIONLOG_REPOSITORY || value.eventName !== "workflow_dispatch"
    || value.activation === "ENABLE_AUTOMATIC_LIONLOG_REFRESH"
    || value.runAttempt !== 1 || !Number.isSafeInteger(value.writerId) || value.writerId <= 0
    || !Number.isSafeInteger(value.expectedRunId) || value.expectedRunId <= 0
    || !/^[a-f0-9]{40}$/.test(value.expectedRootSha)
    || !/^[a-f0-9]{40}$/.test(value.expectedSourceSha)
    || !/^[a-f0-9]{40}$/.test(value.productionSha)) {
    throw new Error("Checkpoint bootstrap workflow authority is invalid or active.");
  }
  branchFromProductionRef(value.productionRef);
  if (value.ref !== value.productionRef || value.sha !== value.productionSha
    || value.expectedSourceSha !== value.productionSha
    || value.workflowRef !== `${LIONLOG_REPOSITORY}/.github/workflows/bootstrap-publication-checkpoint.yml@${value.productionRef}`) {
    throw new Error("Checkpoint bootstrap workflow differs from the approved production pin.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = new Map(process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.split("="); return [key, value.join("=")];
  }));
  const required = (key: string): string => {
    const value = args.get(key); if (!value) throw new Error(`Missing ${key}.`); return value;
  };
  const expectedRunId = Number(required("--expected-run-id"));
  const expectedRootSha = required("--expected-root-sha");
  const expectedSourceSha = required("--expected-source-sha");
  assertTrustedBootstrapEnvironment({ repository: process.env.GITHUB_REPOSITORY ?? "",
    eventName: process.env.GITHUB_EVENT_NAME ?? "", workflowRef: process.env.GITHUB_WORKFLOW_REF ?? "",
    ref: process.env.GITHUB_REF ?? "", sha: process.env.GITHUB_SHA ?? "",
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT), activation: process.env.LIONLOG_REFRESH_ACTIVATION ?? "",
    productionRef: process.env.LIONLOG_PRODUCTION_REF ?? "", productionSha: process.env.LIONLOG_PRODUCTION_SHA ?? "",
    writerId: Number(process.env.LIONLOG_PUBLICATION_WRITER_ID), expectedRunId,
    expectedRootSha, expectedSourceSha });
  const commitSha = await bootstrapPublicationCheckpoint({
    token: process.env.LIONLOG_PUBLICATION_WRITER_TOKEN ?? "",
    authorizedWriterId: Number(process.env.LIONLOG_PUBLICATION_WRITER_ID),
    authorizedAppSlug: process.env.LIONLOG_PUBLICATION_APP_SLUG ?? "",
    expectedRootSha, expectedRunId, expectedSourceSha,
    productionRef: process.env.LIONLOG_PRODUCTION_REF ?? "",
    manifestBytes: await readFile(required("--manifest")),
    incidentHistory: JSON.parse(await readFile(required("--incidents"), "utf8")),
  });
  process.stdout.write(`${commitSha}\n`);
}
