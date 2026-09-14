import { readFile, rename, writeFile } from "node:fs/promises";
import { main } from "../../scripts/deploy-exact-pages-artifact.mjs";

const configPath = process.env.LIONLOG_ADAPTER_CLI_CONFIG;
const resultPath = process.env.LIONLOG_ADAPTER_CLI_RESULT;
if (!configPath || !resultPath) throw new Error("Protected-adapter CLI fixture paths are unavailable.");
const config = JSON.parse(await readFile(configPath, "utf8"));
let currentTime = Date.parse(config.initialTime);
const calls = { oidc: 0, pagesPosts: 0 };

async function applyTransition(stage) {
  const transition = config.transitions?.[stage];
  if (!transition) return;
  if (transition.time) currentTime = Date.parse(transition.time);
  if (transition.replaceManifest) {
    const manifestPath = process.env.RELEASE_MANIFEST_PATH;
    if (!manifestPath) throw new Error("RELEASE_MANIFEST_PATH is unavailable to the CLI fixture.");
    const original = await readFile(manifestPath);
    await rename(manifestPath, `${manifestPath}.${stage}.original`);
    await writeFile(manifestPath, transition.replaceManifest === "identical" ? original : "{}\n");
  }
}

let failure;
try {
  await main({
    environment: process.env,
    fetchImpl: async (_input, init) => {
      if (init?.method === "POST") {
        calls.pagesPosts += 1;
        return Response.json({
          id: "deployment-cli",
          status_url: "https://api.github.com/repos/CrunchyBrunch/lionlog/pages/deployments/deployment-cli/status",
          page_url: "https://crunchybrunch.github.io/lionlog/",
        });
      }
      return Response.json({ status: "succeed" });
    },
    clock: () => currentTime,
    wait: async () => {},
    readActualImpl: async () => config.actual,
    verifyCurrentStateImpl: async () => { await applyTransition("afterCurrentState"); },
    requestOidcImpl: async () => {
      calls.oidc += 1;
      await applyTransition("duringOidc");
      return "mock-oidc-token";
    },
    createLedgerImpl: async () => {
      await applyTransition("duringLedger");
      return 77;
    },
    recordStatusImpl: async () => ({}),
    stagedTarPath: process.env.STAGED_TAR_PATH,
  });
} catch (error) {
  failure = error;
}

await writeFile(resultPath, `${JSON.stringify({
  calls,
  error: failure instanceof Error ? failure.message : null,
})}\n`);
if (failure) throw failure;
