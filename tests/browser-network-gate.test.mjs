import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import test from "node:test";
import { createBrowserNetworkGate, finalizeBrowserVerification } from "../scripts/verify-public-pwa.mjs";

test("browser network gate cleanup before offline mode tears down an active CONNECT tunnel and closes idempotently", { timeout: 5_000 }, async () => {
  const targetSockets = new Set();
  const target = createTcpServer((socket) => {
    targetSockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => targetSockets.delete(socket));
  });
  await listen(target);
  const gate = await createBrowserNetworkGate({ closeTimeoutMs: 500 });
  const client = connect(gate.port, "127.0.0.1");
  client.on("error", () => undefined);
  try {
    const address = target.address();
    assert.ok(address && typeof address === "object");
    await once(client, "connect");
    client.write(`CONNECT 127.0.0.1:${address.port} HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`);
    const response = await nextData(client);
    assert.match(response, /^HTTP\/1\.1 200 Connection Established/);
    const closed = once(client, "close");
    gate.disconnect();
    await bounded(closed, 1_000, "client tunnel close");
    const first = gate.close();
    const second = gate.close();
    assert.equal(first, second);
    await bounded(first, 1_000, "network gate close");
    gate.assertHealthy();
  } finally {
    client.destroy();
    await gate.close();
    for (const socket of targetSockets) socket.destroy();
    await closeServer(target);
  }
});

test("browser network gate contains a client-side tunnel socket error", { timeout: 5_000 }, async () => {
  let targetSocket;
  const target = createTcpServer((socket) => {
    targetSocket = socket;
    socket.on("error", () => undefined);
  });
  await listen(target);
  const gate = await createBrowserNetworkGate({ closeTimeoutMs: 500 });
  const client = connect(gate.port, "127.0.0.1");
  client.on("error", () => undefined);
  try {
    const address = target.address();
    assert.ok(address && typeof address === "object");
    await once(client, "connect");
    client.write(`CONNECT 127.0.0.1:${address.port} HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\n\r\n`);
    assert.match(await nextData(client), /^HTTP\/1\.1 200 Connection Established/);
    const upstreamClosed = targetSocket && once(targetSocket, "close");
    client.destroy(new Error("fixture client socket error"));
    if (upstreamClosed) await bounded(upstreamClosed, 1_000, "upstream close after client error");
    await bounded(gate.close(), 1_000, "client-error cleanup");
    gate.assertHealthy();
  } finally {
    client.destroy();
    await gate.close();
    targetSocket?.destroy();
    await closeServer(target);
  }
});

test("browser network gate absorbs aborted HTTP clients and upstream resets without hanging", { timeout: 5_000 }, async () => {
  let sawRequest;
  const requestSeen = new Promise((resolve) => { sawRequest = resolve; });
  const target = createHttpServer((request) => {
    request.on("error", () => undefined);
    sawRequest();
    request.socket.destroy(new Error("fixture upstream reset"));
  });
  target.on("clientError", (_error, socket) => socket.destroy());
  await listen(target);
  const gate = await createBrowserNetworkGate({ closeTimeoutMs: 500 });
  try {
    const address = target.address();
    assert.ok(address && typeof address === "object");
    const request = httpRequest({
      host: "127.0.0.1",
      port: gate.port,
      method: "GET",
      path: `http://127.0.0.1:${address.port}/reset`,
    });
    request.on("error", () => undefined);
    request.end();
    await bounded(requestSeen, 1_000, "upstream request");
    request.destroy(new Error("fixture client abort"));
    await bounded(gate.close(), 1_000, "aborted HTTP cleanup");
    await bounded(gate.close(), 1_000, "repeated aborted HTTP cleanup");
    gate.assertHealthy();
  } finally {
    await gate.close();
    target.closeAllConnections();
    await closeServer(target);
  }
});

test("browser network gate contains a premature upstream HTTP abort", { timeout: 5_000 }, async () => {
  const target = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-length": "100" });
    response.write("partial");
    response.destroy();
  });
  target.on("clientError", (_error, socket) => socket.destroy());
  await listen(target);
  const gate = await createBrowserNetworkGate({ closeTimeoutMs: 500 });
  try {
    const address = target.address();
    assert.ok(address && typeof address === "object");
    const request = httpRequest({ host: "127.0.0.1", port: gate.port, path: `http://127.0.0.1:${address.port}/abort` });
    request.on("error", () => undefined);
    const closed = new Promise((resolve) => request.once("close", resolve));
    request.end();
    await bounded(closed, 1_000, "aborted upstream response close");
    await bounded(gate.close(), 1_000, "upstream-abort cleanup");
    gate.assertHealthy();
  } finally {
    await gate.close();
    target.closeAllConnections();
    await closeServer(target);
  }
});

test("browser network gate contains refused upstream tunnels and exits within its bound", { timeout: 5_000 }, async () => {
  const reservation = createTcpServer();
  await listen(reservation);
  const address = reservation.address();
  assert.ok(address && typeof address === "object");
  const refusedPort = address.port;
  await closeServer(reservation);

  const gate = await createBrowserNetworkGate({ closeTimeoutMs: 500 });
  const client = connect(gate.port, "127.0.0.1");
  client.on("error", () => undefined);
  try {
    await once(client, "connect");
    const closed = once(client, "close");
    client.write(`CONNECT 127.0.0.1:${refusedPort} HTTP/1.1\r\nHost: 127.0.0.1:${refusedPort}\r\n\r\n`);
    await bounded(closed, 1_000, "refused tunnel close");
    await bounded(gate.close(), 1_000, "refused tunnel cleanup");
    gate.assertHealthy();
  } finally {
    client.destroy(new Error("fixture client teardown"));
    await gate.close();
  }
});

test("browser cleanup preserves the original verification failure", () => {
  const original = new Error("original browser verification failure");
  const teardown = new Error("secondary teardown failure");
  assert.throws(() => finalizeBrowserVerification(undefined, original, [teardown]), (error) => error === original);
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}

function nextData(socket) {
  return bounded(new Promise((resolve, reject) => {
    socket.once("data", (chunk) => resolve(chunk.toString("utf8")));
    socket.once("close", () => reject(new Error("socket closed before data")));
  }), 1_000, "proxy response");
}

async function bounded(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
