import { z } from "zod";

export const PUBLICATION_MANIFEST_VERSION = "lionlog.pages-release.v2";
export const PUBLICATION_RECEIPT_VERSION = "lionlog.pages-candidate-receipt.v2";
export const PUBLICATION_MARKER_VERSION = "lionlog.pages-release-marker.v1";
export const PUBLICATION_DEPLOYMENT_RECEIPT_VERSION = "lionlog.pages-deployment-receipt.v2";
export const LIONLOG_REPOSITORY = "CrunchyBrunch/lionlog";
export const LIONLOG_REPOSITORY_ID = 1_346_360_244;
export const LIVE_CANDIDATE_WORKFLOW = ".github/workflows/build-live-menu-artifact.yml";
export const LIVE_CANDIDATE_WORKFLOW_ID = 347_085_467;
export const REQUIRED_CI_WORKFLOW = ".github/workflows/ci.yml";
export const REQUIRED_CI_WORKFLOW_ID = 346_680_782;
export const PROMOTION_WORKFLOW_ID = 347_992_874;
export const TARGET_ORIGIN = "https://crunchybrunch.github.io";
export const TARGET_BASE_PATH = "/lionlog/";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const positiveIdentifierSchema = z.number().int().positive().safe();

export const publicationInventoryEntrySchema = z.object({
  path: z.string().min(1).max(500),
  bytes: z.number().int().min(0).max(10 * 1024 * 1024),
  sha256: sha256Schema,
}).strict();

export const publicationReleaseMarkerSchema = z.object({
  markerVersion: z.literal(PUBLICATION_MARKER_VERSION),
  releaseId: sha256Schema,
  releaseKind: z.enum(["live", "first-release-recovery"]),
  sourceCommitSha: gitShaSchema,
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  catalogSha256: sha256Schema.nullable(),
  shellRevision: gitShaSchema,
  generatedAt: z.string().datetime({ offset: true }),
}).strict();

const menuMetadataSchema = z.object({
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  catalogPath: z.literal("menu-data/v2/catalog.json"),
  catalogSha256: sha256Schema,
  catalogVersion: z.literal("lionlog.psu-catalog.v3"),
  snapshotSchemaVersion: z.literal("lionlog.psu-menu.v2"),
  parserVersion: z.literal("psu-html.v2"),
  generatedAt: z.string().datetime({ offset: true }),
  retrievalStartedAt: z.string().datetime({ offset: true }),
  retrievalCompletedAt: z.string().datetime({ offset: true }),
  earliestFreshUntil: z.string().datetime({ offset: true }),
  earliestRetainUntil: z.string().datetime({ offset: true }),
  coverage: z.enum(["complete", "partial"]),
  sourceObservationCount: z.number().int().min(0).max(100_000),
  publishedObservationCount: z.number().int().min(0).max(100_000),
  omissions: z.object({ "invalid-name": z.number().int().min(0).max(5) }).strict(),
  snapshotCount: z.number().int().min(1).max(2_000),
}).strict();

export const publicationReleaseManifestSchema = z.object({
  manifestVersion: z.literal(PUBLICATION_MANIFEST_VERSION),
  releaseId: sha256Schema,
  releaseKind: z.enum(["live", "first-release-recovery"]),
  createdAt: z.string().datetime({ offset: true }),
  repository: z.object({
    id: z.literal(LIONLOG_REPOSITORY_ID),
    name: z.literal(LIONLOG_REPOSITORY),
  }).strict(),
  source: z.object({
    commitSha: gitShaSchema,
    workflowPath: z.literal(LIVE_CANDIDATE_WORKFLOW),
    workflowId: z.literal(LIVE_CANDIDATE_WORKFLOW_ID),
    workflowRunId: positiveIdentifierSchema,
    workflowRunAttempt: z.literal(1),
  }).strict(),
  target: z.object({
    origin: z.literal(TARGET_ORIGIN),
    basePath: z.literal(TARGET_BASE_PATH),
  }).strict(),
  shellRevision: gitShaSchema,
  menu: menuMetadataSchema.nullable(),
  recovery: z.object({
    releaseId: sha256Schema,
    manifestSha256: sha256Schema,
    artifactId: positiveIdentifierSchema,
    artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict().nullable(),
  marker: z.object({ path: z.literal("release.json"), sha256: sha256Schema }).strict(),
  site: z.object({
    tarFile: z.literal("site.tar"),
    tarSha256: sha256Schema,
    bytes: z.number().int().positive().max(100 * 1024 * 1024),
    inventory: z.array(publicationInventoryEntrySchema).min(5).max(2_000),
  }).strict(),
}).strict().superRefine((manifest, context) => {
  if (manifest.shellRevision !== manifest.source.commitSha) {
    context.addIssue({ code: "custom", message: "Shell revision must equal the source commit SHA." });
  }
  if ((manifest.releaseKind === "live") !== (manifest.menu !== null)) {
    context.addIssue({ code: "custom", message: "Only live releases may contain menu metadata." });
  }
  if ((manifest.releaseKind === "live") !== (manifest.recovery !== null)) {
    context.addIssue({ code: "custom", message: "Live releases must bind one exact first-release recovery artifact." });
  }
  if (manifest.menu !== null && manifest.menu.serviceDate === "") {
    context.addIssue({ code: "custom", message: "Live release service date is missing." });
  }
  const paths = manifest.site.inventory.map((entry) => entry.path);
  if (paths.some((value, index) => index > 0 && paths[index - 1] >= value)) {
    context.addIssue({ code: "custom", message: "Release inventory must be sorted and unique." });
  }
  if (!paths.includes("release.json") || !paths.includes("index.html") || !paths.includes("sw.js")) {
    context.addIssue({ code: "custom", message: "Release inventory is missing required files." });
  }
  if (manifest.releaseKind === "live" && !paths.includes("menu-data/v2/catalog.json")) {
    context.addIssue({ code: "custom", message: "Live release inventory is missing its catalog." });
  }
  if (manifest.releaseKind === "first-release-recovery" && paths.some((value) => value.startsWith("menu-data/"))) {
    context.addIssue({ code: "custom", message: "Recovery release cannot contain menu data." });
  }
});

export const publicationCandidateReceiptSchema = z.object({
  receiptVersion: z.literal(PUBLICATION_RECEIPT_VERSION),
  recordedAt: z.string().datetime({ offset: true }),
  repository: z.object({ id: z.literal(LIONLOG_REPOSITORY_ID), name: z.literal(LIONLOG_REPOSITORY) }).strict(),
  producer: z.object({
    workflowPath: z.literal(LIVE_CANDIDATE_WORKFLOW),
    workflowId: z.literal(LIVE_CANDIDATE_WORKFLOW_ID),
    runId: positiveIdentifierSchema,
    runAttempt: z.literal(1),
    sourceCommitSha: gitShaSchema,
  }).strict(),
  candidate: z.object({
    releaseKind: z.enum(["live", "first-release-recovery"]),
    artifactId: positiveIdentifierSchema,
    artifactName: z.string().regex(/^lionlog-(?:live|first-release-recovery)-[a-z0-9._-]+$/),
    artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    artifactBytes: positiveIdentifierSchema.max(110 * 1024 * 1024),
    artifactExpiresAt: z.string().datetime({ offset: true }),
    manifestSha256: sha256Schema,
    releaseId: sha256Schema,
  }).strict(),
}).strict();

export const publicationDeploymentReceiptSchema = z.object({
  receiptVersion: z.literal(PUBLICATION_DEPLOYMENT_RECEIPT_VERSION),
  recordedAt: z.string().datetime({ offset: true }),
  operation: z.enum(["promote", "rollback", "first-release-recovery"]),
  releaseId: sha256Schema,
  releaseKind: z.enum(["live", "first-release-recovery"]),
  deploymentId: z.string().regex(/^[A-Za-z0-9._-]{1,200}$/).nullable(),
  pageUrl: z.literal("https://crunchybrunch.github.io/lionlog/").nullable(),
  previous: z.object({
    releaseId: z.union([sha256Schema, z.literal("NONE_FIRST_DEPLOYMENT")]),
    deploymentId: z.union([z.string().regex(/^[A-Za-z0-9._-]{1,200}$/), z.literal("NONE_FIRST_DEPLOYMENT")]),
  }).strict(),
  promotion: z.object({
    workflowId: z.literal(PROMOTION_WORKFLOW_ID),
    workflowSha: gitShaSchema,
    runId: positiveIdentifierSchema,
    runAttempt: z.literal(1),
    approvalExpiresAt: z.string().datetime({ offset: true }),
  }).strict(),
  source: z.object({
    artifactId: positiveIdentifierSchema,
    artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    manifestSha256: sha256Schema,
  }).strict(),
  staged: z.object({
    artifactId: positiveIdentifierSchema,
    artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    artifactExpiresAt: z.string().datetime({ offset: true }),
  }).strict(),
  attemptPhase: z.enum(["submitting", "submission-uncertain", "submission-rejected", "accepted", "status-uncertain", "terminal"]),
  pagesAccepted: z.boolean(),
  pagesStatus: z.string().min(1).max(100).nullable(),
  markerVerified: z.boolean(),
  publicProductVerified: z.boolean(),
  knownGood: z.boolean(),
  uncertain: z.boolean(),
}).strict().superRefine((receipt, context) => {
  if (receipt.pagesAccepted !== (receipt.deploymentId !== null)) {
    context.addIssue({ code: "custom", message: "Deployment acceptance identity is inconsistent." });
  }
  if (receipt.knownGood && !(receipt.attemptPhase === "terminal" && receipt.pagesAccepted && receipt.pagesStatus === "succeed" && receipt.markerVerified && receipt.publicProductVerified && !receipt.uncertain)) {
    context.addIssue({ code: "custom", message: "Known-good requires terminal Pages success and full public verification." });
  }
});

export type PublicationReleaseManifest = z.infer<typeof publicationReleaseManifestSchema>;
export type PublicationReleaseMarker = z.infer<typeof publicationReleaseMarkerSchema>;
export type PublicationCandidateReceipt = z.infer<typeof publicationCandidateReceiptSchema>;
export type PublicationDeploymentReceipt = z.infer<typeof publicationDeploymentReceiptSchema>;

export function validatePublicationReleaseManifest(value: unknown): PublicationReleaseManifest {
  return publicationReleaseManifestSchema.parse(value);
}

export function validatePublicationReleaseMarker(value: unknown): PublicationReleaseMarker {
  return publicationReleaseMarkerSchema.parse(value);
}

export function validatePublicationCandidateReceipt(value: unknown): PublicationCandidateReceipt {
  return publicationCandidateReceiptSchema.parse(value);
}
