/**
 * Live check for the redesigned model picker (run with: node apps/desktop/scripts/model-picker-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME and proves the things a jsdom test cannot, because they
 * are all questions about LAYOUT and about the NETWORK:
 *
 *  - the prompter carries ONE chip, not the old harness+model pair;
 *  - the popover is genuinely two columns — the detail pane sits beside the list, not under it;
 *  - the effort control fits on ONE line (the wrapped strip in the old design is the bug that
 *    started this rework, and jsdom, having no layout, could never have seen it);
 *  - the detail pane fills with REAL prices from the public catalog, through the server's own
 *    `models.catalog` — the whole point of sourcing them live rather than hardcoding them.
 *
 * The catalog check is reported but not fatal: a machine with no network is a supported state, and
 * the picker's contract is that it opens anyway. Everything else is a hard failure.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9341), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8907);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-picker-live-"));
const results = {};
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
    const set = Object.getOwnPropertyDescriptor(proto, "value").set;
    set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true }));
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  results[name] = { pass: !!cond, ...(detail !== undefined ? { detail } : {}) };
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

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

  await c.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  // 1. One chip. The harness menu is gone; the model chip carries the harness's mark instead.
  const chips = await evalIn(c, `(() => {
    const row = document.querySelector('.composer-actions');
    const btns = [...row.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'));
    const chip = row.querySelector('button[aria-label="Model"]');
    return { btns, title: chip?.title ?? null, brand: chip?.querySelector('[data-brand]')?.dataset.brand ?? null };
  })()`);
  check("the control row has a Model chip and no Harness chip", chips.btns.includes("Model") && !chips.btns.includes("Harness"), chips);
  check("the one chip still names the harness", /through /.test(chips.title ?? ""), { title: chips.title, brand: chips.brand });

  await evalIn(c, `(() => { document.querySelector('button[aria-label="Model"]').click(); return true; })()`);
  await sleep(400);

  // 2. Two columns, side by side — the layout claim. Measured, because "beside" is a fact about
  //    boxes: a detail pane that wrapped under the list would still pass every jsdom assertion.
  const layout = await evalIn(c, `(() => {
    const r = (s) => { const n = document.querySelector(s); if (!n) return null; const b = n.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
    return { picker: r('.model-picker'), list: r('.mp-list'), detail: r('.mp-detail') };
  })()`);
  check("the popover has both a list and a detail pane", !!layout.list && !!layout.detail, layout);
  check("the detail pane sits BESIDE the list, not below it",
    layout.detail && layout.list && layout.detail.left >= layout.list.right - 1 && layout.detail.top < layout.list.bottom, layout);
  check("the popover fits its own declared width", layout.picker && Math.abs(layout.picker.w - 620) <= 1, { width: layout.picker?.w });

  // 3. The effort strip on ONE line. This is the regression the rework exists to fix: five levels in
  //    a wrapping flex row broke onto a second line at this width, and "Max" sat alone under "Low".
  const effort = await evalIn(c, `(() => {
    const group = [...document.querySelectorAll('.mp-seg-group')].find((g) => g.getAttribute('aria-label') === 'Effort');
    if (!group) return null;
    const tops = [...group.querySelectorAll('.mp-seg-opt')].map((b) => Math.round(b.getBoundingClientRect().top));
    return { labels: [...group.querySelectorAll('.mp-seg-opt')].map((b) => b.textContent), rows: [...new Set(tops)].length };
  })()`);
  check("all five effort levels sit on one line", effort && effort.labels.length === 5 && effort.rows === 1, effort);

  // 4. Real prices, from the real catalog, through the real server. Reported rather than enforced:
  //    offline is a supported state and the picker must open regardless.
  const priced = await until(async () => evalIn(c, `(() => {
    const stats = [...document.querySelectorAll('.mp-stat')].map((s) => s.textContent);
    const note = document.querySelector('.mp-detail-note')?.textContent ?? null;
    const rowPrices = [...document.querySelectorAll('.mp-row-price')].map((n) => n.textContent);
    return stats.length ? { stats, note, rowPrices: rowPrices.slice(0, 4) } : null;
  })()`), 20000, "catalog prices").catch(() => null);
  if (priced) {
    check("the detail pane shows a per-million price pair from the live catalog",
      priced.stats.some((s) => s.includes("/ Mtok")), priced);
  } else {
    console.log("SKIP live catalog prices — no rows priced within 20s (offline is a supported state)");
  }

  // 5. The harness's own sentences: what it is for, and how it bills. The line that keeps a
  //    per-token price from reading as this user's bill.
  const harness = await evalIn(c, `(() => ({
    good: document.querySelector('.mp-harness-note')?.textContent ?? null,
    billing: document.querySelector('.mp-harness-billing')?.textContent ?? null,
    routes: [...document.querySelectorAll('.mp-route')].map((b) => b.textContent),
  }))()`);
  check("the detail pane says what the harness is for and how it bills",
    !!harness.good && !!harness.billing, harness);

  /* ── 6. The provider strip. Live because it is only real with a real catalog: the chips are the
        MAKERS the catalog attributes the rows to, so offline there is no axis and no strip — a
        state jsdom can stage but only this can confirm the app actually reaches. */
  if (priced) {
    const strip = await evalIn(c, `(() => {
      const g = document.querySelector('.mp-vendors');
      if (!g) return null;
      const r = (n) => { const b = n.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
      const chips = [...g.querySelectorAll('[role="radio"]')];
      return {
        labels: chips.map((b) => b.textContent),
        lit: chips.find((b) => b.getAttribute('aria-checked') === 'true')?.textContent ?? null,
        rows: [...new Set(chips.map((b) => Math.round(b.getBoundingClientRect().top)))].length,
        search: r(document.querySelector('.mp-search')), self: r(g), list: r(document.querySelector('.mp-list')),
        // One tab stop for the strip, the roving-radio way.
        tabbable: chips.filter((b) => b.tabIndex === 0).map((b) => b.textContent),
      };
    })()`);
    check("a provider strip sits between the search field and the list",
      strip && strip.self.top >= strip.search.bottom - 1 && strip.self.bottom <= strip.list.top + 1, strip);
    check("it leads with the way back, on one line, as a single tab stop",
      strip && strip.labels[0] === "All" && strip.lit === "All" && strip.rows === 1 && strip.tabbable.length === 1,
      strip && { labels: strip.labels.slice(0, 6), rows: strip.rows, tabbable: strip.tabbable });

    const narrowing = await evalIn(c, `(async () => {
      const count = () => document.querySelectorAll('.mp-list [role="option"]').length;
      const chips = [...document.querySelectorAll('.mp-vendors [role="radio"]')];
      const all = count();
      const vendor = chips[1];
      vendor.click();
      await new Promise((r) => setTimeout(r, 200));
      const narrowed = count();
      const lit = document.querySelector('.mp-vendors [aria-checked="true"]')?.textContent ?? null;
      chips[0].click();
      await new Promise((r) => setTimeout(r, 200));
      return { all, narrowed, lit, vendor: vendor.textContent, restored: count() };
    })()`);
    check("choosing a provider narrows the list to it, and All brings the rest back",
      narrowing.narrowed > 0 && narrowing.narrowed < narrowing.all && narrowing.lit === narrowing.vendor
        && narrowing.restored === narrowing.all, narrowing);

    // The collision the strip was easiest to get wrong: ←/→ already walk the highlighted model's
    // ROUTES from the search field, and must go on meaning only that.
    const arrows = await evalIn(c, `(async () => {
      const input = document.querySelector('.mp-search input');
      input.focus();
      const before = document.querySelector('.mp-vendors [aria-checked="true"]')?.textContent ?? null;
      for (const key of ["ArrowRight", "ArrowRight"]) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 200));
      return { before, after: document.querySelector('.mp-vendors [aria-checked="true"]')?.textContent ?? null };
    })()`);
    check("←/→ in the search field leave the provider alone", arrows.before === arrows.after, arrows);
  } else {
    console.log("SKIP the provider strip — no catalog, so there is no vendor axis to draw (offline is a supported state)");
  }

  // CDP's clip takes x/y/width/height only — the rect helper's edges would be rejected outright.
  // 7. The fx mark actually PAINTS. Its path is lifted from a full lockup, so it starts 166 units
  //    from the origin: with the set's default `0 0 24 24` viewBox the glyph sits entirely
  //    off-canvas and the row renders a blank 15px hole — which no DOM assertion can see, because
  //    the <svg> and its <path> are both present and correct. Count ink instead.
  await evalIn(c, `(() => { const i = document.querySelector('.mp-search input'); __live.setInput(i, "fx"); return true; })()`);
  await sleep(300);
  const fxMark = await evalIn(c, `(() => {
    const svg = document.querySelector('.mp-row [data-brand="fx"]');
    if (!svg) return null;
    const b = svg.getBoundingClientRect();
    return { viewBox: svg.getAttribute('viewBox'),
      rect: { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) } };
  })()`);
  check("the fx row carries a mark", !!fxMark, fxMark);
  if (fxMark) {
    const markShot = await c.send("Page.captureScreenshot", { format: "png",
      clip: { x: fxMark.rect.x, y: fxMark.rect.y, width: fxMark.rect.w, height: fxMark.rect.h, scale: 4 } });
    const ink = await evalIn(c, `(async () => {
      const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(markShot.data)};
      await img.decode();
      const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
      // The glyph is light ink on the popover's dark surface; anything appreciably brighter than the
      // darkest pixel present is the mark itself.
      let lo = 255, hi = 0;
      for (let i = 0; i < px.length; i += 4) {
        const l = 0.299*px[i] + 0.587*px[i+1] + 0.114*px[i+2];
        if (l < lo) lo = l; if (l > hi) hi = l;
      }
      let lit = 0;
      for (let i = 0; i < px.length; i += 4) {
        const l = 0.299*px[i] + 0.587*px[i+1] + 0.114*px[i+2];
        if (l > lo + (hi - lo) * 0.5) lit++;
      }
      return { lit, total: px.length / 4, contrast: Math.round(hi - lo) };
    })()`);
    // A blank box has no contrast at all; the ligature covers a healthy share of its own square.
    check("the fx glyph paints inside its viewBox", ink.contrast > 20 && ink.lit / ink.total > 0.05,
      { viewBox: fxMark.viewBox, ...ink });
  }
  await evalIn(c, `(() => { const i = document.querySelector('.mp-search input'); __live.setInput(i, ""); return true; })()`);
  await sleep(250);

  const shot = await c.send("Page.captureScreenshot", { format: "png",
    clip: { x: layout.picker.left, y: layout.picker.top, width: layout.picker.w, height: layout.picker.h, scale: 2 } });
  const out = path.join(os.tmpdir(), "realm-model-picker.png");
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`SCREENSHOT picker ${out}`);
  const full = await c.send("Page.captureScreenshot", { format: "png" });
  const outFull = path.join(os.tmpdir(), "realm-model-picker-full.png");
  fs.writeFileSync(outFull, Buffer.from(full.data, "base64"));
  console.log(`SCREENSHOT full ${outFull}`);

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  c.close();
}

main()
  .catch((e) => { console.error("ERROR", e.message); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => { electron?.kill("SIGKILL"); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 1200);
  });
