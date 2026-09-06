const AUTHORIZATION = "I_UNDERSTAND_THIS_CONTACTS_PSU";
const CONFIRMATION = "PREPARE_LIVE_PAGES_FIELD_RELEASE";
const REPOSITORY = "CrunchyBrunch/lionlog";
const WORKFLOW_PATH = ".github/workflows/build-live-menu-artifact.yml";
const ALLOWED_REFS = new Set([
  "refs/heads/main",
  "refs/heads/feature/live-pages-field-release-alpha-4",
]);

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
  if (!ALLOWED_REFS.has(ref)) {
    throw new Error("Trusted release ingestion is restricted to an authorized branch ref.");
  }
  const expectedWorkflowRef = `${REPOSITORY}/${WORKFLOW_PATH}@${ref}`;
  if (environment.GITHUB_WORKFLOW_REF !== expectedWorkflowRef) {
    throw new Error("Trusted release ingestion did not originate from the authorized workflow ref.");
  }
  if (!/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA ?? "")) {
    throw new Error("Trusted release ingestion requires an exact Git commit SHA.");
  }
}

export const TRUSTED_RELEASE_CONFIRMATION = CONFIRMATION;
