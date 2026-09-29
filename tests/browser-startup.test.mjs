import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createLaunchDiagnostics, waitForBrowserSpawn, waitForEndpoint } from "../scripts/verify-public-pwa.mjs";

const running = { pid: 123, exitCode: null, signalCode: null, spawnfile: "/browser/chrome" };
const ready = (url) => new Response(JSON.stringify(url.endsWith("/list")
  ? [{ type: "page", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1/page" }]
  : { webSocketDebuggerUrl: "ws://127.0.0.1/browser" }));

test("quoted credentials never reach retained diagnostics or startup errors across chunk boundaries", async () => {
  for (const record of [
    '{"token":"SYNTHETIC_SECRET words"}',
    "{'password': 'SYNTHETIC_SECRET words'}",
    '{"Authorization":"Bearer SYNTHETIC_SECRET"}',
    'URL https://example.test/?token="SYNTHETIC_SECRET words"',
    'api-key="SYNTHETIC_SECRET words"',
  ]) {
    for (let split = 0; split <= record.length; split += 1) {
      const diagnostics = createLaunchDiagnostics();
      diagnostics.append(record.slice(0, split));
      diagnostics.append(record.slice(split));
      assert.doesNotMatch(diagnostics.read(), /SYNTHETIC_SECRET/);
      diagnostics.append("\n");
      await assert.rejects(waitForEndpoint(1, { ...running, exitCode: 1 }, () => diagnostics.read()), (error) => {
        assert.equal(error.code, "BROWSER_STARTUP_FAILED");
        assert.doesNotMatch(error.message, /SYNTHETIC_SECRET/);
        return true;
      });
    }
    const diagnostics = createLaunchDiagnostics();
    for (const character of record + "\n") diagnostics.append(character);
    assert.doesNotMatch(diagnostics.read(), /SYNTHETIC_SECRET/);
  }
});

test("a real synchronous Windows spawn failure closes servers and removes its profile", { skip: process.platform !== "win32", timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lionlog-invalid-launch-"));
  try {
    const executable = path.join(directory, "invalid.exe");
    await writeFile(executable, "This is a synthetic invalid executable.\n");
    const verifier = new URL("../scripts/verify-public-pwa.mjs", import.meta.url).href;
    const script = `import { verifyBrowserSession } from ${JSON.stringify(verifier)};
      try { await verifyBrowserSession({ targetUrl: 'http://127.0.0.1:1/', chromeBin: ${JSON.stringify(executable)},
        expected: { contextVersion: 'lionlog.pages-browser-context.v1', releaseId: 'b'.repeat(64), shellRevision: 'a'.repeat(40),
          serviceDate: '2026-08-31', hallId: 'psu:campus:11', mealPeriodId: 'lunch', expectedItemCount: 2, expectedFirstFoodName: 'Fixture' } });
      } catch (error) { console.log(JSON.stringify({ code: error.code, reason: error.startup?.reason, spawnError: error.startup?.spawnError })); }`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      env: { ...process.env, TEMP: directory, TMP: directory }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.resume();
    let forced = false;
    const timer = setTimeout(() => { forced = true; child.kill(); }, 5_000);
    let exitCode;
    try { exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }); }
    finally { clearTimeout(timer); }
    assert.equal(forced, false, "verifier must exit naturally without listening servers");
    assert.equal(exitCode, 0);
    assert.deepEqual(JSON.parse(stdout), { code: "BROWSER_STARTUP_FAILED", reason: "spawn-error", spawnError: "UNKNOWN" });
    assert.deepEqual((await readdir(directory)).filter((name) => name.startsWith("lionlog-pages-chrome-")), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnostics redact split records and drop oversized records before tail retention", () => {
  const diagnostics = createLaunchDiagnostics("/private/profile");
  diagnostics.append("Authoriz");
  diagnostics.append("ation: Bearer ");
  diagnostics.append("s".repeat(2_100));
  diagnostics.append("more-secret\nChrome sandbox failed\n");
  diagnostics.append("token=\"two ");
  diagnostics.append("secret words\"\n");
  diagnostics.append("DevTools listening on ws://private.example/secret\n/private/profile\n");
  assert.match(diagnostics.read(), /Chrome sandbox failed/);
  assert.doesNotMatch(diagnostics.read(), /sss|more-secret|secret words|private/);
  assert.ok(diagnostics.read().length <= 2_000);
});

test("a real failed spawn is classified without an unhandled process error", async () => {
  const executable = `${process.execPath}.does-not-exist`;
  const child = spawn(executable, [], { stdio: "ignore" });
  await assert.rejects(waitForBrowserSpawn(child, executable), (error) => {
    assert.equal(error.code, "BROWSER_STARTUP_FAILED");
    assert.equal(error.startup.spawnError, "ENOENT");
    assert.equal(error.startup.reason, "spawn-error");
    return true;
  });
});

test("startup failure reports exit state and redacted diagnostics, not an application failure", async () => {
  await assert.rejects(waitForEndpoint(1, { ...running, exitCode: 7 },
    () => "sandbox failed\nhttps://user:secret@example.test/?token=secret token=hidden", {
      timeoutMs: 100, fetchEndpoint: async () => { throw new Error("connection refused"); },
    }), (error) => {
    assert.equal(error.code, "BROWSER_STARTUP_FAILED");
    assert.equal(error.startup.reason, "process-exit");
    assert.equal(error.startup.exitCode, 7);
    assert.equal(error.startup.executable, "/browser/chrome");
    assert.match(error.message, /sandbox failed/);
    assert.doesNotMatch(error.message, /secret|hidden/);
    return true;
  });
});

test("startup accepts a delayed endpoint beyond the former ten-second budget without relaunch", async () => {
  let elapsed = 0;
  let probes = 0;
  const endpoint = await waitForEndpoint(1234, { ...running, exitCode: 0 }, () => "", {
    now: () => elapsed,
    pause: async (ms) => { elapsed += ms; },
    fetchEndpoint: async (url) => {
      probes += 1;
      if (elapsed < 11_000) throw new Error("not listening yet");
      return ready(url);
    },
  });
  assert.equal(endpoint.page.url, "about:blank");
  assert.equal(endpoint.startup.outcome, "delayed-ready");
  assert.ok(endpoint.startup.elapsedMs >= 11_000);
  assert.ok(probes > 100);
});

test("signal and spawn errors fail as startup errors without waiting the full budget", async () => {
  for (const [chrome, launchError, reason] of [
    [{ ...running, signalCode: "SIGTERM" }, undefined, "process-exit"],
    [running, { code: "ENOENT" }, "spawn-error"],
  ]) {
    await assert.rejects(waitForEndpoint(1234, chrome, () => "", {
      getLaunchError: () => launchError,
      fetchEndpoint: async () => { throw new Error("refused"); },
    }), (error) => error.code === "BROWSER_STARTUP_FAILED" && error.startup.reason === reason);
  }
});

test("startup validates HTTP/JSON readiness and reports the last failed probe", async () => {
  for (const [response, expected] of [
    [() => new Response("private body", { status: 503 }), "http-503"],
    [() => new Response("not JSON"), "invalid-json"],
    [() => new Response("{}"), "missing-targets"],
  ]) {
    let elapsed = 0;
    await assert.rejects(waitForEndpoint(1234, running, () => "", {
      timeoutMs: 200, now: () => elapsed, pause: async (ms) => { elapsed += ms; },
      fetchEndpoint: async () => response(),
    }), (error) => {
      assert.equal(error.startup.reason, "timeout");
      assert.equal(error.startup.lastProbe, expected);
      assert.doesNotMatch(error.message, /private body|not JSON/);
      return true;
    });
  }
});

test("startup bounds stalled HTTP headers and bodies", { timeout: 5_000 }, async () => {
  for (const sendHeaders of [false, true]) {
    const server = createServer((_request, response) => {
      if (sendHeaders) { response.writeHead(200); response.write("{"); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const started = performance.now();
    try {
      await assert.rejects(waitForEndpoint(server.address().port, running, () => "", {
        timeoutMs: 300, probeTimeoutMs: 80,
      }), (error) => {
        assert.equal(error.code, "BROWSER_STARTUP_FAILED");
        assert.equal(error.startup.reason, "timeout");
        assert.equal(error.startup.lastProbe, "probe-timeout");
        return true;
      });
      assert.ok(performance.now() - started < 1_500);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});
