import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { createServer } from "node:net";
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

export async function verifyBrowserSession({ targetUrl, expected: expectedValue, chromeBin = process.env.CHROME_BIN ?? "google-chrome", onOfflineStart, getOfflineServerRequestCount }) {
  const expected = validateExpectedContext(expectedValue);
  const expectedUrl = new URL(targetUrl).href;
  const profile = await mkdtemp(path.join(tmpdir(), "lionlog-pages-chrome-"));
  const port = await availablePort();
  const chrome = spawn(chromeBin, ["--headless=new", "--no-sandbox", "--disable-dev-shm-usage", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  let pageClient;
  let browserClient;
  try {
    const endpoint = await waitForEndpoint(port);
    pageClient = await connectCdp(endpoint.page.webSocketDebuggerUrl);
    browserClient = await connectCdp(endpoint.browser.webSocketDebuggerUrl);
    const diagnostics = [];
    pageClient.onEvent((event) => {
      if (event.method === "Runtime.exceptionThrown") diagnostics.push({ kind: "exception", text: event.params?.exceptionDetails?.text ?? "exception" });
      if (event.method === "Runtime.consoleAPICalled") diagnostics.push({ kind: "console", type: event.params?.type, text: JSON.stringify(event.params?.args ?? []) });
      if (event.method === "ServiceWorker.workerErrorReported") diagnostics.push({ kind: "service-worker", text: event.params?.errorMessage?.errorMessage ?? "service worker error" });
    });
    await pageClient.command("Page.enable");
    await pageClient.command("Runtime.enable");
    await pageClient.command("Network.enable");
    await pageClient.command("ServiceWorker.enable");
    await pageClient.command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await navigate(pageClient, expectedUrl);
    await waitForMenuControls(pageClient);
    await waitForServiceWorker(pageClient, diagnostics);
    await selectMenuContext(pageClient, expected);
    const ready = (state) => state.selectedHall === expected.hallId && state.selectedPeriod === expected.mealPeriodId && state.selectedDate === expected.serviceDate && state.itemNames.length === expected.expectedItemCount && state.itemNames[0] === expected.expectedFirstFoodName;
    const online = await waitForPageState(pageClient, ready);
    online.publicReleaseId = await evaluate(pageClient, `fetch("./release.json", {cache:"no-store"}).then((response) => { if (!response.ok) throw new Error("release marker unavailable"); return response.json(); }).then((marker) => marker.releaseId)`, true);
    assertPageState(online, expected, { expectedUrl });
    assertNoBrowserDiagnostics(diagnostics);

    const isolation = await enforceOfflineIsolation(browserClient, pageClient);
    if (!isolation.targetTypes.includes("service_worker")) throw new Error("No service-worker target was isolated for the offline check.");
    await onOfflineStart?.();
    const negativeControlUrl = new URL(`./api/offline-negative-control-${Date.now()}-${Math.random().toString(16).slice(2)}`, expectedUrl).href;
    const uncachedResourceFailed = await evaluate(pageClient, `fetch(${JSON.stringify(negativeControlUrl)}, {cache:"no-store"}).then(() => false, () => true)`, true);
    if (uncachedResourceFailed !== true) throw new Error("Uncached offline negative control unexpectedly reached a response.");
    await reload(pageClient);
    await waitForMenuControls(pageClient);
    await selectMenuContext(pageClient, expected);
    const offline = await waitForPageState(pageClient, ready);
    assertPageState(offline, expected, { offline: true, expectedUrl });
    assertNoBrowserDiagnostics(diagnostics);
    const offlineServerRequestCount = await getOfflineServerRequestCount?.();
    if (offlineServerRequestCount !== undefined && offlineServerRequestCount !== 0) throw new Error(`The origin recorded ${offlineServerRequestCount} request(s) during the offline phase.`);
    return { online, offline, diagnostics: diagnostics.length, uncachedResourceFailed, offlineServerRequestCount: offlineServerRequestCount ?? null, isolatedTargetTypes: isolation.targetTypes, approvedReleaseId: expected.releaseId };
  } finally {
    pageClient?.close();
    browserClient?.close();
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

async function verify() {
  const targetUrl = process.env.PUBLIC_URL ?? EXPECTED_URL;
  if (targetUrl !== EXPECTED_URL) throw new Error("Public browser verification URL is not the canonical Pages URL.");
  const contextPath = process.env.BROWSER_CONTEXT_PATH;
  if (!contextPath) throw new Error("Browser verification context is missing.");
  const result = await verifyBrowserSession({ targetUrl, expected: JSON.parse(await readFile(contextPath, "utf8")) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function enforceOfflineIsolation(browserClient, pageClient) {
  const configuredSessions = new Set();
  const configuredTargets = new Map();
  const pending = new Set();
  const configure = (sessionId, targetInfo) => {
    if (!sessionId || configuredSessions.has(sessionId)) return;
    configuredSessions.add(sessionId);
    if (OFFLINE_TARGET_TYPES.has(targetInfo.type)) configuredTargets.set(targetInfo.targetId, targetInfo.type);
    const task = (async () => {
      if (OFFLINE_TARGET_TYPES.has(targetInfo.type)) {
        await browserClient.command("Network.enable", {}, sessionId);
        await browserClient.command("Network.emulateNetworkConditions", offlineConditions(), sessionId);
      }
      await browserClient.command("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  browserClient.onEvent((event) => {
    if (event.method === "Target.attachedToTarget") configure(event.params?.sessionId, event.params?.targetInfo ?? {});
  });
  await browserClient.command("Target.setDiscoverTargets", { discover: true });
  await browserClient.command("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  const targets = await browserClient.command("Target.getTargets");
  for (const targetInfo of targets.targetInfos ?? []) {
    if (!OFFLINE_TARGET_TYPES.has(targetInfo.type) || configuredTargets.has(targetInfo.targetId)) continue;
    const attached = await browserClient.command("Target.attachToTarget", { targetId: targetInfo.targetId, flatten: true });
    configure(attached.sessionId, targetInfo);
  }
  await flushPending(pending);
  await pageClient.command("Network.emulateNetworkConditions", offlineConditions());
  await flushPending(pending);
  return { targetTypes: [...new Set(configuredTargets.values())].sort() };
}

function offlineConditions() { return { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }; }
async function flushPending(pending) { while (pending.size > 0) await Promise.all([...pending]); }

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("Could not reserve a Chrome debugging port.");
  return port;
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
