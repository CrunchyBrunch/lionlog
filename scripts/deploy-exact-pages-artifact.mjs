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
}) {
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0) throw new Error("Pages artifact ID is invalid.");
  if (!/^[a-f0-9]{40}$/.test(buildVersion)) throw new Error("Pages build version must be an exact Git SHA.");
  if (environment !== "github-pages") throw new Error("Unexpected Pages environment.");
  let response;
  try {
    response = await fetchImpl(`${API_ROOT}/repos/${REPOSITORY}/pages/deployments`, {
      method: "POST",
      redirect: "error",
      headers: apiHeaders(githubToken),
      body: JSON.stringify({
        artifact_id: artifactId,
        pages_build_version: buildVersion,
        oidc_token: oidcToken,
        environment,
      }),
    });
  } catch (error) {
    throw new Error("Pages deployment submission outcome is uncertain; reconcile before any retry.", { cause: error });
  }
  if (!response.ok || response.redirected) {
    throw new Error(`Pages deployment submission failed with HTTP ${response.status}; do not retry blindly.`);
  }
  const created = await response.json();
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(created?.id ?? "")) throw new Error("Pages deployment response omitted a safe deployment ID.");
  const statusUrl = new URL(created.status_url ?? "", API_ROOT);
  if (statusUrl.origin !== API_ROOT || statusUrl.pathname !== `/repos/${REPOSITORY}/pages/deployments/${created.id}/status`) {
    throw new Error("Pages deployment returned an unexpected status URL.");
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(5_000);
    const statusResponse = await fetchImpl(statusUrl, { headers: apiHeaders(githubToken), redirect: "error" });
    if (!statusResponse.ok || statusResponse.redirected) throw new Error("Pages deployment status became unavailable; reconcile before retrying.");
    const status = (await statusResponse.json())?.status;
    if (status === "succeed") {
      const pageUrl = new URL(created.page_url);
      if (
        pageUrl.origin !== "https://crunchybrunch.github.io"
        || pageUrl.pathname !== "/lionlog/"
        || pageUrl.search !== ""
        || pageUrl.hash !== ""
      ) {
        throw new Error("Pages deployment returned an unexpected public URL.");
      }
      return { deploymentId: created.id, pageUrl: pageUrl.href, status };
    }
    if (TERMINAL_FAILURES.has(status)) throw new Error(`Pages deployment failed with status ${status}.`);
  }
  throw new Error("Pages deployment status timed out; reconcile before retrying.");
}

export async function requestOidcToken({ requestUrl, requestToken, fetchImpl = fetch }) {
  const url = new URL(requestUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".actions.githubusercontent.com")) {
    throw new Error("OIDC request URL is not a GitHub Actions endpoint.");
  }
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${requestToken}` },
    redirect: "error",
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
  const oidcToken = await requestOidcToken({
    requestUrl: process.env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "",
    requestToken: process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "",
  });
  const result = await deployExactPagesArtifact({
    artifactId: Number(process.env.STAGED_ARTIFACT_ID),
    buildVersion: process.env.GITHUB_SHA ?? "",
    githubToken: process.env.GITHUB_TOKEN ?? "",
    oidcToken,
  });
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is unavailable.");
  const { appendFile } = await import("node:fs/promises");
  await appendFile(output, `deployment_id=${result.deploymentId}\npage_url=${result.pageUrl}\nstatus=${result.status}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
