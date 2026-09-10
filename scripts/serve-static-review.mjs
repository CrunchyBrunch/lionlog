import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(process.env.STATIC_REVIEW_ROOT ?? "dist/client");
const port = Number(process.env.STATIC_REVIEW_PORT ?? "4187");
const basePath = process.env.STATIC_REVIEW_BASE_PATH ?? "/lionlog/";
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("STATIC_REVIEW_PORT is invalid.");
if (!/^\/[A-Za-z0-9][A-Za-z0-9._-]*\/$/.test(basePath)) throw new Error("STATIC_REVIEW_BASE_PATH must be one absolute path segment with a trailing slash.");

const mime = new Map([
  [".css", "text/css"], [".html", "text/html"], [".ico", "image/x-icon"],
  [".js", "text/javascript"], [".json", "application/json"], [".png", "image/png"],
  [".svg", "image/svg+xml"], [".webmanifest", "application/manifest+json"],
]);

createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (!url.pathname.startsWith(basePath)) throw new Error("Request is outside the review scope.");
    const relative = decodeURIComponent(url.pathname.slice(basePath.length)) || "index.html";
    if (relative.includes("..") || path.isAbsolute(relative)) throw new Error("Review path is unsafe.");
    let file = path.resolve(root, ...relative.split("/"));
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) throw new Error("Review path escapes the root.");
    if ((await stat(file)).isDirectory()) file = path.join(file, "index.html");
    response.writeHead(200, {
      "content-type": mime.get(path.extname(file)) ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(await readFile(file));
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
    response.end("not found");
  }
}).listen(port, "127.0.0.1", () => process.stdout.write(`Static review server: http://127.0.0.1:${port}${basePath}\n`));
