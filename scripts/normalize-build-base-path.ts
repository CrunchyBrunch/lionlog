import { access, readFile } from "node:fs/promises";
import path from "node:path";

const basePath = process.env.LIONLOG_BASE_PATH ?? "";
if (basePath === "") process.exit(0);
if (!/^\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(basePath)) {
  throw new Error("LIONLOG_BASE_PATH must be one absolute single path segment.");
}

const clientDirectory = path.resolve("dist/client");
const applicationDocument = path.join(clientDirectory, "index.html");
const frameworkAssets = path.join(clientDirectory, "_next");

await access(applicationDocument);
await access(frameworkAssets);

const html = await readFile(applicationDocument, "utf8");
if (!html.includes(`${basePath}/_next/`)) {
  throw new Error(`The static application document does not reference ${basePath}/_next/.`);
}
