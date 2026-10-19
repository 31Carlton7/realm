// Checks and draws the architecture docs with the Electron and Mermaid Realm already ships.
//
//   apps/desktop/node_modules/.bin/electron docs/architecture/render.mjs [--blocks <dir>] [--no-poster]
//
// 1. Every ```mermaid block in docs/architecture/*.md is drawn by Mermaid (the copy the renderer uses
//    for an agent's diagrams). A block that does not parse fails the run with its file and line.
// 2. The poster (realm-architecture.html) is drawn whole and written to realm-architecture.png.
// --blocks <dir> also writes each drawn block as a PNG there, so the drawings can be looked at.
//
// Nothing is fetched: the page is a file, Mermaid is read from node_modules, and the window is
// offscreen, so a run never takes focus from the window you are working in.

import { app, BrowserWindow } from "electron";
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const mermaidPath = join(root, "apps/desktop/node_modules/mermaid/dist/mermaid.min.js");

const args = process.argv.slice(2);
const blocksDir = args.includes("--blocks") ? resolve(args[args.indexOf("--blocks") + 1]) : null;
const drawPoster = !args.includes("--no-poster");

/** Every fenced mermaid block in the folder's Markdown, with where it starts. */
function mermaidBlocks() {
  const blocks = [];
  for (const name of readdirSync(here).filter((f) => f.endsWith(".md")).sort()) {
    const lines = readFileSync(join(here, name), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== "```mermaid") continue;
      const start = i + 1;
      const body = [];
      while (++i < lines.length && lines[i].trim() !== "```") body.push(lines[i]);
      blocks.push({ file: name, line: start, source: body.join("\n") });
    }
  }
  return blocks;
}

function offscreenWindow(width, height) {
  return new BrowserWindow({
    show: false, width, height, useContentSize: true, paintWhenInitiallyHidden: true,
    webPreferences: { offscreen: true, contextIsolation: true },
  });
}

async function checkBlocks(blocks) {
  const win = offscreenWindow(1600, 1200);
  await win.loadURL("data:text/html,<!doctype html><meta charset=utf-8><body style='margin:8px;background:%23fff'></body>");
  await win.webContents.executeJavaScript(readFileSync(mermaidPath, "utf8") + "\n;0");
  // Strict, as Realm's renderer runs it; labels as HTML, as GitHub draws them.
  await win.webContents.executeJavaScript(`mermaid.initialize({
    startOnLoad: false, securityLevel: "strict", theme: "neutral", maxEdges: 2000, maxTextSize: 200000,
  }); 0`);
  const failures = [];
  for (const [n, block] of blocks.entries()) {
    const result = await win.webContents.executeJavaScript(`(async () => {
      try {
        const { svg } = await mermaid.render("d${n}", ${JSON.stringify(block.source)});
        document.body.innerHTML = svg;
        // Drawn at its own size, not the window's, so the PNG is the diagram as a reader gets it.
        const el = document.body.firstElementChild;
        const { width, height } = el.viewBox.baseVal;
        el.removeAttribute("style");
        el.setAttribute("width", width);
        el.setAttribute("height", height);
        return { ok: true, width: Math.ceil(width), height: Math.ceil(height) };
      } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
    })()`);
    const where = `${block.file}:${block.line}`;
    if (!result.ok) { failures.push(`${where}\n${result.reason}`); continue; }
    console.log(`ok   ${where}  ${result.width}x${result.height}`);
    if (blocksDir) {
      win.setContentSize(Math.max(200, result.width + 16), Math.max(100, result.height + 16));
      await new Promise((r) => setTimeout(r, 150));
      const image = await win.webContents.capturePage();
      writeFileSync(join(blocksDir, `${block.file.replace(/\.md$/, "")}-${block.line}.png`), image.toPNG());
    }
  }
  // Not destroyed: a window made after one is destroyed fails to load a file in this Electron.
  return failures;
}

async function exportPoster() {
  // The poster's world is 4000 × 2230; drawn 1:1, its 12px labels stay 12px in the PNG.
  const width = 4000;
  const height = 2230;
  const win = offscreenWindow(width, height);
  win.webContents.on("console-message", (e) => { if (e.level === "warning" || e.level === "error") console.error(`poster: ${e.message}`); });
  await win.loadFile(join(here, "realm-architecture.html"), { query: { export: "1" } });
  await win.webContents.executeJavaScript("new Promise((r) => { const t = setInterval(() => { if (window.__drawn) { clearInterval(t); r(0); } }, 50); })");
  const overflow = await win.webContents.executeJavaScript("window.__overflow");
  for (const line of overflow) console.error(`poster: text wider than its box, ${line}`);
  await new Promise((r) => setTimeout(r, 400));
  // Captured at the display's density, so text stays sharp when the PNG is zoomed.
  const image = await win.webContents.capturePage();
  writeFileSync(join(here, "realm-architecture.png"), image.toPNG());
  console.log(`poster  realm-architecture.png  ${image.getSize().width}x${image.getSize().height}`);
  return overflow.length;
}

app.disableHardwareAcceleration();
if (process.platform === "darwin") app.setActivationPolicy("accessory");

app.whenReady().then(async () => {
  let code = 0;
  try {
    if (blocksDir) mkdirSync(blocksDir, { recursive: true });
    const blocks = mermaidBlocks();
    const failures = await checkBlocks(blocks);
    console.log(`${blocks.length - failures.length}/${blocks.length} mermaid blocks drew`);
    for (const f of failures) console.error(`FAIL ${f}\n`);
    if (failures.length) code = 1;
    if (drawPoster && (await exportPoster()) > 0) code = 1;
  } catch (e) {
    console.error(e);
    code = 1;
  }
  app.exit(code);
});
