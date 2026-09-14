import { readFile } from "node:fs/promises";

export const RELEASE_MANIFEST_PATH_ENV = "RELEASE_MANIFEST_PATH";

export function requireReleaseManifestPath(environment) {
  if (environment.MANIFEST_PATH !== undefined) {
    throw new Error("MANIFEST_PATH is not supported; use RELEASE_MANIFEST_PATH.");
  }
  const value = environment[RELEASE_MANIFEST_PATH_ENV];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("RELEASE_MANIFEST_PATH is required.");
  }
  return value;
}

export async function readReleaseManifestFromEnvironment(environment) {
  const manifestPath = requireReleaseManifestPath(environment);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error("RELEASE_MANIFEST_PATH does not contain a readable JSON manifest.", { cause: error });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RELEASE_MANIFEST_PATH does not contain a manifest object.");
  }
  return parsed;
}
