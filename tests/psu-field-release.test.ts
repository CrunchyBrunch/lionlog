import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parsePsuMealOptionsHtml } from "../infrastructure/psu/menu-parser.ts";
import {
  buildReleaseQueries,
  derivePsuReleaseRequestBudget,
  PSU_RELEASE_HALL_IDS,
  PSU_RELEASE_MAXIMUM_REQUESTS,
  PSU_RELEASE_MAXIMUM_UNIQUE_NUTRITION_OBSERVATIONS,
  validatePsuReleaseReport,
} from "../infrastructure/psu/release-plan.ts";
import { assertTrustedReleaseIngestionEnvironment } from "../infrastructure/psu/trusted-release-guard.ts";

const fixturePath = path.resolve("tests/fixtures/psu/menu-east-lunch.sanitized.html");
const authorizedEnvironment = {
  LIONLOG_ALLOW_PSU_NETWORK: "I_UNDERSTAND_THIS_CONTACTS_PSU",
  LIONLOG_RELEASE_CONFIRMATION: "PREPARE_LIVE_PAGES_FIELD_RELEASE",
  CI: "true",
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "CrunchyBrunch/lionlog",
  GITHUB_REF: "refs/heads/feature/live-pages-field-release-alpha-4",
  GITHUB_WORKFLOW_REF: "CrunchyBrunch/lionlog/.github/workflows/build-live-menu-artifact.yml@refs/heads/feature/live-pages-field-release-alpha-4",
  GITHUB_SHA: "a".repeat(40),
} as const;

test("trusted release guard requires the exact workflow, repository, ref, event, and confirmation", () => {
  assert.doesNotThrow(() => assertTrustedReleaseIngestionEnvironment(authorizedEnvironment));
  for (const [key, value] of [
    ["GITHUB_EVENT_NAME", "pull_request"],
    ["GITHUB_REPOSITORY", "fork/lionlog"],
    ["GITHUB_REF", "refs/heads/untrusted"],
    ["LIONLOG_RELEASE_CONFIRMATION", "yes"],
    ["GITHUB_ACTIONS", "false"],
  ] as const) {
    assert.throws(() => assertTrustedReleaseIngestionEnvironment({ ...authorizedEnvironment, [key]: value }));
  }
});

test("source-driven meal option parser validates context and rejects unknown expansion", async () => {
  const html = await readFile(fixturePath, "utf8");
  assert.deepEqual(parsePsuMealOptionsHtml(html, {
    sourceCampusId: "11",
    sourceDate: "8/31/26",
  }), [{ mealPeriodId: "lunch", sourceValue: "Lunch" }]);
  assert.throws(
    () => parsePsuMealOptionsHtml(html.replace('value="Lunch"', 'value="Brunch"'), {
      sourceCampusId: "11",
      sourceDate: "8/31/26",
    }),
    /Unknown PSU meal option/,
  );
});

test("release planning covers the exact five halls and only source-verified meals", () => {
  const meals = new Map(PSU_RELEASE_HALL_IDS.map((hallId) => [hallId, [
    { mealPeriodId: "breakfast", sourceValue: "Breakfast" },
    { mealPeriodId: "dinner", sourceValue: "Dinner" },
  ]] as const));
  const queries = buildReleaseQueries("2026-09-01", meals);
  assert.equal(queries.length, 10);
  assert.deepEqual([...new Set(queries.map((query) => query.hallId))], [...PSU_RELEASE_HALL_IDS]);
  assert.throws(() => buildReleaseQueries("2026-09-01", new Map()), /No source meal options/);
  assert.throws(() => buildReleaseQueries("2026-02-30", meals), /Invalid ISO service date/);
});

test("release request budget is derived from the workflow window and paced request envelope", () => {
  const budget = derivePsuReleaseRequestBudget({
    workflowTimeoutMs: 45 * 60_000,
    nonIngestionReserveMs: 10 * 60_000,
    minimumIntervalMs: 1_000,
    maximumJitterMs: 250,
    hallDiscoveryRequests: 5,
    maximumMenuQueries: 20,
    maximumAttemptsPerOperation: 3,
  });
  assert.deepEqual(budget, {
    ingestionWindowMs: 35 * 60_000,
    maximumPacedRequestIntervalMs: 1_250,
    maximumUpstreamAttempts: 1_680,
    maximumUniqueNutritionObservations: 1_655,
    maximumAttemptsPerOperation: 3,
  });
  assert.equal(PSU_RELEASE_MAXIMUM_REQUESTS, 1_680);
  assert.equal(PSU_RELEASE_MAXIMUM_UNIQUE_NUTRITION_OBSERVATIONS, 1_655);
  assert.throws(() => derivePsuReleaseRequestBudget({
    workflowTimeoutMs: 60_000,
    nonIngestionReserveMs: 60_000,
    minimumIntervalMs: 1_000,
    maximumJitterMs: 0,
    hallDiscoveryRequests: 5,
    maximumMenuQueries: 20,
    maximumAttemptsPerOperation: 3,
  }), /no bounded ingestion window/i);
});

test("release report rejects incomplete coverage, inconsistent counts, and excess scope", () => {
  const queries = PSU_RELEASE_HALL_IDS.map((hallId, index) => ({
    serviceDate: "2026-09-01",
    hallId,
    mealPeriodId: "lunch",
    sourceMeal: "Lunch",
    recognizedEmpty: index === 0,
    itemCount: index === 0 ? 0 : 1,
    coverage: "complete",
    sourceObservationCount: index === 0 ? 0 : 1,
    publishedObservationCount: index === 0 ? 0 : 1,
    omissions: { "invalid-name": 0 },
    snapshotId: `psu:snapshot:v2:${String(index).padStart(64, "0")}`,
    retrievedAt: "2026-09-01T16:00:00.000Z",
  }));
  const report = {
    reportVersion: "lionlog.psu-field-release-report.v2",
    serviceDate: "2026-09-01",
    commitSha: "a".repeat(40),
    startedAt: "2026-09-01T15:00:00.000Z",
    completedAt: "2026-09-01T16:00:00.000Z",
    hallIds: [...PSU_RELEASE_HALL_IDS],
    queryCount: 5,
    itemCount: 4,
    coverage: "complete",
    sourceObservationCount: 4,
    publishedObservationCount: 4,
    omissions: { "invalid-name": 0 },
    requestCount: 10,
    nutritionRequests: 4,
    nutritionCacheHits: 1,
    queries,
  };
  assert.equal(validatePsuReleaseReport(report).queryCount, 5);
  assert.throws(() => validatePsuReleaseReport({ ...report, queryCount: 4 }), /query count is inconsistent/i);
  assert.throws(() => validatePsuReleaseReport({ ...report, hallIds: report.hallIds.slice(1) }), /Invalid PSU release report/i);
});

test("release report enforces per-query, one-percent, absolute, all-lost, and metadata consistency", () => {
  const base = releaseReportFixture();
  const partialQueries = base.queries.map((query, index) => index < 2 ? {
    ...query,
    recognizedEmpty: false,
    coverage: "partial" as const,
    sourceObservationCount: index === 0 ? 50 : 50,
    publishedObservationCount: 49,
    itemCount: 49,
    omissions: { "invalid-name": 1 },
  } : query);
  const underOnePercent = {
    ...base,
    coverage: "partial" as const,
    sourceObservationCount: 103,
    publishedObservationCount: 101,
    itemCount: 101,
    omissions: { "invalid-name": 2 },
    queries: partialQueries,
  };
  assert.throws(() => validatePsuReleaseReport(underOnePercent), /omission threshold/i);

  const permittedQueries = partialQueries.map((query, index) => index === 0
    ? { ...query, sourceObservationCount: 100, publishedObservationCount: 99, itemCount: 99 }
    : index === 1
      ? { ...query, sourceObservationCount: 97, publishedObservationCount: 96, itemCount: 96 }
      : query);
  const permitted = {
    ...underOnePercent,
    sourceObservationCount: 200,
    publishedObservationCount: 198,
    itemCount: 198,
    queries: permittedQueries,
  };
  assert.equal(validatePsuReleaseReport(permitted).omissions["invalid-name"], 2);
  assert.throws(() => validatePsuReleaseReport({ ...permitted, omissions: { "invalid-name": 6 } }), /Invalid PSU release report/);
  assert.throws(() => validatePsuReleaseReport({
    ...permitted,
    queries: permitted.queries.map((query, index) => index === 0
      ? { ...query, sourceObservationCount: 101, publishedObservationCount: 99, omissions: { "invalid-name": 2 } }
      : query),
  }), /Invalid PSU release report/);
  assert.throws(() => validatePsuReleaseReport({
    ...permitted,
    queries: permitted.queries.map((query, index) => index === 0
      ? { ...query, publishedObservationCount: 0, itemCount: 0, sourceObservationCount: 1, omissions: { "invalid-name": 1 } }
      : query),
  }), /Invalid PSU release report/);
  assert.throws(() => validatePsuReleaseReport({ ...permitted, coverage: "complete" }), /coverage status/i);
});

test("live release workflow is manual-only and has no deployment privilege or step", async () => {
  const workflow = await readFile(path.resolve(".github/workflows/build-live-menu-artifact.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*schedule:/m);
  assert.match(workflow, /permissions:\s*\r?\n\s*contents: read/);
  assert.doesNotMatch(workflow, /pages:\s*write|id-token:\s*write|deploy-pages/);
  assert.match(workflow, /prepare:psu-field-release/);
  assert.doesNotMatch(workflow, /pull_request:|push:/);
  assert.match(workflow, /actions\/cache\/restore@caa296126883cff596d87d8935842f9db880ef25/);
  assert.match(workflow, /actions\/cache\/save@caa296126883cff596d87d8935842f9db880ef25/);
  assert.match(workflow, /restore-keys:[\s\S]*lionlog-psu-nutrition-v2-psu-html-v2-/);
  assert.match(workflow, /continue-on-error: true/);
  assert.match(workflow, /hashFiles\('work\/psu-field-release-cache\/lionlog\.psu-nutrition\.v2\/\*\.json'\) != ''/);
  const ingestion = workflow.indexOf("id: ingestion");
  const cacheValidation = workflow.indexOf("id: nutrition-cache-validation");
  const cacheSave = workflow.indexOf("actions/cache/save@");
  const failureGate = workflow.indexOf("Fail closed before publication when ingestion failed");
  const exportStep = workflow.indexOf("Export the exact validated release set");
  assert.ok(ingestion < cacheValidation && cacheValidation < cacheSave && cacheSave < failureGate && failureGate < exportStep);
});

function releaseReportFixture() {
  const queries = PSU_RELEASE_HALL_IDS.map((hallId, index) => ({
    serviceDate: "2026-09-01",
    hallId,
    mealPeriodId: "lunch",
    sourceMeal: "Lunch",
    recognizedEmpty: false,
    itemCount: 1,
    coverage: "complete" as const,
    sourceObservationCount: 1,
    publishedObservationCount: 1,
    omissions: { "invalid-name": 0 },
    snapshotId: `psu:snapshot:v2:${String(index).padStart(64, "0")}`,
    retrievedAt: "2026-09-01T16:00:00.000Z",
  }));
  return {
    reportVersion: "lionlog.psu-field-release-report.v2" as const,
    serviceDate: "2026-09-01",
    commitSha: "a".repeat(40),
    startedAt: "2026-09-01T15:00:00.000Z",
    completedAt: "2026-09-01T16:00:00.000Z",
    hallIds: [...PSU_RELEASE_HALL_IDS],
    queryCount: 5,
    itemCount: 5,
    coverage: "complete" as const,
    sourceObservationCount: 5,
    publishedObservationCount: 5,
    omissions: { "invalid-name": 0 },
    requestCount: 10,
    nutritionRequests: 5,
    nutritionCacheHits: 0,
    queries,
  };
}
