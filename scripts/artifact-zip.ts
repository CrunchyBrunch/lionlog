import { inflateRawSync } from "node:zlib";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const MAX_ZIP_BYTES = 115 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 4;

export interface ArtifactZipEntry { readonly path: string; readonly data: Buffer }

export function parseArtifactZip(input: Buffer, expectedPaths: readonly string[]): ArtifactZipEntry[] {
  if (input.byteLength < 22 || input.byteLength > MAX_ZIP_BYTES) throw new Error("Artifact ZIP size is invalid.");
  const eocdOffset = input.byteLength - 22;
  if (input.readUInt32LE(eocdOffset) !== EOCD || input.readUInt16LE(eocdOffset + 20) !== 0) {
    throw new Error("Artifact ZIP must have a canonical end record without a comment.");
  }
  const disk = input.readUInt16LE(eocdOffset + 4);
  const centralDisk = input.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = input.readUInt16LE(eocdOffset + 8);
  const entryCount = input.readUInt16LE(eocdOffset + 10);
  const centralBytes = input.readUInt32LE(eocdOffset + 12);
  const centralOffset = input.readUInt32LE(eocdOffset + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount || entryCount < 1 || entryCount > MAX_FILES) {
    throw new Error("Artifact ZIP disk or entry count is invalid.");
  }
  if (centralOffset + centralBytes !== eocdOffset) throw new Error("Artifact ZIP central directory bounds are invalid.");

  const entries: Array<ArtifactZipEntry & { localOffset: number; endOffset: number; flags: number; crc: number; compressed: number }> = [];
  const seen = new Set<string>();
  const folded = new Set<string>();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocdOffset || input.readUInt32LE(cursor) !== CENTRAL) throw new Error("Artifact ZIP central directory is malformed.");
    const madeBy = input.readUInt16LE(cursor + 4);
    const flags = input.readUInt16LE(cursor + 8);
    const method = input.readUInt16LE(cursor + 10);
    const crc = input.readUInt32LE(cursor + 16);
    const compressed = input.readUInt32LE(cursor + 20);
    const uncompressed = input.readUInt32LE(cursor + 24);
    const nameBytes = input.readUInt16LE(cursor + 28);
    const extraBytes = input.readUInt16LE(cursor + 30);
    const commentBytes = input.readUInt16LE(cursor + 32);
    const diskStart = input.readUInt16LE(cursor + 34);
    const external = input.readUInt32LE(cursor + 38);
    const localOffset = input.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const next = nameStart + nameBytes + extraBytes + commentBytes;
    if (next > eocdOffset || diskStart !== 0 || nameBytes === 0 || extraBytes !== 0 || commentBytes !== 0) {
      throw new Error("Artifact ZIP entry metadata is not canonical.");
    }
    if ((flags & ~0x0808) !== 0 || (method !== 0 && method !== 8) || compressed > MAX_FILE_BYTES || uncompressed > MAX_FILE_BYTES) {
      throw new Error("Artifact ZIP entry encoding is unsupported.");
    }
    const entryPath = input.subarray(nameStart, nameStart + nameBytes).toString("utf8");
    if (!Buffer.from(entryPath, "utf8").equals(input.subarray(nameStart, nameStart + nameBytes)) || /[^\x20-\x7e]/.test(entryPath)) {
      throw new Error("Artifact ZIP entry path must be canonical ASCII.");
    }
    validateArtifactWrapperPath(entryPath);
    if (seen.has(entryPath) || folded.has(entryPath.toLowerCase())) throw new Error("Artifact ZIP contains duplicate or case-colliding paths.");
    seen.add(entryPath);
    folded.add(entryPath.toLowerCase());
    const platform = madeBy >>> 8;
    const unixMode = external >>> 16;
    if (entryPath.endsWith("/") || (platform === 3 && (unixMode & 0o170000) !== 0o100000)) {
      throw new Error("Artifact ZIP may contain only regular files.");
    }
    if (localOffset + 30 > centralOffset || input.readUInt32LE(localOffset) !== LOCAL) throw new Error("Artifact ZIP local header is invalid.");
    const localFlags = input.readUInt16LE(localOffset + 6);
    const localMethod = input.readUInt16LE(localOffset + 8);
    const localCrc = input.readUInt32LE(localOffset + 14);
    const localCompressed = input.readUInt32LE(localOffset + 18);
    const localUncompressed = input.readUInt32LE(localOffset + 22);
    const localNameBytes = input.readUInt16LE(localOffset + 26);
    const localExtraBytes = input.readUInt16LE(localOffset + 28);
    const localNameStart = localOffset + 30;
    const dataStart = localNameStart + localNameBytes + localExtraBytes;
    if (
      localFlags !== flags || localMethod !== method || localNameBytes !== nameBytes || localExtraBytes !== 0
      || !input.subarray(localNameStart, localNameStart + localNameBytes).equals(input.subarray(nameStart, nameStart + nameBytes))
      || dataStart + compressed > centralOffset
      || ((flags & 0x0008) === 0 && (localCrc !== crc || localCompressed !== compressed || localUncompressed !== uncompressed))
      || ((flags & 0x0008) !== 0 && (localCrc !== 0 || localCompressed !== 0 || localUncompressed !== 0))
    ) throw new Error("Artifact ZIP local and central headers disagree.");
    const compressedData = input.subarray(dataStart, dataStart + compressed);
    const data = method === 0 ? Buffer.from(compressedData) : inflateRawSync(compressedData, { maxOutputLength: MAX_FILE_BYTES });
    if (data.byteLength !== uncompressed || crc32(data) !== crc) throw new Error("Artifact ZIP entry payload failed integrity validation.");
    entries.push({ path: entryPath, data, localOffset, endOffset: dataStart + compressed, flags, crc, compressed });
    cursor = next;
  }
  if (cursor !== eocdOffset) throw new Error("Artifact ZIP has trailing central-directory data.");
  const ordered = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    const nextOffset = ordered[index + 1]?.localOffset ?? centralOffset;
    if (entry.endOffset > nextOffset) throw new Error("Artifact ZIP local entries overlap.");
    const gap = nextOffset - entry.endOffset;
    if ((entry.flags & 0x0008) === 0) {
      if (gap !== 0) throw new Error("Artifact ZIP has unexplained data between entries.");
    } else {
      if (gap !== 12 && gap !== 16) throw new Error("Artifact ZIP data descriptor length is invalid.");
      const descriptor = entry.endOffset + (gap === 16 ? 4 : 0);
      if (gap === 16 && input.readUInt32LE(entry.endOffset) !== DESCRIPTOR) throw new Error("Artifact ZIP descriptor signature is invalid.");
      if (input.readUInt32LE(descriptor) !== entry.crc || input.readUInt32LE(descriptor + 4) !== entry.compressed || input.readUInt32LE(descriptor + 8) !== entry.data.byteLength) {
        throw new Error("Artifact ZIP data descriptor is invalid.");
      }
    }
  }
  const actualPaths = entries.map((entry) => entry.path).sort();
  const expected = [...expectedPaths].sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(expected)) throw new Error("Artifact ZIP wrapper file set is invalid.");
  return entries.map(({ path: entryPath, data }) => ({ path: entryPath, data }));
}

export async function extractArtifactZip(input: Buffer, outputDirectory: string, expectedPaths: readonly string[]): Promise<void> {
  const entries = parseArtifactZip(input, expectedPaths);
  await mkdir(outputDirectory, { recursive: false });
  for (const entry of entries) await writeFile(path.join(outputDirectory, entry.path), entry.data, { flag: "wx" });
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function main(): Promise<void> {
  const args = new Map(process.argv.slice(2).map((argument) => {
    const [name, ...value] = argument.split("=");
    return [name, value.join("=")] as const;
  }));
  const zip = args.get("--zip");
  const output = args.get("--output");
  const expected = args.get("--expected")?.split(",").filter(Boolean);
  if (!zip || !output || !expected?.length) throw new Error("Artifact ZIP arguments are incomplete.");
  highlights(expected);
  await extractArtifactZip(await readFile(zip), output, expected);
}

function highlights(paths: readonly string[]): void {
  if (new Set(paths).size !== paths.length) throw new Error("Expected artifact paths must be unique.");
  for (const value of paths) validateArtifactWrapperPath(value);
}

function validateArtifactWrapperPath(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value) || value.includes("..")) {
    throw new Error(`Unsafe artifact ZIP wrapper path: ${value}`);
  }
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) await main();
