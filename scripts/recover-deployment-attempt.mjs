import { rename, writeFile } from "node:fs/promises";
import { publicationLedgerPayload, recoverRepositoryDeploymentAttempt } from "./publication-deployment-ledger.mjs";

const outputPath = process.env.DEPLOYMENT_ATTEMPT_PATH;
if (!outputPath) throw new Error("DEPLOYMENT_ATTEMPT_PATH is unavailable.");

const result = await recoverRepositoryDeploymentAttempt({
  token: process.env.GITHUB_TOKEN ?? "",
  expectedWorkflowSha: process.env.EXPECTED_PROMOTION_WORKFLOW_SHA ?? "",
  expectedPayload: publicationLedgerPayload({
    promotionRunId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    releaseId: process.env.RELEASE_ID ?? "",
    sourceArtifactId: Number(process.env.SOURCE_ARTIFACT_ID),
    stagedArtifactId: Number(process.env.STAGED_ARTIFACT_ID),
  }),
});
const temporary = `${outputPath}.tmp`;
await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
await rename(temporary, outputPath);
