import path from "node:path";
import { getPsuHall, getPsuMealPeriod, psuHalls, psuMealPeriods } from "../infrastructure/psu/constants.ts";
import { PsuIngestionPipeline } from "../infrastructure/psu/ingestion-pipeline.ts";
import { assertManualIngestionEnvironment } from "../infrastructure/psu/manual-ingestion-guard.ts";
import { PsuHttpRetriever } from "../infrastructure/psu/retriever.ts";
import { FilePsuSnapshotStore } from "../infrastructure/psu/snapshot-store.ts";

const argumentsByName = parseArguments(process.argv.slice(2));
if (argumentsByName.has("help")) {
  printHelp();
  process.exit(0);
}

assertManualIngestionEnvironment();

const serviceDate = requireArgument(argumentsByName, "date");
const hallId = resolveHall(requireArgument(argumentsByName, "hall"));
const mealPeriodId = resolveMeal(requireArgument(argumentsByName, "meal"));
const cacheDirectory = path.resolve(argumentsByName.get("cache-dir") ?? "work/psu-ingestion");

const store = new FilePsuSnapshotStore(cacheDirectory);
const retriever = new PsuHttpRetriever({
  allowNetwork: true,
  minimumIntervalMs: 1_000,
  maximumAttempts: 3,
  timeoutMs: 10_000,
});
const pipeline = new PsuIngestionPipeline(retriever, store);
const result = await pipeline.run({ serviceDate, hallId, mealPeriodId, venueIds: [] });

if (result.state === "live") {
  process.stdout.write(`${JSON.stringify({
    state: result.state,
    snapshotId: result.snapshot.snapshotId,
    retrievedAt: result.snapshot.retrievedAt,
    cacheDirectory,
    report: result.report,
  }, null, 2)}\n`);
} else {
  process.stderr.write(`${JSON.stringify({
    state: result.state,
    snapshotId: result.snapshot?.snapshotId ?? null,
    retrievedAt: result.snapshot?.retrievedAt ?? null,
    cacheDirectory,
    error: result.error.message,
  }, null, 2)}\n`);
  process.exitCode = result.state === "stale" ? 2 : 1;
}

function parseArguments(values: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const value of values) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(value);
    if (!match) throw new Error(`Unexpected argument: ${value}`);
    parsed.set(match[1], match[2] ?? "true");
  }
  return parsed;
}

function requireArgument(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing required --${name}=... argument.`);
  return value;
}

function resolveHall(value: string): string {
  const hall = psuHalls.find((candidate) =>
    candidate.id === value || candidate.sourceCampusId === value
  );
  if (!hall) {
    throw new Error(`Unknown hall ${value}. Use a LionLog PSU hall ID or campus ID.`);
  }
  return getPsuHall(hall.id).id;
}

function resolveMeal(value: string): string {
  const normalized = value.toLowerCase();
  const period = psuMealPeriods.find((candidate) =>
    candidate.id === normalized || candidate.sourceValue.toLowerCase() === normalized
  );
  if (!period) throw new Error(`Unknown meal ${value}.`);
  return getPsuMealPeriod(period.id).id;
}

function printHelp(): void {
  process.stdout.write([
    "Manually ingest one Penn State public dining-menu snapshot.",
    "",
    "Usage:",
    "  npm run ingest:psu -- --date=YYYY-MM-DD --hall=<campus-id> --meal=<meal>",
    "",
    "Examples:",
    "  npm run ingest:psu -- --date=2026-08-31 --hall=11 --meal=Lunch",
    "  npm run ingest:psu -- --date=2026-08-31 --hall=14 --meal=Dinner --cache-dir=work/psu-ingestion",
    "",
    "This command is manual only. It writes validated JSON under the ignored cache directory and never stores raw HTML.",
  ].join("\n") + "\n");
}
