import { copyFile, lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertSnapshotMatchesCatalog, validatePsuPublicationCatalog } from "../infrastructure/psu/publication-catalog.ts";
import { validatePsuSnapshot } from "../infrastructure/psu/snapshot-schema.ts";

const REQUIRED_FILES = ["index.html", ".nojekyll", "manifest.webmanifest", "sw.js"] as const;
const OMITTED_BUILD_METADATA = new Set([".vite", ".assetsignore"]);
const ALLOWED_HIDDEN_PATH = ".nojekyll";
const TEXT_EXTENSIONS = new Set(["", ".css", ".html", ".js", ".json", ".rsc", ".txt", ".webmanifest"]);
const FORBIDDEN_EXTENSIONS = new Set([".bak", ".env", ".gz", ".key", ".log", ".map", ".p12", ".pem", ".pfx", ".tar", ".zip"]);
const FORBIDDEN_SEGMENTS = new Set(["node_modules", "work"]);
const FORBIDDEN_TEXT = [
  /chatgpt\.site/i,
  /C:\\Users\\/i,
  /\/Users\//,
  /\/home\//,
  /\.codex[\\/]/i,
  /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /gh[pousr]_[A-Za-z0-9_]{20,}/,
] as const;
const FORBIDDEN_BROWSER_CODE = [
  /selMenuDate/,
  /selCampus/,
  /selMeal/,
  /menu-category-section/,
  /daily-menu-item/,
  /PsuHttpRetriever/,
  /parsePsuMenuHtml/,
  /retrieveNutrition/,
  /minimumIntervalMs/,
  /I_UNDERSTAND_THIS_CONTACTS_PSU/,
  /node:fs/,
  /node:crypto/,
] as const;
const ROOT_HOSTED_APPLICATION_PATH = String.raw`(?:_next(?:\/|\\u002[fF])|manifest\.webmanifest(?=[?#"'\\)\s]|$)|sw\.js(?=[?#"'\\)\s]|$)|icons\/|og\.png(?=[?#"'\\)\s]|$)|menu-data\/)`;

export async function preparePagesArtifact(sourceDirectory: string, outputDirectory: string): Promise<void> {
  const source = path.resolve(sourceDirectory);
  const output = path.resolve(outputDirectory);
  if (source === output || output.startsWith(`${source}${path.sep}`) || source.startsWith(`${output}${path.sep}`)) {
    throw new Error("Pages artifact source and output must be separate directories.");
  }

  await stat(source);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await copyPublicationTree(source, output);
  await validatePagesArtifact(output);
}

export async function validatePagesArtifact(directory: string): Promise<string[]> {
  const root = path.resolve(directory);
  const files = await listPublicationFiles(root);
  const fileSet = new Set(files);

  for (const required of REQUIRED_FILES) {
    if (!fileSet.has(required)) throw new Error(`Pages artifact is missing ${required}.`);
  }
  await validateMenuDataPublication(root, files);

  const noJekyll = await readFile(path.join(root, ALLOWED_HIDDEN_PATH), "utf8");
  if (noJekyll.trim() !== "") throw new Error(".nojekyll must not contain publication data.");

  const index = await readFile(path.join(root, "index.html"), "utf8");
  if (!index.includes("/lionlog/_next/")) throw new Error("Pages index does not use the /lionlog/ framework base path.");
  if (!index.includes('href="./manifest.webmanifest"')) throw new Error("Pages index does not link the relative manifest.");

  const manifest = JSON.parse(await readFile(path.join(root, "manifest.webmanifest"), "utf8")) as {
    id?: unknown;
    start_url?: unknown;
    scope?: unknown;
    icons?: Array<{ src?: unknown }>;
  };
  for (const key of ["id", "start_url", "scope"] as const) {
    if (manifest[key] !== "./") throw new Error(`Manifest ${key} must be ./ for project-site hosting.`);
  }
  if (!Array.isArray(manifest.icons) || manifest.icons.length === 0) throw new Error("Manifest icons are missing.");
  for (const icon of manifest.icons) {
    if (typeof icon.src !== "string" || !icon.src.startsWith("./icons/") || icon.src.includes("..")) {
      throw new Error("Manifest icon paths must remain within ./icons/.");
    }
    if (!fileSet.has(icon.src.slice(2))) throw new Error(`Manifest icon is missing: ${icon.src}`);
  }

  const serviceWorker = await readFile(path.join(root, "sw.js"), "utf8");
  if (!serviceWorker.includes("lionlog-shell-") || !serviceWorker.includes("menu-data")) {
    throw new Error("Service worker shell/menu-data separation is missing.");
  }

  for (const relativePath of files) {
    validatePublicationPath(relativePath);
    const extension = path.extname(relativePath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) && path.basename(relativePath) !== "_headers") continue;
    const text = await readFile(path.join(root, relativePath), "utf8");
    const rootHostedReference = findRootHostedApplicationReference(relativePath, text);
    if (rootHostedReference) {
      throw new Error(`Pages artifact contains a root-hosted application URL in ${relativePath}: ${rootHostedReference}`);
    }
    for (const pattern of FORBIDDEN_TEXT) {
      if (pattern.test(text)) throw new Error(`Forbidden publication text in ${relativePath}: ${pattern.source}`);
    }
    if (extension === ".js") {
      for (const pattern of FORBIDDEN_BROWSER_CODE) {
        if (pattern.test(text)) throw new Error(`Forbidden browser ingestion code in ${relativePath}: ${pattern.source}`);
      }
    }
  }

  return files;
}

function findRootHostedApplicationReference(relativePath: string, text: string): string | null {
  const extension = path.extname(relativePath).toLowerCase();
  const patterns: RegExp[] = [];

  if (extension === ".html") {
    patterns.push(new RegExp(String.raw`\b(?:src|href|action|poster|data-rsc-css-href)\s*=\s*["']\/(?:${ROOT_HOSTED_APPLICATION_PATH})`, "i"));
  }
  if (extension === ".css") {
    patterns.push(new RegExp(String.raw`url\(\s*["']?\/(?:${ROOT_HOSTED_APPLICATION_PATH})`, "i"));
  }
  if ([".html", ".js", ".json", ".rsc", ".webmanifest"].includes(extension)) {
    // Covers generated JS string tables and both plain and JSON-escaped RSC
    // bootstrap strings without treating external absolute URLs as same-origin.
    patterns.push(new RegExp(String.raw`(?:["'\x60]|\\["'])\/(?:${ROOT_HOSTED_APPLICATION_PATH})`, "i"));
  }

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

async function copyPublicationTree(source: string, output: string, relativeDirectory = ""): Promise<void> {
  const currentSource = path.join(source, relativeDirectory);
  for (const entry of await readdir(currentSource, { withFileTypes: true })) {
    const relativePath = path.posix.join(relativeDirectory.split(path.sep).join(path.posix.sep), entry.name);
    if (relativeDirectory === "" && OMITTED_BUILD_METADATA.has(entry.name)) continue;
    validatePublicationPath(relativePath);

    const sourcePath = path.join(source, ...relativePath.split("/"));
    const outputPath = path.join(output, ...relativePath.split("/"));
    const details = await lstat(sourcePath);
    if (details.isSymbolicLink()) throw new Error(`Pages artifact cannot contain symlinks: ${relativePath}`);
    if (details.isDirectory()) {
      await mkdir(outputPath, { recursive: true });
      await copyPublicationTree(source, output, relativePath.split("/").join(path.sep));
    } else if (details.isFile()) {
      await mkdir(path.dirname(outputPath), { recursive: true });
      await copyFile(sourcePath, outputPath);
    } else {
      throw new Error(`Unsupported publication entry: ${relativePath}`);
    }
  }
}

async function listPublicationFiles(root: string, relativeDirectory = ""): Promise<string[]> {
  const files: string[] = [];
  const current = path.join(root, ...relativeDirectory.split("/").filter(Boolean));
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    const details = await lstat(path.join(root, ...relativePath.split("/")));
    if (details.isSymbolicLink()) throw new Error(`Pages artifact cannot contain symlinks: ${relativePath}`);
    if (details.isDirectory()) files.push(...await listPublicationFiles(root, relativePath));
    else if (details.isFile()) files.push(relativePath);
    else throw new Error(`Unsupported publication entry: ${relativePath}`);
  }
  return files.sort();
}

function validatePublicationPath(relativePath: string): void {
  const normalized = relativePath.split(path.sep).join("/");
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Unsafe publication path: ${relativePath}`);
  }
  const hidden = segments.filter((segment) => segment.startsWith("."));
  if (hidden.length > 0 && normalized !== ALLOWED_HIDDEN_PATH) {
    throw new Error(`Unexpected hidden publication path: ${relativePath}`);
  }
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment.toLowerCase()))) {
    throw new Error(`Forbidden publication directory: ${relativePath}`);
  }
  if (segments[0] === "menu-data" && !/^menu-data\/v1\/(?:catalog\.json|snapshots\/\d{4}-\d{2}-\d{2}\/\d+\/(?:breakfast|lunch|dinner|late-night)\.json)$/.test(normalized)) {
    throw new Error(`Unexpected menu-data publication path: ${relativePath}`);
  }
  const extension = path.extname(normalized).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(extension)) throw new Error(`Forbidden publication file: ${relativePath}`);
  if (extension === ".html" && normalized !== "index.html" && normalized !== "404.html") {
    throw new Error(`Unexpected HTML publication file: ${relativePath}`);
  }
}

async function validateMenuDataPublication(root: string, files: readonly string[]): Promise<void> {
  const menuFiles = files.filter((file) => file.startsWith("menu-data/"));
  if (menuFiles.length === 0) return;
  const catalogPath = "menu-data/v1/catalog.json";
  if (!menuFiles.includes(catalogPath)) throw new Error("Menu-data publication is missing its catalog.");
  const catalog = validatePsuPublicationCatalog(JSON.parse(await readFile(path.join(root, ...catalogPath.split("/")), "utf8")));
  const expectedFiles = new Set([catalogPath]);
  let itemCount = 0;
  let emptyCount = 0;
  for (const entry of catalog.snapshots) {
    const relative = `menu-data/v1/${entry.snapshotUrl.slice(2)}`;
    expectedFiles.add(relative);
    if (!menuFiles.includes(relative)) throw new Error(`Catalog-referenced snapshot is missing: ${relative}`);
    const snapshot = validatePsuSnapshot(JSON.parse(await readFile(path.join(root, ...relative.split("/")), "utf8")));
    assertSnapshotMatchesCatalog(snapshot, entry);
    const snapshotItems = snapshot.stations.reduce((total, station) => total + station.items.length, 0);
    itemCount += snapshotItems;
    if (snapshotItems === 0) emptyCount += 1;
  }
  if (menuFiles.some((file) => !expectedFiles.has(file)) || expectedFiles.size !== menuFiles.length) {
    throw new Error("Menu-data publication contains a file not referenced by the catalog.");
  }
  if (
    catalog.publication.itemCount !== itemCount
    || catalog.publication.recognizedEmptySnapshotCount !== emptyCount
  ) throw new Error("Catalog publication coverage does not match its snapshots.");
}

async function main(): Promise<void> {
  const argumentsByName = new Map(
    process.argv.slice(2).map((argument) => {
      const [name, ...value] = argument.split("=");
      return [name, value.length === 0 ? "true" : value.join("=")] as const;
    }),
  );
  const validate = argumentsByName.get("--validate");
  if (validate) {
    const files = await validatePagesArtifact(validate);
    if (argumentsByName.has("--require-menu-data") && !files.includes("menu-data/v1/catalog.json")) {
      throw new Error("Pages artifact requires a validated menu-data publication.");
    }
    console.log(`Validated Pages artifact: ${files.length} files.`);
    return;
  }
  const source = argumentsByName.get("--source");
  const output = argumentsByName.get("--output");
  if (!source || !output) {
    throw new Error("Usage: --source=<build-directory> --output=<isolated-directory>, or --validate=<directory>.");
  }
  await preparePagesArtifact(source, output);
  const files = await validatePagesArtifact(output);
  console.log(`Prepared Pages artifact: ${files.length} files.`);
}

const entryPoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entryPoint) await main();
