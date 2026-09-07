import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  LIONLOG_REPOSITORY,
  LIONLOG_REPOSITORY_ID,
  PUBLICATION_RECEIPT_VERSION,
  publicationCandidateReceiptSchema,
  validatePublicationReleaseManifest,
} from "../infrastructure/publication/release-contract.ts";
import { sha256 } from "./create-publication-bundle.ts";

const args = new Map(process.argv.slice(2).map((argument) => {
  const [name, ...value] = argument.split("=");
  return [name, value.join("=")] as const;
}));
const required = (name: string): string => {
  const value = args.get(name);
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
};
const manifestBytes = await readFile(required("--manifest"));
const manifest = validatePublicationReleaseManifest(JSON.parse(manifestBytes.toString("utf8")));
const recordedAt = required("--recorded-at");
const metadata = JSON.parse(await readFile(required("--artifact-metadata"), "utf8")) as {
  id?: unknown;
  name?: unknown;
  digest?: unknown;
  size_in_bytes?: unknown;
  expires_at?: unknown;
  expired?: unknown;
  workflow_run?: { id?: unknown; head_sha?: unknown; head_branch?: unknown; head_repository_id?: unknown };
};
if (
  metadata.expired !== false
  || metadata.workflow_run?.id !== manifest.source.workflowRunId
  || metadata.workflow_run?.head_sha !== manifest.source.commitSha
  || metadata.workflow_run?.head_branch !== "main"
  || metadata.workflow_run?.head_repository_id !== LIONLOG_REPOSITORY_ID
) throw new Error("Candidate artifact metadata does not match its trusted producer.");
const expectedArtifactName = manifest.releaseKind === "live"
  ? `lionlog-live-${manifest.menu?.serviceDate}-${manifest.source.commitSha}-${manifest.source.workflowRunId}-${manifest.source.workflowRunAttempt}`
  : `lionlog-first-release-recovery-${manifest.source.commitSha}-${manifest.source.workflowRunId}-${manifest.source.workflowRunAttempt}`;
if (metadata.name !== expectedArtifactName || Date.parse(String(metadata.expires_at)) <= Date.parse(recordedAt)) {
  throw new Error("Candidate artifact identity or retention is inconsistent with its receipt.");
}
const receipt = publicationCandidateReceiptSchema.parse({
  receiptVersion: PUBLICATION_RECEIPT_VERSION,
  recordedAt,
  repository: { id: LIONLOG_REPOSITORY_ID, name: LIONLOG_REPOSITORY },
  producer: {
    workflowPath: manifest.source.workflowPath,
    runId: manifest.source.workflowRunId,
    runAttempt: manifest.source.workflowRunAttempt,
    sourceCommitSha: manifest.source.commitSha,
  },
  candidate: {
    releaseKind: manifest.releaseKind,
    artifactId: metadata.id,
    artifactName: metadata.name,
    artifactDigest: metadata.digest,
    artifactBytes: metadata.size_in_bytes,
    artifactExpiresAt: metadata.expires_at,
    manifestSha256: sha256(manifestBytes),
    releaseId: manifest.releaseId,
  },
});
await writeFile(path.resolve(required("--output")), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
