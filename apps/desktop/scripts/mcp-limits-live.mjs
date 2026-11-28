/**
 * Live check that Realm puts no limits of its own on an MCP server (run with:
 * node apps/desktop/scripts/mcp-limits-live.mjs; `pnpm build` first). The BUILT app on a scratch
 * home and a scratch HOME, quiet, with the fake agent as the only engine, so nothing is billed.
 * `mcp/fixtures/limits-stdio.mjs` stands in for every server:
 *
 *   - "starting" waits nine seconds before it speaks, like a first `npx -y` run: Test says it is still
 *     starting, then reaches it; a second Test is cancelled;
 *   - "slow" works for 75 s, past the old one-minute cut-off, and its answer lands;
 *   - "many" has 300 tools, and the agent's tools/list carries every one;
 *   - a server with the longest name Realm takes, and a tool whose full name would pass Claude's 128
 *     characters, is listed short and still reached;
 *   - "flaky" fails to start three times, the circuit opens, and after the cool-off it is back.
 *
 * Each state is pictured, dark and light, to LIVE_OUT_DIR as `<step>-<mode>.png`.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { launchLiveApp, repoRoot, sleep, until } from "./lib/live-app.mjs";

const OUT_DIR = process.env.LIVE_OUT_DIR ?? path.resolve(process.cwd(), ".verify/mcp-limits");
const FIXTURE = path.join(repoRoot, "apps/server/src/mcp/fixtures/limits-stdio.mjs");
const LONG_SERVER = `wide_${"s".repeat(101)}`;
const LONG_TOOL = "long_".padEnd(60, "x");
/** `gatewayToolName` in apps/server's mcp/gateway.ts, for the name the agent is shown. */
const shortName = (server, tool) => {
  const full = `${server}__${tool}`;
  if (full.length <= 116) return full;
  const hash = createHash("sha256").update(tool).digest("hex").slice(0, 8);
  return `${full.slice(0, 116 - hash.length - 1)}_${hash}`;
};

const SCRIPT = [
  { on: "list every tool", emit: [{ kind: "list" }] },
  { on: "run the slow tool", emit: [{ kind: "call", tool: "slow__slow", input: { seconds: 75 } }] },
  { on: "call the long-named tool", emit: [{ kind: "call", tool: shortName(LONG_SERVER, LONG_TOOL), input: {} }] },
];

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  return {
    ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "realm-mcp-limits-home-"));
const scriptFile = path.join(OUT_DIR, "fake-script.json");
fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
// Fails to start three times, then serves: a counter beside the script.
const flaky = path.join(scratchHome, "flaky.mjs");
fs.writeFileSync(flaky, [
  'import fs from "node:fs";',
  `const f = ${JSON.stringify(path.join(scratchHome, "flaky-count"))};`,
  'const n = Number(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : 0) + 1; fs.writeFileSync(f, String(n));',
  `if (n <= 3) process.exit(1); await import(${JSON.stringify(FIXTURE)});`,
].join("\n"));

const app = await launchLiveApp({
  name: "mcp-limits", inspect: true,
  env: { HOME: scratchHome, REALM_FAKE_STANDS_IN: "claude,codex", REALM_LIVE_SCRATCH: "1", REALM_FAKE_SCRIPT: scriptFile },
  args: ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
});
let api = null;
try {
  const page = app.page;
  const ev = (expr) => page.eval(expr);
  const js = JSON.stringify;
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await app.main.eval(`(() => { const w = require("electron").BrowserWindow.getAllWindows()[0]; w.setContentSize(1280, 860); return true; })()`);
  const awake = () => ev(`(() => { document.documentElement.removeAttribute("data-window-inactive"); return true; })()`);

  /** `target` is an expression for the element to frame, or nothing for the whole window. */
  async function shots(step, target) {
    for (const mode of ["dark", "light"]) {
      await ev(`(() => { document.documentElement.dataset.mode = ${js(mode)}; return true; })()`);
      await awake();
      await sleep(400);
      await ev(`(() => { const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = "none"; return true; })()`);
      const clip = target ? await ev(`(() => { const el = ${target}; if (!el) return null;
        el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect();
        return { x: Math.max(0, r.left - 16), y: Math.max(0, r.top - 16), width: r.width + 32, height: r.height + 32, scale: 1 }; })()`) : null;
      const shot = await page.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip } : {}) });
      await ev(`(() => { const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = ""; return true; })()`);
      // The capture keeps the DOM's alpha and none of the window's material: lay it on the page colour.
      const data = await ev(`(async () => {
        const img = new Image(); img.src = "data:image/png;base64," + ${js(shot.data)}; await img.decode();
        const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d");
        g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim(); g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(img, 0, 0); return cv.toDataURL("image/png").split(",")[1]; })()`);
      const file = path.join(OUT_DIR, `${step}-${mode}.png`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`SHOT ${file}`);
    }
    await ev(`(() => { document.documentElement.dataset.mode = "dark"; return true; })()`);
  }

  await until(() => ev(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await ev(`(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm"); input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => ev(`!!document.querySelector('.composer')`), 30_000, "composer");
  api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  const [first] = await until(async () => { const all = await api.call("sessions.listAllFull", {}); return all.length ? all : null; }, 15_000, "onboarding session");
  await api.call("sessions.setAgent", { id: first.id, agentKind: "fake" });
  const spaceId = first.spaceId;

  const add = async (name, env, command = process.execPath, args = [FIXTURE]) => {
    const row = await api.call("mcp.add", { spaceId, name, transport: "stdio", command, args, env });
    await api.call("mcp.setEnabled", { spaceId, id: row.id, enabled: true });
    return row;
  };
  await add("starting", { LIMITS_START_MS: "9000" });
  await add("slow", {});
  await add("many", { LIMITS_TOOLS: "300" });
  await add(LONG_SERVER, { LIMITS_NAME_LENGTH: String(LONG_TOOL.length) });
  const flakyRow = await add("flaky", {}, process.execPath, [flaky]);

  // ── Connections: Test on a server still starting, then reached ────────────────────────────────
  await ev(`(() => { [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Connections" || b.title?.startsWith("Connections")).click(); return true; })()`);
  await until(() => ev(`(() => { const r = document.querySelector('input[type=radio][name^="connections-tab"][value="servers"]'); if (!r) return null; r.click(); return true; })()`), 10_000, "the MCP servers tab");
  await until(() => ev(`[...document.querySelectorAll(".mcp-row")].some((r) => r.getClientRects().length > 0 && r.querySelector(".env-name")?.textContent === "starting")`), 15_000, "the starting row");
  // The visible row: a space page can hold a hidden copy of the same list.
  const rowOf = (name) => `[...document.querySelectorAll(".mcp-row")].find((r) => r.getClientRects().length > 0 && r.querySelector(".env-name")?.textContent === ${js(name)})`;
  const press = (name, label) => ev(`(() => { const b = [...${rowOf(name)}.querySelectorAll("button")].find((x) => x.textContent === ${js(label)}); b.click(); return true; })()`);
  const testText = (name) => ev(`${rowOf(name)}.querySelector(".mcp-test")?.textContent ?? null`);
  await press("starting", "Test");
  await until(async () => (await testText("starting"))?.startsWith("Still starting"), 8_000, "still starting");
  check("a server still starting after four seconds says so, with Cancel in place of Test",
    await ev(`[...${rowOf("starting")}.querySelectorAll("button")].some((b) => b.textContent === "Cancel")`), await testText("starting"));
  await shots("1-still-starting", rowOf("starting"));
  await until(async () => (await testText("starting"))?.startsWith("reached"), 20_000, "reached");
  check("…and is reached when it speaks, nine seconds in — the old five-second test called it broken", true, await testText("starting"));
  await shots("2-reached-after-start", rowOf("starting"));
  await press("starting", "Test");
  await until(async () => (await testText("starting"))?.startsWith("Still starting"), 8_000, "still starting again");
  await press("starting", "Cancel");
  await until(async () => (await testText("starting")) === "cancelled before the server answered", 5_000, "cancelled");
  check("a test can be cancelled while the server is still starting", true, await testText("starting"));
  await shots("3-cancelled", rowOf("starting"));

  // ── The circuit: three failed starts open it, and it closes by itself ─────────────────────────
  for (let i = 0; i < 3; i++) await api.call("mcp.tools.list", { id: flakyRow.id });
  const statusOf = async (id) => (await api.call("mcp.list", { spaceId })).servers.find((s) => s.id === id)?.status;
  await until(async () => (await statusOf(flakyRow.id)) === "circuit_open", 10_000, "circuit open");
  await until(() => ev(`${rowOf("flaky")}.querySelector(".mcp-circuit") !== null`), 5_000, "the circuit copy");
  check("three failed starts open the circuit", (await statusOf(flakyRow.id)) === "circuit_open");
  await shots("4-circuit-open", rowOf("flaky"));
  const opened = Date.now();
  await until(async () => (await statusOf(flakyRow.id)) === "connected", 45_000, "the circuit to close by itself");
  check("…and closes by itself after the cool-off, with no Retry pressed", true, { seconds: Math.round((Date.now() - opened) / 1000) });
  await until(() => ev(`${rowOf("flaky")}.querySelector(".mcp-state")?.textContent === "Connected"`), 5_000, "Connected on the row");
  await shots("5-circuit-recovered", rowOf("flaky"));

  // ── The agent's side: 300 tools, a long name, a call past a minute ────────────────────────────
  const { session } = await api.call("sessions.create", { spaceId, agentKind: "fake", title: "Limits", permissionMode: "bypassPermissions" });
  const send = (text) => api.call("sessions.send", { id: session.id, text, attachments: [], mentions: [] });
  const said = async () => (await api.call("sessions.events", { id: session.id })).map((e) => e.event);
  await until(() => ev(`(() => { const row = [...document.querySelectorAll('.item-list .item-row')].find((b) => b.textContent.includes("Limits")); if (!row) return null; row.click(); return true; })()`), 20_000, "the Limits row");
  await sleep(800);

  await send("list every tool");
  const listed = await until(async () => (await said()).filter((e) => e.type === "assistant_text").map((e) => e.payload.text).find((t) => t.startsWith("tools/list:")), 30_000, "the tool list");
  const names = listed.slice("tools/list: ".length).split("\n")[0].split(", ");
  check("all 300 of one server's tools reach the agent", names.filter((n) => /^many__tool_\d{3}$/.test(n)).length === 300);
  const longName = shortName(LONG_SERVER, LONG_TOOL);
  check("a tool whose full name would pass Claude's 128 characters is listed short enough", names.includes(longName) && `mcp__realm__${longName}`.length <= 128, { length: `mcp__realm__${longName}`.length });
  check("every name the agent is shown fits Claude's 128", names.every((n) => `mcp__realm__${n}`.length <= 128));

  await send("call the long-named tool");
  const longAnswer = await until(async () => (await said()).filter((e) => e.type === "tool_result").at(-1)?.payload, 30_000, "the long tool's answer");
  check("…and the short name still reaches the server's tool", longAnswer.content === `${LONG_TOOL} ran` && !longAnswer.isError, longAnswer);

  const callStarted = Date.now();
  await send("run the slow tool");
  await until(async () => (await said()).filter((e) => e.type === "tool_call").length === 2, 15_000, "the slow call");
  await sleep(62_000);
  check("a minute in, the slow call is still running — no 60 s cut-off", (await said()).filter((e) => e.type === "tool_result").length === 1);
  await shots("6-slow-call-running");
  const slowAnswer = await until(async () => { const r = (await said()).filter((e) => e.type === "tool_result"); return r.length === 2 ? r[1].payload : null; }, 40_000, "the slow call's answer");
  check("the slow call answers after 75 s, as the server said", slowAnswer.content.startsWith("slow answered after 75s") && !slowAnswer.isError, { content: slowAnswer.content, seconds: Math.round((Date.now() - callStarted) / 1000) });
  await sleep(800);
  await shots("7-slow-call-answered");
} finally {
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  await app.stop();
  fs.rmSync(scratchHome, { recursive: true, force: true });
}
