import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validatePublicationReleaseManifest } from "../infrastructure/publication/release-contract.ts";
import { assertSnapshotMatchesCatalog, validatePsuPublicationCatalog } from "../infrastructure/psu/publication-catalog.ts";
import { validatePsuSnapshot } from "../infrastructure/psu/snapshot-schema.ts";
import { parsePublicationTar } from "./publication-tar.ts";
import { sha256 } from "./create-publication-bundle.ts";

export async function selectBrowserVerificationContext(bundleDirectory: string): Promise<Record<string, unknown>> {
  const manifest = validatePublicationReleaseManifest(JSON.parse(await readFile(path.join(bundleDirectory, "release-manifest.json"), "utf8")));
  if (manifest.releaseKind !== "live" || manifest.menu === null) throw new Error("Browser verification requires a live release.");
  const tarBytes = await readFile(path.join(bundleDirectory, manifest.site.tarFile));
  if (tarBytes.byteLength !== manifest.site.bytes || sha256(tarBytes) !== manifest.site.tarSha256) {
    throw new Error("Browser verification site tar differs from its release manifest.");
  }
  const entries = parsePublicationTar(tarBytes);
  const inventory = entries.map((entry) => ({ path: entry.path, bytes: entry.data.byteLength, sha256: sha256(entry.data) }));
  if (JSON.stringify(inventory) !== JSON.stringify(manifest.site.inventory)) {
    throw new Error("Browser verification inventory differs from its release manifest.");
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry.data]));
  const catalogBytes = byPath.get(manifest.menu.catalogPath);
  if (!catalogBytes) throw new Error("Browser verification catalog is missing.");
  if (sha256(catalogBytes) !== manifest.menu.catalogSha256) throw new Error("Browser verification catalog digest is invalid.");
  const catalog = validatePsuPublicationCatalog(JSON.parse(catalogBytes.toString("utf8")));
  for (const catalogEntry of catalog.snapshots) {
    const snapshotPath = `menu-data/v2/${catalogEntry.snapshotUrl.slice(2)}`;
    const snapshotBytes = byPath.get(snapshotPath);
    if (!snapshotBytes) throw new Error(`Browser verification snapshot is missing: ${snapshotPath}`);
    const snapshot = validatePsuSnapshot(JSON.parse(snapshotBytes.toString("utf8")));
    assertSnapshotMatchesCatalog(snapshot, catalogEntry);
    const items = snapshot.stations.flatMap((station) => station.items);
    if (items.length > 0) {
      return {
        contextVersion: "lionlog.pages-browser-context.v1",
        releaseId: manifest.releaseId,
        shellRevision: manifest.shellRevision,
        serviceDate: snapshot.query.serviceDate,
        hallId: snapshot.query.hallId,
        mealPeriodId: snapshot.query.mealPeriodId,
        snapshotId: snapshot.snapshotId,
        expectedItemCount: items.length,
        expectedFirstFoodName: items[0].name,
      };
    }
  }
  throw new Error("Live release has no non-empty menu context for substantive browser verification.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const bundle = process.argv.find((argument) => argument.startsWith("--bundle="))?.slice("--bundle=".length);
  const output = process.argv.find((argument) => argument.startsWith("--output="))?.slice("--output=".length);
  if (!bundle || !output) throw new Error("Browser verification context arguments are incomplete.");
  await writeFile(output, `${JSON.stringify(await selectBrowserVerificationContext(bundle), null, 2)}\n`, { flag: "wx" });
}
