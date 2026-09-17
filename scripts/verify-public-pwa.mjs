import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_URL = "https://crunchybrunch.github.io/lionlog/";

export function assertPageState(state, expected, { offline = false } = {}) {
  if (state.url !== EXPECTED_URL) throw new Error(`Browser reached an unexpected URL: ${state.url}`);
  if (state.title !== "Build a meal | LionLog") throw new Error("LionLog document title is missing.");
  if (state.shellRevision !== expected.shellRevision) throw new Error("Rendered shell revision differs from the approved release.");
  if (state.selectedHall !== expected.hallId || state.selectedPeriod !== expected.mealPeriodId || state.selectedDate !== expected.serviceDate) {
    throw new Error("Browser did not retain the selected approved menu context.");
  }
  if (state.itemNames.length !== expected.expectedItemCount || state.itemNames[0] !== expected.expectedFirstFoodName) {
    throw new Error("Browser menu item identity/count differs from the approved snapshot.");
  }
  if (state.samplePressed || !state.livePressed || /sample/i.test(state.sourceState)) throw new Error("Browser silently switched to sample data.");
  if (state.scrollWidth > state.clientWidth) throw new Error(`Mobile viewport overflows horizontally (${state.scrollWidth} > ${state.clientWidth}).`);
  if (!offline) {
    if (state.publicReleaseId !== expected.releaseId) throw new Error("Browser release marker differs from the approved release.");
    if (!state.text.includes("Retrieved")) throw new Error("Live source retrieval time is not visible.");
    if (!state.text.includes("independent") || !state.text.includes("not affiliated with or endorsed by Penn State")) {
      throw new Error("Independent/not-endorsed disclosure is not visible.");
    }
  }
}

export function assertNoBrowserDiagnostics(events) {
  const failures = events.filter((event) => event.kind === "exception" || event.type === "error" || event.type === "warning");
  if (failures.length > 0) throw new Error(`Browser console/runtime diagnostics were emitted: ${JSON.stringify(failures)}`);
}

async function verify() {
  const targetUrl = process.env.PUBLIC_URL ?? EXPECTED_URL;
  if (targetUrl !== EXPECTED_URL) throw new Error("Public browser verification URL is not the canonical Pages URL.");
  const contextPath = process.env.BROWSER_CONTEXT_PATH;
  if (!contextPath) throw new Error("Browser verification context is missing.");
  const expected = validateExpectedContext(JSON.parse(await readFile(contextPath, "utf8")));
  const profile = await mkdtemp(path.join(tmpdir(), "lionlog-pages-chrome-"));
  const port = 9222;
  const chrome = spawn(process.env.CHROME_BIN ?? "google-chrome", [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ], { stdio: "ignore" });
  const exited = new Promise((resolve) => chrome.once("exit", resolve));
  try {
    const endpoint = await waitForEndpoint(port);
    const client = await connectCdp(endpoint.webSocketDebuggerUrl);
    const diagnostics = [];
    client.onEvent((event) => {
      if (event.method === "Runtime.exceptionThrown") diagnostics.push({ kind: "exception", text: event.params?.exceptionDetails?.text ?? "exception" });
      if (event.method === "Runtime.consoleAPICalled") diagnostics.push({ kind: "console", type: event.params?.type, text: JSON.stringify(event.params?.args ?? []) });
    });
    await client.command("Page.enable");
    await client.command("Runtime.enable");
    await client.command("Network.enable");
    await client.command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await navigate(client, targetUrl);
    await evaluate(client, `Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((_, reject) => setTimeout(() => reject(new Error("service worker timeout")), 15000))])`, true);
    await selectMenuContext(client, expected);
    const online = await waitForPageState(client, (state) => state.itemNames.length === expected.expectedItemCount && state.itemNames[0] === expected.expectedFirstFoodName);
    online.publicReleaseId = await evaluate(client, `fetch("./release.json", {cache:"no-store"}).then((response) => { if (!response.ok) throw new Error("release marker unavailable"); return response.json(); }).then((marker) => marker.releaseId)`, true);
    assertPageState(online, expected);
    assertNoBrowserDiagnostics(diagnostics);

    await client.command("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await reload(client);
    await selectMenuContext(client, expected);
    const offline = await waitForPageState(client, (state) => state.itemNames.length === expected.expectedItemCount && state.itemNames[0] === expected.expectedFirstFoodName);
    assertPageState(offline, expected, { offline: true });
    assertNoBrowserDiagnostics(diagnostics);
    client.close();
    process.stdout.write(`${JSON.stringify({ online, offline, diagnostics: diagnostics.length })}\n`);
  } finally {
    if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
    await exited;
    await rm(profile, { recursive: true, force: true });
  }
}

async function waitForEndpoint(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const pages = await response.json();
      if (pages[0]?.webSocketDebuggerUrl) return pages[0];
    } catch { /* Chrome is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome DevTools endpoint did not start.");
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  socket.addEventListener("message", (message) => {
    const payload = JSON.parse(String(message.data));
    if (payload.id) {
      const waiter = pending.get(payload.id);
      if (!waiter) return;
      pending.delete(payload.id);
      if (payload.error) waiter.reject(new Error(payload.error.message));
      else waiter.resolve(payload.result);
    } else listeners.forEach((listener) => listener(payload));
  });
  return {
    command(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return withTimeout(new Promise((resolve, reject) => pending.set(id, { resolve, reject })), `CDP command ${method}`);
    },
    onEvent(listener) { listeners.push(listener); },
    close() { socket.close(); },
  };
}

async function navigate(client, url) {
  const loaded = eventOnce(client, "Page.loadEventFired");
  const result = await client.command("Page.navigate", { url });
  if (result.errorText) throw new Error(`Page navigation failed: ${result.errorText}`);
  await loaded;
}

async function reload(client) {
  const loaded = eventOnce(client, "Page.loadEventFired");
  await client.command("Page.reload", { ignoreCache: true });
  await loaded;
}

function eventOnce(client, method) {
  return withTimeout(new Promise((resolve) => {
    let done = false;
    client.onEvent((event) => {
      if (!done && event.method === method) { done = true; resolve(event); }
    });
  }), `CDP event ${method}`);
}

async function evaluate(client, expression, awaitPromise = false) {
  const result = await client.command("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Browser evaluation failed.");
  return result.result?.value;
}

async function pageState(client) {
  return evaluate(client, `({
    url: location.href,
    title: document.title,
    text: document.body.innerText,
    shellRevision: document.documentElement.getAttribute("data-lionlog-shell"),
    selectedHall: document.querySelectorAll("select")[0]?.value ?? null,
    selectedPeriod: document.querySelectorAll("select")[1]?.value ?? null,
    selectedDate: document.querySelector('input[type="date"]')?.value ?? null,
    itemNames: [...document.querySelectorAll(".food-row h3")].map((node) => node.textContent),
    sourceState: document.querySelector(".menu-section .section-kicker")?.textContent ?? "",
    livePressed: document.querySelector('button[aria-pressed="true"]')?.textContent === "PSU snapshots",
    samplePressed: [...document.querySelectorAll("button")].some((button) => button.textContent === "Sample demo" && button.getAttribute("aria-pressed") === "true"),
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  })`);
}

async function selectMenuContext(client, expected) {
  await evaluate(client, `(async () => {
    const change = (element, value) => { element.value = value; element.dispatchEvent(new Event("change", {bubbles:true})); };
    const selects = document.querySelectorAll("select");
    if (selects.length < 2) throw new Error("menu selectors unavailable");
    change(selects[0], ${JSON.stringify(expected.hallId)});
    await new Promise((resolve) => setTimeout(resolve, 250));
    change(document.querySelectorAll("select")[1], ${JSON.stringify(expected.mealPeriodId)});
    change(document.querySelector('input[type="date"]'), ${JSON.stringify(expected.serviceDate)});
  })()`, true);
}

async function waitForPageState(client, ready) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await pageState(client);
    if (ready(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("LionLog page did not reach its expected rendered state.");
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out.`)), 20_000)),
  ]);
}

function validateExpectedContext(value) {
  if (
    value?.contextVersion !== "lionlog.pages-browser-context.v1"
    || !/^[a-f0-9]{64}$/.test(value.releaseId ?? "")
    || !/^[a-f0-9]{40}$/.test(value.shellRevision ?? "")
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.serviceDate ?? "")
    || typeof value.hallId !== "string" || typeof value.mealPeriodId !== "string"
    || !Number.isSafeInteger(value.expectedItemCount) || value.expectedItemCount < 1
    || typeof value.expectedFirstFoodName !== "string" || value.expectedFirstFoodName.length < 1
  ) throw new Error("Browser verification context is invalid or empty.");
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await verify();
