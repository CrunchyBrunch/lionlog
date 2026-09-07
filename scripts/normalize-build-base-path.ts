import { access, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";

const basePath = process.env.LIONLOG_BASE_PATH ?? "";
const shellRevision = process.env.LIONLOG_SHELL_REVISION ?? "development";
if (!/^(?:development|[a-f0-9]{40})$/.test(shellRevision)) {
  throw new Error("LIONLOG_SHELL_REVISION must be development or an exact lowercase Git SHA.");
}
if (!/^(?:|\/[A-Za-z0-9][A-Za-z0-9._-]*)$/.test(basePath)) {
  throw new Error("LIONLOG_BASE_PATH must be empty or one absolute single path segment.");
}

const clientDirectory = path.resolve("dist/client");
const applicationDocument = path.join(clientDirectory, "index.html");
const nestedDirectory = basePath === "" ? null : path.join(clientDirectory, basePath.slice(1));
const nestedFrameworkAssets = nestedDirectory === null ? null : path.join(nestedDirectory, "_next");
const frameworkAssets = path.join(clientDirectory, "_next");

await access(applicationDocument);
if (nestedFrameworkAssets !== null && nestedDirectory !== null) {
  await access(nestedFrameworkAssets);
  try {
    await access(frameworkAssets);
    throw new Error("Refusing to replace an existing dist/client/_next directory.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  await rename(nestedFrameworkAssets, frameworkAssets);
  await rmdir(nestedDirectory);
}

const html = await readFile(applicationDocument, "utf8");
if (basePath !== "" && !html.includes(`${basePath}/_next/`)) {
  throw new Error(`The static application document does not reference ${basePath}/_next/.`);
}
if (!html.includes(`data-lionlog-shell="${shellRevision}"`)) {
  throw new Error("The application document does not contain the expected shell revision.");
}

const serviceWorkerPath = path.join(clientDirectory, "sw.js");
const serviceWorker = await readFile(serviceWorkerPath, "utf8");
const placeholder = "__LIONLOG_SHELL_REVISION__";
if (!serviceWorker.includes(placeholder)) throw new Error("Service-worker shell revision placeholder is missing.");
await writeFile(serviceWorkerPath, serviceWorker.replaceAll(placeholder, shellRevision));
