import {
  nutritionUrlForHandle,
  PSU_MENU_PATH,
  PSU_MENU_URL,
  PSU_NUTRITION_PATH,
  PSU_SOURCE_ORIGIN,
} from "./constants.ts";
import { PsuRetrievalError } from "./errors.ts";

export interface PsuRetrieverOptions {
  readonly fetchImpl?: typeof fetch;
  readonly allowNetwork?: boolean;
  readonly minimumIntervalMs?: number;
  readonly timeoutMs?: number;
  readonly maximumAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly maximumRequests?: number;
  readonly maximumElapsedMs?: number;
  readonly jitterMs?: number;
  readonly random?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

export interface RetrievedHtml {
  readonly html: string;
  readonly sourceUrl: string;
  readonly retrievedAt: Date;
}

export interface PsuRequestTelemetry {
  readonly requestCount: number;
  readonly mealOptionRequests: number;
  readonly menuRequests: number;
  readonly nutritionRequests: number;
  readonly retryRequests: number;
}

type PsuRequestKind = "meal-options" | "menu" | "nutrition";

export class PsuHttpRetriever {
  private readonly fetchImpl: typeof fetch;
  private readonly minimumIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maximumAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maximumRequests: number;
  private readonly maximumElapsedMs: number;
  private readonly jitterMs: number;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private serialTail: Promise<void> = Promise.resolve();
  private lastRequestStartedAt = Number.NEGATIVE_INFINITY;
  private requestCountValue = 0;
  private mealOptionRequestCount = 0;
  private menuRequestCount = 0;
  private nutritionRequestCount = 0;
  private retryRequestCount = 0;
  private readonly startedAtMs: number;

  constructor(options: PsuRetrieverOptions = {}) {
    if (!options.fetchImpl && !options.allowNetwork) {
      throw new Error("PSU network access is disabled unless a manual caller explicitly enables it.");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.minimumIntervalMs = boundedInteger(options.minimumIntervalMs ?? 1_000, "minimum interval", 0, 60_000);
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, "timeout", 1, 60_000);
    this.maximumAttempts = boundedInteger(options.maximumAttempts ?? 3, "maximum attempts", 1, 5);
    this.baseBackoffMs = boundedInteger(options.baseBackoffMs ?? 1_000, "base backoff", 0, 60_000);
    this.maximumRequests = boundedInteger(options.maximumRequests ?? 1_000, "maximum requests", 1, 2_000);
    this.maximumElapsedMs = boundedInteger(options.maximumElapsedMs ?? 60 * 60_000, "maximum elapsed time", 1, 60 * 60_000);
    this.jitterMs = boundedInteger(options.jitterMs ?? 250, "jitter", 0, 5_000);
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
    this.startedAtMs = this.now();
  }

  get requestCount(): number { return this.requestCountValue; }

  get telemetry(): PsuRequestTelemetry {
    return {
      requestCount: this.requestCountValue,
      mealOptionRequests: this.mealOptionRequestCount,
      menuRequests: this.menuRequestCount,
      nutritionRequests: this.nutritionRequestCount,
      retryRequests: this.retryRequestCount,
    };
  }

  retrieveMealOptions(form: {
    readonly sourceDate: string;
    readonly sourceCampusId: string;
  }): Promise<RetrievedHtml> {
    const body = new URLSearchParams({
      selMenuDate: form.sourceDate,
      selMeal: "",
      selCampus: form.sourceCampusId,
    });
    return this.enqueue(() => this.retrieveWithRetry("meal-options", PSU_MENU_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
    }, 1_048_576));
  }

  retrieveMenu(form: {
    readonly sourceDate: string;
    readonly sourceMeal: string;
    readonly sourceCampusId: string;
  }): Promise<RetrievedHtml> {
    const body = new URLSearchParams({
      selMenuDate: form.sourceDate,
      selMeal: form.sourceMeal,
      selCampus: form.sourceCampusId,
    });
    return this.enqueue(() => this.retrieveWithRetry("menu", PSU_MENU_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
    }, 1_048_576));
  }

  retrieveNutrition(sourceHandle: string): Promise<RetrievedHtml> {
    return this.enqueue(() => this.retrieveWithRetry(
      "nutrition",
      nutritionUrlForHandle(sourceHandle),
      { method: "GET" },
      262_144,
    ));
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serialTail.then(operation, operation);
    this.serialTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async retrieveWithRetry(
    kind: PsuRequestKind,
    url: string,
    init: RequestInit,
    maximumBytes: number,
  ): Promise<RetrievedHtml> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
      await this.pace();
      try {
        return await this.retrieveOnce(kind, attempt, url, init, maximumBytes);
      } catch (error) {
        lastError = error;
        if (!(error instanceof PsuRetrievalError) || !error.retryable || attempt === this.maximumAttempts) {
          throw error;
        }
        const exponentialMs = this.baseBackoffMs * 2 ** (attempt - 1);
        await this.sleep(Math.max(error.retryAfterMs ?? 0, exponentialMs));
      }
    }
    throw lastError;
  }

  private async pace(): Promise<void> {
    const jitter = Math.floor(validateRandom(this.random()) * (this.jitterMs + 1));
    const waitMs = Math.max(0, this.minimumIntervalMs + jitter - (this.now() - this.lastRequestStartedAt));
    if (waitMs > 0) await this.sleep(waitMs);
    this.lastRequestStartedAt = this.now();
  }

  private async retrieveOnce(
    kind: PsuRequestKind,
    attempt: number,
    url: string,
    init: RequestInit,
    maximumBytes: number,
  ): Promise<RetrievedHtml> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      if (this.requestCountValue >= this.maximumRequests) {
        throw new PsuRetrievalError("PSU release request limit was reached.", false);
      }
      if (this.now() - this.startedAtMs >= this.maximumElapsedMs) {
        throw new PsuRetrievalError("PSU ingestion time budget was reached.", false);
      }
      this.requestCountValue += 1;
      if (kind === "meal-options") this.mealOptionRequestCount += 1;
      else if (kind === "menu") this.menuRequestCount += 1;
      else this.nutritionRequestCount += 1;
      if (attempt > 1) this.retryRequestCount += 1;
      const response = await this.fetchImpl(url, { ...init, redirect: "manual", signal: controller.signal });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        const retryAfterMs = retryable ? parseRetryAfter(response.headers.get("retry-after"), this.now()) : undefined;
        throw new PsuRetrievalError(`PSU returned HTTP ${response.status}.`, retryable, response.status, retryAfterMs);
      }
      const finalUrl = response.url || url;
      assertAllowedResponseUrl(finalUrl, url);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.startsWith("text/html")) {
        throw new PsuRetrievalError(`PSU returned unexpected content type: ${contentType || "missing"}.`, false);
      }
      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader !== null) {
        if (!/^\d+$/.test(contentLengthHeader)) {
          throw new PsuRetrievalError("PSU returned an invalid content length.", false);
        }
        const contentLength = Number(contentLengthHeader);
        if (!Number.isSafeInteger(contentLength) || contentLength > maximumBytes) {
          throw new PsuRetrievalError("PSU response exceeded the configured size limit.", false);
        }
      }
      const bytes = await readBoundedBody(response, maximumBytes);
      return {
        html: decodeUtf8(bytes),
        sourceUrl: finalUrl,
        retrievedAt: new Date(this.now()),
      };
    } catch (error) {
      if (error instanceof PsuRetrievalError) throw error;
      const message = error instanceof Error ? error.message : "unknown network error";
      throw new PsuRetrievalError(`PSU request failed: ${message}`, true);
    } finally {
      clearTimeout(timeout);
    }
  }
}

function validateRandom(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error("PSU retriever random source must return a value from 0 up to but not including 1.");
  }
  return value;
}

function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - nowMs;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  return Math.min(milliseconds, 60_000);
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`PSU retriever ${field} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("PSU response exceeded the configured size limit.").catch(() => undefined);
        throw new PsuRetrievalError("PSU response exceeded the configured size limit.", false);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PsuRetrievalError("PSU response was not valid UTF-8 HTML.", false);
  }
}

function assertAllowedResponseUrl(finalValue: string, requestedValue: string): void {
  const finalUrl = new URL(finalValue);
  const requestedUrl = new URL(requestedValue);
  if (finalUrl.origin !== PSU_SOURCE_ORIGIN || finalUrl.origin !== requestedUrl.origin) {
    throw new PsuRetrievalError("PSU response redirected outside the allowlisted origin.", false);
  }
  const isMenu = requestedUrl.pathname === PSU_MENU_PATH
    && finalUrl.pathname === PSU_MENU_PATH
    && finalUrl.search === "";
  const isNutrition = requestedUrl.pathname === PSU_NUTRITION_PATH
    && finalUrl.pathname === PSU_NUTRITION_PATH
    && finalUrl.searchParams.get("mid") === requestedUrl.searchParams.get("mid")
    && [...finalUrl.searchParams.keys()].length === 1;
  if (!isMenu && !isNutrition) {
    throw new PsuRetrievalError("PSU response path or query did not match the request.", false);
  }
}
