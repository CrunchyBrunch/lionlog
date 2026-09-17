import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXPECTED_URL = "https://crunchybrunch.github.io/lionlog/";

export function assertPageState(state, { offline = false } = {}) {
  if (state.url !== EXPECTED_URL) throw new Error(`Browser reached an unexpected URL: ${state.url}`);
  if (state.title !== "Build a meal | LionLog") throw new Error("LionLog document title is missing.");
  if (!state.text.includes("LionLog")) throw new Error("LionLog application content is missing.");
  if (state.scrollWidth > state.clientWidth) throw new Error(`Mobile viewport overflows horizontally (${state.scrollWidth} > ${state.clientWidth}).`);
  if (!offline) {
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
    const online = await waitForPageState(client, (state) => state.text.includes("Retrieved"));
    assertPageState(online);
    assertNoBrowserDiagnostics(diagnostics);

    await client.command("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await reload(client);
    const offline = await waitForPageState(client, (state) => state.text.includes("LionLog"));
    assertPageState(offline, { offline: true });
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
  return evaluate(client, `({url: location.href, title: document.title, text: document.body.innerText, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth})`);
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await verify();
