import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LIVE_CANDIDATE_WORKFLOW,
  LIVE_CANDIDATE_WORKFLOW_ID,
  LIONLOG_REPOSITORY,
  LIONLOG_REPOSITORY_ID,
  PUBLICATION_MANIFEST_VERSION,
  PUBLICATION_MARKER_VERSION,
  TARGET_BASE_PATH,
  TARGET_ORIGIN,
  publicationReleaseManifestSchema,
  publicationReleaseMarkerSchema,
  type PublicationReleaseManifest,
} from "../infrastructure/publication/release-contract.ts";
import { deriveMenuEvidence } from "../infrastructure/publication/menu-evidence.ts";
import { validatePagesArtifact } from "./prepare-pages-artifact.ts";
import { createPublicationTar, readPublicationFiles } from "./publication-tar.ts";

interface BundleOptions {
  site: string;
  output: string;
  releaseKind: "live" | "first-release-recovery";
  commitSha: string;
  runId: number;
  runAttempt: number;
  createdAt: string;
  recoveryManifest?: string;
  recoveryArtifactId?: number;
  recoveryArtifactDigest?: string;
}

interface PublicationReleaseIdentityInput {
  releaseKind: "live" | "first-release-recovery";
  sourceCommitSha: string;
  workflowRunId: number;
  workflowRunAttempt: number;
  serviceDate: string | null;
  catalogSha256: string | null;
  shellRevision: string;
  recoveryReleaseId: string | null;
}

export async function createPublicationBundle(options: BundleOptions): Promise<PublicationReleaseManifest> {
  const site = path.resolve(options.site);
  const output = path.resolve(options.output);
  if (!/^[a-f0-9]{40}$/.test(options.commitSha)) throw new Error("Candidate source must be an exact lowercase Git SHA.");
  if (options.runAttempt !== 1) throw new Error("Candidate workflow reruns are not eligible for publication.");
  if (!Number.isSafeInteger(options.runId) || options.runId <= 0) throw new Error("Candidate workflow run ID is invalid.");
  if (!Number.isFinite(Date.parse(options.createdAt))) throw new Error("Candidate creation time is invalid.");
  const initialFiles = await validatePagesArtifact(site);
  if (initialFiles.includes("release.json")) throw new Error("Candidate site already contains a release marker.");
  const [applicationDocument, serviceWorker] = await Promise.all([
    readFile(path.join(site, "index.html"), "utf8"),
    readFile(path.join(site, "sw.js"), "utf8"),
  ]);
  if (
    !applicationDocument.includes(`data-lionlog-shell="${options.commitSha}"`)
    || !serviceWorker.includes(`const SHELL_REVISION = "${options.commitSha}";`)
  ) throw new Error("Candidate shell revision does not match its source commit.");

  let menu: PublicationReleaseManifest["menu"] = null;
  let recovery: PublicationReleaseManifest["recovery"] = null;
  let catalogSha256: string | null = null;
  if (options.releaseKind === "live") {
    if (!initialFiles.includes("menu-data/v2/catalog.json")) throw new Error("Live candidate is missing menu data.");
    const evidence = deriveMenuEvidence(await readPublicationFiles(site, initialFiles), options.commitSha, sha256);
    catalogSha256 = evidence.catalogSha256;
    menu = evidence.menu;
    if (!options.recoveryManifest || !Number.isSafeInteger(options.recoveryArtifactId) || !/^sha256:[a-f0-9]{64}$/.test(options.recoveryArtifactDigest ?? "")) {
      throw new Error("Live candidate lacks an exact retained recovery artifact relationship.");
    }
    const recoveryBytes = await readFile(options.recoveryManifest);
    const recoveryManifest = publicationReleaseManifestSchema.parse(JSON.parse(recoveryBytes.toString("utf8")));
    if (
      recoveryManifest.releaseKind !== "first-release-recovery"
      || recoveryManifest.source.commitSha !== options.commitSha
      || recoveryManifest.source.workflowRunId !== options.runId
      || recoveryManifest.source.workflowRunAttempt !== options.runAttempt
    ) throw new Error("Recovery candidate does not match the live producer identity.");
    recovery = {
      releaseId: recoveryManifest.releaseId,
      manifestSha256: sha256(recoveryBytes),
      artifactId: options.recoveryArtifactId!,
      artifactDigest: options.recoveryArtifactDigest!,
    };
  } else if (initialFiles.some((file) => file.startsWith("menu-data/"))) {
    throw new Error("First-release recovery candidate cannot contain menu data.");
  }

  const releaseId = computePublicationReleaseId({
    releaseKind: options.releaseKind,
    sourceCommitSha: options.commitSha,
    workflowRunId: options.runId,
    workflowRunAttempt: options.runAttempt,
    serviceDate: menu?.serviceDate ?? null,
    catalogSha256,
    shellRevision: options.commitSha,
    recoveryReleaseId: recovery?.releaseId ?? null,
  });
  const marker = publicationReleaseMarkerSchema.parse({
    markerVersion: PUBLICATION_MARKER_VERSION,
    releaseId,
    releaseKind: options.releaseKind,
    sourceCommitSha: options.commitSha,
    serviceDate: menu?.serviceDate ?? null,
    catalogSha256,
    shellRevision: options.commitSha,
    generatedAt: options.createdAt,
  });
  const markerBytes = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`);
  await writeFile(path.join(site, "release.json"), markerBytes, { flag: "wx" });
  const files = (await validatePagesArtifact(site)).sort();
  const entries = await readPublicationFiles(site, files);
  const inventory = entries.map((entry) => ({ path: entry.path, bytes: entry.data.byteLength, sha256: sha256(entry.data) }));
  const tarBytes = createPublicationTar(entries);
  const markerInventory = inventory.find((entry) => entry.path === "release.json");
  if (!markerInventory) throw new Error("Release marker is missing from the candidate inventory.");

  const manifest = publicationReleaseManifestSchema.parse({
    manifestVersion: PUBLICATION_MANIFEST_VERSION,
    releaseId,
    releaseKind: options.releaseKind,
    createdAt: options.createdAt,
    repository: { id: LIONLOG_REPOSITORY_ID, name: LIONLOG_REPOSITORY },
    source: {
      commitSha: options.commitSha,
      workflowPath: LIVE_CANDIDATE_WORKFLOW,
      workflowId: LIVE_CANDIDATE_WORKFLOW_ID,
      workflowRunId: options.runId,
      workflowRunAttempt: options.runAttempt,
    },
    target: { origin: TARGET_ORIGIN, basePath: TARGET_BASE_PATH },
    shellRevision: options.commitSha,
    menu,
    recovery,
    marker: { path: "release.json", sha256: markerInventory.sha256 },
    site: { tarFile: "site.tar", tarSha256: sha256(tarBytes), bytes: tarBytes.byteLength, inventory },
  });

  await mkdir(output, { recursive: false });
  await writeFile(path.join(output, "site.tar"), tarBytes, { flag: "wx" });
  await writeFile(path.join(output, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return manifest;
}

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function computePublicationReleaseId(input: PublicationReleaseIdentityInput): string {
  return sha256(Buffer.from(JSON.stringify({
    releaseKind: input.releaseKind,
    repositoryId: LIONLOG_REPOSITORY_ID,
    repository: LIONLOG_REPOSITORY,
    sourceCommitSha: input.sourceCommitSha,
    workflowRunId: input.workflowRunId,
    workflowRunAttempt: input.workflowRunAttempt,
    serviceDate: input.serviceDate,
    catalogSha256: input.catalogSha256,
    shellRevision: input.shellRevision,
    targetOrigin: TARGET_ORIGIN,
    targetBasePath: TARGET_BASE_PATH,
    recoveryReleaseId: input.recoveryReleaseId,
  })));
}

function parseArguments(): BundleOptions {
  const args = new Map(process.argv.slice(2).map((argument) => {
    const [name, ...value] = argument.split("=");
    return [name, value.join("=")] as const;
  }));
  const releaseKind = args.get("--kind");
  if (releaseKind !== "live" && releaseKind !== "first-release-recovery") throw new Error("--kind is invalid.");
  const site = args.get("--site");
  const output = args.get("--output");
  const commitSha = args.get("--commit-sha");
  if (!site || !output || !commitSha) throw new Error("Candidate bundle arguments are incomplete.");
  return {
    site,
    output,
    releaseKind,
    commitSha,
    runId: Number(args.get("--run-id")),
    runAttempt: Number(args.get("--run-attempt")),
    createdAt: args.get("--created-at") ?? new Date().toISOString(),
    recoveryManifest: args.get("--recovery-manifest"),
    recoveryArtifactId: args.has("--recovery-artifact-id") ? Number(args.get("--recovery-artifact-id")) : undefined,
    recoveryArtifactDigest: args.get("--recovery-artifact-digest"),
  };
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) {
  const manifest = await createPublicationBundle(parseArguments());
  console.log(`Created ${manifest.releaseKind} publication bundle ${manifest.releaseId}.`);
}
