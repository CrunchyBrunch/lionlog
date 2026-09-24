import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createBrowserCleanup,
  createBrowserNetworkGate,
  createBrowserProcessOwner,
  finalizeBrowserVerification,
  matchesWindowsBrowserOwnership,
  parseWindowsCommandLine,
  sameWindowsProcessIdentity,
} from "../scripts/verify-public-pwa.mjs";

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
  assert.throws(() => finalizeBrowserVerification({ verified: true }, undefined, [teardown]), (error) => error === teardown);
});

test("browser process cleanup terminates a surviving child after the launcher exits and is idempotent", async () => {
  const profile = "C:\\Temp\\lionlog-pages-chrome-survivor";
  const identity = browserIdentity(501, profile, 9222, "2026-09-24T12:00:00.000Z");
  let currentIdentity = identity;
  const terminated = [];
  const launcher = { pid: 500, exitCode: 0, signalCode: null };
  const owner = createBrowserProcessOwner({
    launcher,
    launcherExited: Promise.resolve(0),
    profile,
    debuggingPort: 9222,
    browserExecutable: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    platform: "win32",
    findPortProcessIds: async () => currentIdentity ? [currentIdentity.pid] : [],
    inspectProcessIdentity: async () => currentIdentity ? { ...currentIdentity } : null,
    terminateOwnedProcess: async (validated) => {
      terminated.push(validated.pid);
      currentIdentity = null;
    },
  });
  const first = owner.terminate();
  const second = owner.terminate();
  assert.equal(first, second);
  await bounded(first, 1_000, "surviving-child cleanup");
  assert.deepEqual(terminated, [501]);
});

test("port reuse by a different profile fails closed without terminating the unknown browser", async () => {
  const originalProfile = "C:\\Temp\\lionlog-pages-chrome-original";
  const replacement = browserIdentity(601, "C:\\Temp\\lionlog-pages-chrome-replacement", 9333, "2026-09-24T12:01:00.000Z");
  const terminated = [];
  const owner = createBrowserProcessOwner({
    launcher: { pid: 600, exitCode: 0, signalCode: null },
    launcherExited: Promise.resolve(0),
    profile: originalProfile,
    debuggingPort: 9333,
    browserExecutable: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    platform: "win32",
    findPortProcessIds: async () => [replacement.pid],
    inspectProcessIdentity: async () => ({ ...replacement }),
    terminateOwnedProcess: async (validated) => { terminated.push(validated.pid); },
  });
  await assert.rejects(owner.terminate(), /ownership could not be established/);
  assert.deepEqual(terminated, []);
});

test("process replacement after initial ownership inspection fails closed at handle acquisition", async () => {
  const profile = "C:\\Temp\\lionlog-pages-chrome-original";
  const original = browserIdentity(701, profile, 9444, "2026-09-24T12:02:00.000Z");
  const replacement = browserIdentity(701, "C:\\Temp\\lionlog-pages-chrome-replacement", 9444, "2026-09-24T12:03:00.000Z");
  const terminated = [];
  const owner = createBrowserProcessOwner({
    launcher: { pid: 700, exitCode: 0, signalCode: null },
    launcherExited: Promise.resolve(0),
    profile,
    debuggingPort: 9444,
    browserExecutable: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    platform: "win32",
    findPortProcessIds: async () => [701],
    inspectProcessIdentity: async () => ({ ...original }),
    terminateOwnedProcess: async (validated) => {
      // Model the helper opening the PID after it was recycled. It compares
      // the retained instance to the validated identity before termination.
      if (!sameWindowsProcessIdentity(validated, replacement)) throw new Error("identity changed before handle-bound termination");
      terminated.push(replacement.pid);
    },
  });
  await assert.rejects(owner.terminate(), /identity changed before handle-bound termination/);
  assert.deepEqual(terminated, []);
});

test("Windows browser ownership requires exact profile, port, executable, and stable creation identity", () => {
  const profile = "C:\\Temp\\LionLog Profile";
  const identity = browserIdentity(801, profile, 9555, "2026-09-24T12:04:00.000Z");
  const expected = { profile, debuggingPort: 9555, expectedExecutablePath: identity.executablePath };
  assert.equal(matchesWindowsBrowserOwnership(identity, expected), true);
  assert.equal(matchesWindowsBrowserOwnership({ ...identity, commandLine: identity.commandLine.replace(profile, `${profile}-other`) }, expected), false);
  assert.equal(matchesWindowsBrowserOwnership({ ...identity, commandLine: identity.commandLine.replace("9555", "9556") }, expected), false);
  assert.equal(matchesWindowsBrowserOwnership({ ...identity, executablePath: "C:\\Elsewhere\\chrome.exe" }, expected), false);
  assert.equal(matchesWindowsBrowserOwnership({ ...identity, executablePath: "C:\\Elsewhere\\msedge.exe" }, expected), false);
  assert.equal(sameWindowsProcessIdentity(identity, { ...identity }), true);
  assert.equal(sameWindowsProcessIdentity(identity, { ...identity, creationDate: "2026-09-24T12:05:00.000Z" }), false);
  assert.equal(sameWindowsProcessIdentity(identity, { ...identity, creationTicks: "639258591000000001" }), false);
});

test("Windows ownership rejects duplicate, split, and ambiguous switches in every quoted order", () => {
  const profile = "C:\\Temp\\LionLog Profile";
  const identity = browserIdentity(802, profile, 9555, "2026-09-24T12:04:00.000Z");
  const expected = { profile, debuggingPort: 9555, expectedExecutablePath: identity.executablePath };
  const other = "C:\\Temp\\Foreign Profile";
  const original = identity.commandLine;
  for (const commandLine of [
    `${original} --user-data-dir=${other}`,
    `${original} "--user-data-dir=${other}"`,
    original.replace(`"--user-data-dir=${profile}"`, `--user-data-dir=${other} "--user-data-dir=${profile}"`),
    original.replace(`"--user-data-dir=${profile}"`, `"--user-data-dir=${profile}" --user-data-dir=${other}`),
    `${original} --remote-debugging-port=9556`,
    original.replace(`"--user-data-dir=${profile}"`, `-- "--user-data-dir=${profile}"`),
    original.replace(`"--user-data-dir=${profile}"`, `--user-data-dir "${profile}"`),
    original.replace(`"--user-data-dir=${profile}"`, `--user-data-directory=${profile}`),
    `${original} "--user-data-dir=${other}`,
  ]) assert.equal(matchesWindowsBrowserOwnership({ ...identity, commandLine }, expected), false, commandLine);
  assert.deepEqual(parseWindowsCommandLine(original).slice(1, 4), ["--headless=new", `--user-data-dir=${profile}`, "--remote-debugging-port=9555"]);
});

test("Windows handle-bound termination rejects a replaced identity after validation and retains the original handle through termination", { skip: process.platform !== "win32", timeout: 20_000 }, async () => {
  const run = promisify(execFile);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  const exited = once(child, "exit");
  try {
    const inspect = `$v=Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid}'; [pscustomobject]@{ pid=[int]$v.ProcessId; parentPid=[int]$v.ParentProcessId; creationDate=[string]$v.CreationDate; creationTicks=[string]([Diagnostics.Process]::GetProcessById(${child.pid}).StartTime.ToUniversalTime().Ticks); executablePath=[string]$v.ExecutablePath; commandLine=[string]$v.CommandLine } | ConvertTo-Json -Compress`;
    const identity = JSON.parse((await run("powershell.exe", ["-NoProfile", "-Command", inspect])).stdout);
    assert.equal(identity.pid, child.pid);
    const helper = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "terminate-owned-browser.ps1");
    const terminate = (value) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper, "-IdentityBase64", Buffer.from(JSON.stringify(value)).toString("base64")], { timeout: 15_000 });
    await assert.rejects(terminate({ ...identity, creationDate: "injected replacement" }), /identity changed before handle-bound termination/);
    assert.equal(child.exitCode, null, "fault injection must leave the foreign instance alive");
    await terminate(identity);
    await bounded(exited, 2_000, "handle-bound process exit");
  } finally {
    if (child.exitCode === null) child.kill();
  }
});

test("failure-before-offline cleanup is bounded, idempotent, and preserves the verification error", async () => {
  const original = new Error("verification failed before offline mode");
  const cleanupError = new Error("owned browser cleanup failed");
  const calls = { page: 0, browser: 0, process: 0, gate: 0, profile: 0 };
  const cleanup = createBrowserCleanup({
    getPageClient: () => ({ close() { calls.page += 1; } }),
    getBrowserClient: () => ({ close() { calls.browser += 1; } }),
    processOwner: { async terminate() { calls.process += 1; throw cleanupError; } },
    networkGate: { async close() { calls.gate += 1; } },
    profile: "fixture-profile",
    removeProfile: async () => { calls.profile += 1; },
  });
  const first = cleanup();
  const second = cleanup();
  assert.equal(first, second);
  const failures = await bounded(first, 1_000, "failure-before-offline cleanup");
  assert.deepEqual(calls, { page: 1, browser: 1, process: 1, gate: 1, profile: 1 });
  assert.deepEqual(failures, [cleanupError]);
  assert.throws(() => finalizeBrowserVerification(undefined, original, failures), (error) => error === original);
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

function browserIdentity(pid, profile, port, creationDate) {
  const executablePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  return {
    pid,
    parentPid: 1,
    creationDate,
    creationTicks: String(BigInt(Date.parse(creationDate)) * 10000n + 621355968000000000n),
    executablePath,
    commandLine: `"${executablePath}" --headless=new "--user-data-dir=${profile}" --remote-debugging-port=${port}`,
  };
}
