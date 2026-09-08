import { pathToFileURL } from "node:url";

const REPOSITORY = "CrunchyBrunch/lionlog";
const API_ROOT = "https://api.github.com";
const TERMINAL_FAILURES = new Set(["deployment_failed", "deployment_content_failed", "deployment_cancelled", "deployment_lost"]);

export async function deployExactPagesArtifact({
  artifactId,
  buildVersion,
  environment = "github-pages",
  githubToken,
  oidcToken,
  fetchImpl = fetch,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = 10 * 60_000,
  approvalExpiresAt,
  minimumFreshUntil = undefined,
  now = () => Date.now(),
  recordAttempt = async (value) => { void value; },
}) {
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0) throw new Error("Pages artifact ID is invalid.");
  if (!/^[a-f0-9]{40}$/.test(buildVersion)) throw new Error("Pages build version must be an exact Git SHA.");
  if (environment !== "github-pages") throw new Error("Unexpected Pages environment.");
  const assertTemporalAuthorization = () => {
    const current = now();
    if (!Number.isFinite(Date.parse(approvalExpiresAt ?? "")) || Date.parse(approvalExpiresAt) <= current) {
      throw new Error("Pages approval expired before submission.");
    }
    if (minimumFreshUntil && Date.parse(minimumFreshUntil) < current + 15 * 60_000) {
      throw new Error("Live release freshness margin elapsed before submission.");
    }
  };
  assertTemporalAuthorization();
  await recordAttempt({ phase: "submitting", artifactId, buildVersion, deploymentId: null, status: null, uncertain: true, recordedAt: new Date(now()).toISOString() });
  assertTemporalAuthorization();
  let response;
  try {
    response = await fetchImpl(`${API_ROOT}/repos/${REPOSITORY}/pages/deployments`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: apiHeaders(githubToken),
      body: JSON.stringify({
        artifact_id: artifactId,
        pages_build_version: buildVersion,
        oidc_token: oidcToken,
        environment,
      }),
    });
  } catch (error) {
    await recordAttempt({ phase: "submission-uncertain", artifactId, buildVersion, deploymentId: null, status: null, uncertain: true, recordedAt: new Date(now()).toISOString() });
    throw new Error("Pages deployment submission outcome is uncertain; reconcile before any retry.", { cause: error });
  }
  if (!response.ok || response.redirected) {
    await recordAttempt({ phase: "submission-rejected", artifactId, buildVersion, deploymentId: null, status: `http-${response.status}`, uncertain: false, recordedAt: new Date(now()).toISOString() });
    throw new Error(`Pages deployment submission failed with HTTP ${response.status}; do not retry blindly.`);
  }
  let created;
  try { created = await response.json(); } catch (error) {
    await recordAttempt({ phase: "submission-uncertain", artifactId, buildVersion, deploymentId: null, status: "invalid-response", uncertain: true, recordedAt: new Date(now()).toISOString() });
    throw new Error("Pages deployment submission response was unreadable; reconcile before retrying.", { cause: error });
  }
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(created?.id ?? "")) {
    await recordAttempt({ phase: "submission-uncertain", artifactId, buildVersion, deploymentId: null, status: "missing-deployment-id", uncertain: true, recordedAt: new Date(now()).toISOString() });
    throw new Error("Pages deployment response omitted a safe deployment ID; reconcile before retrying.");
  }
  await recordAttempt({ phase: "accepted", artifactId, buildVersion, deploymentId: created.id, status: "accepted", uncertain: true, recordedAt: new Date(now()).toISOString() });
  const statusUrl = new URL(created.status_url ?? "", API_ROOT);
  if (statusUrl.origin !== API_ROOT || statusUrl.pathname !== `/repos/${REPOSITORY}/pages/deployments/${created.id}/status`) {
    throw new Error("Pages deployment returned an unexpected status URL.");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(5_000);
    let statusResponse;
    try {
      statusResponse = await fetchImpl(statusUrl, { headers: apiHeaders(githubToken), redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      await recordAttempt({ phase: "status-uncertain", artifactId, buildVersion, deploymentId: created.id, status: "request-failed", uncertain: true, recordedAt: new Date(now()).toISOString() });
      throw new Error(`Pages deployment ${created.id} status request failed; reconcile before retrying.`, { cause: error });
    }
    if (!statusResponse.ok || statusResponse.redirected) {
      await recordAttempt({ phase: "status-uncertain", artifactId, buildVersion, deploymentId: created.id, status: `http-${statusResponse.status}`, uncertain: true, recordedAt: new Date(now()).toISOString() });
      throw new Error(`Pages deployment ${created.id} status became unavailable; reconcile before retrying.`);
    }
    let status;
    try { status = (await statusResponse.json())?.status; } catch (error) {
      await recordAttempt({ phase: "status-uncertain", artifactId, buildVersion, deploymentId: created.id, status: "invalid-response", uncertain: true, recordedAt: new Date(now()).toISOString() });
      throw new Error(`Pages deployment ${created.id} status response was unreadable; reconcile before retrying.`, { cause: error });
    }
    if (status === "succeed") {
      await recordAttempt({ phase: "terminal", artifactId, buildVersion, deploymentId: created.id, status, uncertain: true, recordedAt: new Date(now()).toISOString() });
      const pageUrl = new URL(created.page_url);
      if (
        pageUrl.origin !== "https://crunchybrunch.github.io"
        || pageUrl.pathname !== "/lionlog/"
        || pageUrl.search !== ""
        || pageUrl.hash !== ""
      ) {
        throw new Error("Pages deployment returned an unexpected public URL.");
      }
      await recordAttempt({ phase: "terminal", artifactId, buildVersion, deploymentId: created.id, status, uncertain: false, recordedAt: new Date(now()).toISOString() });
      return { deploymentId: created.id, pageUrl: pageUrl.href, status };
    }
    if (TERMINAL_FAILURES.has(status)) {
      await recordAttempt({ phase: "terminal", artifactId, buildVersion, deploymentId: created.id, status, uncertain: false, recordedAt: new Date(now()).toISOString() });
      throw new Error(`Pages deployment ${created.id} failed with status ${status}.`);
    }
  }
  await recordAttempt({ phase: "status-uncertain", artifactId, buildVersion, deploymentId: created.id, status: "timeout", uncertain: true, recordedAt: new Date(now()).toISOString() });
  throw new Error(`Pages deployment ${created.id} status timed out; reconcile before retrying.`);
}

export async function requestOidcToken({ requestUrl, requestToken, fetchImpl = fetch }) {
  const url = new URL(requestUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".actions.githubusercontent.com")) {
    throw new Error("OIDC request URL is not a GitHub Actions endpoint.");
  }
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${requestToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || response.redirected) throw new Error("GitHub OIDC token request failed.");
  const value = (await response.json())?.value;
  if (typeof value !== "string" || value.length < 20) throw new Error("GitHub OIDC token response was invalid.");
  return value;
}

function apiHeaders(token) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
}

async function main() {
  if (
    process.env.GITHUB_REPOSITORY !== REPOSITORY
    || process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
    || process.env.GITHUB_REF !== "refs/heads/main"
    || process.env.GITHUB_RUN_ATTEMPT !== "1"
  ) throw new Error("Pages deployment is restricted to a first-attempt manual run on LionLog main.");
  if (process.env.EXPECTED_PROMOTION_WORKFLOW_SHA !== process.env.GITHUB_SHA) {
    throw new Error("Promotion workflow SHA is not the explicitly approved SHA.");
  }
  const approvalExpiresAt = process.env.APPROVAL_EXPIRES_AT ?? "";
  const minimumFreshUntil = process.env.MINIMUM_FRESH_UNTIL || undefined;
  const assertCurrentTime = () => {
    const current = Date.now();
    if (!Number.isFinite(Date.parse(approvalExpiresAt)) || Date.parse(approvalExpiresAt) <= current) throw new Error("Pages approval expired before OIDC.");
    if (minimumFreshUntil && Date.parse(minimumFreshUntil) < current + 15 * 60_000) throw new Error("Live release freshness margin elapsed before OIDC.");
  };
  assertCurrentTime();
  const oidcToken = await requestOidcToken({
    requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "",
    requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "",
  });
  assertCurrentTime();
  const attemptPath = process.env.DEPLOYMENT_ATTEMPT_PATH;
  if (!attemptPath) throw new Error("DEPLOYMENT_ATTEMPT_PATH is unavailable.");
  const { rename, writeFile } = await import("node:fs/promises");
  const recordAttempt = async (value) => {
    const temporary = `${attemptPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await rename(temporary, attemptPath);
  };
  const result = await deployExactPagesArtifact({
    artifactId: Number(process.env.STAGED_ARTIFACT_ID),
    buildVersion: process.env.GITHUB_SHA ?? "",
    githubToken: process.env.GITHUB_TOKEN ?? "",
    oidcToken,
    approvalExpiresAt,
    minimumFreshUntil,
    recordAttempt,
  });
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is unavailable.");
  const { appendFile } = await import("node:fs/promises");
  await appendFile(output, `deployment_id=${result.deploymentId}\npage_url=${result.pageUrl}\nstatus=${result.status}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
