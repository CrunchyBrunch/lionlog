import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { TARGET_BASE_PATH, TARGET_ORIGIN, validatePublicationReleaseMarker } from "../infrastructure/publication/release-contract.ts";

export const FIRST_PUBLICATION = "NONE_FIRST_PUBLICATION";
const SHA256 = /^[a-f0-9]{64}$/;
const PUBLIC_MARKER_URL = `${TARGET_ORIGIN}${TARGET_BASE_PATH}release.json`;

export type PublicReleaseObservation =
  | { state: "absent"; releaseId: null }
  | { state: "present"; releaseId: string };

export function validateExpectedPredecessor(value: unknown): string {
  if (value === FIRST_PUBLICATION || (typeof value === "string" && SHA256.test(value))) return value;
  throw new Error("Expected predecessor release identity is invalid.");
}

export function assertExpectedPredecessor(expectedValue: unknown, observationValue: unknown): PublicReleaseObservation {
  const expected = validateExpectedPredecessor(expectedValue);
  const observation = validateObservation(observationValue);
  if (expected === FIRST_PUBLICATION) {
    if (observation.state !== "absent") throw new Error("First publication was authorized but a public LionLog release already exists.");
  } else if (observation.state !== "present" || observation.releaseId !== expected) {
    throw new Error("Public predecessor release is absent or differs from the exact authorization.");
  }
  return observation;
}

export async function observePublicRelease(fetchImpl: typeof fetch = fetch): Promise<PublicReleaseObservation> {
  let response: Response;
  try {
    response = await fetchImpl(PUBLIC_MARKER_URL, {
      cache: "no-store",
      redirect: "error",
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new Error("Public predecessor state is unavailable or ambiguous.", { cause: error });
  }
  if (response.status === 404) {
    if (response.redirected || response.url !== PUBLIC_MARKER_URL) throw new Error("Public predecessor absence response is ambiguous.");
    return { state: "absent", releaseId: null };
  }
  if (!response.ok || response.redirected || response.url !== PUBLIC_MARKER_URL) {
    throw new Error(`Public predecessor state is unavailable or ambiguous (HTTP ${response.status}).`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new Error("Public predecessor marker has an invalid content type.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 16 * 1024) throw new Error("Public predecessor marker size is invalid.");
  const marker = validatePublicationReleaseMarker(JSON.parse(bytes.toString("utf8")));
  return { state: "present", releaseId: marker.releaseId };
}

function validateObservation(value: unknown): PublicReleaseObservation {
  const observation = value as PublicReleaseObservation;
  if (observation?.state === "absent" && observation.releaseId === null) return observation;
  if (observation?.state === "present" && SHA256.test(observation.releaseId ?? "")) return observation;
  throw new Error("Public predecessor observation is invalid.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const output = process.argv.find((argument) => argument.startsWith("--output="))?.slice("--output=".length);
  const expected = process.argv.find((argument) => argument.startsWith("--expected="))?.slice("--expected=".length);
  if (!output || !expected) throw new Error("Public predecessor observation arguments are incomplete.");
  const observation = await observePublicRelease();
  assertExpectedPredecessor(expected, observation);
  await writeFile(output, `${JSON.stringify(observation, null, 2)}\n`, { flag: "wx" });
}
