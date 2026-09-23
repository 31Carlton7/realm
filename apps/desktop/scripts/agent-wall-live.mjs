/**
 * Live check for the Agents wall and the fan-out sheet
 * (run with: node apps/desktop/scripts/agent-wall-live.mjs)
 *
 * jsdom has no layout, so the unit tests can say the tiles EXIST and nothing about whether they
 * lay out as a field, whether the live line survives its column, or whether anything on them fell
 * under the 11px type floor. All three are measurements, so they are measured here, in the real
 * renderer, against real sessions that reached a real state.
 *
 * The wall is staged with sessions that END IN ERROR rather than sessions mid-turn, and that is a
 * property of the check rather than a compromise: a turn cannot be held still long enough to
 * photograph, while `Failed` is a live group that stays put and carries a real activity line — the
 * error the adapter actually raised. What is being measured — the grid, the three lines of a tile,
 * the type — is the same in any of the three live states.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9374), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8941);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-agent-wall-"));
let electron = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function socket(url, protocols) {
  const ws = new WebSocket(url, protocols);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  return { ws, ready, pending, next: () => ++id };
}

function cdp(wsUrl) {
  const s = socket(wsUrl);
  return {
    ready: s.ready,
    send: (method, params) => new Promise((res, rej) => {
      const i = s.next();
      s.pending.set(i, (msg) => (msg.error ? rej(new Error(msg.error.message)) : res(msg.result)));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
  };
}

function rpc(port, token) {
  const s = socket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  return {
    ready: s.ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(s.next());
      s.pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
  };
}

const HELPERS = `
globalThis.__live = {
  dest(label) {
    const row = [...document.querySelectorAll('.sb-destinations .dest-row')].find((b) => b.textContent.trim().startsWith(label));
    if (!row) throw new Error('no destination: ' + label);
    row.click();
    return true;
  },
  view(label) {
    const b = [...document.querySelectorAll('.agents-view')].find((x) => x.textContent.trim() === label);
    if (!b) throw new Error('no view button: ' + label);
    b.click();
    return b.getAttribute('aria-pressed');
  },
  /* Every tile's rendered box plus the parts a reader has to be able to read: what it is doing, the
     folder that tells a fan-out apart, and the smallest type on it. */
  tiles() {
    return [...document.querySelectorAll('.agent-tile')].map((t) => {
      const r = t.getBoundingClientRect();
      const doing = t.querySelector('.agent-tile-doing-text');
      const sizes = [...t.querySelectorAll('*')]
        .map((el) => parseFloat(getComputedStyle(el).fontSize))
        .filter((n) => Number.isFinite(n) && n > 0);
      return {
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        title: t.querySelector('.agent-tile-title')?.textContent ?? '',
        doing: doing?.textContent ?? null,
        /* The line is one line or it is not a line: a tile that wraps its activity into three rows
           is the "splattered text" the guidelines name, and only a real box can say. */
        doingLines: doing ? Math.round(doing.getBoundingClientRect().height / parseFloat(getComputedStyle(doing).lineHeight)) : 0,
        doingOverflows: doing ? doing.scrollWidth > doing.clientWidth + 1 : false,
        folder: t.querySelector('.agent-tile-mono')?.textContent ?? '',
        minType: sizes.length ? Math.min(...sizes) : null,
      };
    });
  },
  wall() {
    const g = document.querySelector('.agent-wall');
    if (!g) return null;
    const cols = getComputedStyle(g).gridTemplateColumns.split(' ').filter(Boolean);
    const r = g.getBoundingClientRect();
    return { columns: cols.length, width: Math.round(r.width), x: Math.round(r.x), y: Math.round(r.y),
             height: Math.round(r.height) };
  },
  groups() {
    return [...document.querySelectorAll('.agents-group')].map((s) => s.getAttribute('aria-label'));
  },
  openFanOut() {
    const b = [...document.querySelectorAll('.page-head button')].find((x) => x.textContent.trim().startsWith('Start agents'));
    if (!b) throw new Error('no fan-out button');
    b.click();
    return true;
  },
  /* The hint has to read as a hint. This stylesheet has no generic placeholder rule — every field
     opts in — so the failure mode is a field whose hint renders at the weight of typed text. */
  placeholder(sel) {
    const el = document.querySelector(sel);
    if (!el) throw new Error('no field: ' + sel);
    return { hint: getComputedStyle(el, '::placeholder').color, typed: getComputedStyle(el).color };
  },
  focusRing() {
    const el = document.activeElement;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { cls: el.className, outline: cs.outlineWidth, shadow: cs.boxShadow !== 'none' };
  },
  /* What the farm actually PAINTED. jsdom has no canvas at all, so every claim about the sprites
     reaching the screen — that they draw, that they move, that they stop — can only be made here.
     Returns the ink (non-transparent pixel count) and the distinct colours, which is how a field
     painted in one accent-derived ramp is told from one painting whatever it likes. */
  farm() {
    const el = document.querySelector('.agent-office-canvas');
    if (!el) return null;
    const ctx = el.getContext('2d');
    const px = ctx.getImageData(0, 0, el.width, el.height).data;
    const seen = new Map();
    let ink = 0, sumX = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      ink++;
      sumX += ((i / 4) % el.width);
      const k = px[i] + ',' + px[i + 1] + ',' + px[i + 2] + ',' + px[i + 3];
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    /* A content hash, because ink and centroid are too coarse to see this move: a typing frame
       differs from its neighbour by a few pixels of HAND, which changes neither the number of opaque
       pixels nor their mean x. Measured — both were identical across an animating office, and the
       'nothing is moving' that suggested was the metric's, not the engine's. FNV-1a over every
       fourth byte: enough to catch a hand, cheap enough to run per sample. */
    let hash = 0x811c9dc5;
    for (let i = 0; i < px.length; i += 16) {
      hash ^= px[i]; hash = Math.imul(hash, 0x01000193);
    }
    return { ink, colours: [...seen.keys()], centroid: ink ? Math.round(sumX / ink) : 0, hash: hash >>> 0,
             w: el.width, h: el.height, quiet: document.documentElement.hasAttribute('data-quiet') };
  },
  sheet() {
    const el = document.querySelector('.sheet');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const note = document.querySelector('.fan-out-note');
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
             note: note?.textContent ?? null,
             /* The primary action must be reachable without scrolling the sheet — a first-run rule
                this sheet is also bound by. */
             actionInView: (() => {
               const a = document.querySelector('.sheet-actions .btn.primary');
               if (!a) return false;
               const ar = a.getBoundingClientRect();
               return ar.bottom <= r.bottom + 1 && ar.top >= r.top;
             })(),
             minType: Math.min(...[...el.querySelectorAll('*')]
               .map((x) => parseFloat(getComputedStyle(x).fontSize))
               .filter((n) => Number.isFinite(n) && n > 0)) };
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function shot(c, tag, clip) {
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
  const out = path.join(os.tmpdir(), `realm-agent-wall-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
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
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: path.join(repoRoot, "apps/desktop/out/main/index.js"),
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
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Live');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  /* Six agents through the real create/send seam, each parked on a permission the fake agent holds
     open (`needsPermission` blocks its adapter until a decision arrives). That is the only state a
     session can be HELD in long enough to photograph: a turn settles in milliseconds, a scripted
     throw is what failover absorbs, and a failed spawn ends the session rather than failing it —
     all three measured, none of them stays put. `Needs you` is also the group the page exists for.
     Titles are set here only so the tiles are told apart in the capture; the product leaves them to
     the server's own generator. */
  const api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const space = (await api.call("spaces.list", {}))[0];
  const briefs = ["Rework the mapper", "Port the picker", "Chase the checkpoint flake",
    "Audit the adapters", "Trim the transcript reducer", "Measure the pane divider"];
  for (const title of briefs) {
    const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title });
    // Not awaited: the send does not resolve until the permission is answered, which is the point.
    void api.call("sessions.send", { id: session.id, text: "ask me" }).catch(() => {});
  }

  await evalIn(c, `__live.dest("Agents")`);
  await until(() => evalIn(c, `__live.groups().length > 0`), 20000, "agents page");
  await sleep(600);
  await shot(c, "list");

  await evalIn(c, `__live.view("Wall")`);
  const pressed = await until(() => evalIn(c,
    `[...document.querySelectorAll('.agents-view')].find((b) => b.textContent.trim() === 'Wall')?.getAttribute('aria-pressed')`),
    5000, "wall pressed");
  check("the wall is a view you can switch to, and the button says it is on", pressed === "true", pressed);
  await until(() => evalIn(c, `!!__live.wall()`), 15000, "wall");
  await until(() => evalIn(c, `__live.tiles().length >= 6`), 20000, "tiles");
  await sleep(700);

  const wall = await evalIn(c, `__live.wall()`);
  const tiles = await evalIn(c, `__live.tiles()`);
  const groups = await evalIn(c, `__live.groups()`);
  await shot(c, "wall");

  check("the wall draws a field, not a column: several tiles per row at a full pane width",
    wall.columns >= 3, wall);
  check("history stays on the list — no Ready or Ended group on the wall",
    !groups.includes("Ready") && !groups.includes("Ended"), groups);
  check("the blocked ones are what the wall opens on", groups[0] === "Needs you", groups);
  check("every tile carries the live line the list cannot show",
    tiles.length >= 6 && tiles.every((t) => t.doing && t.doing.trim().length > 0),
    tiles.map((t) => t.doing));
  check("the line stays ONE line, clipped rather than wrapped",
    tiles.every((t) => t.doingLines === 1), tiles.map((t) => t.doingLines));
  check("every tile keeps the folder that tells a fan-out's agents apart",
    tiles.every((t) => t.folder.trim().length > 0), tiles.map((t) => t.folder));
  check("nothing on a tile is set below the 11px type floor",
    tiles.every((t) => t.minType >= 11), tiles.map((t) => t.minType));
  /* Tiles in one row are peers and must read as peers: a row of cards at three different heights is
     the repetition the guidelines allow being spent on something that is not actually uniform. */
  const rows = new Map();
  for (const t of tiles) { const k = t.y; rows.set(k, [...(rows.get(k) ?? []), t.h]); }
  check("tiles sharing a row share a height",
    [...rows.values()].every((hs) => Math.max(...hs) - Math.min(...hs) <= 1), [...rows.entries()]);
  /* A card is as tall as its content. The failure this pins is the one the session summary shipped:
     a panel that took its container's height and drew empty surface under three short rows. */
  check("a tile is as tall as its three lines, not as tall as the space it was given",
    tiles.every((t) => t.h > 50 && t.h < 130), tiles.map((t) => t.h));

  await evalIn(c, `__live.openFanOut()`);
  await until(() => evalIn(c, `!!__live.sheet()`), 10000, "fan-out sheet");
  await sleep(500);
  const sheet = await evalIn(c, `__live.sheet()`);
  await shot(c, "fan-out");
  check("the fan-out sheet's primary action is live without scrolling it", sheet.actionInView, sheet);
  check("the sheet names what the worktree switch being on is FOR",
    /cannot overwrite each other/.test(sheet.note ?? ""), sheet.note);
  check("nothing in the sheet is set below the 11px type floor", sheet.minType >= 11, sheet.minType);

  /* The hint on the one field this sheet is FOR. Measured rather than read off the stylesheet: what
     a missing rule renders as is the UA's answer, which no amount of reading the CSS will tell you. */
  const ph = await evalIn(c, `__live.placeholder('.fan-out-brief')`);
  check("the brief's placeholder reads as a hint, not as typed text", ph.hint !== ph.typed, ph);

  /* Tab from the brief: the next control must show where the keyboard is. */
  await evalIn(c, `(() => { document.querySelector('.fan-out-brief').focus(); return true; })()`);
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await sleep(250);
  const ring = await evalIn(c, `__live.focusRing()`);
  check("tab moves inside the sheet and the focused control is visibly focused",
    !!ring && (parseFloat(ring.outline) > 0 || ring.shadow), ring);

  await evalIn(c, `(() => { document.querySelector('.sheet-head .icon-btn').click(); return true; })()`);
  await sleep(300);

  /* Light is an equal mode, not an inverted screenshot of the dark one, so the wall is looked at in
     both. The type floor and the one-line clip are face-independent; what is not is whether the
     tile is still a distinct object against its ground, which the capture is for. */
  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await until(() => evalIn(c, `document.documentElement.getAttribute('data-mode') === 'light'`), 8000, "light face");
  await sleep(400);
  const lightTiles = await evalIn(c, `__live.tiles()`);
  await shot(c, "wall-light");
  check("the wall survives the light face: same tiles, same one-line clip, same floor",
    lightTiles.length === tiles.length && lightTiles.every((t) => t.doingLines === 1 && t.minType >= 11),
    lightTiles.map((t) => ({ lines: t.doingLines, type: t.minType })));
  await c.send("Emulation.setEmulatedMedia", { features: [] });
  await sleep(300);

  /* A narrow pane. The grid must recompose to fewer columns rather than overflow, and the line must
     still clip to one row — the two things `auto-fill` plus a min track are supposed to guarantee
     and which only a real layout can confirm. */
  await c.send("Emulation.setDeviceMetricsOverride", { width: 820, height: 700, deviceScaleFactor: 2, mobile: false });
  await sleep(600);
  const narrowWall = await evalIn(c, `__live.wall()`);
  const narrowTiles = await evalIn(c, `__live.tiles()`);
  await shot(c, "wall-narrow");
  check("a narrow pane recomposes to fewer columns instead of overflowing",
    narrowWall.columns >= 1 && narrowWall.columns < wall.columns, { narrow: narrowWall, wide: wall });
  check("and the live line still clips to one row at the narrow width",
    narrowTiles.every((t) => t.doingLines === 1), narrowTiles.map((t) => t.doingLines));
  check("no tile overflows its grid at the narrow width",
    narrowTiles.every((t) => t.x >= narrowWall.x - 1 && t.x + t.w <= narrowWall.x + narrowWall.width + 1),
    narrowTiles.map((t) => [t.x, t.w]));

  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  // ── The office ────────────────────────────────────────────────────────────
  await evalIn(c, `__live.view("Office")`);
  await until(() => evalIn(c, `!!document.querySelector('.agent-office-canvas')`), 10000, "office canvas");
  await sleep(1500);

  const farm = await evalIn(c, `__live.farm()`);
  await shot(c, "office");
  check("the office draws — a room with people in it, not an empty canvas",
    farm.ink > 5000, { ink: farm.ink, w: farm.w, h: farm.h });
  /* The office is full pixel art, so unlike the one-hue field it replaced there is nothing to assert
     about its palette — what IS assertable is that it is drawing many colours rather than a flat
     fill, which is the difference between a rendered room and a cleared canvas. */
  check("it is pixel art rather than a flat fill", farm.colours.length > 20, farm.colours.length);

  /* Counts the office's OWN draws by watching the one call every frame makes, and collects anything
     the renderer threw while doing it. A room that is not moving is either a loop that is not
     running or a loop that is running and drawing the same thing; only this can tell them apart. */
  const drawProbe = await evalIn(c, `(async () => {
    const proto = CanvasRenderingContext2D.prototype;
    const real = proto.clearRect;
    let draws = 0;
    const errs = [];
    const onErr = (e) => errs.push(String(e.message ?? e.reason ?? e));
    window.addEventListener('error', onErr); window.addEventListener('unhandledrejection', onErr);
    proto.clearRect = function (...a) { draws++; return real.apply(this, a); };
    await new Promise((r) => setTimeout(r, 1200));
    proto.clearRect = real;
    window.removeEventListener('error', onErr); window.removeEventListener('unhandledrejection', onErr);
    return { draws, errs: errs.slice(0, 3) };
  })()`);
  check("the office's frame loop is actually running", drawProbe.draws > 20, drawProbe);
  const focus = await evalIn(c, `({ quiet: document.documentElement.getAttribute('data-quiet'), focused: document.hasFocus() })`);
  check("the window is not already parked — otherwise every check below it is vacuous",
    focus.quiet === null, focus);

  const moved = await until(async () => {
    const a = await evalIn(c, `__live.farm()`);
    await sleep(700);
    const b = await evalIn(c, `__live.farm()`);
    return a.hash !== b.hash ? { a: a.hash, b: b.hash } : null;
  }, 15000, "office motion").catch(() => null);
  check("the characters are alive — the room changes between frames", !!moved, moved);

  /* The power contract, which the vendored engine's own loop does NOT implement: upstream's
     `startGameLoop` is an unconditional rAF. This is the check that Realm's replacement does. */
  await evalIn(c, `(() => { document.documentElement.setAttribute('data-quiet', 'always'); return true; })()`);
  await sleep(700);
  const q1 = await evalIn(c, `__live.farm()`);
  await sleep(1000);
  const q2 = await evalIn(c, `__live.farm()`);
  check("under data-quiet the office freezes where it stands — the loop is stopped, not throttled",
    q1.hash === q2.hash, { q1: q1.hash, q2: q2.hash });
  check("…and it is frozen rather than blanked, like every other paused animation in the app",
    q2.ink > 5000, q2.ink);
  await evalIn(c, `(() => { document.documentElement.removeAttribute('data-quiet'); return true; })()`);
  await sleep(800);

  await c.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  await sleep(1000);
  const r1 = await evalIn(c, `__live.farm()`);
  await sleep(1000);
  const r2 = await evalIn(c, `__live.farm()`);
  check("with reduced motion the office stands still, and still stands there",
    r1.hash === r2.hash && r2.ink > 5000, { r1: r1.hash, r2: r2.hash, ink: r2.ink });
  await c.send("Emulation.setEmulatedMedia", { features: [] });
  const resumed = await until(async () => {
    const a = await evalIn(c, `__live.farm()`);
    await sleep(700);
    const b = await evalIn(c, `__live.farm()`);
    return a.hash !== b.hash ? true : null;
  }, 15000, "office resume").catch(() => false);
  check("and it starts again when the preference goes away", resumed === true);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    electron?.kill("SIGTERM");
    await sleep(600);
    electron?.kill("SIGKILL");
    fs.rmSync(scratch, { recursive: true, force: true });
  });
