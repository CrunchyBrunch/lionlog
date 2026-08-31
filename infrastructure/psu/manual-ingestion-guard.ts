export function assertManualIngestionEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const ciValue = environment.CI?.trim().toLowerCase();
  if (ciValue && ciValue !== "false" && ciValue !== "0") {
    throw new Error("Live PSU ingestion is disabled in CI environments.");
  }
}
