export class PsuRetrievalError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    retryable: boolean,
    status?: number,
  ) {
    super(message);
    this.name = "PsuRetrievalError";
    this.retryable = retryable;
    this.status = status;
  }
}

export class PsuStructuralError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PsuStructuralError";
  }
}
