import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validatePublicationEntryPath } from "./prepare-pages-artifact.ts";

const BLOCK_BYTES = 512;
const MAX_TAR_BYTES = 100 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 2_000;

export interface TarFileEntry {
  readonly path: string;
  readonly data: Buffer;
}

export function createPublicationTar(entries: readonly TarFileEntry[]): Buffer {
  if (entries.length === 0 || entries.length > MAX_FILES) throw new Error("Publication tar file count is invalid.");
  const sorted = [...entries].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const seen = new Set<string>();
  const blocks: Buffer[] = [];
  for (const entry of sorted) {
    validatePublicationEntryPath(entry.path);
    if (seen.has(entry.path)) throw new Error(`Duplicate publication tar entry: ${entry.path}`);
    seen.add(entry.path);
    if (entry.data.byteLength > MAX_FILE_BYTES) throw new Error(`Publication tar entry is too large: ${entry.path}`);
    const { name, prefix } = splitTarPath(entry.path);
    const header = Buffer.alloc(BLOCK_BYTES);
    writeString(header, 0, 100, name);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.data.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeString(header, 257, 6, "ustar");
    writeString(header, 263, 2, "00");
    writeString(header, 345, 155, prefix);
    const checksum = header.reduce((total, value) => total + value, 0);
    const checksumText = checksum.toString(8).padStart(6, "0");
    header.write(checksumText, 148, 6, "ascii");
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header, entry.data);
    const padding = (BLOCK_BYTES - (entry.data.byteLength % BLOCK_BYTES)) % BLOCK_BYTES;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(BLOCK_BYTES * 2));
  const archive = Buffer.concat(blocks);
  if (archive.byteLength > MAX_TAR_BYTES) throw new Error("Publication tar exceeds its total size bound.");
  return archive;
}

export function parsePublicationTar(archive: Buffer): TarFileEntry[] {
  if (archive.byteLength === 0 || archive.byteLength > MAX_TAR_BYTES || archive.byteLength % BLOCK_BYTES !== 0) {
    throw new Error("Publication tar size is invalid.");
  }
  const entries: TarFileEntry[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let zeroBlocks = 0;
  while (offset < archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK_BYTES);
    offset += BLOCK_BYTES;
    if (header.every((value) => value === 0)) {
      zeroBlocks += 1;
      if (zeroBlocks >= 2) {
        if (!archive.subarray(offset).every((value) => value === 0)) throw new Error("Publication tar has data after its terminator.");
        break;
      }
      continue;
    }
    if (zeroBlocks > 0) throw new Error("Publication tar has an invalid zero block.");
    if (entries.length >= MAX_FILES) throw new Error("Publication tar has too many files.");
    const storedChecksum = readOctal(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((total, value) => total + value, 0);
    if (storedChecksum !== actualChecksum) throw new Error("Publication tar header checksum is invalid.");
    const magic = readString(header, 257, 6);
    if (magic !== "ustar") throw new Error("Publication tar must use the ustar format.");
    const type = header[156];
    if (type !== 0 && type !== "0".charCodeAt(0)) throw new Error("Publication tar may contain only regular files.");
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const entryPath = prefix === "" ? name : `${prefix}/${name}`;
    validatePublicationEntryPath(entryPath);
    if (seen.has(entryPath)) throw new Error(`Duplicate publication tar entry: ${entryPath}`);
    seen.add(entryPath);
    const size = readOctal(header, 124, 12);
    if (size > MAX_FILE_BYTES || offset + size > archive.byteLength) throw new Error(`Invalid publication tar size for ${entryPath}`);
    entries.push({ path: entryPath, data: Buffer.from(archive.subarray(offset, offset + size)) });
    const paddedSize = Math.ceil(size / BLOCK_BYTES) * BLOCK_BYTES;
    if (!archive.subarray(offset + size, offset + paddedSize).every((value) => value === 0)) {
      throw new Error(`Publication tar has non-zero padding for ${entryPath}`);
    }
    offset += paddedSize;
  }
  if (zeroBlocks < 2 || entries.length === 0) throw new Error("Publication tar is incomplete.");
  return entries;
}

export async function extractPublicationTar(archive: Buffer, outputDirectory: string): Promise<TarFileEntry[]> {
  const entries = parsePublicationTar(archive);
  await mkdir(outputDirectory, { recursive: true });
  for (const entry of entries) {
    const destination = path.join(outputDirectory, ...entry.path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, entry.data, { flag: "wx" });
  }
  return entries;
}

export async function readPublicationFiles(root: string, paths: readonly string[]): Promise<TarFileEntry[]> {
  return Promise.all(paths.map(async (relativePath) => ({
    path: relativePath,
    data: await readFile(path.join(root, ...relativePath.split("/"))),
  })));
}

function splitTarPath(relativePath: string): { name: string; prefix: string } {
  if (Buffer.byteLength(relativePath, "ascii") <= 100) return { name: relativePath, prefix: "" };
  for (let index = relativePath.lastIndexOf("/"); index > 0; index = relativePath.lastIndexOf("/", index - 1)) {
    const prefix = relativePath.slice(0, index);
    const name = relativePath.slice(index + 1);
    if (Buffer.byteLength(prefix, "ascii") <= 155 && Buffer.byteLength(name, "ascii") <= 100) return { name, prefix };
  }
  throw new Error(`Publication path does not fit ustar: ${relativePath}`);
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
  if (Buffer.byteLength(value, "ascii") > length) throw new Error(`Tar field is too long: ${value}`);
  buffer.write(value, offset, length, "ascii");
}

function readString(buffer: Buffer, offset: number, length: number): string {
  const field = buffer.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end < 0 ? field.length : end).toString("ascii");
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length >= length) throw new Error("Tar numeric field overflow.");
  buffer.write(text, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function readOctal(buffer: Buffer, offset: number, length: number): number {
  const value = readString(buffer, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("Publication tar has an invalid octal field.");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Publication tar numeric field is invalid.");
  return parsed;
}
