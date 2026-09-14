#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_MANIFEST_PATH:?RELEASE_MANIFEST_PATH is required}"
: "${OPERATION:?OPERATION is required}"
: "${SOURCE_MANIFEST_DIGEST:?SOURCE_MANIFEST_DIGEST is required}"
: "${PARTIAL_APPROVAL:?PARTIAL_APPROVAL is required}"
: "${EXPIRED_ROLLBACK_APPROVAL:?EXPIRED_ROLLBACK_APPROVAL is required}"

RELEASE_KIND="$(jq -er '.releaseKind | strings' "$RELEASE_MANIFEST_PATH")"

if [[ "$OPERATION" == "promote" ]]; then
  test "$RELEASE_KIND" = "live"
  FRESH_UNTIL="$(jq -er '.menu.earliestFreshUntil | strings' "$RELEASE_MANIFEST_PATH")"
  FRESH_EPOCH="$(date -u -d "$FRESH_UNTIL" +%s)"
  NOW_EPOCH="$(date -u +%s)"
  test "$FRESH_EPOCH" -ge "$((NOW_EPOCH + 900))"
fi

COVERAGE="$(jq -er '.menu.coverage // "none"' "$RELEASE_MANIFEST_PATH")"
if [[ "$COVERAGE" == "partial" ]]; then
  INVALID_NAME_COUNT="$(jq -er '.menu.omissions["invalid-name"] | numbers' "$RELEASE_MANIFEST_PATH")"
  test "$PARTIAL_APPROVAL" = "APPROVE_PARTIAL:$SOURCE_MANIFEST_DIGEST:$INVALID_NAME_COUNT"
else
  test "$PARTIAL_APPROVAL" = "COMPLETE_ONLY"
fi

if [[ "$OPERATION" == "rollback" && "$RELEASE_KIND" == "live" ]]; then
  RETAIN_UNTIL="$(jq -er '.menu.earliestRetainUntil | strings' "$RELEASE_MANIFEST_PATH")"
  RETAIN_EPOCH="$(date -u -d "$RETAIN_UNTIL" +%s)"
  NOW_EPOCH="$(date -u +%s)"
  if [[ "$RETAIN_EPOCH" -lt "$NOW_EPOCH" ]]; then
    test "$EXPIRED_ROLLBACK_APPROVAL" = "ALLOW_EXPIRED_ROLLBACK:$SOURCE_MANIFEST_DIGEST"
  else
    test "$EXPIRED_ROLLBACK_APPROVAL" = "NONE"
  fi
else
  test "$EXPIRED_ROLLBACK_APPROVAL" = "NONE"
fi
