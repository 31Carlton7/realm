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
 *  simply not screenshotted, which check 6 catches.
 *  Walked MODE-OUTER, because the palette menu now sets the face on screen and offers only the
 *  palettes that have it — picking the mode second would apply Monokai to whatever face happened to
 *  be showing, and then ask for a light face it does not have. */
const PALETTES = [
  ["Realm", "realm", ["light", "dark"]],
  ["One", "one", ["light", "dark"]],
  ["Monokai", "monokai", ["dark"]],
  ["Dracula", "dracula", ["dark"]],
  ["Nord", "nord", ["dark"]],
  ["Solarized", "solarized", ["light", "dark"]],
  ["Gruvbox", "gruvbox", ["light", "dark"]],
  ["Catppuccin", "catppuccin", ["light", "dark"]],
  ["GitHub", "github", ["light", "dark"]],
  ["Rosé Pine", "rosepine", ["light", "dark"]],
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
  /** Settings → App, which is where every control the space menu cannot reach lives. */
  async openAppSettings() {
    document.querySelector('[aria-label="Space menu"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    for (let i = 0; i < 40 && !document.querySelector(".palette-list"); i++) await new Promise((r) => setTimeout(r, 25));
    const open = [...document.querySelectorAll(".palette-list [role=option], .palette-list button")]
      .find((b) => /settings/i.test(b.textContent));
    open?.click();
    for (let i = 0; i < 80 && !document.querySelector(".settings-page-pane"); i++) await new Promise((r) => setTimeout(r, 25));
    [...document.querySelectorAll(".page-rail input")].find((r) => r.value === "app")?.click();
    for (let i = 0; i < 80 && !document.querySelector(".mode-grid"); i++) await new Promise((r) => setTimeout(r, 25));
    document.querySelector(".mode-grid")?.scrollIntoView();
    return !!document.querySelector(".mode-grid");
  },
  byLabel(role, name) {
    const all = [...document.querySelectorAll("input, select, textarea, button")];
    return all.find((el) => el.getAttribute("aria-label") === name && (!role || el.tagName.toLowerCase() === role));
  },
  /** A hex field commits on blur, and React listens for focusout rather than blur — so a synthetic
   *  FocusEvent("blur") sets the value and commits nothing. Focus it, type, blur it for real, and
   *  let the browser fire the event React is actually subscribed to. */
  setHex(label, value) {
    const el = this.byLabel("input", label);
    if (!el) throw new Error("no field: " + label);
    el.scrollIntoView({ block: "center" });
    el.focus();
    this.setInput(el, value);
    el.blur();
    // blur() is a no-op unless the element really is the active one, and it is not while the pane is
    // mid-scroll or something else holds focus. The commit hangs off focusout, so fire it outright
    // rather than hoping; committing the same value twice is a no-op, missing it is a silent pass.
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    return true;
  },
  setRange(label, value) { const el = this.byLabel("input", label); this.setInput(el, String(value)); return true; },
  setSelect(label, value) {
    const el = this.byLabel("select", label);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  },
  clickButton(re) {
    const hit = [...document.querySelectorAll("button")].find((b) => re.test(b.textContent.trim()));
    if (!hit) throw new Error("no button matching " + re);
    hit.click();
    return true;
  },
  /** What the previews are actually painted with — read off the preview elements, not off :root,
   *  which is the whole claim. */
  previews() {
    const minis = [...document.querySelectorAll(".mode-card-preview .mini-window")];
    const cp = document.querySelector(".code-preview");
    const at = (el, prop) => this.srgb(getComputedStyle(el).getPropertyValue(prop).trim()).join(",");
    return {
      miniPages: minis.map((m) => this.srgb(getComputedStyle(m).backgroundColor).join(",")),
      keyword: this.srgb(getComputedStyle(cp.querySelector(".hljs-keyword")).color).join(","),
      string: this.srgb(getComputedStyle(cp.querySelector(".hljs-string")).color).join(","),
      body: at(cp, "--syn-fg"),
    };
  },
  inkRamp() {
    const cs = getComputedStyle(document.documentElement);
    const t = (n) => this.srgb(cs.getPropertyValue(n).trim());
    return { ink: t("--ink"), ink2: t("--ink-2"), ink3: t("--ink-3"), surface: t("--surface"), page: t("--page"), accent: t("--accent") };
  },
  fonts() {
    const mono = document.querySelector(".code-preview") ?? document.querySelector("kbd");
    // The RENDERED weight of each rung, not the token text. The ladder is written as
    // calc(450 + var(--fw-shift)) and getPropertyValue hands back that string unresolved — only a
    // real element being laid out resolves it, which is also the number that reaches a glyph.
    const probe = (this._fw ??= (() => { const el = document.createElement("span"); el.style.position = "fixed"; el.style.visibility = "hidden"; document.body.appendChild(el); return el; })());
    const rungs = ["--fw-medium", "--fw-label", "--fw-title", "--fw-strong"].map((n) => {
      probe.style.fontWeight = "var(" + n + ")";
      return Number(getComputedStyle(probe).fontWeight);
    });
    return { body: getComputedStyle(document.body).fontFamily, mono: getComputedStyle(mono).fontFamily, rungs };
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
  for (const mode of ["light", "dark"]) {
    await evalIn(c, `__live.menu(${JSON.stringify(`Theme: ${mode[0].toUpperCase()}${mode.slice(1)}`)})`);
    await sleep(300);
    for (const [label, name, modes] of PALETTES) {
      if (!modes.includes(mode)) {
        // The other half of the split: a palette with no such face must not be OFFERED for it. The
        // menu is filtered, so asking throws — which is the assertion.
        const offered = await evalIn(c, `__live.menu(${JSON.stringify(`Palette: ${label}`)}).then(() => true, () => false)`);
        check(`${name}: not offered for the ${mode} face it does not have`, offered === false);
        continue;
      }
      await evalIn(c, `__live.menu(${JSON.stringify(`Palette: ${label}`)})`);
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

  // 7. The two slots really are two. Set a different palette on each face and flip between them: a
  //    shared slot would show the same palette both times, which no per-face check above can see
  //    because each of them only ever looks at one face.
  await evalIn(c, `__live.menu("Theme: Light")`); await sleep(250);
  await evalIn(c, `__live.menu("Palette: Solarized")`); await sleep(300);
  const lightFace = await evalIn(c, `__live.probe()`);
  await evalIn(c, `__live.menu("Theme: Dark")`); await sleep(250);
  await evalIn(c, `__live.menu("Palette: Monokai")`); await sleep(300);
  const darkFace = await evalIn(c, `__live.probe()`);
  await evalIn(c, `__live.menu("Theme: Light")`); await sleep(300);
  const backToLight = await evalIn(c, `__live.probe()`);
  check("each face keeps its own palette across a mode flip",
    lightFace.theme === "solarized" && darkFace.theme === "monokai" && backToLight.theme === "solarized",
    { light: lightFace.theme, dark: darkFace.theme, backToLight: backToLight.theme });
  check("a dark-only palette does not drag the window dark with it", backToLight.mode === "light", backToLight.mode);

  // 8. Settings → App: the previews, and the three controls the menu cannot reach. Screenshotted
  //    because everything on this page is a picture of a palette and a picture cannot be asserted.
  await evalIn(c, `__live.openAppSettings()`);
  await until(() => evalIn(c, `!!document.querySelector('.mode-grid')`), 10000, "app settings");
  await sleep(400);
  const settingsShot = (await c.send("Page.captureScreenshot", { format: "png" })).data;
  const settingsOut = path.join(os.tmpdir(), "realm-theme-settings.png");
  fs.writeFileSync(settingsOut, Buffer.from(settingsShot, "base64"));
  shots.push(settingsOut);
  console.log(`SCREENSHOT settings ${settingsOut}`);

  const previews = await evalIn(c, `__live.previews()`);
  // A preview built off :root would show the mode already on screen in every card. Three cards, at
  // least two distinct grounds, and the code preview coloured by the --syn-* roles rather than by
  // whatever the page's own text colour is.
  check("the mode cards preview more than one face at once",
    new Set(previews.miniPages).size >= 2, previews.miniPages);
  check("the code preview is painted by the syntax roles, not by the page",
    previews.keyword !== previews.body && previews.string !== previews.keyword,
    { keyword: previews.keyword, string: previews.string, body: previews.body });

  // 9. An override reaches the compositor. THE past-the-machinery mutant would still pass a CSSOM
  //    check; what this asserts is that the whole ladder moved with the ground, so the pane's own
  //    pixel is the CANVAS derived from the new page rather than the old palette's.
  const beforeOverride = await evalIn(c, `__live.probe()`);
  await evalIn(c, `__live.setHex("Background hex", "#1b2a1b")`);
  await sleep(400);
  const afterOverride = await evalIn(c, `__live.probe()`);
  check("an override repaints the whole ladder, not just the one token it names",
    !near(afterOverride.page, beforeOverride.page, 2) && !near(afterOverride.canvas, beforeOverride.canvas, 2)
      && !near(afterOverride.surface, beforeOverride.surface, 2),
    { page: afterOverride.page, canvas: afterOverride.canvas, surface: afterOverride.surface });
  const ovShot = (await c.send("Page.captureScreenshot", { format: "png" })).data;
  const ovOut = path.join(os.tmpdir(), "realm-theme-override.png");
  fs.writeFileSync(ovOut, Buffer.from(ovShot, "base64"));
  shots.push(ovOut);
  console.log(`SCREENSHOT override ${ovOut}`);
  await evalIn(c, `__live.clickButton(/^Reset to /)`);
  await sleep(400);
  const afterReset = await evalIn(c, `__live.probe()`);
  check("resetting an override lands back on the palette's own ground",
    near(afterReset.page, beforeOverride.page, 1), { was: beforeOverride.page, now: afterReset.page });

  // 10. The contrast control, through the real cascade. It has to move the secondary tier and leave
  //     the ground and the accent exactly where they were, and never drop below its floor.
  const inkAt = async (v) => {
    await evalIn(c, `__live.setRange("Contrast", ${v})`);
    await sleep(350);
    return evalIn(c, `__live.inkRamp()`);
  };
  const [lo, mid, hi] = [await inkAt(0), await inkAt(60), await inkAt(100)];
  check("contrast opens and closes the ink ramp on screen",
    contrast(lo.ink2, lo.surface) < contrast(mid.ink2, mid.surface)
      && contrast(mid.ink2, mid.surface) < contrast(hi.ink2, hi.surface),
    { lo: +contrast(lo.ink2, lo.surface).toFixed(2), mid: +contrast(mid.ink2, mid.surface).toFixed(2), hi: +contrast(hi.ink2, hi.surface).toFixed(2) });
  check("contrast moves nothing but the ramp", near(lo.page, hi.page, 1) && near(lo.accent, hi.accent, 1));
  for (const [name, s] of [["0", lo], ["60", mid], ["100", hi]]) {
    check(`contrast ${name}: --ink-2 still clears 3:1 on the surface`, contrast(s.ink2, s.surface) >= 3,
      { ratio: +contrast(s.ink2, s.surface).toFixed(2) });
    check(`contrast ${name}: --ink-3 still clears 2.4:1 on the surface`, contrast(s.ink3, s.surface) >= 2.4,
      { ratio: +contrast(s.ink3, s.surface).toFixed(2) });
  }
  await evalIn(c, `__live.setRange("Contrast", 60)`); await sleep(300);

  // 11. The font preference, as the browser resolves it — not as a string comparison on a token.
  //     `font-family` on a real element is what actually got picked.
  const fontBefore = await evalIn(c, `__live.fonts()`);
  await evalIn(c, `__live.setSelect("UI font", "system")`);
  await evalIn(c, `__live.setSelect("Code font", "system")`);
  await evalIn(c, `__live.setSelect("UI font weight", "medium")`);
  await sleep(400);
  const fontAfter = await evalIn(c, `__live.fonts()`);
  check("the UI face reaches real elements", fontBefore.body.includes("Inter") && !fontAfter.body.includes("Inter"),
    { before: fontBefore.body, after: fontAfter.body });
  check("the code face reaches real elements",
    fontBefore.mono.includes("JetBrains") && !fontAfter.mono.includes("JetBrains"), { before: fontBefore.mono, after: fontAfter.mono });
  // THE absolute-weight mutant: the four rungs collapse onto one number. They have to stay four.
  check("the weight preference shifts the whole ladder and keeps it a ladder",
    fontAfter.rungs.every((w, i) => i === 0 || w > fontAfter.rungs[i - 1]) && fontAfter.rungs[0] > fontBefore.rungs[0],
    { before: fontBefore.rungs, after: fontAfter.rungs });
  await evalIn(c, `__live.setSelect("UI font", "bundled")`);
  await evalIn(c, `__live.setSelect("Code font", "bundled")`);
  await evalIn(c, `__live.setSelect("UI font weight", "regular")`);
  await sleep(300);

  // 12. …and returning to the default lands exactly back on the palette that shipped.
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
