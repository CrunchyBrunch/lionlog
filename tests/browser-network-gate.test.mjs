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
  waitForEndpoint,
} from "../scripts/verify-public-pwa.mjs";

test("DevTools startup continues after a successful launcher exit until the child endpoint appears", { timeout: 3_000 }, async () => {
  let listRequests = 0;
  const server = createHttpServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/json/list") {
      listRequests += 1;
      response.end(JSON.stringify(listRequests > 1 ? [{ type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1/page" }] : []));
    } else response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1/browser" }));
  });
  await listen(server);
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = await bounded(waitForEndpoint(address.port, { exitCode: 0, signalCode: null }, () => ""), 1_000, "late browser endpoint");
    assert.equal(endpoint.page.url, "about:blank");
    assert.ok(listRequests > 1);
  } finally {
    await closeServer(server);
  }
});

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

test("cleanup waits for a late-owned port after successful launcher exit", async () => {
  const profile = "C:\\Temp\\lionlog-pages-chrome-late";
  const identity = browserIdentity(511, profile, 9223, "2026-09-24T12:00:00.000Z");
  let queries = 0;
  let clock = 0;
  const terminated = [];
  const owner = createBrowserProcessOwner({
    launcher: { pid: 510, exitCode: 0, signalCode: null },
    launcherExited: Promise.resolve(0),
    profile,
    debuggingPort: 9223,
    browserExecutable: identity.executablePath,
    platform: "win32",
    findPortProcessIds: async () => ++queries < 4 ? [] : [identity.pid],
    inspectProcessIdentity: async () => identity,
    terminateOwnedProcess: async (validated) => { terminated.push(validated.pid); },
    pause: async () => { clock += 100; },
    now: () => clock,
  });
  await owner.terminate();
  assert.equal(queries, 4);
  assert.deepEqual(terminated, [identity.pid]);
});

test("cleanup discovery remains finite when no child binds the port", async () => {
  let queries = 0;
  let clock = 0;
  const owner = createBrowserProcessOwner({
    launcher: { pid: 512, exitCode: 0, signalCode: null },
    launcherExited: Promise.resolve(0),
    profile: "C:\\Temp\\lionlog-pages-chrome-none",
    debuggingPort: 9224,
    browserExecutable: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    platform: "win32",
    findPortProcessIds: async () => { queries += 1; return []; },
    inspectProcessIdentity: async () => { throw new Error("unexpected identity inspection"); },
    terminateOwnedProcess: async () => { throw new Error("unexpected termination"); },
    pause: async () => { clock += 100; },
    now: () => clock,
  });
  await owner.terminate();
  assert.equal(queries, 100);
});

test("verification failure cleanup captures a late child and preserves the original error", async () => {
  const profile = "C:\\Temp\\lionlog-pages-chrome-timeout";
  const identity = browserIdentity(514, profile, 9225, "2026-09-24T12:00:00.000Z");
  let queries = 0;
  let clock = 0;
  const terminated = [];
  const owner = createBrowserProcessOwner({
    launcher: { pid: 513, exitCode: 0, signalCode: null },
    launcherExited: Promise.resolve(0),
    profile,
    debuggingPort: 9225,
    browserExecutable: identity.executablePath,
    platform: "win32",
    findPortProcessIds: async () => ++queries < 3 ? [] : [identity.pid],
    inspectProcessIdentity: async () => identity,
    terminateOwnedProcess: async (validated) => { terminated.push(validated.pid); },
    pause: async () => { clock += 100; },
    now: () => clock,
  });
  const cleanup = createBrowserCleanup({
    getPageClient: () => undefined,
    getBrowserClient: () => undefined,
    processOwner: owner,
    networkGate: { async close() {} },
    profile,
    removeProfile: async () => undefined,
  });
  const failures = await cleanup();
  assert.deepEqual(failures, []);
  assert.deepEqual(terminated, [identity.pid]);
  const original = new Error("DevTools endpoint timed out");
  assert.throws(() => finalizeBrowserVerification(undefined, original, failures), (error) => error === original);
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

test("Windows ownership preserves Unicode spaces inside native arguments and rejects decoding loss", () => {
  const profile = "C:\\Temp\\owned";
  const identity = browserIdentity(803, profile, 9555, "2026-09-24T12:04:00.000Z");
  const expected = { profile, debuggingPort: 9555, expectedExecutablePath: identity.executablePath };
  const commandLine = identity.commandLine.replace(`"--user-data-dir=${profile}"`, `--user-data-dir=${profile}\u00a0foreign`);
  assert.deepEqual(parseWindowsCommandLine(commandLine).slice(1, 4), ["--headless=new", `--user-data-dir=${profile}\u00a0foreign`, "--remote-debugging-port=9555"]);
  assert.equal(matchesWindowsBrowserOwnership({ ...identity, commandLine }, expected), false);
  assert.equal(matchesWindowsBrowserOwnership({ ...identity, commandLine: commandLine.replace("\u00a0", "\ufffd") }, expected), false);
});

test("Windows command-line parser agrees with CommandLineToArgvW on separators and quoting", { skip: process.platform !== "win32", timeout: 15_000 }, async () => {
  const cases = [
    '"C:\\Browser\\msedge.exe" --user-data-dir=C:\\Temp\\owned\u00a0foreign --remote-debugging-port=9333',
    '"C:\\Browser\\msedge.exe"\t--user-data-dir=C:\\Temp\\owned\u2003foreign\t--remote-debugging-port=9333',
    '"C:\\Browser\\msedge.exe" "--user-data-dir=C:\\Temp\\two words" --remote-debugging-port=9333',
    '"C:\\Browser\\msedge.exe" "--user-data-dir=C:\\Temp\\tail\\\\" --remote-debugging-port=9333',
    '"C:\\Browser\\msedge.exe" "--user-data-dir=C:\\Temp\\a\\"b" --remote-debugging-port=9333',
    '"C:\\Browser\\msedge.exe" "--user-data-dir=C:\\Temp\\a""b" --remote-debugging-port=9333',
    '"C:\\Browser\\msedge.exe" --user-data-dir="C:\\Temp\\mixed words" --remote-debugging-port=9333',
    '"C:\\Browser\\msedge.exe" "--user-data-dir=" --remote-debugging-port=9333',
  ];
  const encoded = Buffer.from(JSON.stringify(cases), "utf8").toString("base64");
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class NativeArgvFixture {
 [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
 public static string[] Parse(string value) { int count; var block=CommandLineToArgvW(value,out count); try { var result=new string[count]; for(int i=0;i<count;i++) result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(block,i*IntPtr.Size)); return result; } finally { LocalFree(block); } }
}
'@; $cases=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json; $result=@(foreach($case in $cases){ ,([NativeArgvFixture]::Parse([string]$case)) }); ConvertTo-Json -InputObject $result -Compress -Depth 4`;
  const native = JSON.parse((await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", timeout: 12_000 })).stdout);
  assert.equal(native.length, cases.length);
  for (let index = 0; index < cases.length; index += 1) {
    if (index === 5) {
      // Doubled quotes have a surprising native result. A disagreement with
      // the conservative parser must reject ownership rather than guess.
      assert.notDeepEqual(parseWindowsCommandLine(cases[index]), native[index]);
      const identity = browserIdentity(804, "C:\\Temp\\a", 9333, "2026-09-24T12:04:00.000Z");
      assert.equal(matchesWindowsBrowserOwnership({ ...identity, commandLine: cases[index], arguments: native[index] }, { profile: "C:\\Temp\\a", debuggingPort: 9333, expectedExecutablePath: identity.executablePath }), false);
    } else assert.deepEqual(parseWindowsCommandLine(cases[index]), native[index], cases[index]);
  }
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
    // Keep CIM's rounded timestamp and all other fields unchanged. A one-tick
    // replacement must still be rejected by the retained handle's exact time.
    await assert.rejects(terminate({ ...identity, creationTicks: String(BigInt(identity.creationTicks) + 1n) }), /identity changed before handle-bound termination/);
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
