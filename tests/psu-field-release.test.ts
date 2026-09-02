import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parsePsuMealOptionsHtml } from "../infrastructure/psu/menu-parser.ts";
import {
  buildReleaseQueries,
  PSU_RELEASE_HALL_IDS,
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

test("release report rejects incomplete coverage, inconsistent counts, and excess scope", () => {
  const queries = PSU_RELEASE_HALL_IDS.map((hallId, index) => ({
    serviceDate: "2026-09-01",
    hallId,
    mealPeriodId: "lunch",
    sourceMeal: "Lunch",
    recognizedEmpty: index === 0,
    itemCount: index === 0 ? 0 : 1,
    snapshotId: `psu:snapshot:v1:${String(index).padStart(64, "0")}`,
    retrievedAt: "2026-09-01T16:00:00.000Z",
  }));
  const report = {
    reportVersion: "lionlog.psu-field-release-report.v1",
    serviceDate: "2026-09-01",
    commitSha: "a".repeat(40),
    startedAt: "2026-09-01T15:00:00.000Z",
    completedAt: "2026-09-01T16:00:00.000Z",
    hallIds: [...PSU_RELEASE_HALL_IDS],
    queryCount: 5,
    itemCount: 4,
    requestCount: 10,
    nutritionRequests: 4,
    nutritionCacheHits: 1,
    queries,
  };
  assert.equal(validatePsuReleaseReport(report).queryCount, 5);
  assert.throws(() => validatePsuReleaseReport({ ...report, queryCount: 4 }), /query count is inconsistent/i);
  assert.throws(() => validatePsuReleaseReport({ ...report, hallIds: report.hallIds.slice(1) }), /Invalid PSU release report/i);
});

test("live release workflow is manual-only and has no deployment privilege or step", async () => {
  const workflow = await readFile(path.resolve(".github/workflows/build-live-menu-artifact.yml"), "utf8");
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s*schedule:/m);
  assert.match(workflow, /permissions:\s*\r?\n\s*contents: read/);
  assert.doesNotMatch(workflow, /pages:\s*write|id-token:\s*write|deploy-pages/);
  assert.match(workflow, /prepare:psu-field-release/);
  assert.doesNotMatch(workflow, /pull_request:|push:/);
});
