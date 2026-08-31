export function assertManualIngestionEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (environment.LIONLOG_ALLOW_PSU_NETWORK !== "I_UNDERSTAND_THIS_CONTACTS_PSU") {
    throw new Error("Live PSU ingestion requires explicit manual authorization.");
  }
  const ciValue = environment.CI?.trim().toLowerCase();
  if (
    ciValue
    && ciValue !== "false"
    && ciValue !== "0"
    && environment.GITHUB_EVENT_NAME !== "workflow_dispatch"
  ) {
    throw new Error("Live PSU ingestion is disabled outside an explicit workflow_dispatch.");
  }
}
