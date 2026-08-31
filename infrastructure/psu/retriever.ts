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
    this.minimumIntervalMs = options.minimumIntervalMs ?? 1_000;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maximumAttempts = options.maximumAttempts ?? 3;
    this.baseBackoffMs = options.baseBackoffMs ?? 1_000;
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
      const response = await this.fetchImpl(url, { ...init, redirect: "follow", signal: controller.signal });

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
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
        throw new PsuRetrievalError("PSU response exceeded the configured size limit.", false);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maximumBytes) {
        throw new PsuRetrievalError("PSU response exceeded the configured size limit.", false);
      }
      return {
        html: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
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
