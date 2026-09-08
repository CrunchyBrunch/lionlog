import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const EXPECTED_ORIGIN = "https://crunchybrunch.github.io";
const EXPECTED_BASE = "/lionlog/";

export async function verifyPublicSite({ manifest, fetchImpl = fetch }) {
  if (manifest?.target?.origin !== EXPECTED_ORIGIN || manifest?.target?.basePath !== EXPECTED_BASE) {
    throw new Error("Public verification target is invalid.");
  }
  for (const entry of manifest.site.inventory) {
    const url = new URL(entry.path, `${EXPECTED_ORIGIN}${EXPECTED_BASE}`);
    if (url.origin !== EXPECTED_ORIGIN || !url.pathname.startsWith(EXPECTED_BASE)) throw new Error("Public inventory URL escaped the target.");
    const response = await fetchImpl(url, { cache: "no-store", redirect: "error", headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok || response.redirected) throw new Error(`Public release file is unavailable: ${entry.path}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new Error(`Public release file identity mismatch: ${entry.path}`);
    }
  }
  return { verifiedFiles: manifest.site.inventory.length, releaseId: manifest.releaseId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = JSON.parse(await readFile(process.env.RELEASE_MANIFEST_PATH ?? "", "utf8"));
  console.log(JSON.stringify(await verifyPublicSite({ manifest })));
}
