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
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

export interface RetrievedHtml {
  readonly html: string;
  readonly sourceUrl: string;
  readonly retrievedAt: Date;
}

export class PsuHttpRetriever {
  private readonly fetchImpl: typeof fetch;
  private readonly minimumIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maximumAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private serialTail: Promise<void> = Promise.resolve();
  private lastRequestStartedAt = Number.NEGATIVE_INFINITY;

  constructor(options: PsuRetrieverOptions = {}) {
    if (!options.fetchImpl && !options.allowNetwork) {
      throw new Error("PSU network access is disabled unless a manual caller explicitly enables it.");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.minimumIntervalMs = boundedInteger(options.minimumIntervalMs ?? 1_000, "minimum interval", 0, 60_000);
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 10_000, "timeout", 1, 60_000);
    this.maximumAttempts = boundedInteger(options.maximumAttempts ?? 3, "maximum attempts", 1, 5);
    this.baseBackoffMs = boundedInteger(options.baseBackoffMs ?? 1_000, "base backoff", 0, 60_000);
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
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
    return this.enqueue(() => this.retrieveWithRetry(PSU_MENU_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
    }, 1_048_576));
  }

  retrieveNutrition(sourceHandle: string): Promise<RetrievedHtml> {
    return this.enqueue(() => this.retrieveWithRetry(
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
    url: string,
    init: RequestInit,
    maximumBytes: number,
  ): Promise<RetrievedHtml> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
      await this.pace();
      try {
        return await this.retrieveOnce(url, init, maximumBytes);
      } catch (error) {
        lastError = error;
        if (!(error instanceof PsuRetrievalError) || !error.retryable || attempt === this.maximumAttempts) {
          throw error;
        }
        const retryAfterMs = error.status === 429 ? this.baseBackoffMs * 2 ** attempt : 0;
        await this.sleep(Math.max(retryAfterMs, this.baseBackoffMs * 2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }

  private async pace(): Promise<void> {
    const waitMs = Math.max(0, this.minimumIntervalMs - (this.now() - this.lastRequestStartedAt));
    if (waitMs > 0) await this.sleep(waitMs);
    this.lastRequestStartedAt = this.now();
  }

  private async retrieveOnce(
    url: string,
    init: RequestInit,
    maximumBytes: number,
  ): Promise<RetrievedHtml> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { ...init, redirect: "manual", signal: controller.signal });

      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new PsuRetrievalError(`PSU returned HTTP ${response.status}.`, retryable, response.status);
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
        retrievedAt: new Date(),
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
