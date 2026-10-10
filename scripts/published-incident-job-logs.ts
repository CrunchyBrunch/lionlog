import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import mapping from "../infrastructure/publication/published-incident-job-log-mapping.json" with { type: "json" };
import archivalLines from "../infrastructure/publication/published-incident-log-lines.json" with { type: "json" };
import type { PublishedIncident } from "./published-incident.ts";

type Job = Record<string, unknown>;
type Section = typeof mapping.deploy | typeof mapping.verify;
type Witness = {
  jobId: number;
  stepNumber: number;
  stepName: string;
  stepStartedAt: string;
  stepCompletedAt: string;
  logSha256: string;
  firstLine: string;
  lastLine: string;
  events: string[];
  boundaries: string[];
};

export interface PublishedJobLogEvidence {
  evidenceVersion: "lionlog.published-job-log-evidence.v1";
  archival: typeof mapping.archival;
  deploy: Witness;
  verify: Witness;
}

const PINNED_LOG_SHA = {
  deploy: "afc3177556dd20181dae622f49e93f42d89fd77a0e37b96be6578a798d53cca7",
  verify: "49efa274ab69743f1edf6912f138b207f5ac13d5b5888ee0fe20448a9a063818",
};

function linesOf(raw: string, section: Section): string[] {
  if (typeof raw !== "string" || !raw.endsWith("\n") || raw.includes("\r") || raw.includes("\0")) {
    throw new Error("Published incident job log format differs.");
  }
  const lines = raw.slice(0, -1).split("\n");
  if (lines[0] !== section.firstLine || lines.at(-1) !== section.lastLine
    || lines.some((line, index) => (index === 0 ? !/^\uFEFF\d{4}-\d\d-\d\dT/.test(line) : !/^\d{4}-\d\d-\d\dT/.test(line)))) {
    throw new Error("Published incident job log is incomplete or malformed.");
  }
  return lines;
}

function unique(lines: string[], literal: string): number {
  const index = lines.indexOf(literal);
  if (index < 0 || lines.lastIndexOf(literal) !== index) throw new Error("Published incident action or browser-failure log witness differs.");
  return index;
}

function ordered(lines: string[], literals: string[]): number[] {
  const positions = literals.map((line) => unique(lines, line));
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    throw new Error("Published incident action or browser-failure log witness order differs.");
  }
  return positions;
}

function exactStepJob(record: PublishedIncident, value: unknown, section: Section): { startedAt: string; completedAt: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Published incident job metadata differs.");
  const job = value as Job;
  const expected = record.collectorEvidence.jobs.find((item) => item.jobId === section.jobId);
  if (!expected || job.id !== section.jobId || job.run_id !== record.runId || job.run_attempt !== record.runAttempt
    || job.head_sha !== record.workflowSha || job.name !== section.jobName || job.status !== "completed"
    || job.conclusion !== expected.jobConclusion
    || (job.run_url !== undefined && job.run_url !== `https://api.github.com/repos/${mapping.repository}/actions/runs/${record.runId}`)
    || (job.head_branch !== undefined && job.head_branch !== "main")
    || !Array.isArray(job.steps) || job.steps.length !== expected.steps.length) {
    throw new Error("Published incident job metadata differs.");
  }
  for (let index = 0; index < expected.steps.length; index += 1) {
    const actual = job.steps[index] as Job;
    const reviewed = expected.steps[index];
    if (actual?.number !== reviewed.stepNumber || actual.name !== reviewed.stepName
      || actual.status !== reviewed.stepStatus || actual.conclusion !== reviewed.stepConclusion) {
      throw new Error("Published incident job step graph differs.");
    }
  }
  const selected = (job.steps as Job[]).find((step) => step.number === section.stepNumber);
  if (selected?.name !== section.stepName || selected.conclusion !== section.stepConclusion
    || selected.started_at !== section.stepStartedAt || selected.completed_at !== section.stepCompletedAt) {
    throw new Error("Published incident job step timing differs.");
  }
  return { startedAt: section.stepStartedAt, completedAt: section.stepCompletedAt };
}

function projectedTimeMatches(line: string, start: string, end: string): boolean {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.(\d{7})Z /.exec(line);
  if (!match || !Number.isFinite(Date.parse(`${match[1]}Z`))) return false;
  const projected = `${match[1]}Z`;
  return projected >= start && projected <= end;
}

function competing(lines: string[], selected: string, fragment: string): boolean {
  return lines.filter((line) => line.includes(fragment)).some((line) => line !== selected)
    || lines.filter((line) => line.includes(fragment)).length !== 1;
}

function makeWitness(section: Section, raw: string, boundaries: string[]): Witness {
  return {
    jobId: section.jobId, stepNumber: section.stepNumber, stepName: section.stepName,
    stepStartedAt: section.stepStartedAt, stepCompletedAt: section.stepCompletedAt,
    logSha256: createHash("sha256").update(raw, "utf8").digest("hex"),
    firstLine: section.firstLine, lastLine: section.lastLine,
    events: [...section.events], boundaries,
  };
}

export function verifyPublishedJobLogEvidence(record: PublishedIncident, value: {
  deployJob: unknown; verifyJob: unknown; deployLog: string; verifyLog: string;
}): PublishedJobLogEvidence {
  if (record.runId !== mapping.runId || record.runAttempt !== mapping.runAttempt || record.workflowSha !== mapping.workflowSha
    || record.evidence.repository.id !== mapping.repositoryId || record.evidence.repository.fullName !== mapping.repository
    || record.evidence.officialPages.createdAt !== mapping.archival.createdAt
    || !archivalLines.created.includes(mapping.archival.createdAt)
    || record.evidence.officialPages.sourceJobId !== mapping.deploy.jobId
    || record.evidence.officialPages.sourceStepNumber !== mapping.deploy.stepNumber
    || record.evidence.browserFailure.jobId !== mapping.verify.jobId
    || record.evidence.browserFailure.stepNumber !== mapping.verify.stepNumber
    || !mapping.deploy.artifactName.includes(`artifact_name: ${record.evidence.artifacts.staged.name}`)
    || !mapping.deploy.events[0].includes(`"artifact_id": ${record.evidence.officialPages.submittedArtifactId}`)
    || !mapping.deploy.events[1].includes(`"pages_build_version": "${record.evidence.officialPages.pagesBuildVersion}"`)
    || !mapping.deploy.events[2].includes(`Created deployment for ${record.workflowSha}, ID: ${record.evidence.officialPages.deploymentId}`)
    || !mapping.verify.events[0].includes(`"releaseId":"${record.evidence.release.id}"`)
    || !mapping.verify.events[1].includes(record.evidence.browserFailure.error)) {
    throw new Error("Published incident archival or job-log mapping identity differs.");
  }
  exactStepJob(record, value.deployJob, mapping.deploy);
  exactStepJob(record, value.verifyJob, mapping.verify);
  const deploy = linesOf(value.deployLog, mapping.deploy);
  const verify = linesOf(value.verifyLog, mapping.verify);
  const deployBounds = [mapping.deploy.start, mapping.deploy.artifactName, mapping.deploy.preambleEnd,
    ...mapping.deploy.events, mapping.deploy.outputEnd];
  const verifyBounds = [mapping.verify.start, mapping.verify.command, mapping.verify.preambleEnd,
    ...mapping.verify.events, mapping.verify.outputEnd, mapping.verify.nextStepStart, mapping.verify.nextStepCommand];
  const deployPositions = ordered(deploy, deployBounds);
  const verifyPositions = ordered(verify, verifyBounds);
  if (deploy.some((line, index) => index > deployPositions[2] && index < deployPositions.at(-1)!
      && (/##\[group\]Run /.test(line) || line.includes("Post job cleanup.")))
    || verify.some((line, index) => index > verifyPositions[2] && index < verifyPositions[5]
      && (/##\[group\]Run /.test(line) || line.includes("##[error]Process completed with exit code 1.")))
    || deploy.filter((line) => line.includes("##[group]Run actions/deploy-pages@")).length !== 1
    || verify.filter((line) => line.includes("node scripts/verify-public-pwa.mjs")).length !== 1
    || deploy.filter((line) => line.includes("artifact_name:")).length !== 1
    || competing(deploy, mapping.deploy.events[0], '"artifact_id"')
    || competing(deploy, mapping.deploy.events[1], '"pages_build_version"')
    || competing(deploy, mapping.deploy.events[2], "Created deployment for")
    || competing(deploy, mapping.deploy.events[3], "Reported success!")
    || competing(verify, mapping.verify.events[0], '"verifiedFiles"')
    || competing(verify, mapping.verify.events[1], "Error: Service worker did not activate: {")
    || [...mapping.deploy.events].some((line) => !projectedTimeMatches(line, mapping.deploy.stepStartedAt, mapping.deploy.stepCompletedAt))
    || [...mapping.verify.events].some((line) => !projectedTimeMatches(line, mapping.verify.stepStartedAt, mapping.verify.stepCompletedAt))) {
    throw new Error("Published incident action or browser-failure log witness differs.");
  }
  for (const [wrong, expected] of [[verify, mapping.deploy.events], [deploy, mapping.verify.events]] as const) {
    if (expected.some((line) => wrong.includes(line))) throw new Error("Published incident event appeared in wrong job log.");
  }
  return {
    evidenceVersion: "lionlog.published-job-log-evidence.v1",
    archival: structuredClone(mapping.archival),
    deploy: makeWitness(mapping.deploy, value.deployLog, deployBounds.filter((line) => !mapping.deploy.events.includes(line))),
    verify: makeWitness(mapping.verify, value.verifyLog, verifyBounds.filter((line) => !mapping.verify.events.includes(line))),
  };
}

export function matchesPublishedJobLogEvidence(record: PublishedIncident, value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proof = value as PublishedJobLogEvidence;
  const expected = {
    evidenceVersion: "lionlog.published-job-log-evidence.v1",
    archival: mapping.archival,
    deploy: { jobId: mapping.deploy.jobId, stepNumber: mapping.deploy.stepNumber, stepName: mapping.deploy.stepName,
      stepStartedAt: mapping.deploy.stepStartedAt, stepCompletedAt: mapping.deploy.stepCompletedAt,
      logSha256: PINNED_LOG_SHA.deploy, firstLine: mapping.deploy.firstLine, lastLine: mapping.deploy.lastLine,
      events: mapping.deploy.events,
      boundaries: [mapping.deploy.start, mapping.deploy.artifactName, mapping.deploy.preambleEnd, mapping.deploy.outputEnd] },
    verify: { jobId: mapping.verify.jobId, stepNumber: mapping.verify.stepNumber, stepName: mapping.verify.stepName,
      stepStartedAt: mapping.verify.stepStartedAt, stepCompletedAt: mapping.verify.stepCompletedAt,
      logSha256: PINNED_LOG_SHA.verify, firstLine: mapping.verify.firstLine, lastLine: mapping.verify.lastLine,
      events: mapping.verify.events,
      boundaries: [mapping.verify.start, mapping.verify.command, mapping.verify.preambleEnd, mapping.verify.outputEnd,
        mapping.verify.nextStepStart, mapping.verify.nextStepCommand] },
  };
  return record.evidence.officialPages.createdAt === mapping.archival.createdAt
    && record.evidence.officialPages.sourceJobId === mapping.deploy.jobId
    && record.evidence.browserFailure.jobId === mapping.verify.jobId
    && isDeepStrictEqual(proof, expected);
}
