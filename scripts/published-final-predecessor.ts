import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validatePublicationReleaseMarker } from "../infrastructure/publication/release-contract.ts";
import type { PublicReleaseObservation } from "./public-release-state.ts";
import { validatePublishedIncidentRecord, verifyPublishedDecision, type PublishedIncident } from "./published-incident.ts";

const BASE = "https://crunchybrunch.github.io/lionlog/";
const MARKER = `${BASE}release.json`;

export interface PublishedPredecessorCheck {
  phase: "incident-release" | "later-known-good";
  inventoryStartedAt: string | null;
  inventoryCompletedAt: string | null;
  markerObservedAt: string;
  evidenceDigest: string;
  releaseId: string;
  fileCount: number;
}

export async function observePublishedPredecessor(options: {
  record: PublishedIncident;
  expectedReleaseId: string;
  laterKnownGood: boolean;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<{ observation: PublicReleaseObservation; check: PublishedPredecessorCheck }> {
  const { record, expectedReleaseId, laterKnownGood } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.now ?? (() => new Date());
  const now = clock();
  validatePublishedIncidentRecord(record, now);
  await verifyPublishedDecision(record, fetchImpl);
  const incidentPhase = expectedReleaseId === record.evidence.release.id;
  if (!incidentPhase && !laterKnownGood) throw new Error("Later public predecessor lacks an independently known-good attempt.");
  if (incidentPhase && laterKnownGood) throw new Error("Incident publication cannot be treated as independently known good.");

  return readPublicPredecessor({
    expectedReleaseId,
    expectedMarker: incidentPhase ? record.evidence.predecessor.marker : null,
    inventory: incidentPhase ? record.evidence.predecessor.publicInventory : [],
    evidenceDigest: record.decision.evidenceDigest, fetchImpl, clock,
  });
}

export async function readPublicPredecessor(options: {
  expectedReleaseId: string;
  expectedMarker: unknown | null;
  inventory: Array<{ path: string; bytes: number; sha256: string }>;
  evidenceDigest: string;
  fetchImpl: typeof fetch;
  clock: () => Date;
}): Promise<{ observation: PublicReleaseObservation; check: PublishedPredecessorCheck }> {
  const { expectedReleaseId, expectedMarker, inventory, evidenceDigest, fetchImpl, clock } = options;
  const incidentPhase = expectedMarker !== null;
  if (incidentPhase && inventory.length === 0) throw new Error("Published incident inventory is empty.");

  let started: string | null = null;
  let completed: string | null = null;
  if (incidentPhase) {
    started = clock().toISOString();
    for (const entry of inventory) {
      const url = new URL(entry.path, BASE);
      if (url.origin !== new URL(BASE).origin || !url.pathname.startsWith("/lionlog/")) {
        throw new Error("Published incident inventory path escaped the target.");
      }
      const response = await fetchImpl(url.href, {
        cache: "no-store", redirect: "error", headers: { "cache-control": "no-cache" },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status !== 200 || response.redirected || response.url !== url.href) {
        throw new Error(`Published incident public inventory unavailable: ${entry.path}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
        throw new Error(`Published incident public inventory differs: ${entry.path}`);
      }
    }
    completed = clock().toISOString();
  }

  // The canonical marker is deliberately the final network read of this proof batch.
  const response = await fetchImpl(MARKER, {
    cache: "no-store", redirect: "error", headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== 200 || response.redirected || response.url !== MARKER
    || !(response.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
    throw new Error("Published incident final marker is unavailable or ambiguous.");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > 16 * 1024) throw new Error("Published incident final marker size is invalid.");
  const marker = validatePublicationReleaseMarker(JSON.parse(bytes.toString("utf8")));
  if (marker.releaseId !== expectedReleaseId
    || (incidentPhase && !isDeepStrictEqual(marker, expectedMarker))) {
    throw new Error("Published incident public predecessor changed after inventory verification.");
  }
  const observed = clock().toISOString();
  if (completed !== null && Date.parse(completed) > Date.parse(observed)) {
    throw new Error("Published incident inventory completed after final marker.");
  }
  return {
    observation: { state: "present", releaseId: marker.releaseId },
    check: {
      phase: incidentPhase ? "incident-release" : "later-known-good",
      inventoryStartedAt: started, inventoryCompletedAt: completed, markerObservedAt: observed,
      evidenceDigest, releaseId: marker.releaseId,
      fileCount: incidentPhase ? inventory.length : 0,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const arg = (name: string): string => {
    const value = process.argv.find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
    if (!value) throw new Error(`Missing ${name}.`);
    return value;
  };
  const history = JSON.parse(await readFile(arg("--incidents"), "utf8")) as { incidents: unknown[] };
  const matches = history.incidents.filter((item) =>
    (item as { outcome?: unknown }).outcome === "resolved-published-browser-unverified");
  if (matches.length !== 1) throw new Error("Published incident history record is missing or duplicate.");
  const record = validatePublishedIncidentRecord(matches[0], new Date());
  const expectedReleaseId = arg("--expected");
  const prior = JSON.parse(await readFile(arg("--prior"), "utf8")) as Array<{ receipt?: { content?: Record<string, unknown> } }>;
  const laterKnownGood = prior.some((attempt) => {
    const content = attempt.receipt?.content;
    return content?.knownGood === true && content?.unresolved === false
      && (content.release as { id?: unknown } | undefined)?.id === expectedReleaseId;
  });
  const result = await observePublishedPredecessor({ record, expectedReleaseId, laterKnownGood });
  await writeFile(arg("--output"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
}
