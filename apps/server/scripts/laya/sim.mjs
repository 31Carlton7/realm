#!/usr/bin/env node
// The Laya benchmark's crawler: read a simulator's accessibility tree the way realm-simulator does
// (serve-sim's /helper/<udid>/ax, flattened by the same rules as `parseAxTree`), save screens and
// before/after pairs, and drive the device through serve-sim's socket and CLI and `xcrun simctl`.
//
//   UDID       the device (default: the iPhone 17 Pro Max this benchmark was crawled on)
//   SIM_URL    its serve-sim stream origin, e.g. http://127.0.0.1:3470 (never read from PORT: a
//              Realm-hosted shell sets that for itself)
//   SERVE_SIM  the serve-sim CLI (default: `serve-sim` on PATH)
//   LAYA_CRAWL_DIR  where screens/ and pairs/ go (default /tmp/laya-train/crawl)
//   WAIT       ms to wait after a step before reading the screen it left (default 1800)
//
// Commands: ax [all] | snap <name> [note] | tap <n|label|#id|=exact> [fresh] | tapxy x y |
//           swipe up|down|left|right|back|bigup | home | type text | launch bundle | url u |
//           pair <name> <label|#id|=exact|xy:x,y|swipe:dir|type:text|home> <intent> [note]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");

const UDID = process.env.UDID || "7F4B34AC-20B1-4330-B3D2-B8E285096D29";
const BASE = process.env.SIM_URL || "http://127.0.0.1:3470";
const SS = process.env.SERVE_SIM || "serve-sim";
const DIR = process.env.LAYA_CRAWL_DIR || "/tmp/laya-train/crawl";
const LAST = join(DIR, "last.json");
mkdirSync(join(DIR, "screens"), { recursive: true });
mkdirSync(join(DIR, "pairs"), { recursive: true });

const str = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
function frameOf(node) {
  const f = node.frame;
  if (!f || typeof f !== "object") return null;
  const { x, y, width, height } = f;
  if ([x, y, width, height].some((n) => typeof n !== "number") || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}
function parseAxTree(body) {
  const roots = JSON.parse(body);
  const list = Array.isArray(roots) ? roots : [roots];
  const root = list[0];
  const rootFrame = frameOf(root);
  const elements = [];
  const walk = (node, path, depth) => {
    const frame = frameOf(node);
    if (frame && depth > 0) {
      elements.push({ path, label: str(node.AXLabel), value: str(node.AXValue), role: str(node.type) || str(node.role_description) || "Element", id: node.AXUniqueId || null, enabled: node.enabled !== false, frame, depth });
    }
    (Array.isArray(node.children) ? node.children : []).forEach((k, i) => walk(k, path === "" ? String(i) : `${path}.${i}`, depth + 1));
  };
  list.forEach((n, i) => walk(n, String(i), 0));
  return { screen: { width: rootFrame.width, height: rootFrame.height }, app: str(root.AXLabel), elements };
}
async function ax() {
  for (let i = 0; i < 6; i++) {
    try {
      const res = await fetch(`${BASE}/helper/${UDID}/ax`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const tree = parseAxTree(await res.text());
        writeFileSync(LAST, JSON.stringify(tree));
        return tree;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("no ax tree");
}
const box = (f) => [Math.round(f.x), Math.round(f.y), Math.round(f.width), Math.round(f.height)];
const observed = (el) => ({ id: el.path, role: el.role, label: el.label, ...(el.value ? { value: el.value } : {}), frame: box(el.frame) });
function list(tree, all = false) {
  const lines = [`app: ${tree.app} (${tree.elements.length} elements, screen ${tree.screen.width}x${tree.screen.height})`];
  tree.elements.forEach((e, i) => {
    if (!all && !e.label && !e.value) return;
    const f = e.frame;
    lines.push(`[${i}] ${e.role} '${e.label}'${e.value ? ` = ${e.value}` : ""}${e.id ? ` #${e.id}` : ""} (${Math.round(f.x)},${Math.round(f.y)} ${Math.round(f.width)}x${Math.round(f.height)})${e.enabled ? "" : " disabled"}`);
  });
  return lines.join("\n");
}
function cli(args) {
  return execFileSync(SS, [...args, "-d", UDID], { encoding: "utf8", timeout: 60000 });
}
const WS = BASE.replace("http", "ws") + `/helper/${UDID}/ws`;
const gframe = (type, x, y) => { const b = Buffer.from(JSON.stringify({ type, x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) })); return Buffer.concat([Buffer.from([3]), b]); };
async function send(steps) {
  const ws = new WebSocket(WS);
  ws.on("error", () => {});
  await new Promise((res, rej) => { const t = setTimeout(() => rej(new Error("ws timeout")), 5000); ws.once("open", () => { clearTimeout(t); res(); }); ws.once("error", (e) => { clearTimeout(t); rej(e); }); });
  for (const [f, wait] of steps) { await new Promise((res, rej) => ws.send(f, (e) => (e ? rej(e) : res()))); if (wait) await new Promise((r) => setTimeout(r, wait)); }
  await new Promise((r) => setTimeout(r, 50));
  ws.close();
}
async function tapPoint(x, y, screen) {
  const nx = x / screen.width, ny = y / screen.height;
  await send([[gframe("begin", nx, ny), 40], [gframe("end", nx, ny), 0]]);
}
async function swipeN(x1, y1, x2, y2, ms = 300) {
  const n = Math.max(2, Math.round(ms / 16)); const every = ms / n;
  const steps = [[gframe("begin", x1, y1), every]];
  for (let i = 1; i <= n; i++) steps.push([gframe("move", x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n), i === n ? 0 : every]);
  steps.push([gframe("end", x2, y2), 0]);
  await send(steps);
}
const SWIPES = { up: [[0.5, 0.7], [0.5, 0.35]], down: [[0.5, 0.35], [0.5, 0.7]], left: [[0.85, 0.5], [0.15, 0.5]], right: [[0.15, 0.5], [0.85, 0.5]], back: [[0.01, 0.5], [0.8, 0.5]], bigup: [[0.5, 0.85], [0.5, 0.2]] };
async function swipe(dir, ms) {
  const pts = SWIPES[dir];
  if (!pts) throw new Error(`no swipe ${dir}`);
  const [[x1, y1], [x2, y2]] = pts;
  await swipeN(x1, y1, x2, y2, Number(ms || 400));
}
function centre(e) { return { x: e.frame.x + e.frame.width / 2, y: e.frame.y + e.frame.height / 2 }; }
function lastTree() { return JSON.parse(readFileSync(LAST, "utf8")); }
function find(tree, sel) {
  if (/^\d+$/.test(sel)) return tree.elements[Number(sel)];
  if (sel.startsWith("#")) return tree.elements.find((e) => e.id === sel.slice(1));
  if (sel.startsWith("=")) return tree.elements.find((e) => e.label === sel.slice(1));
  const exact = tree.elements.filter((e) => e.label === sel);
  if (exact.length) return exact[0];
  const lower = sel.toLowerCase();
  return tree.elements.find((e) => e.label.toLowerCase().includes(lower));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function save(name, tree, extra = {}) {
  const file = join(DIR, "screens", `${name}.json`);
  writeFileSync(file, JSON.stringify({ id: name, app: tree.app, at: new Date().toISOString(), screen: tree.screen, elements: tree.elements.slice(0, 300), ...extra }, null, 1));
  return file;
}

const [cmd, ...rest] = process.argv.slice(2);
const main = async () => {
  switch (cmd) {
    case "ax": { const t = await ax(); console.log(list(t, rest[0] === "all")); break; }
    case "snap": { const t = await ax(); console.log(save(rest[0], t, rest[1] ? { note: rest[1] } : {})); console.log(list(t)); break; }
    case "tap": {
      const t = rest[1] === "fresh" ? await ax() : lastTree();
      const e = find(t, rest[0]);
      if (!e) throw new Error(`no element ${rest[0]}`);
      const c = centre(e); await tapPoint(c.x, c.y, t.screen);
      console.log(`tapped ${e.role} '${e.label}' at ${Math.round(c.x)},${Math.round(c.y)}`);
      break;
    }
    case "tapxy": { const t = lastTree(); await tapPoint(Number(rest[0]), Number(rest[1]), t.screen); console.log("tapped"); break; }
    case "swipe": { await swipe(rest[0], rest[1]); console.log(`swiped ${rest[0]}`); break; }
    case "home": cli(["button", "home"]); console.log("home"); break;
    case "type": cli(["type", rest.join(" ")]); console.log("typed"); break;
    case "launch": execFileSync("xcrun", ["simctl", "launch", "--terminate-running-process", UDID, rest[0]], { encoding: "utf8" }); console.log("launched"); break;
    case "terminate": try { execFileSync("xcrun", ["simctl", "terminate", UDID, rest[0]], { encoding: "utf8" }); } catch {} console.log("terminated"); break;
    case "url": execFileSync("xcrun", ["simctl", "openurl", UDID, rest[0]], { encoding: "utf8" }); console.log("opened"); break;
    case "pair": {
      const [name, action, intent, note] = rest;
      const before = await ax();
      let target = null;
      if (action.startsWith("swipe:")) {
        await swipe(action.slice(6));
      } else if (action.startsWith("type:")) {
        cli(["type", action.slice(5)]);
      } else if (action === "home") {
        cli(["button", "home"]);
      } else if (action.startsWith("xy:")) {
        const [x, y] = action.slice(3).split(",").map(Number);
        await tapPoint(x, y, before.screen);
      } else {
        const e = find(before, action);
        if (!e) throw new Error(`no element ${action}`);
        target = observed(e);
        const c = centre(e); await tapPoint(c.x, c.y, before.screen);
      }
      await sleep(Number(process.env.WAIT || 1800));
      const after = await ax();
      writeFileSync(join(DIR, "pairs", `${name}.json`), JSON.stringify({ id: name, action, intent, note: note ?? "", target, app: before.app, afterApp: after.app, at: new Date().toISOString(), screen: before.screen, before: before.elements.slice(0, 300).map(observed), after: after.elements.slice(0, 300).map(observed) }, null, 1));
      console.log(`pair ${name}: ${before.app} -> ${after.app}; before ${before.elements.length} after ${after.elements.length}`);
      console.log(list(after));
      break;
    }
    default: console.log("commands: ax [all] | snap <name> [note] | tap <n|label> [fresh] | tapxy x y | swipe up|down|left|right|back|bigup | home | type text | launch bundle | url u | pair name action intent [note]");
  }
};
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
