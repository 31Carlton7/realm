/**
 * Live check: a tool call's row, its states, its opened panel, and the head of a folded run
 * (run with: pnpm build && node apps/desktop/scripts/tool-card-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME. One session is seeded straight into the scratch DB
 * with a call of every kind — a command, an edit with its diff, a read, a search, a fetch, two MCP
 * calls, a failure with a stated exit code and one without, a sub-agent's line, a call the turn was
 * stopped on, a long run with a failure in it, and a run the turn ended on with a failure. A second
 * session runs the scripted agent's "Build the dark-mode toggle" turn, which stops on a permission,
 * for the row that is waiting on the person. Every state is captured in both faces, at the normal
 * width and with the pane narrowed, and the geometry the design rests on is measured.
 *
 * Ports: LIVE_SERVER_PORT (8798), LIVE_CDP_PORT (9238). Writes only under LIVE_SCRATCH (the OS temp
 * dir by default); LIVE_OUT keeps the captures. Nothing is billed: every session runs the fake agent.
 */
import { execFileSync, spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9238);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8798);
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-tool-card-live-"));
const home = path.join(scratch, "home");
const OUTDIR = process.env.LIVE_OUT ?? path.join(scratch, "shots");
fs.mkdirSync(OUTDIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let electron = null;
let api = null;

const note = (name, detail) => console.log(`INFO ${name} ${JSON.stringify(detail)}`);
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function portFree(port) {
  return new Promise((resolve) => {
    const s = connect({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(true));
  });
}

async function until(fn, ms, tag) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout:${tag}`);
    await sleep(150);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails?.exception?.description ?? "exception");
  });
  return {
    ready, errors,
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

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

const SEEDED = "Show me every kind of call";
const LIVE = "Build the dark-mode toggle in Settings";

const HELPERS = `
globalThis.__live = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), r: Math.round(r.right) }; },
  centre(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + Math.min(r.width / 2, 40)), y: Math.round(r.top + r.height / 2) }; },
  pane: (asked) => [...document.querySelectorAll(".session-pane")].find((p) => [...p.querySelectorAll(".msg-user")].some((m) => m.textContent.includes(asked))) ?? null,
  card: (id) => document.querySelector('.tool-card[data-tool-use-id="' + id + '"]'),
  async show(el) { el?.scrollIntoView({ block: "center" }); await new Promise((r) => setTimeout(r, 350)); return __live.box(el); },
  /** A CSS colour of any syntax (oklch, color-mix) as sRGB bytes, by painting it. */
  rgb(css) { const cv = document.createElement("canvas"); cv.width = cv.height = 1; const x = cv.getContext("2d", { willReadFrequently: true });
    x.clearRect(0, 0, 1, 1); x.fillStyle = css; x.fillRect(0, 0, 1, 1); const d = x.getImageData(0, 0, 1, 1).data; return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 }; },
  /** WCAG contrast of an element's ink against the pane's ground tokens — the authored grounds, since
   *  a CDP capture has none of the window's material under them. The worst of the two is the claim. */
  contrast(el) {
    const lum = ({ r, g, b }) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const probe = document.createElement("div"); el.parentElement.appendChild(probe);
    const token = (name) => { probe.style.background = "var(" + name + ")"; return __live.rgb(getComputedStyle(probe).backgroundColor); };
    const page = token("--page");
    const grounds = { panel: over(token("--rl-panel"), page), canvas: over(token("--canvas"), page), page };
    probe.remove();
    const ink = __live.rgb(getComputedStyle(el).color);
    const ratio = (g) => { const [a, b] = [lum(over(ink, g)), lum(g)].sort((x, y) => y - x); return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100; };
    const each = Object.fromEntries(Object.entries(grounds).map(([k, g]) => [k, ratio(g)]));
    return { ratio: Math.min(...Object.values(each)), each, ink: getComputedStyle(el).color };
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function shoot(c, tag, clip) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 2 } } : {}) });
  const out = path.join(OUTDIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}
const pad = (b, n = 12) => (b ? { x: Math.max(0, b.x - n), y: Math.max(0, b.y - n), w: b.w + 2 * n, h: b.h + 2 * n } : null);

async function paletteRow(c, label) {
  await evalIn(c, `(() => { if (!document.querySelector(".palette input")) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector(".palette input")`), 5000, "the palette");
  await evalIn(c, `(() => { const input = document.querySelector(".palette input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await until(() => evalIn(c, `(() => { const hit = [...document.querySelectorAll(".palette-list [role=option]")].find((o) => o.textContent.trim().startsWith(${JSON.stringify(label)}));
    if (!hit) return null; hit.click(); return true; })()`), 3000, `palette row ${label}`);
}

function killPort(port) {
  try {
    const pids = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" })
      .split("\n").map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  } catch { /* nothing listening */ }
}

/** Every kind of call, written into the scratch DB with its own stamps. */
function seedCalls(sessionId, cwd) {
  const t0 = Date.now() - 60 * 60_000;
  let t = t0;
  const ev = [];
  const at = (dt = 1_000) => (t += dt);
  const say = (text) => ev.push([at(), "assistant_text", { messageId: `m${ev.length}`, text }]);
  const call = (id, name, input, result, isError = false, dt = 1_000) => {
    ev.push([at(dt), "tool_call", { toolUseId: id, name, input, parentToolUseId: null }]);
    if (result !== null) ev.push([at(dt), "tool_result", { toolUseId: id, content: result, isError }]);
  };
  const p = (rel) => path.join(cwd, rel);
  ev.push([at(), "user_message", { text: SEEDED, attachments: [] }]);
  ev.push([at(), "status", { status: "running" }]);
  say("Running the card's tests first.");
  call("run1", "Bash", { command: "pnpm -C apps/desktop test tool-card", description: "Run the tool card tests" },
    " ✓ src/renderer/src/panes/session/tool-card.test.tsx (62 tests) 1204ms\n\n Test Files  1 passed (1)\n      Tests  62 passed (62)\n   Duration  3.81s");
  say("Now the change itself.");
  call("edit1", "Edit", { file_path: p("web/lib/orgs.ts"), old_string: "const org = await db.org(id);\nreturn org;", new_string: "const org = await db.org(id, { withMembers });\nif (!org) throw new NotFound(id);\nreturn org;" },
    `The file ${p("web/lib/orgs.ts")} has been updated successfully.`);
  say("Reading where it is called.");
  call("read1", "Read", { file_path: p("web/lib/access.ts"), offset: 40, limit: 6 },
    "    40\texport async function canSee(user: User, orgId: string) {\n    41\t  const org = await getOrg(orgId);\n    42\t  if (!org) return false;\n    43\t  return org.members.some((m) => m.id === user.id);\n    44\t}\n    45\t");
  say("Searching for the other callers.");
  call("grep1", "Grep", { pattern: "isDelegationLine", path: "apps/desktop", output_mode: "content", "-n": true },
    "apps/desktop/src/renderer/src/panes/session/tool-group.ts:11:export const isDelegationLine = (b: ToolBlock): boolean => SPAWNS.has(bareToolName(b.name)) && !b.result?.isError;\napps/desktop/src/renderer/src/panes/session/DelegationLine.tsx:10:export { isDelegationLine, isDelegationWait } from \"./tool-group\";\napps/desktop/src/renderer/src/panes/session/ToolCard.tsx:13:import { DelegationLine, DelegationWait, isDelegationLine, isDelegationWait } from \"./DelegationLine\";");
  say("Checking the API's docs.");
  call("fetch1", "WebFetch", { url: "https://docs.anthropic.com/en/api/messages", prompt: "What does the stop_reason field hold?" },
    "stop_reason is one of end_turn, max_tokens, stop_sequence, tool_use, pause_turn or refusal. It says why the model stopped generating.");
  say("Filing the follow-up.");
  call("mcp1", "mcp__linear__save_issue", { team: "REA", title: "Tool card redesign", priority: 2, labels: ["design", "transcript"] },
    JSON.stringify({ id: "REA-412", url: "https://linear.app/realm/issue/REA-412", state: "Todo" }));
  say("Opening the preview.");
  call("mcp2", "mcp__realm__realm-browser__browser_open", { url: "http://localhost:5173/settings", intent: "Look at the settings page after the change" }, "Opened browser b1 on http://localhost:5173/settings");
  say("Typechecking.");
  call("fail1", "Bash", { command: "pnpm typecheck" },
    "Exit code 2\nsrc/main/index.ts(41,7): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/main/index.ts(88,3): error TS2554: Expected 2 arguments, but got 1.", true);
  say("Asking Notion for the spec.");
  call("fail2", "mcp__notion__fetch", { id: "spec-tool-card" }, "Error: The page spec-tool-card could not be found, or the integration has no access to it.", true);
  say("Handing the copy to a sub-agent.");
  call("agent1", "mcp__realm__realm-agent__agent_start", { goal: "Write the release note for the tool card", constraints: { model: "Fable" } }, "Started delegated agent 01JC0000000000000000000009.");
  say("Now the full pass over the transcript.");
  // A long run: reads, edits, searches, commands, and a failure it recovered from.
  call("g1", "Read", { file_path: p("src/panes/session/ToolCard.tsx") }, "     1\timport { Icon } from \"@realm/ui\";\n     2\t", false, 2_000);
  call("g2", "Read", { file_path: p("src/panes/session/tool-group.ts") }, "     1\timport { bareToolName } from \"@realm/contracts\";\n", false, 2_000);
  call("g3", "Grep", { pattern: "tool-group-row", path: "src" }, "src/styles.css:4230:.tool-group-row { display: flex; }", false, 3_000);
  call("g4", "Edit", { file_path: p("src/panes/session/ToolCard.tsx"), old_string: "a\nb\nc", new_string: "a\nB\nc\nd\ne" }, "updated", false, 4_000);
  call("g5", "Edit", { file_path: p("src/styles.css"), old_string: "x\ny", new_string: "x\nY\nz\nw" }, "updated", false, 5_000);
  call("g6", "Bash", { command: "pnpm vitest run tool-card" }, "Exit code 1\nFAIL tool-card.test.tsx > the group head\nAssertionError: expected '2 reads' to be '3 reads'", true, 9_000);
  call("g7", "Edit", { file_path: p("src/panes/session/tool-group.ts"), old_string: "reads++", new_string: "reads += 1" }, "updated", false, 6_000);
  call("g8", "Bash", { command: "pnpm vitest run tool-card" }, " Test Files  1 passed (1)\n      Tests  62 passed (62)", false, 20_000);
  call("g9", "Read", { file_path: p("design.md") }, "     1\t# Design interfaces like Realm\n", false, 2_000);
  say("Starting the dev server, which was stopped.");
  call("stop1", "Bash", { command: "pnpm dev" }, null);
  ev.push([at(), "status", { status: "idle", interrupted: true }]);
  // A second turn that ends on a failure: the run opens itself.
  ev.push([at(60_000), "user_message", { text: "Ship it", attachments: [] }]);
  ev.push([at(), "status", { status: "running" }]);
  call("e1", "Bash", { command: "git status --short" }, " M src/panes/session/ToolCard.tsx", false, 1_000);
  call("e2", "Bash", { command: "pnpm build" }, "Exit code 1\nerror during build:\n[vite]: Rollup failed to resolve import \"@realm/pixel-office\" from \"src/renderer/src/panes/office/Office.tsx\".", true, 12_000);
  ev.push([at(), "status", { status: "idle" }]);
  const q = (s) => `'${String(s).replaceAll("'", "''")}'`;
  const sql = ev.map(([ts, type, payload]) => `INSERT INTO session_events (session_id, ts, type, payload_json) VALUES (${q(sessionId)}, ${ts}, ${q(type)}, ${q(JSON.stringify(payload))});`);
  execFileSync("sqlite3", ["-cmd", ".timeout 5000", path.join(home, "realm.db"), sql.join("\n")]);
}

async function boot() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
  electron = spawn(electronBin, [wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      REALM_HOME: home, REALM_HTML_MENUS: "1",
      REALM_PORT: String(SERVER_PORT), REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      REALM_ENABLE_FAKE_AGENT: "1",
      LIVE_USER_DATA: path.join(scratch, "userData"), LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Tool cards");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

const SHOTS = ["run1", "edit1", "read1", "grep1", "fetch1", "mcp1", "mcp2", "fail1", "fail2", "agent1", "stop1"];

async function capture(c, face, width) {
  const tag = (name) => `${name}-${face}-${width}`;
  await evalIn(c, `(async () => { const p = __live.pane(${JSON.stringify(SEEDED)}); p.querySelector(".transcript").scrollTop = 0; await new Promise((r) => setTimeout(r, 300)); return true; })()`);
  // The column of single calls, collapsed.
  const col = await evalIn(c, `(async () => { const a = __live.card("run1"), b = __live.card("stop1"); await __live.show(a);
    const p = __live.pane(${JSON.stringify(SEEDED)}); p.querySelector(".transcript").scrollTop += __live.box(a).y - 120; await new Promise((r) => setTimeout(r, 300));
    const top = __live.box(a), col = __live.box(p.querySelector(".transcript-col")); return { x: col.x, y: top.y, w: col.w, h: Math.min(860, __live.box(b).b - top.y) }; })()`);
  await shoot(c, tag("rows"), pad(col));
  // Each card on its own, then opened.
  for (const id of ["run1", "edit1", "read1", "grep1", "fetch1", "mcp1", "fail1"]) {
    const box = await evalIn(c, `(async () => { const k = __live.card(${JSON.stringify(id)}); const row = k.querySelector(".tool-row");
      if (row.getAttribute("aria-expanded") !== "true") row.click(); await new Promise((r) => setTimeout(r, 450)); return __live.show(k); })()`);
    await shoot(c, tag(`open-${id}`), pad(box));
  }
  // Show raw on the run.
  const raw = await evalIn(c, `(async () => { const k = __live.card("run1"); const t = k.querySelector(".tool-raw-toggle"); if (t.getAttribute("aria-expanded") !== "true") t.click();
    await new Promise((r) => setTimeout(r, 300)); return __live.show(k); })()`);
  await shoot(c, tag("open-run1-raw"), pad(raw));
  // Close them again.
  await evalIn(c, `(() => { for (const id of ["run1", "edit1", "read1", "grep1", "fetch1", "mcp1", "fail1"]) { const k = __live.card(id); const t = k.querySelector(".tool-raw-toggle");
    if (t?.getAttribute("aria-expanded") === "true") t.click(); const r = k.querySelector(".tool-row"); if (r.getAttribute("aria-expanded") === "true") r.click(); } return true; })()`);
  await sleep(400);
  // The long run, folded, then open.
  const folded = await evalIn(c, `(async () => { const gs = [...__live.pane(${JSON.stringify(SEEDED)}).querySelectorAll(".tool-group")]; const g = gs[0]; await __live.show(g); return __live.box(g); })()`);
  await shoot(c, tag("group-folded"), pad(folded));
  const opened = await evalIn(c, `(async () => { const g = [...__live.pane(${JSON.stringify(SEEDED)}).querySelectorAll(".tool-group")][0]; const r = g.querySelector(".tool-group-row");
    if (r.getAttribute("aria-expanded") !== "true") r.click(); await new Promise((r) => setTimeout(r, 400)); return __live.show(g); })()`);
  await shoot(c, tag("group-open"), pad(opened));
  await evalIn(c, `(() => { const g = [...__live.pane(${JSON.stringify(SEEDED)}).querySelectorAll(".tool-group")][0]; g.querySelector(".tool-group-row").click(); return true; })()`);
  // The run the turn ended on with a failure.
  const ended = await evalIn(c, `(async () => { const g = [...__live.pane(${JSON.stringify(SEEDED)}).querySelectorAll(".tool-group")].pop(); return __live.show(g); })()`);
  await shoot(c, tag("group-ended-on-failure"), pad(ended));
}

async function main() {
  const c = await boot();
  const [first] = await api.call("sessions.listAll", {});
  await api.call("sessions.setAgent", { id: first.id, agentKind: "fake" });
  fs.mkdirSync(first.cwd, { recursive: true });

  // ── The seeded session ──
  const made = await api.call("sessions.create", { spaceId: first.spaceId, agentKind: "fake" });
  const seededId = made.session?.id ?? made.id;
  seedCalls(seededId, first.cwd);
  await api.call("items.update", { id: made.itemId ?? made.item?.id, title: "Every kind of call" }).catch(() => {});
  await sleep(400);
  await evalIn(c, `(() => { const row = [...document.querySelectorAll(".item-row")].find((r) => r.textContent.includes("Every kind of call")); row?.click(); return !!row; })()`);
  await until(() => evalIn(c, `!!__live.pane(${JSON.stringify(SEEDED)})?.querySelector('[data-tool-use-id="stop1"]')`), 20_000, "the seeded session");
  await sleep(600);

  // ── What the rows say ──
  const rows = await evalIn(c, `(() => Object.fromEntries(${JSON.stringify(SHOTS)}.map((id) => { const k = __live.card(id); if (!k) return [id, null];
    return [id, { state: k.dataset.state ?? null, verb: k.querySelector(".tool-row .tool-name")?.textContent ?? null, glyph: k.querySelector(".tool-status [data-glyph]")?.dataset.glyph ?? null,
      object: k.querySelector(".tool-object")?.textContent ?? null, meta: k.querySelector(".tool-meta")?.textContent ?? null, reason: k.querySelector(".tool-reason")?.textContent ?? null,
      title: k.querySelector(".tool-row")?.title ?? null, h: __live.box(k.querySelector(".tool-row")).h, leadX: __live.box(k.querySelector(".tool-status")).x }]; })))()`);
  note("rows", rows);
  check("every call reads as a plain verb with the raw name in its tooltip",
    rows.run1.verb === "Run" && rows.edit1.verb === "Edit" && rows.read1.verb === "Read" && rows.grep1.verb === "Search" && rows.fetch1.verb === "Fetch"
      && rows.mcp1.verb === "Save issue" && rows.mcp2.verb === "Browser open" && rows.mcp1.title === "mcp__linear__save_issue", rows);
  check("a settled call leads with its kind, an MCP call with its vendor's mark", rows.run1.glyph === "terminal" && rows.grep1.glyph === "search"
    && rows.mcp1.glyph === "linear" && rows.mcp2.glyph === "plug" && rows.edit1.glyph === "typescript", rows);
  check("a failure says its stated exit code, or Failed, and its reason under the row",
    rows.fail1.meta === "exit 2" && /^src\/main\/index\.ts\(41,7\): error TS2322/.test(rows.fail1.reason ?? "") && rows.fail2.meta === "Failed" && /could not be found/.test(rows.fail2.reason ?? ""), { fail1: rows.fail1, fail2: rows.fail2 });
  const buildReason = await evalIn(c, `__live.card("e2")?.querySelector(".tool-reason")?.textContent ?? null`);
  check("a failure whose first line only introduces the error runs on into it", /^error during build: \[vite\]: Rollup failed/.test(buildReason ?? ""), buildReason);
  check("a call the turn was stopped on says Stopped", rows.stop1.state === "none" && rows.stop1.meta === "Stopped", rows.stop1);
  const heights = Object.values(rows).filter(Boolean).map((r) => r.h);
  check("every row is 32 tall", heights.every((h) => h === 32), heights);
  const groupHead = await evalIn(c, `(() => [...__live.pane(${JSON.stringify(SEEDED)}).querySelectorAll(".tool-group")].map((g) => ({ open: g.dataset.open !== undefined,
    head: g.querySelector(".tool-group-row").textContent, failed: g.querySelector(".tool-group-failed")?.textContent ?? null })))()`);
  note("groups", groupHead);
  check("a folded run names its work and its failure", /Worked for .+ · 3 reads · 3 edits \+\d+ −\d+ · 1 search · 2 commands/.test(groupHead[0]?.head ?? "") && groupHead[0]?.failed?.includes("1 failed") && !groupHead[0].open, groupHead[0]);
  check("a run the turn ended on with a failure opens itself", groupHead[1]?.open === true && groupHead[1]?.failed?.includes("1 failed"), groupHead[1]);
  // The lead column, for a free row, a step in a run, and a sub-agent's line.
  const lead = await evalIn(c, `(async () => { const g = [...__live.pane(${JSON.stringify(SEEDED)}).querySelectorAll(".tool-group")][0]; g.querySelector(".tool-group-row").click();
    await new Promise((r) => setTimeout(r, 400)); const col = __live.box(__live.pane(${JSON.stringify(SEEDED)}).querySelector(".transcript-col")).x;
    const x = (el) => el ? __live.box(el).x - col : null;
    const out = { card: x(__live.card("run1").querySelector(".tool-status")), step: x(__live.card("g2").querySelector(".tool-status")),
      delegation: x(document.querySelector(".delegation-line .tool-status")), rail: x(g.querySelector(".tool-group-steps")) };
    g.querySelector(".tool-group-row").click(); return out; })()`);
  check("a free row, a step in a run and a sub-agent's line put their lead glyph on one column, the rail 4px left of it",
    lead.card === lead.step && lead.card === lead.delegation && lead.step - (lead.rail + 1) === 4, lead);

  // ── Both faces, both widths ──
  for (const face of ["dark", "light"]) {
    if (face === "light") { await paletteRow(c, "Theme: Light"); await sleep(700); }
    const contrast = await evalIn(c, `(() => ({ danger: __live.contrast(__live.card("fail1").querySelector(".tool-meta")), reason: __live.contrast(__live.card("fail1").querySelector(".tool-reason")),
      stopped: __live.contrast(__live.card("stop1").querySelector(".tool-meta")), failedHead: __live.contrast(document.querySelector(".tool-group-failed")) }))()`);
    note(`contrast ${face}`, contrast);
    check(`the failure and Stopped ink at 12px clear 4.5:1 on the ${face} ground`, contrast.danger.ratio >= 4.5 && contrast.failedHead.ratio >= 4.5 && contrast.stopped.ratio >= 4.5, contrast);
    for (const width of [1440, 760]) {
      await c.send("Emulation.setDeviceMetricsOverride", { width, height: 940, deviceScaleFactor: 2, mobile: false });
      await sleep(600);
      if (width === 760) {
        const narrow = await evalIn(c, `(async () => { const k = __live.card("mcp2"); await __live.show(k); const o = k.querySelector(".tool-summary");
          return { pane: __live.box(__live.pane(${JSON.stringify(SEEDED)})).w, verb: __live.box(k.querySelector(".tool-name")).w, object: o ? __live.box(o).w : 0,
            failed: (() => { const f = document.querySelector(".tool-group-failed"); return f ? { w: f.scrollWidth, shown: f.clientWidth } : null; })() }; })()`);
        note(`narrow ${face}`, narrow);
        check(`in a ${narrow.pane}px pane an MCP call's object keeps width beside its verb (${face})`, narrow.object >= 60, narrow);
        check(`in a ${narrow.pane}px pane a run's failure count is shown whole (${face})`, narrow.failed && narrow.failed.w === narrow.failed.shown, narrow.failed);
      }
      await capture(c, face, width);
    }
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  }
  await paletteRow(c, "Theme: Dark");
  await sleep(600);

  // ── A call waiting on the person, live ──
  const liveMade = await api.call("sessions.create", { spaceId: first.spaceId, agentKind: "fake" });
  const liveId = liveMade.session?.id ?? liveMade.id;
  await api.call("items.update", { id: liveMade.itemId ?? liveMade.item?.id, title: "Waiting on a permission" }).catch(() => {});
  await sleep(300);
  await evalIn(c, `(() => { const row = [...document.querySelectorAll(".item-row")].find((r) => r.textContent.includes("Waiting on a permission")); row?.click(); return !!row; })()`);
  await sleep(500);
  await api.call("sessions.send", { id: liveId, text: LIVE, attachments: [], mentions: [] });
  const waiting = await until(() => evalIn(c, `(() => { const p = __live.pane(${JSON.stringify(LIVE)}); const k = p && [...p.querySelectorAll(".tool-card")].find((x) => x.dataset.state === "waiting");
    if (!k) return null; const g = k.closest(".tool-group");
    return { verb: k.querySelector(".tool-name").textContent, meta: k.querySelector(".tool-meta")?.textContent, spinner: !!k.querySelector(".tool-status .spinner"),
      head: g?.querySelector(".tool-group-row")?.textContent ?? null, foot: !!p.querySelector(".permission-card, [aria-label^='Permission request']") }; })()`), 30_000, "the waiting row");
  check("the call the agent is blocked on says Waiting for you under a shield, and the decision stays at the foot",
    waiting.verb === "Run" && waiting.meta === "Waiting for you" && !waiting.spinner && waiting.foot, waiting);
  check("the live run's head names the call in flight", /· Run pnpm vitest run settings/.test(waiting.head ?? ""), waiting.head);
  for (const face of ["dark", "light"]) {
    if (face === "light") { await paletteRow(c, "Theme: Light"); await sleep(700); }
    const box = await evalIn(c, `(async () => { const p = __live.pane(${JSON.stringify(LIVE)}); const g = p.querySelector(".tool-group"); await __live.show(g);
      const col = __live.box(p.querySelector(".transcript-col")); const top = __live.box(g); const foot = __live.box(p.querySelector(".composer") ?? g);
      return { x: col.x, y: top.y, w: col.w, h: Math.max(top.h, foot.b - top.y) }; })()`);
    await shoot(c, `waiting-${face}`, pad(box));
    const contrast = await evalIn(c, `__live.contrast([...__live.pane(${JSON.stringify(LIVE)}).querySelectorAll(".tool-meta")].find((m) => m.dataset.tone === "warning"))`);
    note(`waiting contrast ${face}`, contrast);
    check(`the waiting ink at 12px clears 4.5:1 on the ${face} ground`, contrast.ratio >= 4.5, contrast);
  }
  await paletteRow(c, "Theme: Dark");

  check("no uncaught renderer exceptions", c.errors.length === 0, c.errors.slice(0, 3));
}

async function teardown() {
  try { api?.close(); } catch { /* gone */ }
  await stopDaemons(home).catch(() => {});
  try { electron?.kill("SIGTERM"); } catch { /* gone */ }
  await sleep(800);
  try { electron?.kill("SIGKILL"); } catch { /* gone */ }
  killPort(SERVER_PORT);
  killPort(CDP_PORT);
  if (!process.env.LIVE_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
process.exit(process.exitCode ?? 0);
