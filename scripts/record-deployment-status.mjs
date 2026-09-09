import { recordRepositoryDeploymentStatus } from "./publication-deployment-ledger.mjs";

await recordRepositoryDeploymentStatus({
  token: process.env.GITHUB_TOKEN ?? "",
  repositoryDeploymentId: Number(process.env.REPOSITORY_DEPLOYMENT_ID),
  state: process.env.REPOSITORY_DEPLOYMENT_STATE ?? "",
  pagesDeploymentId: process.env.PAGES_DEPLOYMENT_ID || null,
  runId: Number(process.env.GITHUB_RUN_ID),
});
