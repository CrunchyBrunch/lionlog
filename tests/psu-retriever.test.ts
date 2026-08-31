import assert from "node:assert/strict";
import test from "node:test";
import { PsuRetrievalError } from "../infrastructure/psu/errors.ts";
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

test("default retriever cannot contact PSU without explicit manual authorization", () => {
  assert.throws(() => new PsuHttpRetriever(), /network access is disabled/i);
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
