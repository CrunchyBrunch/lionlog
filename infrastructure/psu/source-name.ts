import { normalizeText } from "./html-tree.ts";

export const PSU_SOURCE_NAME_MAXIMUM_LENGTH = 160;

export type InvalidSourceNameReason = "empty" | "over-limit";

export type ValidatedSourceName =
  | { readonly value: string; readonly issue: null }
  | { readonly value: null; readonly issue: InvalidSourceNameReason };

export function validateSourceName(rawValue: string): ValidatedSourceName {
  const value = normalizeText(rawValue);
  if (!value) return { value: null, issue: "empty" };
  if (value.length > PSU_SOURCE_NAME_MAXIMUM_LENGTH) return { value: null, issue: "over-limit" };
  return { value, issue: null };
}
