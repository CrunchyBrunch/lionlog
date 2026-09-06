export class PsuRetrievalError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    retryable: boolean,
    status?: number,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PsuRetrievalError";
    this.retryable = retryable;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export class PsuStructuralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PsuStructuralError";
  }
}
