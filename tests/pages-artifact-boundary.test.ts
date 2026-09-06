import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  preparePagesArtifact,
  validatePagesArtifact,
  validatePublicationEntryPath,
  validatePublicationPathList,
} from "../scripts/prepare-pages-artifact.ts";

test("Pages packaging retains only .nojekyll and survives a download-equivalent tar round trip", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lionlog-pages-boundary-"));
  try {
    const source = path.join(root, "build");
    const prepared = path.join(root, "prepared");
    const extracted = path.join(root, "extracted");
    await writeSiteFixture(source);
    await mkdir(path.join(source, ".vite"));
    await writeFile(path.join(source, ".vite", "metadata.json"), "{}");
    await writeFile(path.join(source, ".assetsignore"), ".vite\n");

    await preparePagesArtifact(source, prepared);
    assert.deepEqual(await validatePagesArtifact(prepared), [
      ".nojekyll",
      "404.html",
      "_next/static/app.js",
      "icons/icon-192.png",
      "index.html",
      "manifest.webmanifest",
      "sw.js",
    ]);

    const archive = path.join(root, "artifact.tar");
    const packed = spawnSync("tar", ["-cf", archive, "-C", prepared, "."], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    const listed = spawnSync("tar", ["-tf", archive], { encoding: "utf8" });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /(?:^|\n)\.\/\.nojekyll(?:\r?\n|$)/);

    await mkdir(extracted);
    const unpacked = spawnSync("tar", ["-xf", archive, "-C", extracted], { encoding: "utf8" });
    assert.equal(unpacked.status, 0, unpacked.stderr);
    assert.deepEqual(await validatePagesArtifact(extracted), await validatePagesArtifact(prepared));
    assert.equal(await readFile(path.join(extracted, ".nojekyll"), "utf8"), "\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pages artifact validation rejects hidden configuration, invalid menu data, source maps, and ingestion code", async () => {
  for (const [relativePath, content, message] of [
    [".env", "SECRET=value", /Unexpected hidden publication path/],
    ["menu-data/v2/catalog.json", "{}", /Invalid PSU catalog/],
    ["_next/static/app.js.map", "{}", /Forbidden publication file/],
    ["_next/static/app.js", "const selMenuDate = 'x';", /Forbidden browser ingestion code/],
  ] as const) {
    const root = await mkdtemp(path.join(os.tmpdir(), "lionlog-pages-reject-"));
    try {
      await writeSiteFixture(root);
      const target = path.join(root, ...relativePath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      await assert.rejects(validatePagesArtifact(root), message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("Pages artifact validation requires an empty .nojekyll and rejects obsolete hosting dependencies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lionlog-pages-host-"));
  try {
    await writeSiteFixture(root);
    await writeFile(path.join(root, ".nojekyll"), "private data");
    await assert.rejects(validatePagesArtifact(root), /must not contain publication data/);
    await writeFile(path.join(root, ".nojekyll"), "\n");
    await writeFile(path.join(root, "index.html"), '<a href="https://example.chatgpt.site/">old host</a> /lionlog/_next/ <link href="./manifest.webmanifest">');
    await assert.rejects(validatePagesArtifact(root), /Forbidden publication text/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication path validation rejects traversal, absolute paths, backslashes, casing, lookalikes, and normalized duplicates", () => {
  for (const relativePath of [
    "../menu-data/v2/catalog.json",
    "/menu-data/v2/catalog.json",
    "C:/menu-data/v2/catalog.json",
    "menu-data\\v2\\catalog.json",
    "Menu-Data/v2/catalog.json",
    "ｍｅｎｕ－ｄａｔａ/v2/catalog.json",
  ]) {
    assert.throws(() => validatePublicationEntryPath(relativePath), /Unsafe publication path|menu-data path spelling|canonical ASCII/);
  }
  assert.throws(
    () => validatePublicationPathList(["_next/static/App.js", "_next/static/app.js"]),
    /Duplicate normalized publication paths/,
  );
});

test("Pages artifact validation rejects file, hardlink, symlink, and empty-directory boundary entries", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lionlog-pages-entry-types-"));
  try {
    const menuDataFile = path.join(root, "menu-data-file");
    await writeSiteFixture(menuDataFile);
    await writeFile(path.join(menuDataFile, "menu-data"), "not a directory");
    await assert.rejects(validatePagesArtifact(menuDataFile), /menu-data must be a real publication directory/);

    const hardlinkRoot = path.join(root, "hardlink");
    await writeSiteFixture(hardlinkRoot);
    await link(path.join(hardlinkRoot, "index.html"), path.join(hardlinkRoot, "menu-data"));
    await assert.rejects(validatePagesArtifact(hardlinkRoot), /hardlinks/);

    const emptyRoot = path.join(root, "empty-directory");
    await writeSiteFixture(emptyRoot);
    await mkdir(path.join(emptyRoot, "menu-data"));
    await assert.rejects(validatePagesArtifact(emptyRoot), /missing its catalog|Unexpected or empty publication directory/);

    const symlinkRoot = path.join(root, "symlink");
    await writeSiteFixture(symlinkRoot);
    try {
      await symlink(path.join(symlinkRoot, "icons"), path.join(symlinkRoot, "menu-data"), "junction");
      await assert.rejects(validatePagesArtifact(symlinkRoot), /symlinks/);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") t.diagnostic("Symlink creation is not permitted on this platform.");
      else throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pages artifact preparation removes partial output after validation failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lionlog-pages-atomic-"));
  try {
    const source = path.join(root, "source");
    const output = path.join(root, "output");
    await writeSiteFixture(source);
    await mkdir(path.join(source, "unexpected-empty"));
    await mkdir(output);
    await writeFile(path.join(output, "stale.txt"), "must not survive");
    await assert.rejects(preparePagesArtifact(source, output), /Unexpected or empty publication directory/);
    await assert.rejects(readFile(path.join(output, "index.html"), "utf8"), /ENOENT/);
    await assert.rejects(readFile(path.join(output, "stale.txt"), "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pages root-reference validation rejects same-origin roots in every generated payload without rejecting external URLs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "lionlog-pages-root-reference-"));
  try {
    await writeSiteFixture(root);
    const externalReference = '<script src="https://cdn.example.test/_next/external.js"></script>';
    const validIndex = `${await readFile(path.join(root, "index.html"), "utf8")}${externalReference}`;
    await writeFile(path.join(root, "index.html"), validIndex);
    await validatePagesArtifact(root);

    for (const [relativePath, content] of [
      ["index.html", `${validIndex}<script src="/_next/root.js"></script>`],
      ["404.html", '<link href="/manifest.webmanifest">'],
      ["_next/static/app.css", "@font-face{src:url('/_next/static/font.woff2')}"],
      ["_next/static/app.js", 'const chunks=["/_next/static/root.js"]'],
      ["index.rsc", String.raw`{\"href\":\"/_next/static/root.css\"}`],
      ["sw.js", "const SHELL = '/icons/icon-192.png'; const CACHE = 'lionlog-shell-v1'; const EXCLUDED = 'menu-data';"],
    ] as const) {
      await writeSiteFixture(root);
      const target = path.join(root, ...relativePath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      await assert.rejects(validatePagesArtifact(root), new RegExp(`root-hosted application URL in ${relativePath.replaceAll(".", "\\.")}`));
      await rm(target, { force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeSiteFixture(root: string): Promise<void> {
  await mkdir(path.join(root, "_next", "static"), { recursive: true });
  await mkdir(path.join(root, "icons"), { recursive: true });
  await writeFile(path.join(root, ".nojekyll"), "\n");
  await writeFile(path.join(root, "index.html"), '<link href="/lionlog/_next/static/app.js"><link href="./manifest.webmanifest">');
  await writeFile(path.join(root, "404.html"), "not found");
  await writeFile(path.join(root, "_next", "static", "app.js"), "console.log('shell');");
  await writeFile(path.join(root, "icons", "icon-192.png"), "icon");
  await writeFile(path.join(root, "manifest.webmanifest"), JSON.stringify({
    id: "./",
    start_url: "./",
    scope: "./",
    icons: [{ src: "./icons/icon-192.png" }],
  }));
  await writeFile(path.join(root, "sw.js"), "const CACHE = 'lionlog-shell-v1'; const EXCLUDED = 'menu-data';");
}
