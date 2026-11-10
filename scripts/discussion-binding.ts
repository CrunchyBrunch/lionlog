/** A read-only monitor can validate the retained correlation artifact before following its IDs. */
export interface DiscussionBinding {
  version: "lionlog.discussion-binding.v1";
  stage: string;
  serviceDate: string;
  commentId: number;
  commentNodeId: string;
  receiverRunId: number;
  receiverSha: string;
  candidateRunId?: number;
  promotionRunId?: number;
  checkpointRunId?: number;
  releaseId?: string;
}
const stages = ["admitted", "candidate-dispatched", "candidate-complete", "promotion-dispatched",
  "promotion-complete", "checkpoint-dispatched", "complete"];
const positive = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;

export function parseDiscussionBinding(raw: unknown, expectedRunId: number, expectedSha: string): DiscussionBinding {
  const value = raw as Partial<DiscussionBinding> | null;
  const stage = stages.indexOf(value?.stage ?? "");
  if (!value || value.version !== "lionlog.discussion-binding.v1" || stage < 0
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.serviceDate ?? "")
    || !positive(value.commentId) || !/^DC_[A-Za-z0-9_-]+$/.test(value.commentNodeId ?? "")
    || value.receiverRunId !== expectedRunId || value.receiverSha !== expectedSha
    || !/^[a-f0-9]{40}$/.test(expectedSha)
    || (stage >= 1 && !positive(value.candidateRunId))
    || (stage < 1 && value.candidateRunId !== undefined)
    || (stage >= 3 && !positive(value.promotionRunId))
    || (stage < 3 && value.promotionRunId !== undefined)
    || (stage >= 5 && !positive(value.checkpointRunId))
    || (stage < 5 && value.checkpointRunId !== undefined)
    || (stage === 6 && !/^[a-f0-9]{64}$/.test(value.releaseId ?? ""))
    || (stage < 6 && value.releaseId !== undefined)) {
    throw new Error("Retained discussion binding is absent, inconsistent or from another receiver run.");
  }
  return value as DiscussionBinding;
}
