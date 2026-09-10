const AUTHORIZATION = "I_UNDERSTAND_THIS_CONTACTS_PSU";
const CONFIRMATION = "PREPARE_LIVE_PAGES_FIELD_RELEASE";
const REPOSITORY = "CrunchyBrunch/lionlog";
const WORKFLOW_PATH = ".github/workflows/build-live-menu-artifact.yml";
const ALLOWED_REF = "refs/heads/main";

export function assertTrustedReleaseIngestionEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (environment.LIONLOG_ALLOW_PSU_NETWORK !== AUTHORIZATION) {
    throw new Error("Trusted release ingestion requires the exact PSU network authorization.");
  }
  if (environment.LIONLOG_RELEASE_CONFIRMATION !== CONFIRMATION) {
    throw new Error("Trusted release ingestion requires the exact field-release confirmation.");
  }
  if (environment.CI !== "true" || environment.GITHUB_ACTIONS !== "true") {
    throw new Error("Trusted release ingestion is restricted to GitHub Actions.");
  }
  if (environment.GITHUB_EVENT_NAME !== "workflow_dispatch") {
    throw new Error("Trusted release ingestion requires workflow_dispatch.");
  }
  if (environment.GITHUB_REPOSITORY !== REPOSITORY) {
    throw new Error("Trusted release ingestion is restricted to the LionLog repository.");
  }
  const ref = environment.GITHUB_REF ?? "";
  if (ref !== ALLOWED_REF) {
    throw new Error("Trusted release ingestion is restricted to main.");
  }
  const expectedWorkflowRef = `${REPOSITORY}/${WORKFLOW_PATH}@${ref}`;
  if (environment.GITHUB_WORKFLOW_REF !== expectedWorkflowRef) {
    throw new Error("Trusted release ingestion did not originate from the authorized workflow ref.");
  }
  if (!/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? "")) {
    throw new Error("Trusted release ingestion requires an exact Git commit SHA.");
  }
  if (environment.EXPECTED_SOURCE_SHA !== environment.GITHUB_SHA) {
    throw new Error("Trusted release ingestion source SHA does not match the authorized SHA.");
  }
  if (environment.GITHUB_RUN_ATTEMPT !== "1" || environment.EXPECTED_RUN_ATTEMPT !== "1") {
    throw new Error("Trusted release ingestion does not permit workflow reruns.");
  }
}

export const TRUSTED_RELEASE_CONFIRMATION = CONFIRMATION;
