import { access, rename, rmdir } from "node:fs/promises";
import path from "node:path";

const basePath = process.env.LIONLOG_BASE_PATH ?? "";
if (basePath === "") process.exit(0);
if (!/^\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(basePath)) {
  throw new Error("LIONLOG_BASE_PATH must be one absolute single path segment.");
}

const clientDirectory = path.resolve("dist/client");
const nestedDirectory = path.join(clientDirectory, basePath.slice(1));
const nestedFrameworkAssets = path.join(nestedDirectory, "_next");
const frameworkAssets = path.join(clientDirectory, "_next");

await access(nestedFrameworkAssets);
try {
  await access(frameworkAssets);
  throw new Error("Refusing to replace an existing dist/client/_next directory.");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

await rename(nestedFrameworkAssets, frameworkAssets);
await rmdir(nestedDirectory);
