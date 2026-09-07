import { pathToFileURL } from "node:url";

const REPOSITORY = "CrunchyBrunch/lionlog";
const RELEASE_URL = "https://crunchybrunch.github.io/lionlog/release.json";
const SHA256 = /^[a-f0-9]{64}$/;

export async function verifyCurrentPublication({
  expectedReleaseId,
  expectedDeploymentId,
  token,
  fetchImpl = fetch,
}) {
  if (expectedReleaseId === "NONE_FIRST_DEPLOYMENT") {
    if (expectedDeploymentId !== "NONE_FIRST_DEPLOYMENT") throw new Error("First deployment identifiers are inconsistent.");
    const response = await fetchImpl(RELEASE_URL, { cache: "no-store", redirect: "error" });
    if (response.status !== 404) throw new Error("A publication already exists at the target URL.");
    return { state: "first-deployment" };
  }
  if (!SHA256.test(expectedReleaseId) || !/^[A-Za-z0-9._-]{1,200}$/.test(expectedDeploymentId)) {
    throw new Error("Expected current publication identity is invalid.");
  }
  const response = await fetchImpl(RELEASE_URL, { cache: "no-store", redirect: "error" });
  if (!response.ok || response.redirected) throw new Error("Current publication marker is unavailable.");
  const marker = await response.json();
  if (marker?.releaseId !== expectedReleaseId) throw new Error("Current public release changed.");
  const deployment = await fetchImpl(
    `https://api.github.com/repos/${REPOSITORY}/pages/deployments/${expectedDeploymentId}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
    },
  );
  if (!deployment.ok || deployment.redirected || (await deployment.json())?.status !== "succeed") {
    throw new Error("Expected current Pages deployment is not successful.");
  }
  return { state: "matched", releaseId: expectedReleaseId, deploymentId: expectedDeploymentId };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyCurrentPublication({
    expectedReleaseId: process.env.EXPECTED_CURRENT_RELEASE_ID ?? "",
    expectedDeploymentId: process.env.EXPECTED_CURRENT_DEPLOYMENT_ID ?? "",
    token: process.env.GITHUB_TOKEN ?? "",
  });
  console.log(JSON.stringify(result));
}
