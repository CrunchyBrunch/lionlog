import assert from "node:assert/strict";
import test from "node:test";
import { PsuRetrievalError } from "../infrastructure/psu/errors.ts";
import { assertManualIngestionEnvironment } from "../infrastructure/psu/manual-ingestion-guard.ts";
import { PsuHttpRetriever } from "../infrastructure/psu/retriever.ts";

test("retriever serializes concurrent upstream requests", async () => {
  let active = 0;
  let maximumActive = 0;
  const retriever = testRetriever(async (input) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return htmlResponse("<html></html>", String(input));
  });

  await Promise.all([
    retriever.retrieveNutrition("900000001"),
    retriever.retrieveNutrition("900000002"),
  ]);
  assert.equal(maximumActive, 1);
});

test("retriever bounds retry/backoff to retryable transport failures", async () => {
  let attempts = 0;
  const sleeps: number[] = [];
  const retriever = testRetriever(async (input) => {
    attempts += 1;
    if (attempts < 3) return htmlResponse("busy", String(input), 503);
    return htmlResponse("<html>ok</html>", String(input));
  }, (milliseconds) => {
    sleeps.push(milliseconds);
    return Promise.resolve();
  });

  const result = await retriever.retrieveNutrition("900000001");
  assert.equal(result.html, "<html>ok</html>");
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [10, 20]);
});

test("retriever rejects cross-origin redirects without retry", async () => {
  let attempts = 0;
  const retriever = testRetriever(async () => {
    attempts += 1;
    return htmlResponse("<html></html>", "https://example.invalid/menu");
  });

  await assert.rejects(
    retriever.retrieveNutrition("900000001"),
    (error: unknown) => error instanceof PsuRetrievalError && error.retryable === false,
  );
  assert.equal(attempts, 1);
});

test("retriever refuses redirects before following their location", async () => {
  let attempts = 0;
  let redirectMode: RequestRedirect | undefined;
  const retriever = testRetriever(async (input, init) => {
    attempts += 1;
    redirectMode = init?.redirect;
    const response = new Response("moved", {
      status: 302,
      headers: {
        "content-type": "text/html; charset=UTF-8",
        location: "https://example.invalid/redirected",
      },
    });
    Object.defineProperty(response, "url", { value: String(input) });
    return response;
  });

  await assert.rejects(
    retriever.retrieveNutrition("900000001"),
    (error: unknown) => error instanceof PsuRetrievalError
      && error.retryable === false
      && error.status === 302,
  );
  assert.equal(redirectMode, "manual");
  assert.equal(attempts, 1);
});

test("retriever stops reading a chunked response at the byte limit", async () => {
  let attempts = 0;
  const retriever = testRetriever(async (input) => {
    attempts += 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(140_000));
        controller.enqueue(new Uint8Array(140_000));
        controller.close();
      },
    });
    return htmlStreamResponse(body, String(input));
  });

  await assert.rejects(
    retriever.retrieveNutrition("900000001"),
    (error: unknown) => error instanceof PsuRetrievalError && error.retryable === false,
  );
  assert.equal(attempts, 1);
});

test("retriever timeout remains active while reading the response body", async () => {
  let attempts = 0;
  const retriever = new PsuHttpRetriever({
    fetchImpl: async (input, init) => {
      attempts += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("Aborted", "AbortError"));
          });
        },
      });
      return htmlStreamResponse(body, String(input));
    },
    minimumIntervalMs: 0,
    maximumAttempts: 1,
    timeoutMs: 5,
  });

  await assert.rejects(
    retriever.retrieveNutrition("900000001"),
    (error: unknown) => error instanceof PsuRetrievalError && error.retryable === true,
  );
  assert.equal(attempts, 1);
});

test("default retriever cannot contact PSU without explicit manual authorization", () => {
  assert.throws(() => new PsuHttpRetriever(), /network access is disabled/i);
});

test("manual ingestion is disabled when a CI environment is detected", () => {
  const authorization = { LIONLOG_ALLOW_PSU_NETWORK: "I_UNDERSTAND_THIS_CONTACTS_PSU" };
  assert.throws(() => assertManualIngestionEnvironment({ ...authorization, CI: "true" }), /workflow_dispatch/i);
  assert.doesNotThrow(() => assertManualIngestionEnvironment({ ...authorization, CI: "false" }));
  assert.doesNotThrow(() => assertManualIngestionEnvironment({
    ...authorization,
    CI: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
  }));
});

test("manual ingestion requires the exact explicit authorization phrase", () => {
  assert.throws(() => assertManualIngestionEnvironment({}), /explicit manual authorization/i);
  assert.throws(
    () => assertManualIngestionEnvironment({ LIONLOG_ALLOW_PSU_NETWORK: "true" }),
    /explicit manual authorization/i,
  );
});

test("retriever rejects unbounded retry and timeout configuration", () => {
  const fetchImpl: typeof fetch = async (input) => htmlResponse("<html></html>", String(input));
  assert.throws(() => new PsuHttpRetriever({ fetchImpl, maximumAttempts: 0 }), /maximum attempts/i);
  assert.throws(() => new PsuHttpRetriever({ fetchImpl, maximumAttempts: 6 }), /maximum attempts/i);
  assert.throws(() => new PsuHttpRetriever({ fetchImpl, timeoutMs: 0 }), /timeout/i);
});

test("retriever honors bounded Retry-After and enforces a total request limit", async () => {
  const sleeps: number[] = [];
  let attempts = 0;
  const retriever = new PsuHttpRetriever({
    fetchImpl: async (input) => {
      attempts += 1;
      if (attempts === 1) {
        const response = new Response("busy", {
          status: 429,
          headers: { "content-type": "text/html", "retry-after": "2" },
        });
        Object.defineProperty(response, "url", { value: String(input) });
        return response;
      }
      return htmlResponse("<html>ok</html>", String(input));
    },
    minimumIntervalMs: 0,
    jitterMs: 0,
    maximumAttempts: 2,
    maximumRequests: 2,
    baseBackoffMs: 10,
    sleep: (milliseconds) => { sleeps.push(milliseconds); return Promise.resolve(); },
  });
  assert.equal((await retriever.retrieveNutrition("900000001")).html, "<html>ok</html>");
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(retriever.requestCount, 2);
  await assert.rejects(retriever.retrieveNutrition("900000002"), /request limit/i);
});

test("release pacing applies at least the minimum interval plus bounded jitter", async () => {
  const sleeps: number[] = [];
  let now = 1_000;
  const retriever = new PsuHttpRetriever({
    fetchImpl: async (input) => htmlResponse("<html></html>", String(input)),
    minimumIntervalMs: 1_000,
    jitterMs: 250,
    random: () => 0.5,
    maximumAttempts: 1,
    sleep: (milliseconds) => { sleeps.push(milliseconds); now += milliseconds; return Promise.resolve(); },
    now: () => now,
  });
  await retriever.retrieveNutrition("900000001");
  await retriever.retrieveNutrition("900000002");
  assert.deepEqual(sleeps, [1_125]);
});

function testRetriever(
  fetchImpl: typeof fetch,
  sleep: (milliseconds: number) => Promise<void> = () => Promise.resolve(),
): PsuHttpRetriever {
  return new PsuHttpRetriever({
    fetchImpl,
    minimumIntervalMs: 0,
    maximumAttempts: 3,
    baseBackoffMs: 10,
    jitterMs: 0,
    sleep,
  });
}

function htmlResponse(body: string, url: string, status = 200): Response {
  const response = new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}

function htmlStreamResponse(body: ReadableStream<Uint8Array>, url: string): Response {
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });
  Object.defineProperty(response, "url", { value: url });
  return response;
}
