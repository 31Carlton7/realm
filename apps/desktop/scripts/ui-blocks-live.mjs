/**
 * Live check: the chart, diagram and comparison blocks an agent writes, drawn in the transcript and in
 * a Markdown document (run with: pnpm build && node apps/desktop/scripts/ui-blocks-live.mjs)
 *
 * Boots the BUILT app on a scratch REALM_HOME and sends the scripted agent's "draw the blocks" turn,
 * which streams one block of each kind and one that does not parse, then writes the same blocks into
 * `notes/blocks.md`. Checked against the real renderer — jsdom has no layout and cannot run Mermaid:
 * a fence is code until it closes and a block after; each block's marks, values and text; the broken
 * one stays code with its reason; Mermaid's drawing carries no link, picture or script, and nothing
 * the session draws makes a single network request; the table toggle and the copies; the second and
 * third turns' other chart kinds and a hostile diagram; the same blocks in the Documents pane's rich
 * view, with a source that can be shown and edited; both faces, a wide window and a narrow one, and
 * reduced motion.
 *
 * Ports: LIVE_SERVER_PORT (8810), LIVE_CDP_PORT (9250). Writes only under LIVE_SCRATCH (the OS temp
 * dir by default). Nothing is billed: the onboarding session is switched to the fake agent before
 * anything is sent, and the built server skips the titler and the recap under the fake agent.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9250);
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8810);
const scratch = fs.mkdtempSync(path.join(process.env.LIVE_SCRATCH ?? os.tmpdir(), "realm-ui-blocks-live-"));
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
    await sleep(120);
  }
}

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const errors = [];
  const requests = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails?.exception?.description ?? "exception");
    else if (msg.method === "Network.requestWillBeSent") requests.push(msg.params.request.url);
  });
  return {
    ready, errors, requests,
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

const HELPERS = `
globalThis.__live = {
  box(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), r: Math.round(r.right) }; },
  centre(el) { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; },
  pane: () => document.querySelector(".session-pane"),
  blocks: (root = document.querySelector(".session-pane")) => [...(root?.querySelectorAll(".ui-block") ?? [])],
  block: (kind, n = 0, root) => __live.blocks(root).filter((b) => b.dataset.kind === kind)[n] ?? null,
  async show(el) { el?.scrollIntoView({ block: "center" }); await new Promise((r) => setTimeout(r, 400)); return __live.box(el); },
  /** The colour a token resolves to, as the screen has it. */
  rgb(cssColor) { const c = document.createElement("canvas").getContext("2d"); c.fillStyle = cssColor; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3); },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function clickAt(c, at) {
  if (!at) throw new Error("nothing to click");
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
  for (const type of ["mousePressed", "mouseReleased"]) await c.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
}

async function shoot(c, tag, clip) {
  const { data } = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 2 } } : {}) });
  const out = path.join(OUTDIR, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}
const pad = (b, n = 14) => (b ? { x: Math.max(0, b.x - n), y: Math.max(0, b.y - n), w: b.w + 2 * n, h: b.h + 2 * n } : null);

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
  await c.send("Network.enable");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Blocks");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
    hold(); new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); return true; })()`);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  await c.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  return c;
}

/** What each drawn block in a root looks like, measured. */
const READ_BLOCKS = (root) => `(() => { const root = ${root}; const col = root?.closest(".transcript")?.querySelector(".transcript-col") ?? root;
  const colBox = __live.box(col);
  return { col: colBox, blocks: __live.blocks(root).map((b) => ({ kind: b.dataset.kind, chart: b.dataset.chart ?? null, box: __live.box(b),
    title: b.querySelector(".ui-block-title")?.textContent, inside: __live.box(b).x >= colBox.x - 1 && __live.box(b).r <= colBox.r + 1 })),
    reasons: [...root.querySelectorAll(".md-block-reason, .ui-block-node-reason")].map((r) => r.textContent).filter(Boolean) }; })()`;

async function main() {
  const c = await boot();
  const [session] = await api.call("sessions.listAll", {});
  // Before anything else: the onboarding session runs a REAL engine.
  await api.call("sessions.setAgent", { id: session.id, agentKind: "fake" });
  fs.mkdirSync(session.cwd, { recursive: true });

  // ── A fence is code while it streams, a block once it closes ──
  await api.call("sessions.send", { id: session.id, text: "Please draw the blocks", attachments: [], mentions: [] });
  const streaming = await until(() => evalIn(c, `(() => { const pre = [...document.querySelectorAll(".session-pane .md-code pre")].find((p) => p.textContent.includes('"kind": "columns"'));
    if (!pre) return null; return { drawn: __live.blocks().length, parked: !!pre.closest(".md-block"), text: pre.textContent.length }; })()`), 30_000, "the chart's fence, streaming");
  check("while the chart's fence is still open its body is code, and nothing is drawn", streaming.drawn === 0 && !streaming.parked, streaming);
  await until(() => evalIn(c, `!!__live.block("chart")`), 30_000, "the chart, drawn");
  check("the chart draws once its fence has closed", true);
  await until(() => evalIn(c, `!!document.querySelector(".session-pane .md-file[data-file$='notes/blocks.md']")`), 60_000, "the turn's end and its file link");
  await until(() => evalIn(c, `!!__live.block("diagram")`), 20_000, "the diagram, drawn");
  await sleep(600);

  // ── What each block drew ──
  const read = await evalIn(c, READ_BLOCKS(`__live.pane()`));
  note("blocks", read);
  check("one chart, one diagram and one comparison are drawn, each inside the transcript's column",
    JSON.stringify(read.blocks.map((b) => b.kind)) === JSON.stringify(["chart", "diagram", "compare"]) && read.blocks.every((b) => b.inside), read.blocks);
  check("the broken chart stays code, with its reason in the code's head", read.reasons.length === 1 && read.reasons[0] === 'Not drawn — "Cold" has 2 values for 3 x labels', read.reasons);
  const brokenCode = await evalIn(c, `(() => { const r = document.querySelector(".session-pane .md-block-reason:not(:empty)"); const code = r?.closest(".md-code");
    return { visible: !!code && getComputedStyle(code).display !== "none", highlighted: !!code?.querySelector(".hljs-attr") }; })()`);
  check("…and that code is on screen, highlighted as the JSON it is", brokenCode.visible && brokenCode.highlighted, brokenCode);

  const chart = await evalIn(c, `(() => { const b = __live.block("chart"); return { bars: b.querySelectorAll("rect.chart-bar").length,
    fills: [...new Set([...b.querySelectorAll("rect.chart-bar")].map((r) => r.getAttribute("fill")))],
    totals: [...b.querySelectorAll(".chart-value")].map((t) => t.textContent), legend: [...b.querySelectorAll(".chart-legend li")].map((l) => l.textContent),
    ticks: [...b.querySelectorAll(".chart-tick")].length, hiddenCode: getComputedStyle(b.parentElement.querySelector(".md-code")).display,
    desc: b.querySelector("svg.chart desc")?.textContent }; })()`);
  check("the chart stacks two series on the palette's first two slots, with every column's total over it",
    chart.bars === 20 && chart.fills.join() === "var(--series-1),var(--series-2)" && chart.totals.length === 10 && chart.legend.join("|") === "App code|Libraries", chart);
  check("the drawn chart replaces its code, and says what it shows to a screen reader", chart.hiddenCode === "none" && /^Columns: Renderer bundle by release, 10 labels/.test(chart.desc ?? ""), chart);

  const diagram = await evalIn(c, `(() => { const b = __live.block("diagram"); const svg = b.querySelector(".ui-diagram svg");
    const text = [...svg.querySelectorAll("text")].map((t) => t.textContent.trim()).filter(Boolean);
    const firstText = svg.querySelector("text.messageText");
    return { id: svg.id, title: b.querySelector(".ui-block-title").textContent, text: text.slice(0, 12), count: text.length,
      forbidden: svg.querySelectorAll("a, image, foreignObject, script, use").length, external: /https?:\\/\\//.test(svg.outerHTML.replace(/xmlns(:\\w+)?="[^"]*"/g, "")),
      ink: getComputedStyle(firstText).fill, box: __live.box(svg), scroller: { sw: svg.parentElement.scrollWidth, cw: svg.parentElement.clientWidth } }; })()`);
  check("the sequence diagram is drawn with its own labels, under an id of its own", diagram.count >= 8 && diagram.text.includes("Sign in with Claude") && /^rlmmd-\d+$/.test(diagram.id), diagram);
  check("…and holds no link, picture, embedded HTML or reference out of the drawing", diagram.forbidden === 0 && !diagram.external, diagram);

  const compare = await evalIn(c, `(() => { const b = __live.block("compare"); const pick = b.querySelector("th[data-pick]"); const other = b.querySelector("thead th:not([data-pick])");
    const cell = b.querySelector("td[data-pick]"); const plain = [...b.querySelectorAll("tbody td")].find((td) => !td.hasAttribute("data-pick"));
    return { pick: pick?.textContent, other: other?.textContent, band: getComputedStyle(cell).backgroundColor, plain: getComputedStyle(plain).backgroundColor,
      rows: b.querySelectorAll("tbody tr").length, label: getComputedStyle(b.querySelector(".ui-compare-pick")).color }; })()`);
  check("the comparison sets SQLite apart on a band down its column, and names it Recommended", compare.pick === "RecommendedSQLite" && compare.band !== compare.plain && compare.rows === 4, compare);

  await shoot(c, "transcript-wide-dark");
  for (const kind of ["chart", "diagram", "compare"]) await shoot(c, `${kind}-dark`, pad(await evalIn(c, `__live.show(__live.block("${kind}"))`)));
  await shoot(c, "broken-dark", pad(await evalIn(c, `__live.show(document.querySelector(".session-pane .md-block-reason:not(:empty)").closest(".md-block"))`)));

  // ── The values, one click away ──
  await clickAt(c, await evalIn(c, `(async () => { const b = __live.block("chart"); await __live.show(b); return __live.centre(b.querySelector('[aria-label="Values as a table"]')); })()`));
  const table = await until(() => evalIn(c, `(() => { const t = __live.block("chart")?.querySelector("table.ui-values"); if (!t) return null;
    return { rows: [...t.querySelectorAll("tr")].map((r) => [...r.children].map((x) => x.textContent)), box: __live.box(t) }; })()`), 5000, "the values table");
  check("the table toggle shows every exact value the chart draws", table.rows.length === 11 && table.rows[1].join("|") === "1.0|612 KB|1,210 KB|1,822 KB", table.rows.slice(0, 3));
  await shoot(c, "chart-table-dark", pad(await evalIn(c, `__live.show(__live.block("chart"))`)));
  await clickAt(c, await evalIn(c, `__live.centre(__live.block("chart").querySelector('[aria-label="Values as a table"]'))`));
  await until(() => evalIn(c, `!!__live.block("chart")?.querySelector("svg.chart")`), 5000, "the chart again");

  // ── The copies ──
  /** Pick a row of a block's menu; a copy waits for the block's ✓, and a copy after a copy first
   *  waits for the last ✓ to go, or the clipboard would be read before the new write lands. */
  const menuRow = async (kind, label, copies = label.startsWith("Copy")) => {
    await until(() => evalIn(c, `__live.block("${kind}")?.querySelector(".icon-swap[data-on]") ? null : true`), 6000, `the last copy's tick on ${kind}`);
    await until(() => evalIn(c, `document.querySelector('[role="menu"]') ? null : true`), 4000, "the last menu, gone");
    await clickAt(c, await evalIn(c, `(async () => { const b = __live.block("${kind}"); await __live.show(b); return __live.centre(b.querySelector('[aria-label="Copy, and more"]')); })()`));
    await clickAt(c, await until(() => evalIn(c, `(() => { const it = [...document.querySelectorAll('[role^="menuitem"]')].find((m) => m.textContent.trim() === ${JSON.stringify(label)}); return it ? __live.centre(it) : null; })()`), 4000, `menu row ${label}`));
    if (copies) await until(() => evalIn(c, `__live.block("${kind}")?.querySelector(".icon-swap[data-on]") ? true : null`), 8000, `${label} done`);
    else await sleep(400);
  };
  const clipboard = () => evalIn(c, `(async () => { const items = await navigator.clipboard.read(); const out = [];
    for (const it of items) for (const t of it.types) { const b = await it.getType(t);
      if (t.startsWith("image/png")) { const buf = new Uint8Array(await b.arrayBuffer()); let s = ""; for (const x of buf) s += String.fromCharCode(x);
        const bmp = await createImageBitmap(b); out.push({ type: t, size: b.size, w: bmp.width, h: bmp.height, png: btoa(s) }); }
      else out.push({ type: t, text: (await b.text()).slice(0, 4000) }); }
    return out; })()`);
  await menuRow("chart", "Copy image");
  const png = (await clipboard()).find((x) => x.type === "image/png");
  const chartBox = await evalIn(c, `__live.box(__live.block("chart"))`);
  if (png) fs.writeFileSync(path.join(OUTDIR, "copied-chart.png"), Buffer.from(png.png, "base64"));
  check("Copy image puts the chart on the clipboard as a PNG at twice its size", !!png && Math.abs(png.w - chartBox.w * 2) <= 4 && png.size > 5000, png && { w: png.w, h: png.h, size: png.size, box: chartBox });
  await menuRow("diagram", "Copy SVG");
  const svgCopy = (await clipboard()).find((x) => x.type === "text/plain");
  check("Copy SVG gives the diagram as SVG markup, its ground stated and nothing external in it",
    !!svgCopy && svgCopy.text.startsWith("<svg") && svgCopy.text.includes("<rect") && !svgCopy.text.includes("example.com"), svgCopy?.text.slice(0, 160));
  await menuRow("diagram", "Copy image");
  const diagramPng = (await clipboard()).find((x) => x.type === "image/png");
  if (diagramPng) fs.writeFileSync(path.join(OUTDIR, "copied-diagram.png"), Buffer.from(diagramPng.png, "base64"));
  check("…and as a picture", !!diagramPng && diagramPng.size > 5000, diagramPng && { w: diagramPng.w, h: diagramPng.h });
  await menuRow("compare", "Copy table");
  const tableCopy = await clipboard();
  check("Copy table pastes as a Markdown table, and as HTML", tableCopy.some((x) => x.type === "text/plain" && x.text.startsWith("| Where the session store lives | Postgres | SQLite (recommended) |"))
    && tableCopy.some((x) => x.type === "text/html" && x.text.includes("<table")), tableCopy.map((x) => x.type));
  await menuRow("compare", "Copy image");
  const comparePng = (await clipboard()).find((x) => x.type === "image/png");
  if (comparePng) fs.writeFileSync(path.join(OUTDIR, "copied-compare.png"), Buffer.from(comparePng.png, "base64"));
  check("…and the comparison as a picture", !!comparePng && comparePng.size > 5000, comparePng && { w: comparePng.w, h: comparePng.h });
  await menuRow("chart", "Show source");
  const shown = await evalIn(c, `(() => { const b = __live.block("chart"); const code = b.parentElement.querySelector(".md-code");
    return { code: getComputedStyle(code).display, below: __live.box(code).y > __live.box(b).y }; })()`);
  check("Show source brings the code back under the drawing", shown.code !== "none" && shown.below, shown);
  await shoot(c, "chart-source-dark", pad(await evalIn(c, `__live.show(__live.block("chart").parentElement)`)));
  await menuRow("chart", "Hide source");

  // ── The light face: the diagram is drawn again in it ──
  const darkGround = await evalIn(c, `getComputedStyle(__live.block("diagram")).backgroundColor`);
  const darkStyle = await evalIn(c, `__live.block("diagram").querySelector(".ui-diagram svg style").textContent.length`);
  await paletteRow(c, "Theme: Light");
  await until(() => evalIn(c, `getComputedStyle(__live.block("diagram")).backgroundColor !== ${JSON.stringify(darkGround)}`), 5000, "the light face");
  const lightDiagram = await until(() => evalIn(c, `(() => { const svg = __live.block("diagram")?.querySelector(".ui-diagram svg"); if (!svg) return null;
    const t = svg.querySelector("text.messageText"); const fill = getComputedStyle(t).fill;
    return fill !== ${JSON.stringify(diagram.ink)} ? { fill, id: svg.id } : null; })()`), 10_000, "the diagram in the light face");
  check("the diagram is redrawn in the light face's ink", !!lightDiagram, { dark: diagram.ink, light: lightDiagram, darkStyle });
  await sleep(500);
  await shoot(c, "transcript-wide-light");
  for (const kind of ["chart", "diagram", "compare"]) await shoot(c, `${kind}-light`, pad(await evalIn(c, `__live.show(__live.block("${kind}"))`)));
  await shoot(c, "broken-light", pad(await evalIn(c, `__live.show(document.querySelector(".session-pane .md-block-reason:not(:empty)").closest(".md-block"))`)));
  await paletteRow(c, "Theme: Dark");
  await sleep(600);

  // ── A narrow window ──
  await c.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 940, deviceScaleFactor: 2, mobile: false });
  await sleep(900);
  const narrow = await evalIn(c, READ_BLOCKS(`__live.pane()`));
  const overflow = await evalIn(c, `(() => { const col = document.querySelector(".session-pane .transcript-col"); const t = document.querySelector(".session-pane .transcript");
    const svg = __live.block("diagram").querySelector(".ui-diagram svg"); const sc = svg.parentElement;
    return { col: col.scrollWidth - col.clientWidth, transcript: t.scrollWidth - t.clientWidth, diagram: { w: Math.round(svg.getBoundingClientRect().width), natural: parseFloat(getComputedStyle(sc).getPropertyValue("--diagram-w")), scrolls: sc.scrollWidth > sc.clientWidth + 1 },
      chartSvg: __live.box(__live.block("chart").querySelector("svg.chart")), chart: __live.box(__live.block("chart")) }; })()`);
  note("narrow", { narrow, overflow });
  check("in a narrow window every block stays inside the column and nothing widens the transcript",
    narrow.blocks.every((b) => b.inside) && overflow.col <= 1 && overflow.transcript <= 1 && overflow.chartSvg.r <= overflow.chart.r, overflow);
  check("the diagram shrinks no further than four fifths of its size, then scrolls", overflow.diagram.w >= Math.floor(overflow.diagram.natural * 0.8) - 1, overflow.diagram);
  for (const kind of ["chart", "diagram", "compare"]) await shoot(c, `${kind}-narrow-dark`, pad(await evalIn(c, `__live.show(__live.block("${kind}"))`)));
  await paletteRow(c, "Theme: Light");
  await sleep(900);
  for (const kind of ["chart", "diagram", "compare"]) await shoot(c, `${kind}-narrow-light`, pad(await evalIn(c, `__live.show(__live.block("${kind}"))`)));
  await paletteRow(c, "Theme: Dark");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });
  await sleep(800);

  // ── The other chart kinds, and a flowchart ──
  await api.call("sessions.send", { id: session.id, text: "Now draw the other charts", attachments: [], mentions: [] });
  await until(() => evalIn(c, `__live.blocks().length >= 7 && !!__live.block("diagram", 1)`), 30_000, "the second turn's blocks");
  await sleep(800);
  const second = await evalIn(c, `(() => { const charts = __live.blocks().filter((b) => b.dataset.kind === "chart");
    const lines = charts.find((b) => b.dataset.chart === "lines"); const bars = charts.find((b) => b.dataset.chart === "bars"); const sparks = charts.find((b) => b.dataset.chart === "sparkline");
    return { kinds: charts.map((b) => b.dataset.chart), coldRuns: lines.querySelectorAll('polyline[stroke="var(--series-1)"]').length, endLabels: [...lines.querySelectorAll(".chart-end-label")].map((t) => t.textContent),
      bars: [...bars.querySelectorAll(".bd-bar-row")].map((r) => r.textContent), sparks: [...sparks.querySelectorAll(".ui-spark")].map((r) => r.textContent),
      flow: [...__live.block("diagram", 1).querySelectorAll("text")].map((t) => t.textContent.trim()).filter(Boolean) }; })()`);
  check("bars, lines and sparklines draw: a line breaks where a value was not measured, and is named at its end",
    second.kinds.join() === "columns,bars,lines,sparkline" && second.coldRuns === 2 && second.endLabels.join() === "Cold,Warm" && second.bars.length === 5 && second.sparks.length === 3, second);
  check("the flowchart draws with its labels", ["Agent CLI", "Adapter", "Session service", "Transcript"].every((l) => second.flow.includes(l)), second.flow);
  for (const [tag, sel] of [["bars", `__live.blocks().find((b) => b.dataset.chart === "bars")`], ["lines", `__live.blocks().find((b) => b.dataset.chart === "lines")`],
    ["sparklines", `__live.blocks().find((b) => b.dataset.chart === "sparkline")`], ["flowchart", `__live.block("diagram", 1)`]]) {
    await shoot(c, `${tag}-dark`, pad(await evalIn(c, `__live.show(${sel})`)));
  }
  await paletteRow(c, "Theme: Light");
  await sleep(1200);
  for (const [tag, sel] of [["bars", `__live.blocks().find((b) => b.dataset.chart === "bars")`], ["lines", `__live.blocks().find((b) => b.dataset.chart === "lines")`],
    ["sparklines", `__live.blocks().find((b) => b.dataset.chart === "sparkline")`], ["flowchart", `__live.block("diagram", 1)`]]) {
    await shoot(c, `${tag}-light`, pad(await evalIn(c, `__live.show(${sel})`)));
  }
  await paletteRow(c, "Theme: Dark");
  await sleep(600);

  // ── A diagram that asks for everything strict mode takes away ──
  await api.call("sessions.send", { id: session.id, text: "Then draw a hostile diagram", attachments: [], mentions: [] });
  const hostile = await until(() => evalIn(c, `(() => { const holders = [...document.querySelectorAll(".session-pane .md-block[data-ui-block=diagram]")]; const h = holders.at(-1);
    if (!h || holders.length < 3) return null; const b = h.querySelector(".ui-block"); const reason = h.querySelector(".md-block-reason")?.textContent;
    if (!b && !reason) return null; const svg = b?.querySelector("svg");
    return { drawn: !!b, reason: reason || null, forbidden: svg ? svg.querySelectorAll("a, image, foreignObject, script, use").length : 0,
      external: svg ? /example\\.com/.test(svg.outerHTML) : false, labels: svg ? [...svg.querySelectorAll("text")].map((t) => t.textContent.trim()).filter(Boolean) : [] }; })()`), 30_000, "the hostile diagram");
  check("a hostile diagram draws as a drawing only: no link, no picture, no reference to anywhere", hostile.forbidden === 0 && !hostile.external, hostile);
  if (hostile.drawn) await shoot(c, "hostile-dark", pad(await evalIn(c, `__live.show([...document.querySelectorAll(".session-pane .md-block[data-ui-block=diagram]")].at(-1))`)));

  // ── Reduced motion ──
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(300);
  const still = await evalIn(c, `(() => ({ running: document.getAnimations().filter((a) => a.effect?.target?.closest?.(".ui-block")).length,
    barTransition: getComputedStyle(__live.blocks().find((b) => b.dataset.chart === "bars").querySelector(".bd-bar-fill")).transitionDuration,
    keyframes: [...document.querySelectorAll(".ui-diagram style")].some((s) => /@keyframes|animation/.test(s.textContent)) }))()`);
  check("under reduced motion nothing in a block moves, and no diagram carries an animation", still.running === 0 && still.barTransition === "0s" && !still.keyframes, still);
  await c.send("Emulation.setEmulatedMedia", { features: [] });

  // ── The same blocks in a Markdown document ──
  await clickAt(c, await evalIn(c, `(async () => { const l = document.querySelector(".session-pane .md-file[data-file$='notes/blocks.md']"); await __live.show(l); return __live.centre(l); })()`));
  const docRoot = `document.querySelector(".documents-pane [aria-label='Rich text editor']")`;
  await until(() => evalIn(c, `(() => { const r = ${docRoot}; return r && r.querySelectorAll(".ui-block").length >= 3 ? true : null; })()`), 30_000, "the document's blocks");
  await sleep(800);
  const doc = await evalIn(c, `(() => { const r = ${docRoot}; return { kinds: [...r.querySelectorAll(".ui-block")].map((b) => b.dataset.kind),
    reasons: [...r.querySelectorAll(".ui-block-node-reason")].map((x) => x.textContent), hiddenCode: [...r.querySelectorAll(".ui-block-node")].map((n) => getComputedStyle(n.querySelector("pre")).display),
    pane: __live.box(document.querySelector(".documents-pane")) }; })()`);
  check("the document draws the same three blocks and leaves the broken one as code with its reason",
    doc.kinds.join() === "chart,diagram,compare" && doc.reasons.length === 1 && doc.reasons[0] === 'Not drawn — "Cold" has 2 values for 3 x labels', doc);
  check("…with each drawn block's source out of the way until it is asked for", doc.hiddenCode.filter((d) => d === "none").length === 3, doc.hiddenCode);
  await shoot(c, "document-dark", doc.pane);
  // Edit source: the code comes back where the caret can go, and the drawing follows the edit.
  await clickAt(c, await evalIn(c, `(async () => { const b = ${docRoot}.querySelector(".ui-block[data-kind=chart]"); await __live.show(b); return __live.centre(b.querySelector('[aria-label="Edit source"]')); })()`));
  const editing = await until(() => evalIn(c, `(() => { const n = ${docRoot}.querySelector(".ui-block-node"); const pre = n.querySelector("pre");
    return getComputedStyle(pre).display !== "none" ? { code: pre.textContent.slice(0, 40), focused: n.contains(document.activeElement) || n.contains(getSelection().anchorNode) } : null; })()`), 5000, "the source, editable");
  check("Edit source shows the block's source in place, with the caret in it", editing.focused && editing.code.includes('"kind"'), editing);
  await shoot(c, "document-edit-source-dark", pad(await evalIn(c, `__live.box(${docRoot}.querySelector(".ui-block-node"))`)));
  await paletteRow(c, "Theme: Light");
  await sleep(1200);
  await shoot(c, "document-light", doc.pane);
  await paletteRow(c, "Theme: Dark");
  await sleep(600);
  await c.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 940, deviceScaleFactor: 2, mobile: false });
  await sleep(900);
  const docNarrow = await evalIn(c, `(() => { const r = ${docRoot}; const box = __live.box(r);
    return { box, inside: [...r.querySelectorAll(".ui-block")].every((b) => __live.box(b).r <= box.r + 1 && __live.box(b).x >= box.x - 1) }; })()`);
  check("in a narrow documents pane the blocks stay inside it", docNarrow.inside, docNarrow);
  await shoot(c, "document-narrow-dark", await evalIn(c, `__live.box(document.querySelector(".documents-pane"))`));
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 940, deviceScaleFactor: 2, mobile: false });

  // ── Nothing fetched ──
  const outside = c.requests.filter((u) => !/^(file:|data:|blob:|devtools:|chrome-extension:|http:\/\/127\.0\.0\.1|ws:\/\/127\.0\.0\.1|realm-media:)/.test(u));
  check("nothing any block drew made a network request", outside.length === 0, outside.slice(0, 5));
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
  if (!process.env.LIVE_KEEP) fs.rmSync(path.join(scratch, "home"), { recursive: true, force: true });
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });
await main().catch((e) => { process.exitCode = 1; console.error(`FAIL ${e?.stack ?? e}`); }).finally(teardown);
process.exit(process.exitCode ?? 0);
