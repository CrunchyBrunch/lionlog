import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DIGEST = /^(?:sha256:)?([a-f0-9]{64})$/;

export function normalizeArtifactDigest(value: string): string {
  const match = DIGEST.exec(value);
  if (!match) throw new Error("Artifact digest must be a bare or sha256-prefixed lowercase SHA-256 value.");
  return `sha256:${match[1]}`;
}

export function assertArtifactDigest(expected: string, actual: string): string {
  const normalizedExpected = normalizeArtifactDigest(expected);
  const normalizedActual = normalizeArtifactDigest(actual);
  if (normalizedExpected !== normalizedActual) throw new Error("Artifact digest mismatch.");
  return normalizedActual;
}

async function main(): Promise<void> {
  const args = new Map(process.argv.slice(2).map((argument) => {
    const [name, ...value] = argument.split("=");
    return [name, value.join("=")] as const;
  }));
  const expected = args.get("--expected");
  if (!expected) throw new Error("Missing --expected artifact digest.");
  let actual = args.get("--actual");
  const file = args.get("--file");
  if ((actual === undefined) === (file === undefined)) throw new Error("Specify exactly one of --actual or --file.");
  if (file) actual = createHash("sha256").update(await readFile(file)).digest("hex");
  process.stdout.write(`${assertArtifactDigest(expected, actual ?? "")}\n`);
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) await main();
