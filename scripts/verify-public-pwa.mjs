import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as connectTcp, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_URL = "https://crunchybrunch.github.io/lionlog/";
const OFFLINE_TARGET_TYPES = new Set(["page", "service_worker", "shared_worker", "worker"]);

export function assertPageState(state, expected, { offline = false, expectedUrl = EXPECTED_URL } = {}) {
  if (state.url !== expectedUrl) throw new Error(`Browser reached an unexpected URL: ${state.url}`);
  if (state.title !== "Build a meal | LionLog") throw new Error("LionLog document title is missing.");
  if (state.shellRevision !== expected.shellRevision) throw new Error("Rendered shell revision differs from the approved release.");
  if (state.selectedHall !== expected.hallId || state.selectedPeriod !== expected.mealPeriodId || state.selectedDate !== expected.serviceDate) throw new Error("Browser did not retain the selected approved menu context.");
  if (state.itemNames.length !== expected.expectedItemCount || state.itemNames[0] !== expected.expectedFirstFoodName) throw new Error("Browser menu item identity/count differs from the approved snapshot.");
  if (state.samplePressed || !state.livePressed || /sample/i.test(state.sourceState)) throw new Error("Browser silently switched to sample data.");
  if (state.scrollWidth > state.clientWidth) throw new Error(`Mobile viewport overflows horizontally (${state.scrollWidth} > ${state.clientWidth}).`);
  if (!offline) {
    if (state.publicReleaseId !== expected.releaseId) throw new Error("Browser release marker differs from the approved release.");
    if (!state.text.includes("Retrieved")) throw new Error("Live source retrieval time is not visible.");
    if (!state.text.includes("independent") || !state.text.includes("not affiliated with or endorsed by Penn State")) throw new Error("Independent/not-endorsed disclosure is not visible.");
  }
}

export function assertNoBrowserDiagnostics(events) {
  const failures = events.filter((event) => event.kind === "exception" || event.kind === "service-worker" || event.type === "error" || event.type === "warning");
  if (failures.length > 0) throw new Error(`Browser console/runtime diagnostics were emitted: ${JSON.stringify(failures)}`);
}

export async function verifyBrowserSession({
  targetUrl,
  expected: expectedValue,
  chromeBin = process.env.CHROME_BIN ?? "google-chrome",
  browserNow,
  onOfflineStart,
  onBeforeOfflineReload,
  getOfflineServerRequestCount,
}) {
  const expected = validateExpectedContext(expectedValue);
  const expectedUrl = new URL(targetUrl).href;
  const profile = await mkdtemp(path.join(tmpdir(), "lionlog-pages-chrome-"));
  const port = await availablePort();
  const networkGate = await createBrowserNetworkGate();
  const chrome = spawn(chromeBin, [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--proxy-server=http://127.0.0.1:${networkGate.port}`,
    "--proxy-bypass-list=<-loopback>",
    "about:blank",
  ], { stdio: "ignore" });
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  const processOwner = createBrowserProcessOwner({
    launcher: chrome,
    launcherExited: exited,
    profile,
    debuggingPort: port,
    browserExecutable: chromeBin,
  });
  let pageClient;
  let browserClient;
  const cleanup = createBrowserCleanup({
    getPageClient: () => pageClient,
    getBrowserClient: () => browserClient,
    processOwner,
    networkGate,
    profile,
  });
  let verificationFailure;
  let result;
  try {
    const endpoint = await waitForEndpoint(port);
    pageClient = await connectCdp(endpoint.page.webSocketDebuggerUrl);
    browserClient = await connectCdp(endpoint.browser.webSocketDebuggerUrl);
    processOwner.recordCdpProcessInfo((await browserClient.command("SystemInfo.getProcessInfo")).processInfo);
    const diagnostics = [];
    const recordDiagnostic = (event) => {
      if (event.method === "Runtime.exceptionThrown") diagnostics.push({ kind: "exception", text: event.params?.exceptionDetails?.text ?? "exception" });
      if (event.method === "Runtime.consoleAPICalled") diagnostics.push({ kind: "console", type: event.params?.type, text: JSON.stringify(event.params?.args ?? []) });
      if (event.method === "ServiceWorker.workerErrorReported") diagnostics.push({ kind: "service-worker", text: event.params?.errorMessage?.errorMessage ?? "service worker error" });
    };
    pageClient.onEvent(recordDiagnostic);
    browserClient.onEvent(recordDiagnostic);
    await pageClient.command("Page.enable");
    await pageClient.command("Runtime.enable");
    await pageClient.command("Network.enable");
    await pageClient.command("ServiceWorker.enable");
    await pageClient.command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    if (browserNow !== undefined) await installFixedClock(pageClient, browserNow);
    await navigate(pageClient, expectedUrl);
    await waitForMenuControls(pageClient);
    await waitForServiceWorker(pageClient, diagnostics);
    await selectMenuContext(pageClient, expected);
    const ready = (state) => state.selectedHall === expected.hallId && state.selectedPeriod === expected.mealPeriodId && state.selectedDate === expected.serviceDate && state.itemNames.length === expected.expectedItemCount && state.itemNames[0] === expected.expectedFirstFoodName;
    const online = await waitForPageState(pageClient, ready);
    online.publicReleaseId = await evaluate(pageClient, `fetch("./release.json", {cache:"no-store"}).then((response) => { if (!response.ok) throw new Error("release marker unavailable"); return response.json(); }).then((marker) => marker.releaseId)`, true);
    assertPageState(online, expected, { expectedUrl });
    assertNoBrowserDiagnostics(diagnostics);
    networkGate.assertHealthy();

    const isolation = await enforceOfflineIsolation(browserClient, pageClient);
    if (!isolation.targetTypes.includes("service_worker")) throw new Error("No service-worker target was isolated for the offline check.");
    networkGate.disconnect();
    await onOfflineStart?.();
    const negativeControlUrl = new URL(`./api/offline-negative-control-${Date.now()}-${Math.random().toString(16).slice(2)}`, expectedUrl).href;
    const workerNegativeControlUrl = new URL(`./api/offline-worker-negative-control-${Date.now()}-${Math.random().toString(16).slice(2)}`, expectedUrl).href;
    const dedicatedWorkerUncachedResourceFailed = await dedicatedWorkerNegativeControl(pageClient, workerNegativeControlUrl);
    if (dedicatedWorkerUncachedResourceFailed !== true) throw new Error("A newly created dedicated worker escaped offline isolation.");
    await isolation.settle();
    const uncachedResourceFailed = await evaluate(pageClient, `fetch(${JSON.stringify(negativeControlUrl)}, {cache:"no-store"}).then(() => false, () => true)`, true);
    if (uncachedResourceFailed !== true) throw new Error("Uncached offline negative control unexpectedly reached a response.");
    const preReloadOfflineServerRequestCount = await getOfflineServerRequestCount?.();
    if (preReloadOfflineServerRequestCount !== undefined && preReloadOfflineServerRequestCount !== 0) {
      throw new Error(`The origin recorded ${preReloadOfflineServerRequestCount} request(s) during the isolated negative controls.`);
    }
    await onBeforeOfflineReload?.();
    await reload(pageClient);
    await waitForMenuControls(pageClient);
    await selectMenuContext(pageClient, expected);
    const offline = await waitForPageState(pageClient, ready);
    assertPageState(offline, expected, { offline: true, expectedUrl });
    assertNoBrowserDiagnostics(diagnostics);
    const offlineServerRequestCount = await getOfflineServerRequestCount?.();
    if (offlineServerRequestCount !== undefined && offlineServerRequestCount !== 0) throw new Error(`The origin recorded ${offlineServerRequestCount} request(s) during the offline phase.`);
    result = {
      online,
      offline,
      diagnostics: diagnostics.length,
      uncachedResourceFailed,
      dedicatedWorkerUncachedResourceFailed,
      offlineServerRequestCount: offlineServerRequestCount ?? null,
      isolatedTargetTypes: isolation.targetTypes,
      approvedReleaseId: expected.releaseId,
    };
  } catch (error) {
    verificationFailure = error;
  }
  const cleanupFailures = await cleanup();
  return finalizeBrowserVerification(result, verificationFailure, cleanupFailures);
}

export function createBrowserProcessOwner({
  launcher,
  launcherExited,
  profile,
  debuggingPort,
  browserExecutable,
  platform = process.platform,
  findPortProcessIds = platform === "win32" ? findWindowsPortProcessIds : undefined,
  inspectProcessIdentity = platform === "win32" ? inspectWindowsProcessIdentity : undefined,
  terminateProcessTree = platform === "win32" ? terminateWindowsProcessTree : undefined,
  pause = delay,
}) {
  if (!launcher || !Number.isSafeInteger(launcher.pid) || launcher.pid < 1) throw new Error("Browser launcher process identity is unavailable.");
  if (
    typeof profile !== "string" || profile.length < 1 || !Number.isSafeInteger(debuggingPort) || debuggingPort < 1
    || typeof browserExecutable !== "string" || browserExecutable.length < 1
  ) {
    throw new Error("Browser process ownership boundary is invalid.");
  }
  const cdpBrowserProcessIds = new Set();
  let termination;
  return {
    recordCdpProcessInfo(processInfo) {
      if (!Array.isArray(processInfo)) throw new Error("Browser process inventory is unavailable.");
      for (const value of processInfo) {
        if (value?.type === "browser" && Number.isSafeInteger(value.id) && value.id > 0) cdpBrowserProcessIds.add(value.id);
      }
      if (cdpBrowserProcessIds.size !== 1) throw new Error("Browser root process identity is missing or ambiguous.");
    },
    terminate() {
      if (termination) return termination;
      termination = platform === "win32"
        ? terminateOwnedWindowsProcesses({
            launcher,
            profile,
            debuggingPort,
            browserExecutable,
            cdpBrowserProcessIds,
            findPortProcessIds,
            inspectProcessIdentity,
            terminateProcessTree,
            pause,
          })
        : terminatePortableBrowserProcesses({ launcher, launcherExited, cdpProcessIds: cdpBrowserProcessIds });
      return termination;
    },
  };
}

export function createBrowserCleanup({
  getPageClient,
  getBrowserClient,
  processOwner,
  networkGate,
  profile,
  removeProfile = removeBrowserProfile,
}) {
  let cleanup;
  return () => {
    if (cleanup) return cleanup;
    cleanup = (async () => {
      const failures = [];
      try { getPageClient()?.close(); } catch (error) { failures.push(error); }
      try { getBrowserClient()?.close(); } catch (error) { failures.push(error); }
      try { await processOwner.terminate(); } catch (error) { failures.push(error); }
      try { await networkGate.close(); } catch (error) { failures.push(error); }
      try { await removeProfile(profile); } catch (error) { failures.push(error); }
      return failures;
    })();
    return cleanup;
  };
}

async function terminateOwnedWindowsProcesses({
  launcher,
  profile,
  debuggingPort,
  browserExecutable,
  cdpBrowserProcessIds,
  findPortProcessIds,
  inspectProcessIdentity,
  terminateProcessTree,
  pause,
}) {
  if (typeof findPortProcessIds !== "function" || typeof inspectProcessIdentity !== "function" || typeof terminateProcessTree !== "function") {
    throw new Error("Windows browser process cleanup is unavailable.");
  }
  let candidates = [...cdpBrowserProcessIds];
  if (candidates.length === 0 && launcher.exitCode === null && launcher.signalCode === null) candidates = [launcher.pid];
  if (candidates.length === 0) candidates = await findPortProcessIds(debuggingPort);
  if (candidates.length === 0) return;
  if (candidates.length !== 1) throw new Error("Verifier-owned browser process identity is ambiguous.");
  const pid = candidates[0];
  const expectedExecutableName = path.win32.basename(browserExecutable).toLowerCase();
  const initialIdentity = await inspectProcessIdentity(pid);
  if (!matchesWindowsBrowserOwnership(initialIdentity, { profile, debuggingPort, expectedExecutableName })) {
    throw new Error("Browser process ownership could not be established from the isolated profile boundary.");
  }
  const preTerminationIdentity = await inspectProcessIdentity(pid);
  if (
    !sameWindowsProcessIdentity(initialIdentity, preTerminationIdentity)
    || !matchesWindowsBrowserOwnership(preTerminationIdentity, { profile, debuggingPort, expectedExecutableName })
  ) {
    throw new Error("Browser process identity changed before termination.");
  }
  for (let pass = 0; pass < 4; pass += 1) {
    const currentIdentity = await inspectProcessIdentity(pid);
    if (currentIdentity === null || !sameWindowsProcessIdentity(initialIdentity, currentIdentity)) return;
    if (!matchesWindowsBrowserOwnership(currentIdentity, { profile, debuggingPort, expectedExecutableName })) {
      throw new Error("Browser process ownership changed during termination.");
    }
    await terminateProcessTree(pid);
    await pause(100);
  }
  const remaining = await inspectProcessIdentity(pid);
  if (sameWindowsProcessIdentity(initialIdentity, remaining)) throw new Error(`Verifier-owned browser process did not terminate: ${pid}`);
}

async function terminatePortableBrowserProcesses({ launcher, launcherExited, cdpProcessIds }) {
  for (const pid of cdpProcessIds) {
    try { process.kill(pid, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") throw error; }
  }
  if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
  if (!await settleWithin(launcherExited, 5_000)) throw new Error("Browser launcher did not terminate within the cleanup bound.");
}

async function findWindowsPortProcessIds(port) {
  const output = await executeFile("netstat.exe", ["-ano", "-p", "tcp"], 4_000);
  const processIds = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!match || !match[1].endsWith(`:${port}`)) continue;
    const pid = Number(match[2]);
    if (Number.isSafeInteger(pid) && pid > 0) processIds.add(pid);
  }
  return [...processIds];
}

async function inspectWindowsProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Browser process ID is invalid.");
  const script = `$ErrorActionPreference='Stop'; $value=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($null -ne $value) { [pscustomobject]@{ pid=[int]$value.ProcessId; parentPid=[int]$value.ParentProcessId; creationDate=[string]$value.CreationDate; executablePath=[string]$value.ExecutablePath; commandLine=[string]$value.CommandLine } | ConvertTo-Json -Compress }`;
  const output = await executeFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], 4_000);
  if (output.trim() === "") return null;
  const value = JSON.parse(output);
  if (
    !Number.isSafeInteger(value?.pid) || value.pid !== pid || !Number.isSafeInteger(value?.parentPid) || value.parentPid < 0
    || typeof value?.creationDate !== "string" || value.creationDate.length < 1
    || typeof value?.executablePath !== "string" || value.executablePath.length < 1
    || typeof value?.commandLine !== "string" || value.commandLine.length < 1
  ) throw new Error("Browser process identity is incomplete.");
  return value;
}

async function terminateWindowsProcessTree(pid) {
  try {
    await executeFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], 4_000);
  } catch {
    // The identity is checked again before any retry and after the bounded termination loop.
  }
}

export function matchesWindowsBrowserOwnership(identity, { profile, debuggingPort, expectedExecutableName }) {
  if (identity === null || typeof identity !== "object") return false;
  const userDataDirectory = windowsCommandLineArgument(identity.commandLine, "--user-data-dir");
  const remoteDebuggingPort = windowsCommandLineArgument(identity.commandLine, "--remote-debugging-port");
  if (userDataDirectory === null || remoteDebuggingPort === null) return false;
  const actualProfile = path.win32.resolve(userDataDirectory).toLowerCase();
  const expectedProfile = path.win32.resolve(profile).toLowerCase();
  return actualProfile === expectedProfile
    && remoteDebuggingPort === String(debuggingPort)
    && path.win32.basename(identity.executablePath).toLowerCase() === expectedExecutableName;
}

export function sameWindowsProcessIdentity(left, right) {
  return left !== null && right !== null
    && left.pid === right.pid
    && left.parentPid === right.parentPid
    && left.creationDate === right.creationDate
    && left.executablePath.toLowerCase() === right.executablePath.toLowerCase()
    && left.commandLine === right.commandLine;
}

function windowsCommandLineArgument(commandLine, name) {
  if (typeof commandLine !== "string") return null;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`(?:^|\\s)"${escapedName}=([^"]*)"(?=\\s|$)`, "i"),
    new RegExp(`(?:^|\\s)${escapedName}="([^"]*)"(?=\\s|$)`, "i"),
    new RegExp(`(?:^|\\s)${escapedName}=([^\\s"]+)(?=\\s|$)`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(commandLine);
    if (match) return match[1];
  }
  return null;
}

function executeFile(file, argumentsValue, timeout) {
  return new Promise((resolve, reject) => {
    execFile(file, argumentsValue, { encoding: "utf8", timeout, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Browser process cleanup command failed: ${stderr.trim() || error.message}`, { cause: error }));
        return;
      }
      resolve(stdout);
    });
  });
}

async function removeBrowserProfile(profile, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    try {
      await rm(profile, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  } while (Date.now() < deadline);
  throw new Error(`Verifier browser profile could not be removed within ${timeoutMs} ms.`, { cause: lastError });
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

export function finalizeBrowserVerification(result, verificationFailure, cleanupFailures) {
  if (verificationFailure !== undefined) throw verificationFailure;
  if (cleanupFailures.length > 0) throw cleanupFailures[0];
  return result;
}

async function verify() {
  const targetUrl = process.env.PUBLIC_URL ?? EXPECTED_URL;
  if (targetUrl !== EXPECTED_URL) throw new Error("Public browser verification URL is not the canonical Pages URL.");
  const contextPath = process.env.BROWSER_CONTEXT_PATH;
  if (!contextPath) throw new Error("Browser verification context is missing.");
  const result = await verifyBrowserSession({ targetUrl, expected: JSON.parse(await readFile(contextPath, "utf8")) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function enforceOfflineIsolation(browserClient, pageClient) {
  const configuredSessions = new Set();
  const configuredTargets = new Map();
  const pending = new Set();
  const failures = [];
  const configure = (owner, ownerName, sessionId, targetInfo) => {
    const sessionKey = `${ownerName}:${sessionId}`;
    if (!sessionId || configuredSessions.has(sessionKey)) return;
    configuredSessions.add(sessionKey);
    if (OFFLINE_TARGET_TYPES.has(targetInfo.type)) configuredTargets.set(targetInfo.targetId, targetInfo.type);
    const task = (async () => {
      try {
        if (OFFLINE_TARGET_TYPES.has(targetInfo.type)) {
          await owner.command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId).catch((error) => {
            if (String(error?.message ?? error) === "Not supported") return;
            throw new Error(`Could not recursively auto-attach ${targetInfo.type}: ${String(error?.message ?? error)}`);
          });
          await owner.command("Runtime.enable", {}, sessionId).catch((error) => { throw new Error(`Could not enable runtime for ${targetInfo.type}: ${String(error?.message ?? error)}`); });
          await owner.command("Network.enable", {}, sessionId).catch((error) => { throw new Error(`Could not enable network control for ${targetInfo.type}: ${String(error?.message ?? error)}`); });
          await owner.command("Network.emulateNetworkConditions", offlineConditions(), sessionId).catch((error) => {
            if (targetInfo.type === "worker" && String(error?.message ?? error) === "Not supported") return;
            throw new Error(`Could not isolate ${targetInfo.type}: ${String(error?.message ?? error)}`);
          });
        }
      } finally {
        await owner.command("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
      }
    })();
    const tracked = task.catch((error) => failures.push(error)).finally(() => pending.delete(tracked));
    pending.add(tracked);
  };
  browserClient.onEvent((event) => {
    if (event.method === "Target.attachedToTarget") configure(browserClient, "browser", event.params?.sessionId, event.params?.targetInfo ?? {});
  });
  pageClient.onEvent((event) => {
    if (event.method === "Target.attachedToTarget") configure(pageClient, "page", event.params?.sessionId, event.params?.targetInfo ?? {});
  });
  await browserClient.command("Target.setDiscoverTargets", { discover: true });
  await browserClient.command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  await pageClient.command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const targets = await browserClient.command("Target.getTargets");
  for (const targetInfo of targets.targetInfos ?? []) {
    if (!OFFLINE_TARGET_TYPES.has(targetInfo.type) || configuredTargets.has(targetInfo.targetId)) continue;
    const attached = await browserClient.command("Target.attachToTarget", { targetId: targetInfo.targetId, flatten: true });
    configure(browserClient, "browser", attached.sessionId, targetInfo);
  }
  const settle = async () => {
    await flushPending(pending);
    if (failures.length > 0) throw failures[0];
  };
  await settle();
  await pageClient.command("Network.emulateNetworkConditions", offlineConditions());
  await settle();
  return {
    get targetTypes() { return [...new Set(configuredTargets.values())].sort(); },
    settle,
  };
}

function offlineConditions() { return { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }; }
async function flushPending(pending) { while (pending.size > 0) await Promise.all([...pending]); }

async function dedicatedWorkerNegativeControl(client, url) {
  return evaluate(client, `(async () => {
    const source = 'self.onmessage=async(event)=>{try{await fetch(event.data,{cache:"no-store"});self.postMessage(false)}catch{self.postMessage(true)}}';
    const blobUrl = URL.createObjectURL(new Blob([source], {type:"text/javascript"}));
    const worker = new Worker(blobUrl);
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("dedicated worker negative control timed out")), 15000);
        worker.onmessage = (event) => { clearTimeout(timer); resolve(event.data); };
        worker.onerror = (event) => { clearTimeout(timer); reject(new Error(event.message || "dedicated worker failed")); };
        worker.postMessage(${JSON.stringify(url)});
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
    }
  })()`, true);
}

async function installFixedClock(client, value) {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new Error("Browser test clock is invalid.");
  await client.command("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => { const NativeDate = Date; const fixed = ${JSON.stringify(time)}; class FixedDate extends NativeDate { constructor(...args) { super(...(args.length === 0 ? [fixed] : args)); } static now() { return fixed; } } Object.setPrototypeOf(FixedDate, NativeDate); globalThis.Date = FixedDate; })();`,
  });
}

async function availablePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("Could not reserve a Chrome debugging port.");
  return port;
}

export async function createBrowserNetworkGate({ closeTimeoutMs = 2_000 } = {}) {
  if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs < 1 || closeTimeoutMs > 10_000) {
    throw new Error("Browser network gate close timeout is invalid.");
  }
  let disconnected = false;
  let closePromise;
  let serverFailure;
  const clientSockets = new Set();
  const upstreamSockets = new Set();
  const forwards = new Set();
  const ignoreExpectedSocketError = () => undefined;
  const trackSocket = (socket, collection) => {
    if (collection.has(socket)) return socket;
    collection.add(socket);
    socket.on("error", ignoreExpectedSocketError);
    socket.once("close", () => collection.delete(socket));
    return socket;
  };
  const destroy = (stream) => {
    if (stream && !stream.destroyed) stream.destroy();
  };
  const disconnectAll = () => {
    disconnected = true;
    for (const forward of forwards) destroy(forward);
    for (const socket of upstreamSockets) destroy(socket);
    for (const socket of clientSockets) destroy(socket);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  };
  const server = createHttpServer((request, response) => {
    response.on("error", ignoreExpectedSocketError);
    if (disconnected) {
      destroy(request.socket);
      return;
    }
    let target;
    try {
      target = new URL(request.url ?? "");
      if (!new Set(["http:", "https:"]).has(target.protocol) || target.username || target.password) throw new Error("unsupported proxy target");
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    const headers = { ...request.headers, host: target.host };
    delete headers["proxy-connection"];
    const forward = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
      method: request.method,
      headers,
    }, (upstream) => {
      if (upstream.socket) trackSocket(upstream.socket, upstreamSockets);
      upstream.on("error", () => destroy(response));
      upstream.on("aborted", () => destroy(response));
      response.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(response);
    });
    forwards.add(forward);
    forward.on("socket", (socket) => trackSocket(socket, upstreamSockets));
    forward.on("error", () => destroy(response));
    forward.once("close", () => forwards.delete(forward));
    request.on("aborted", () => destroy(forward));
    request.on("error", () => destroy(forward));
    response.on("close", () => { if (!response.writableEnded) destroy(forward); });
    request.pipe(forward);
  });
  server.on("connect", (request, clientSocket, head) => {
    trackSocket(clientSocket, clientSockets);
    if (disconnected) {
      destroy(clientSocket);
      return;
    }
    let authority;
    try {
      authority = new URL(`http://${request.url}`);
      if (!authority.hostname || authority.username || authority.password) throw new Error("invalid tunnel authority");
    } catch {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const upstream = trackSocket(connectTcp(Number(authority.port || 443), authority.hostname, () => {
      if (disconnected || clientSocket.destroyed) {
        destroy(upstream);
        destroy(clientSocket);
        return;
      }
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    }), upstreamSockets);
    upstream.on("error", () => destroy(clientSocket));
    upstream.on("close", () => destroy(clientSocket));
    clientSocket.on("error", () => destroy(upstream));
    clientSocket.on("close", () => destroy(upstream));
  });
  server.on("connection", (socket) => {
    trackSocket(socket, clientSockets);
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  server.on("error", (error) => { serverFailure ??= error; });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("Browser network gate did not start.");
  return {
    port: address.port,
    assertHealthy() {
      if (serverFailure) throw new Error("Browser network gate failed.", { cause: serverFailure });
    },
    disconnect() {
      disconnectAll();
    },
    close() {
      if (closePromise) return closePromise;
      disconnectAll();
      closePromise = new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          disconnectAll();
          resolve();
        };
        timer = setTimeout(finish, closeTimeoutMs);
        server.close(finish);
      });
      return closePromise;
    },
  };
}

async function settleWithin(promise, timeoutMs) {
  let timer;
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const settled = Promise.resolve(promise).then(() => true, () => true);
  const result = await Promise.race([settled, timedOut]);
  clearTimeout(timer);
  return result;
}

async function waitForEndpoint(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const [pagesResponse, browserResponse] = await Promise.all([fetch(`http://127.0.0.1:${port}/json/list`), fetch(`http://127.0.0.1:${port}/json/version`)]);
      const pages = await pagesResponse.json();
      const browser = await browserResponse.json();
      const page = pages.find((target) => target.type === "page" && target.url === "about:blank")
        ?? pages.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl && browser?.webSocketDebuggerUrl) return { page, browser };
    } catch { /* Chrome is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome DevTools endpoint did not start.");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  socket.addEventListener("message", (message) => {
    const payload = JSON.parse(String(message.data));
    if (payload.id) {
      const waiter = pending.get(payload.id);
      if (!waiter) return;
      pending.delete(payload.id);
      if (payload.error) waiter.reject(new Error(payload.error.message)); else waiter.resolve(payload.result);
    } else listeners.forEach((listener) => listener(payload));
  });
  return {
    command(method, params = {}, sessionId) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      return withTimeout(new Promise((resolve, reject) => pending.set(id, { resolve, reject })), `CDP command ${method}`);
    },
    onEvent(listener) { listeners.push(listener); },
    close() { socket.close(); },
  };
}

async function navigate(client, url) {
  const loaded = eventOnce(client, "Page.loadEventFired");
  const result = await client.command("Page.navigate", { url });
  if (result.errorText) {
    loaded.catch(() => undefined);
    throw new Error(`Page navigation failed: ${result.errorText}`);
  }
  await loaded;
}
async function reload(client) { const loaded = eventOnce(client, "Page.loadEventFired"); await client.command("Page.reload", { ignoreCache: true }); await loaded; }
function eventOnce(client, method) { return withTimeout(new Promise((resolve) => { let done = false; client.onEvent((event) => { if (!done && event.method === method) { done = true; resolve(event); } }); }), `CDP event ${method}`); }
async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.command("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Browser evaluation failed.");
  return result.result?.value;
}
async function pageState(client) {
  return evaluate(client, `({url: location.href,title: document.title,text: document.body.innerText,shellRevision: document.documentElement.getAttribute("data-lionlog-shell"),selectedHall: document.querySelectorAll("select")[0]?.value ?? null,selectedPeriod: document.querySelectorAll("select")[1]?.value ?? null,selectedDate: document.querySelector('input[type="date"]')?.value ?? null,itemNames: [...document.querySelectorAll(".food-row h3")].map((node) => node.textContent),sourceState: document.querySelector(".menu-section .section-kicker")?.textContent ?? "",livePressed: document.querySelector('button[aria-pressed="true"]')?.textContent === "PSU snapshots",samplePressed: [...document.querySelectorAll("button")].some((button) => button.textContent === "Sample demo" && button.getAttribute("aria-pressed") === "true"),scrollWidth: document.documentElement.scrollWidth,clientWidth: document.documentElement.clientWidth})`);
}
async function selectMenuContext(client, expected) {
  await evaluate(client, `(async () => {const setNativeValue=(element,value,prototype)=>{if(!element)throw new Error("menu control unavailable");const setter=Object.getOwnPropertyDescriptor(prototype,"value")?.set;if(!setter)throw new Error("native menu-control value setter unavailable");setter.call(element,value);element.dispatchEvent(new Event("input",{bubbles:true}));element.dispatchEvent(new Event("change",{bubbles:true}));};const selects=document.querySelectorAll("select");if(selects.length<2)throw new Error("menu selectors unavailable");setNativeValue(selects[0],${JSON.stringify(expected.hallId)},HTMLSelectElement.prototype);await new Promise((resolve)=>setTimeout(resolve,250));setNativeValue(document.querySelectorAll("select")[1],${JSON.stringify(expected.mealPeriodId)},HTMLSelectElement.prototype);setNativeValue(document.querySelector('input[type="date"]'),${JSON.stringify(expected.serviceDate)},HTMLInputElement.prototype);})()`, true);
}
async function waitForPageState(client, ready) { for (let attempt = 0; attempt < 200; attempt += 1) { const state = await pageState(client); if (ready(state)) return state; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("LionLog page did not reach its expected rendered state."); }
async function waitForMenuControls(client) { for (let attempt = 0; attempt < 200; attempt += 1) { if (await evaluate(client, `document.querySelectorAll("select").length >= 2 && document.querySelector('input[type="date"]') !== null`)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("LionLog menu controls did not become available."); }
async function waitForServiceWorker(client, diagnostics) {
  let status = null;
  for (let attempt = 0; attempt < 450; attempt += 1) {
    status = await evaluate(client, `(async () => {const registration=await navigator.serviceWorker.getRegistration();return {controller:navigator.serviceWorker.controller?.scriptURL??null,installing:registration?.installing?.state??null,waiting:registration?.waiting?.state??null,active:registration?.active?.state??null,scriptURL:registration?.active?.scriptURL??registration?.installing?.scriptURL??null};})()`, true);
    if (status?.active === "activated") return status;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Service worker did not activate: ${JSON.stringify({ status, diagnostics })}`);
}
function withTimeout(promise, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out.`)), 60_000);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
function validateExpectedContext(value) {
  if (value?.contextVersion !== "lionlog.pages-browser-context.v1" || !/^[a-f0-9]{64}$/.test(value.releaseId ?? "") || !/^[a-f0-9]{40}$/.test(value.shellRevision ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(value.serviceDate ?? "") || typeof value.hallId !== "string" || typeof value.mealPeriodId !== "string" || !Number.isSafeInteger(value.expectedItemCount) || value.expectedItemCount < 1 || typeof value.expectedFirstFoodName !== "string" || value.expectedFirstFoodName.length < 1) throw new Error("Browser verification context is invalid or empty.");
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await verify();
