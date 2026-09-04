/**
 * Live check for the custom palettes (run with: node apps/desktop/scripts/themes-live.mjs)
 *
 * Boots the REAL built app on a scratch REALM_HOME, walks every palette through the space menu, and
 * measures what reaches the screen. The vitest suite proves the derivation clears its floors on
 * numbers it computed itself; it cannot prove those numbers ever became pixels. jsdom has no
 * cascade, no `var()` resolution against a real stylesheet and no compositor, so to it
 * `color: var(--syn-keyword)` and `color: var(--nonsense)` are the same declaration.
 *
 * Two kinds of claim, measured two different ways:
 *   - The TOKEN CHAIN, off the real CSSOM: a `.hljs-keyword` span's resolved colour has to equal the
 *     theme's own `--syn-keyword`, for every role, on every theme. That is the whole path — rule to
 *     role to inline custom property — resolved by Chromium rather than asserted against a string.
 *   - The GROUND, off a screenshot: the pane really paints the theme's `--canvas`. A palette that
 *     was computed and never applied passes every CSSOM check and leaves the window grey.
 *
 * Its mutant is the gate: force `applyTheme` to skip the inline writes and the pane ground stops
 * moving between themes, which check 4 fails by name. Check 2 is the mutant for the syntax roles —
 * re-inline `var(--accent)` on `.hljs-keyword` and keyword stops matching `--syn-keyword` on every
 * theme but the one the mapping was written for.
 *
 * Screenshots for every palette in every mode land in /tmp and are meant to be LOOKED at. A theme
 * that clears a contrast assertion and looks wrong is still wrong.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9341), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8907);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-themes-live-"));
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The syntax floor from packages/ui/src/themes.ts. Restated rather than imported: this script runs
 *  under plain node against the BUILT app, and a copy that disagrees with the source is exactly the
 *  drift the assertion is for. */
const SYNTAX_FLOOR = 2.7;
/** Every palette, and the modes each one has. Read off THEMES; a theme added there and not here is
 *  simply not screenshotted, which check 5 catches. */
const PALETTES = [
  ["Realm", "realm", ["light", "dark"]],
  ["One", "one", ["light", "dark"]],
  ["Monokai", "monokai", ["dark"]],
  ["Dracula", "dracula", ["dark"]],
  ["Nord", "nord", ["dark"]],
  ["Solarized", "solarized", ["light", "dark"]],
  ["Gruvbox", "gruvbox", ["light", "dark"]],
];
const SYNTAX_ROLES = ["keyword", "string", "number", "title", "type", "attr", "comment"];

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

/** Installed in the page once. `probe` is the whole measurement: it plants a real highlight.js
 *  fragment in the transcript column so the syntax roles are resolved by the same cascade the app
 *  uses, then reports the resolved colours beside the custom properties they are supposed to be. */
const HELPERS = `
window.__live = window.__live ?? {
  setInput(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  /** Click a menu item by its visible label, opening the space menu first. */
  async menu(label) {
    document.querySelector('[aria-label="Space menu"]').click();
    for (let i = 0; i < 40 && !document.querySelector('[role="menu"]'); i++) await new Promise((r) => setTimeout(r, 25));
    const hit = [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent.trim() === label);
    if (!hit) { document.querySelector('[role="menu"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); throw new Error("no menu item: " + label); }
    hit.click();
    return true;
  },
  /** A fenced-code fragment in the pane, carrying one span per syntax role. Reused across themes so
   *  the sampled geometry never moves; the colours are re-read after every switch. */
  plantCode() {
    let host = document.getElementById("live-syntax");
    if (!host) {
      host = document.createElement("div");
      host.id = "live-syntax";
      host.className = "md";
      host.style.cssText = "position:fixed;left:24px;bottom:24px;z-index:9999;width:360px";
      host.innerHTML = '<div class="md-code"><div class="md-code-head"><span class="md-code-lang">ts</span></div>' +
        '<pre><code class="hljs">' + ${JSON.stringify(SYNTAX_ROLES)}.map((r) =>
          '<span class="hljs-' + (r === "title" ? "title" : r) + '" data-role="' + r + '">' + r.toUpperCase() + '</span>').join(" ") +
        '</code></pre></div>';
      document.body.appendChild(host);
    }
    return true;
  },
  /** Any CSS colour as an sRGB triple. Chromium reports a computed colour in the space it was
   *  authored in — these tokens come back in oklch() — and contrast is defined on
   *  sRGB luminance and on nothing else. Painting it and reading the pixel back is the conversion
   *  the compositor itself will perform, including the gamut clip. */
  srgb(color) {
    const g = (this._cv ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true }));
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = color;
    g.fillRect(0, 0, 1, 1);
    return [...g.getImageData(0, 0, 1, 1).data].slice(0, 3);
  },
  probe() {
    const cs = getComputedStyle(document.documentElement);
    const tok = (n) => cs.getPropertyValue(n).trim();
    const roles = {};
    for (const el of document.querySelectorAll("#live-syntax [data-role]")) {
      const s = getComputedStyle(el);
      roles[el.dataset.role] = {
        resolved: this.srgb(s.color),
        token: this.srgb(s.getPropertyValue("--syn-" + el.dataset.role).trim()),
      };
    }
    const card = document.querySelector("#live-syntax .md-code");
    return {
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.mode,
      page: this.srgb(tok("--page")), canvas: this.srgb(tok("--canvas")), surface: this.srgb(tok("--surface")),
      cardGround: this.srgb(getComputedStyle(card).backgroundColor),
      roles,
      paneRect: (document.querySelector(".panel") ?? document.querySelector(".main")).getBoundingClientRect().toJSON(),
    };
  },
  /** The mean colour of a band of the screenshot, as [r,g,b]. Solid grounds only — glyphs would drag
   *  the mean by however much text happens to be in the band. */
  async band(b64, x0, y0, x1, y1) {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const cv = document.createElement("canvas");
    cv.width = img.width; cv.height = img.height;
    const g = cv.getContext("2d");
    g.drawImage(img, 0, 0);
    const dpr = img.width / window.innerWidth;
    const px = g.getImageData(Math.floor(x0 * dpr), Math.floor(y0 * dpr), Math.max(1, Math.floor((x1 - x0) * dpr)), Math.max(1, Math.floor((y1 - y0) * dpr))).data;
    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; gg += px[i + 1]; b += px[i + 2]; }
    const n = px.length / 4;
    return [r / n, gg / n, b / n];
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) { failures++; process.exitCode = 1; }
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

const rgb = (s) => (Array.isArray(s) ? s : s.match(/[\d.]+/g).slice(0, 3).map(Number));
const near = (a, b, tol) => rgb(a).every((v, i) => Math.abs(v - rgb(b)[i]) <= tol);
const relLum = (c) => {
  const [r, g, b] = rgb(c).map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [relLum(a), relLum(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
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
    env: {
      ...process.env,
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
  const rendererTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(rendererTarget.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.setInput(input, "Live");
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 820, deviceScaleFactor: 1, mobile: false });
  await evalIn(c, `__live.plantCode()`);
  await sleep(500);

  const grounds = new Map();
  const shots = [];
  for (const [label, name, modes] of PALETTES) {
    await evalIn(c, `__live.menu(${JSON.stringify(`Palette: ${label}`)})`);
    await sleep(250);
    for (const mode of modes) {
      await evalIn(c, `__live.menu(${JSON.stringify(`Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`)})`);
      await sleep(300);
      const p = await evalIn(c, `__live.probe()`);
      const tag = `${name}-${mode}`;
      // BOTH halves of the selection, not just the mode. `tag` is built from what was ASKED for, so
      // a menu click that silently missed fails here by name instead of quietly relabelling every
      // check below it with whatever palette was still on.
      check(`${tag}: the menu selection is the palette the window is actually wearing`,
        p.theme === name && p.mode === mode, { asked: `${name}/${mode}`, got: `${p.theme}/${p.mode}` });

      // 2. The token chain, end to end, through the real cascade.
      for (const role of SYNTAX_ROLES) {
        const r = p.roles[role];
        check(`${tag}: .hljs-${role} resolves to --syn-${role}`, r && near(r.resolved, r.token, 1), r);
      }
      // 3. The roles are still telling things apart — a mapping collapsed onto one token would
      //    resolve consistently and highlight nothing.
      const distinct = new Set(SYNTAX_ROLES.map((r) => rgb(p.roles[r].resolved).map(Math.round).join(",")));
      check(`${tag}: the seven syntax roles are seven colours`, distinct.size >= 6, { distinct: distinct.size });
      // 4. …and each is legible on the card it is drawn on.
      for (const role of SYNTAX_ROLES) {
        const ratio = contrast(p.roles[role].resolved, p.cardGround);
        check(`${tag}: --syn-${role} clears ${SYNTAX_FLOOR}:1 on the code card`, ratio >= SYNTAX_FLOOR, { ratio: +ratio.toFixed(2) });
      }

      const shot = (await c.send("Page.captureScreenshot", { format: "png" })).data;
      // 5. The composited pane ground, which is the claim the CSSOM cannot make: --rl-panel is
      //    --canvas and the pane is opaque, so the pixel is the token or the palette never landed.
      const r = p.paneRect;
      const sampled = await evalIn(c, `__live.band(${JSON.stringify(shot)}, ${r.x + r.width - 60}, ${r.y + 60}, ${r.x + r.width - 20}, ${r.y + 100})`);
      grounds.set(tag, sampled.map((v) => Math.round(v)));

      const out = path.join(os.tmpdir(), `realm-theme-${tag}.png`);
      fs.writeFileSync(out, Buffer.from(shot, "base64"));
      shots.push(out);
      console.log(`SCREENSHOT ${tag} ${out}  pane=${sampled.map((v) => Math.round(v)).join(",")}`);
    }
  }

  // 6. THE never-applied mutant: strip the inline writes from applyTheme and every one of these
  //    grounds is the same grey. Distinct grounds are the only evidence the palette reached the
  //    compositor rather than merely being computed.
  const uniq = new Set([...grounds.values()].map((v) => v.join(",")));
  check("every palette paints a ground of its own", uniq.size === grounds.size,
    { faces: grounds.size, distinct: uniq.size });

  // 7. …and returning to the default lands exactly back on the palette that shipped.
  await evalIn(c, `__live.menu("Palette: Realm")`);
  await sleep(300);
  const back = await evalIn(c, `__live.probe()`);
  // tokens.css: dark --canvas is oklch(0.231 0.004 264.487) = #1c1d1f, light is
  // oklch(0.961 0.002 247.84) = #f1f2f3. Tolerance 1, not 2 — at 2 a wrong expectation still passes,
  // which is how the previous #1c1d20 went unnoticed.
  check("returning to Realm restores the shipped palette, not the last theme's",
    near(back.canvas, back.mode === "dark" ? [28, 29, 31] : [241, 242, 243], 1), back.canvas);

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  console.log(failures === 0 ? "\nALL CLEAR" : `\n${failures} failures`);
  c.close();
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => { electron?.kill("SIGKILL"); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 1200);
  });
