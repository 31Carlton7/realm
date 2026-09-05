/**
 * Live check for the decorative wash (run with: node apps/desktop/scripts/wash-live.mjs)
 *
 * Boots the REAL built app on a scratch REALM_HOME and measures the decoration as pixels. Nothing
 * here is checkable in jsdom, and two of the claims are not checkable off the CSSOM either:
 *
 *   - `oklch(from var(--accent) …)` is RELATIVE COLOUR SYNTAX. If Chromium cannot parse it the whole
 *     `background-image` declaration is invalid and the computed value falls back to `none` — a
 *     silent, total loss of the feature that every string assertion in styles.test.ts still passes.
 *   - Grain is a texture. Its presence is a variance in the pixels and nothing else; a screenshot is
 *     the only place that number exists.
 *   - "Still under reduced motion" is a claim about two frames, not about a stylesheet. The check is
 *     that two shots a second apart are IDENTICAL under the preference and DIFFERENT without it —
 *     an animation slowed rather than stopped fails the first half.
 *
 * Screenshots of every decorated surface, in both modes, on a dark palette and a light one, land in
 * /tmp and are meant to be LOOKED at. A wash that clears every assertion and looks like a smudge is
 * still wrong.
 *
 * REBUILD FIRST (`pnpm build`): this boots apps/desktop/out, not the sources.
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9347), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8914);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-wash-live-"));
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The three ink floors from packages/ui/src/themes.ts. Restated because this runs under plain node
 *  against the BUILT app, and a copy that disagrees with the source is the drift worth catching. */
const FLOOR = { ink: 4.5, ink2: 3, ink3: 2.4 };

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
  const events = [];
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      events.push(msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });
  return {
    ready, events,
    send: (method, params) => new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

const HELPERS = `
window.__live = window.__live ?? {
  setInput(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  async menu(label) {
    document.querySelector('[aria-label="Space menu"]').click();
    for (let i = 0; i < 40 && !document.querySelector('[role="menu"]'); i++) await new Promise((r) => setTimeout(r, 25));
    const hit = [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent.trim() === label);
    if (!hit) { document.querySelector('[role="menu"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); throw new Error("no menu item: " + label); }
    hit.click();
    return true;
  },
  /** Open a page pane by its command-palette entry. */
  async openPage(re) {
    document.querySelector('[aria-label="Space menu"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    for (let i = 0; i < 40 && !document.querySelector(".palette-list"); i++) await new Promise((r) => setTimeout(r, 25));
    const open = [...document.querySelectorAll(".palette-list [role=option], .palette-list button")]
      .find((b) => new RegExp(re, "i").test(b.textContent));
    if (!open) throw new Error("no palette entry: " + re);
    open.click();
    return true;
  },
  /** The first-run card is shown once and never again, so after onboarding the only way to look at
   *  the grain on another palette is to plant the same markup and let the real cascade resolve it —
   *  the fragment carries no styling of its own beyond where it sits. */
  plantCard(vars) {
    let host = document.getElementById("live-card");
    if (!host) {
      host = document.createElement("section");
      host.id = "live-card";
      host.className = "sheet onboarding wash";
      host.setAttribute("data-grain", "");
      host.style.cssText = "position:fixed;right:32px;top:96px;z-index:9999;width:380px;height:260px";
      host.innerHTML = '<div class="sheet-head"><h3>Welcome to Realm</h3></div>' +
        '<div class="sheet-body"><p class="muted onboarding-lead">Realm drives the agent CLIs already installed on this machine.</p></div>';
      document.body.appendChild(host);
    }
    for (const [k, v] of Object.entries(vars)) host.style.setProperty(k, v);
    return true;
  },
  rect(sel) { const el = document.querySelector(sel); return el ? el.getBoundingClientRect().toJSON() : null; },
  /** Whether the decoration survived parsing at all. A computed background-image of "none" on a
   *  .wash element means the relative-colour declaration was thrown away. */
  washState(sel) {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = getComputedStyle(el);
    return { image: s.backgroundImage, ground: s.backgroundColor, hue: s.getPropertyValue("--grain-hue").trim() };
  },
  srgb(color) {
    const g = (this._cv ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true }));
    g.clearRect(0, 0, 1, 1); g.fillStyle = color; g.fillRect(0, 0, 1, 1);
    return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
  },
  /** The ink a real element on the page is actually painted in. */
  inkOf(sel) { const el = document.querySelector(sel); return el ? this.srgb(getComputedStyle(el).color) : null; },
  async _pixels(b64) {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = "data:image/png;base64," + b64; });
    const c = document.createElement("canvas"); c.width = img.width; c.height = img.height;
    c.getContext("2d").drawImage(img, 0, 0);
    return { c, dpr: img.width / window.innerWidth };
  },
  /** Mean colour of a CSS-pixel rect, and the standard deviation of its luminance. The mean says
   *  which ground was painted; the deviation is the only number that says whether it has grain. */
  async patch(b64, r) {
    const { c, dpr } = await this._pixels(b64);
    const x = Math.floor(r.x * dpr), y = Math.floor(r.y * dpr);
    const w = Math.max(1, Math.floor(r.w * dpr)), h = Math.max(1, Math.floor(r.h * dpr));
    const d = c.getContext("2d").getImageData(x, y, w, h).data;
    let sr = 0, sg = 0, sb = 0, n = 0; const lum = [];
    for (let i = 0; i < d.length; i += 4) { sr += d[i]; sg += d[i+1]; sb += d[i+2]; n++;
      lum.push(0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2]); }
    const mean = lum.reduce((a, b) => a + b, 0) / n;
    return { rgb: [sr/n, sg/n, sb/n], sd: Math.sqrt(lum.reduce((a, v) => a + (v - mean) ** 2, 0) / n) };
  },
  /** Largest per-channel difference between two shots over a rect — zero means nothing moved. */
  async diff(a, b, r) {
    const A = await this._pixels(a), B = await this._pixels(b);
    const x = Math.floor(r.x * A.dpr), y = Math.floor(r.y * A.dpr);
    const w = Math.max(1, Math.floor(r.w * A.dpr)), h = Math.max(1, Math.floor(r.h * A.dpr));
    const da = A.c.getContext("2d").getImageData(x, y, w, h).data;
    const db = B.c.getContext("2d").getImageData(x, y, w, h).data;
    let worst = 0;
    for (let i = 0; i < da.length; i++) if (i % 4 !== 3) worst = Math.max(worst, Math.abs(da[i] - db[i]));
    return worst;
  },
};
`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

let failures = 0;
function check(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
}

const relLum = (c) => { const [r, g, b] = c.map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [relLum(a), relLum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const shot = async (c) => (await c.send("Page.captureScreenshot", { format: "png" })).data;
const save = (tag, b64) => {
  const out = path.join(os.tmpdir(), `realm-wash-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(b64, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
  return out;
};
const media = (c, features) => c.send("Emulation.setEmulatedMedia", { features });

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");

  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, [
    'import { app } from "electron";',
    'app.setPath("userData", process.env.LIVE_USER_DATA);',
    "await import(process.env.LIVE_MAIN);",
  ].join("\n"));
  const electronBin = process.platform === "darwin"
    ? path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
    : path.join(repoRoot, "apps/desktop/node_modules/.bin/electron");
  electron = spawn(electronBin, [wrapper], {
    env: { ...process.env,
      REALM_HOME: path.join(scratch, "home"),
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  electron.stderr.on("data", () => {}); electron.stdout.on("data", () => {});

  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const target = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
  await sleep(500);

  // ── 1. The first-run card, which is the one surface that wears the grain ───────────────────────
  const card = await evalIn(c, `__live.washState('.sheet.onboarding')`);
  check("1 the wash survives parsing (relative colour syntax resolved)",
    !!card && card.image !== "none" && card.image.includes("gradient"),
    `background-image: ${String(card?.image).slice(0, 72)}…`);
  // `url(` appears twice in the texture layer alone — the outer data URI and the SVG's own
  // filter='url(#g)' — so the texture is counted by its data URI, not by the function name.
  check("2 the texture and the lift are both in the stack",
    !!card && (card.image.match(/url\("data:/g) ?? []).length === 1 && (card.image.match(/gradient/g) ?? []).length === 2,
    `${(card?.image.match(/gradient/g) ?? []).length} gradients, ${(card?.image.match(/url\("data:/g) ?? []).length} textures`);
  check("3 the launch draw reached the element", !!card && card.hue !== "" && Math.abs(Number(card.hue)) <= 40, `--grain-hue: ${card?.hue}`);
  save("onboarding-realm-dark", await shot(c));

  /* The pixel measurements need a patch of ground with no text on it, and the real first-run card is
     a form from its heading down. So they run against the same markup, planted and resolved by the
     real cascade — the fragment carries only its position. */
  await evalIn(c, `__live.plantCard({ "--grain-hue": "24", "--grain-x": "72%", "--grain-y": "6%", "--grain-spread": "96%" })`);
  await sleep(400);
  const pr = await evalIn(c, `__live.rect('#live-card')`);
  const flat = { x: pr.x + 16, y: pr.y + 150, w: pr.width - 32, h: 80 };
  const near = { x: pr.x + pr.width - 90, y: pr.y + 10, w: 70, h: 26 };
  const far = { x: pr.x + 14, y: pr.y + pr.height - 40, w: 70, h: 26 };

  const on = await shot(c);
  const grained = await evalIn(c, `__live.patch(${JSON.stringify(on)}, ${JSON.stringify(flat)})`);
  const hot = await evalIn(c, `__live.patch(${JSON.stringify(on)}, ${JSON.stringify(near)})`);
  const cold = await evalIn(c, `__live.patch(${JSON.stringify(on)}, ${JSON.stringify(far)})`);

  // The mutant, on the same pixels: take the decoration away and the ground goes flat and even.
  await evalIn(c, `(() => { document.getElementById('live-card').classList.remove('wash'); return true; })()`);
  await sleep(300);
  const offShot = await shot(c);
  const bareGround = await evalIn(c, `__live.patch(${JSON.stringify(offShot)}, ${JSON.stringify(flat)})`);
  const bareHot = await evalIn(c, `__live.patch(${JSON.stringify(offShot)}, ${JSON.stringify(near)})`);
  check("4 the grain is really in the pixels, not just in the stylesheet",
    grained.sd > bareGround.sd + 0.35, `sd ${grained.sd.toFixed(2)} decorated vs ${bareGround.sd.toFixed(2)} plain`);
  check("5 the field paints, and falls off across the card the way a field should",
    Math.max(...hot.rgb.map((v, i) => Math.abs(v - cold.rgb[i]))) >= 2,
    `origin ${hot.rgb.map(Math.round)} vs far corner ${cold.rgb.map(Math.round)}`);
  // Measured at the field's ORIGIN. The flat strip above is deliberately at the far corner, where
  // the field has fallen off to nothing — a ground that had moved there would be a field that does
  // not fall off, which is a wash over the whole card rather than a light on one corner of it.
  check("6 at its origin the field really has moved the ground off the bare --surface",
    Math.max(...hot.rgb.map((v, i) => Math.abs(v - bareHot.rgb[i]))) >= 2,
    `${hot.rgb.map((v) => v.toFixed(1))} vs ${bareHot.rgb.map((v) => v.toFixed(1))}`);
  await evalIn(c, `(() => { document.getElementById('live-card').classList.add('wash'); return true; })()`);
  await sleep(300);

  // ── The drift, and whether the preference actually stops it ────────────────────────────────────
  const a1 = await shot(c); await sleep(1400); const a2 = await shot(c);
  const moved = await evalIn(c, `__live.diff(${JSON.stringify(a1)}, ${JSON.stringify(a2)}, ${JSON.stringify(flat)})`);
  check("7 the grain drifts on its own", moved > 0, `largest channel change over 1.4s: ${moved}`);

  await media(c, [{ name: "prefers-reduced-motion", value: "reduce" }]);
  await sleep(500);
  const b1 = await shot(c); await sleep(1400); const b2 = await shot(c);
  const still = await evalIn(c, `__live.diff(${JSON.stringify(b1)}, ${JSON.stringify(b2)}, ${JSON.stringify(flat)})`);
  check("8 reduced motion stops it dead rather than slowing it", still === 0, `largest channel change over 1.4s: ${still}`);
  save("onboarding-reduced-motion", b2);

  // ── Reduced transparency takes the decoration away entirely ────────────────────────────────────
  await media(c, [{ name: "prefers-reduced-transparency", value: "reduce" }]);
  await sleep(500);
  const rt = await shot(c);
  const bare = await evalIn(c, `__live.patch(${JSON.stringify(rt)}, ${JSON.stringify(flat)})`);
  check("9 reduced transparency leaves the plain surface, grain and field both gone",
    Math.abs(bare.sd - bareGround.sd) < 0.3 && Math.max(...bare.rgb.map((v, i) => Math.abs(v - bareGround.rgb[i]))) < 2,
    `sd ${bare.sd.toFixed(2)} vs plain ${bareGround.sd.toFixed(2)}; ${bare.rgb.map(Math.round)} vs ${bareGround.rgb.map(Math.round)}`);
  save("onboarding-reduced-transparency", rt);
  await media(c, []);
  await sleep(300);
  await evalIn(c, `(() => { document.getElementById('live-card')?.remove(); return true; })()`);

  // ── Past onboarding, to the two decorated pages ────────────────────────────────────────────────
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.setInput(input, "Live");
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  for (const [palette, mode, tag] of [["Realm", "Dark", "realm-dark"], ["GitHub", "Light", "github-light"]]) {
    await evalIn(c, `__live.menu(${JSON.stringify(`Theme: ${mode}`)})`);
    await sleep(300);
    await evalIn(c, `__live.menu(${JSON.stringify(`Palette: ${palette}`)})`);
    await sleep(500);

    for (const [name, sel, re] of [["settings", ".settings-page-pane", "settings"], ["notifications", ".notifications-page-pane", "notification"]]) {
      await evalIn(c, `__live.openPage(${JSON.stringify(re)})`);
      await until(() => evalIn(c, `!!document.querySelector('${sel}')`), 15000, `${name} pane`);
      await sleep(450);
      const state = await evalIn(c, `__live.washState('${sel}')`);
      check(`10 ${name}/${tag}: the field paints and carries no texture`,
        !!state && state.image !== "none" && state.image.includes("gradient") && !state.image.includes("url("),
        `${(state?.image.match(/gradient/g) ?? []).length} gradients, ${(state?.image.match(/url\(/g) ?? []).length} textures`);

      const r = await evalIn(c, `__live.rect('${sel} .page-head')`);
      const png = await shot(c);
      save(`${name}-${tag}`, png);
      // The subtitle under the page title is --ink-2 sitting straight on the decorated ground.
      const ink = await evalIn(c, `__live.inkOf('${sel} .page-sub')`);
      const ground = await evalIn(c, `__live.patch(${JSON.stringify(png)}, ${JSON.stringify({ x: r.x + r.width - 90, y: r.y + 8, w: 60, h: 20 })})`);
      const ratio = contrast(ink, ground.rgb.map(Math.round));
      check(`11 ${name}/${tag}: the subtitle still clears its floor on the decorated ground`,
        ratio >= FLOOR.ink2, `${ratio.toFixed(2)}:1 against ${FLOOR.ink2} (ink ${ink}, ground ${ground.rgb.map(Math.round)})`);
      check(`12 ${name}/${tag}: the page ground is genuinely flat — no texture reached --canvas`,
        ground.sd < 2.2, `sd ${ground.sd.toFixed(2)}`);
    }

    // The first-run card cannot be reopened, so its markup is planted and resolved by the real
    // cascade — the point is to look at the grain on a light palette as well as a dark one.
    await evalIn(c, `__live.plantCard({ "--grain-hue": "24", "--grain-x": "70%", "--grain-y": "4%", "--grain-spread": "96%" })`);
    await sleep(500);
    const planted = await shot(c);
    save(`card-${tag}`, planted);
    const pr = await evalIn(c, `__live.rect('#live-card')`);
    const grainy = await evalIn(c, `__live.patch(${JSON.stringify(planted)}, ${JSON.stringify({ x: pr.x + 20, y: pr.y + 150, w: pr.width - 40, h: 60 })})`);
    check(`13 card/${tag}: the grain is visible on this palette too`, grainy.sd > 0.7, `sd ${grainy.sd.toFixed(2)}`);
    await evalIn(c, `(() => { document.getElementById('live-card')?.remove(); return true; })()`);
  }

  const errs = c.events.filter((e) => !/Autofill/.test(e));
  check("14 no renderer console errors", errs.length === 0, errs.join(" | "));
  c.close();
  console.log(failures === 0 ? "\nALL CLEAR" : `\n${failures} FAILED`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => { electron?.kill("SIGKILL"); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 1200);
  });
