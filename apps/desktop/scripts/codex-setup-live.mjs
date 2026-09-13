/** Rendered Codex setup validation against the built Electron app and a scratch Realm/Codex home. */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const out = path.join(repo, ".validation", "codex-setup-ui");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "RealmCodexSetupLive."));
const cdpPort = Number(process.env.LIVE_CDP_PORT ?? 9336);
const serverPort = Number(process.env.LIVE_SERVER_PORT ?? 8902);
const codexHome = path.join(scratch, "codex");
const userHome = path.join(scratch, "user");
let electron;
const electronOutput = [];

fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(userHome, { recursive: true });
fs.writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bounded = (promise, timeoutMs, name) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`timeout: ${name}`)), timeoutMs);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const phaseLog = path.join(out, "phases.log");
fs.writeFileSync(phaseLog, "");
const phase = (name) => { fs.appendFileSync(phaseLog, `${new Date().toISOString()} ${name}\n`); console.log(`PHASE ${name}`); };
async function portFree(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => resolve(true));
  });
}
async function until(work, timeoutMs, name) {
  const started = Date.now();
  for (;;) {
    const result = await work();
    if (result) return result;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${name}`);
    await wait(150);
  }
}

function controller(port) {
  const socket = connect({ host: "127.0.0.1", port });
  let nextId = 0;
  let buffer = "";
  const pending = new Map();
  const ready = bounded(new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  }), 30_000, "Electron controller");
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending.get(message.id)?.(message);
    }
  });
  return {
    ready,
    consoleErrors: [],
    send(method, params = {}) {
      return bounded(new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, (message) => message.error ? reject(new Error(message.error)) : resolve(message.result));
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      }), 70_000, `Electron ${method}`);
    },
    close: () => socket.destroy(),
  };
}

function rpc(port) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  let nextId = 0;
  const pending = new Map();
  const ready = new Promise((resolve) => socket.addEventListener("open", resolve));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  return {
    ready: bounded(ready, 10_000, "RPC socket"),
    call(method, params) {
      return bounded(new Promise((resolve, reject) => {
        const id = String(++nextId);
        pending.set(id, (message) => message.ok ? resolve(message.result) : reject(new Error(`${method}: ${message.error?.message}`)));
        socket.send(JSON.stringify({ id, method, params }));
      }), 30_000, `RPC ${method}`);
    },
    close: () => socket.close(),
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

const setValue = (selector, value) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return false;
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;
const clickText = (selector, text) => `(() => {
  const element = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => node.textContent.trim() === ${JSON.stringify(text)});
  if (!element) return false;
  element.click();
  return true;
})()`;

const artifacts = [];
const checks = [];
async function capture(cdp, state) {
  for (const mode of ["light", "dark"]) {
    await evaluate(cdp, `document.documentElement.setAttribute("data-mode", ${JSON.stringify(mode)}); true`);
    for (const [size, width, height] of [["narrow", 900, 700], ["standard", 1280, 820]]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await evaluate(cdp, `document.querySelector('[role="status"]')?.scrollIntoView({ block: "center" }); true`);
      const geometry = await evaluate(cdp, `(() => {
        const panel = document.querySelector('.codex-setup-panel');
        const rect = panel?.getBoundingClientRect();
        return {
          mode: document.documentElement.dataset.mode,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          panel: rect ? { left: rect.left, right: rect.right, width: rect.width, height: rect.height } : null,
          fonts: document.fonts.status,
          controls: [...document.querySelectorAll('.codex-setup-panel button, .codex-setup-panel input, .codex-setup-panel select, .codex-setup-panel textarea')]
            .every((element) => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0),
        };
      })()`);
      const ok = geometry.mode === mode && geometry.overflow <= 0 && geometry.panel?.left >= 0 && geometry.panel?.right <= width && geometry.panel?.width > 300 && geometry.fonts === "loaded" && geometry.controls;
      checks.push({ state, mode, size, ok, geometry });
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const file = path.join(out, `${state}-${mode}-${size}.png`);
      fs.writeFileSync(file, Buffer.from(screenshot.data, "base64"));
      artifacts.push({ path: path.relative(repo, file), state, mode, viewport: { width, height }, bytes: fs.statSync(file).size });
    }
  }
}

async function main() {
  if (!(await portFree(cdpPort)) || !(await portFree(serverPort))) throw new Error("live validation port already in use");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app, BrowserWindow, safeStorage } from "electron";',
    'import { createServer } from "node:net";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    '// Scratch validation must not touch the macOS login Keychain.',
    'safeStorage.isEncryptionAvailable = () => false;',
    'await import(process.env.LIVE_MAIN);',
    'const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));',
    'const windowFor = async () => { let win; for (let i = 0; i < 600 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; if (!win) await wait(100); } if (!win) throw new Error("Realm window did not open"); return win; };',
    'const server = createServer((socket) => {',
    '  let buffer = "";',
    '  socket.on("data", async (chunk) => {',
    '    buffer += chunk.toString();',
    '    for (;;) {',
    '      const newline = buffer.indexOf("\\n"); if (newline < 0) break;',
    '      const request = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);',
    '      try {',
    '        const win = await windowFor(); let result = {};',
    '        if (request.method === "Runtime.evaluate") result = { result: { value: await win.webContents.executeJavaScript(request.params.expression, true) } };',
    '        else if (request.method === "Emulation.setDeviceMetricsOverride") { win.setContentSize(request.params.width, request.params.height); await wait(80); }',
    '        else if (request.method === "Page.captureScreenshot") result = { data: (await win.webContents.capturePage()).toPNG().toString("base64") };',
    '        socket.write(JSON.stringify({ id: request.id, result }) + "\\n");',
    '      } catch (error) { socket.write(JSON.stringify({ id: request.id, error: error.message }) + "\\n"); }',
    '    }',
    '  });',
    '});',
    'server.listen(Number(process.env.LIVE_CONTROLLER_PORT), "127.0.0.1");',
  ].join("\n"));
  const electronBin = process.platform === "darwin"
    ? path.join(repo, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repo, "apps/desktop/node_modules/.bin/electron");
  electron = spawn(electronBin, [wrapper], {
    env: {
      ...process.env,
      HOME: userHome,
      CODEX_HOME: codexHome,
      REALM_HOME: path.join(scratch, "realm"),
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(serverPort),
      LIVE_CONTROLLER_PORT: String(cdpPort),
      REALM_SERVER_ENTRY: path.join(repo, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "electron"),
      LIVE_MAIN: path.join(repo, "apps/desktop/out/main/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.on("error", (error) => electronOutput.push(error.stack ?? error.message));
  electron.stdout.on("data", (chunk) => electronOutput.push(chunk.toString()));
  electron.stderr.on("data", (chunk) => electronOutput.push(chunk.toString()));

  await until(async () => !(await portFree(cdpPort)), 30_000, "Electron controller");
  const cdp = controller(cdpPort);
  await cdp.ready;
  phase("Electron controller ready");
  await until(async () => !(await portFree(serverPort)), 30_000, "Realm server");
  const api = rpc(serverPort);
  await api.ready;
  phase("RPC ready");

  await until(() => evaluate(cdp, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20_000, "onboarding");
  phase("onboarding");
  await evaluate(cdp, `(() => { const input = document.querySelector('.onboarding input:not([type=radio])'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Validation"); input.dispatchEvent(new Event("input", { bubbles: true })); input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evaluate(cdp, `!!document.querySelector('.composer')`), 20_000, "initial space");
  await evaluate(cdp, clickText("button", "Settings"));
  await until(() => evaluate(cdp, `!!document.querySelector('.settings-page-pane')`), 10_000, "Settings page");
  await evaluate(cdp, `document.querySelector('input[value="codex"]').click(); true`);
  await until(() => evaluate(cdp, `!!document.querySelector('.codex-setup-panel')`), 10_000, "Codex setup panel");
  phase("panel");

  await capture(cdp, "empty");
  phase("empty captured");
  await evaluate(cdp, setValue(".codex-setup-panel textarea", "relative/path"));
  await evaluate(cdp, clickText("button", "Preview Codex setup"));
  await until(() => evaluate(cdp, `document.querySelector('[role="status"]')?.textContent.includes("could not be inspected")`), 20_000, "error state");
  await capture(cdp, "error");
  phase("error captured");

  await evaluate(cdp, setValue(".codex-setup-panel textarea", ""));
  await evaluate(cdp, clickText("button", "Preview Codex setup"));
  await until(() => evaluate(cdp, `!!document.querySelector('.codex-setup-panel .import-sources')`), 30_000, "preview state");
  await capture(cdp, "preview");
  phase("preview captured");

  fs.appendFileSync(path.join(codexHome, "config.toml"), '\nmodel_reasoning_effort = "high"\n');
  await evaluate(cdp, clickText("button", "Connect setup"));
  await until(() => evaluate(cdp, `document.querySelector('[role="status"]')?.textContent.includes("changed after preview")`), 30_000, "stale preview state");
  await capture(cdp, "stale-preview");
  phase("stale captured");

  if (!await evaluate(cdp, clickText("button", "Scan again"))) throw new Error("Scan again button missing after stale preview");
  await until(() => evaluate(cdp, `(() => {
    const buttons = [...document.querySelectorAll('.codex-setup-panel button')];
    const scan = buttons.find((button) => button.textContent.trim() === 'Scan again');
    const connect = buttons.find((button) => button.textContent.trim() === 'Connect setup');
    const status = document.querySelector('[role="status"]')?.textContent ?? '';
    return !status.includes('changed after preview') && !!scan && !scan.disabled && !!connect && !connect.disabled;
  })()`), 30_000, "fresh preview");
  await evaluate(cdp, clickText("button", "Connect setup"));
  try {
    await until(() => evaluate(cdp, `document.querySelector('[role="status"]')?.textContent.includes("Codex setup connected")`), 30_000, "connected state");
  } catch (error) {
    const ui = await evaluate(cdp, `({
      status: document.querySelector('[role="status"]')?.textContent ?? null,
      buttons: [...document.querySelectorAll('.codex-setup-panel button')].map((button) => ({ text: button.textContent.trim(), disabled: button.disabled })),
    })`);
    throw new Error(`${error.message}: ${JSON.stringify(ui)}`);
  }
  await capture(cdp, "connected");
  phase("connected captured");

  const [profile] = await api.call("profiles.list", {});
  const scan = await api.call("codexSetup.scan", { cwd: repo, codexHome, extraSkillRoots: [] });
  await api.call("codexSetup.apply", { profileId: profile.id, scan: { cwd: scan.cwd, codexHome, extraSkillRoots: [], fingerprint: scan.fingerprint }, overrides: { model: "conflicting-model" } });
  await evaluate(cdp, clickText("button", "Disconnect"));
  await until(() => evaluate(cdp, `document.querySelector('[role="status"]')?.textContent.includes("changed later")`), 20_000, "disconnect conflict state");
  await capture(cdp, "rollback-conflict");
  phase("conflict captured");

  const relevantErrors = cdp.consoleErrors.filter((message) => !message.includes("Autofill"));
  if (relevantErrors.length) throw new Error(`renderer console errors: ${relevantErrors.slice(0, 3).join(" | ")}`);
  if (checks.some((check) => !check.ok)) throw new Error(`render checks failed: ${JSON.stringify(checks.filter((check) => !check.ok))}`);
  if (artifacts.some((artifact) => artifact.bytes < 10_000)) throw new Error("one or more screenshots are empty");
  fs.writeFileSync(path.join(out, "live.json"), JSON.stringify({ status: "passed", checks, artifacts }, null, 2));
  api.close();
  cdp.close();
  console.log(JSON.stringify({ status: "passed", screenshots: artifacts.length, states: [...new Set(artifacts.map((artifact) => artifact.state))] }));
}

main().catch((error) => {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "live.json"), JSON.stringify({ status: "failed", error: error.message, processOutput: electronOutput.slice(-20), checks, artifacts }, null, 2));
  console.error(error.stack ?? error.message, electronOutput.slice(-10).join(""));
  process.exitCode = 1;
}).finally(() => {
  electron?.kill();
  fs.rmSync(scratch, { recursive: true, force: true });
});
