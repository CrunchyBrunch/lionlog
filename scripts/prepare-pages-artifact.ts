import { copyFile, lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_FILES = ["index.html", ".nojekyll", "manifest.webmanifest", "sw.js"] as const;
const OMITTED_BUILD_METADATA = new Set([".vite", ".assetsignore"]);
const ALLOWED_HIDDEN_PATH = ".nojekyll";
const TEXT_EXTENSIONS = new Set(["", ".css", ".html", ".js", ".json", ".rsc", ".txt", ".webmanifest"]);
const FORBIDDEN_EXTENSIONS = new Set([".bak", ".env", ".gz", ".key", ".log", ".map", ".p12", ".pem", ".pfx", ".tar", ".zip"]);
const FORBIDDEN_SEGMENTS = new Set(["menu-data", "node_modules", "work"]);
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

  const noJekyll = await readFile(path.join(root, ALLOWED_HIDDEN_PATH), "utf8");
  if (noJekyll.trim() !== "") throw new Error(".nojekyll must not contain publication data.");

  const index = await readFile(path.join(root, "index.html"), "utf8");
  if (!index.includes("/lionlog/_next/")) throw new Error("Pages index does not use the /lionlog/ framework base path.");
  if (!index.includes('href="./manifest.webmanifest"')) throw new Error("Pages index does not link the relative manifest.");
  if (/\b(?:src|href)=["']\/_next\//.test(index)) throw new Error("Pages index contains a root-hosted framework URL.");

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
  const extension = path.extname(normalized).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(extension)) throw new Error(`Forbidden publication file: ${relativePath}`);
  if (extension === ".html" && normalized !== "index.html" && normalized !== "404.html") {
    throw new Error(`Unexpected HTML publication file: ${relativePath}`);
  }
}

async function main(): Promise<void> {
  const argumentsByName = new Map(
    process.argv.slice(2).map((argument) => {
      const [name, ...value] = argument.split("=");
      return [name, value.join("=")] as const;
    }),
  );
  const validate = argumentsByName.get("--validate");
  if (validate) {
    const files = await validatePagesArtifact(validate);
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
