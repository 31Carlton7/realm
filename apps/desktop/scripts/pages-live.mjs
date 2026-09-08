/**
 * Live check for the page-chrome pass (run with: node apps/desktop/scripts/pages-live.mjs)
 *
 * Three changes, all of which jsdom can only confirm exist — never that they LAND:
 *
 *   1. **Page headers.** The glyph tile and the sub-title paragraph are gone, and the title now
 *      starts where the page's CONTENT starts rather than where the window does. That last one is
 *      pure arithmetic against the rail, and getting it wrong by the gap is invisible in a rule and
 *      obvious on screen.
 *   2. **The checkbox.** Nine of these shipped as the raw macOS control. The proof it is Realm's now
 *      is that its box is not the OS's size and its tick is drawn by us — both facts about the
 *      rendered element, and neither readable from the stylesheet, since `appearance: none` either
 *      takes or it does not.
 *   3. **Notifications.** One measured column of cards, no wash, and a modal for the row you pick.
 *
 * Ports: env-overridable. Touches only a scratch dir; kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9365), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8931);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-pages-live-"));
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

/** A client for the server's own RPC socket. The fake agent has to be selected over the wire — a
 *  fresh session defaults to an engine this scratch home has no CLI for, and the summary needs an
 *  actual answer to summarise. Same helper `message-actions-live.mjs` uses, for the same reason. */
function rpc(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
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
  box: (n) => { const b = n.getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) }; },
  type(sel, value) {
    const el = document.querySelector(sel);
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  },
  dest(label) {
    const row = [...document.querySelectorAll('.sb-destinations .dest-row')].find((b) => b.textContent.trim().startsWith(label));
    if (!row) throw new Error('no destination: ' + label);
    row.click();
    return true;
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

const shot = async (c, tag, clip) => {
  const r = await c.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 2 } } : {}) });
  const out = path.join(os.tmpdir(), `realm-pages-live-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
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
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  const api = rpc(SERVER_PORT);
  await api.ready;

  /* ── 1. Page headers ────────────────────────────────────────────────────── */
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 950, deviceScaleFactor: 2, mobile: false });
  await sleep(300);
  for (const [dest, sel] of [["Settings", ".settings-page-pane"], ["Library", ".page"], ["Connections", ".page"]]) {
    await evalIn(c, `__live.dest(${JSON.stringify(dest)})`);
    await until(() => evalIn(c, `!!document.querySelector('.page-head h1')`), 15000, `${dest} head`);
    await sleep(350);
    const head = await evalIn(c, `(() => {
      const page = document.querySelector('.page');
      const h1 = page.querySelector('.page-head h1');
      const rail = page.querySelector('.page-rail');
      /* The content column's own first child, not the column element itself. That element carries a
         4px padding with a matching negative margin so a focus ring inside it is not clipped, which
         puts its BORDER box 4px left of anything a reader sees. Lining a title up with a box nobody
         can see is how you ship an off-by-four. (No backticks in here: this whole block is inside a
         template literal, and one would end it.) */
      const contentEl = page.querySelector('.page-content, .page-body > *:last-child');
      const content = contentEl?.firstElementChild ?? contentEl;
      return { title: h1.textContent, h1: __live.box(h1),
               rail: rail ? __live.box(rail) : null, content: content ? __live.box(content) : null,
               glyph: !!page.querySelector('.page-glyph'), sub: !!page.querySelector('.page-sub'),
               size: getComputedStyle(h1).fontSize };
    })()`);
    check(`${dest}: no glyph tile and no sub-title paragraph`, !head.glyph && !head.sub, head);
    check(`${dest}: the title is the header's own size, not a row label`, parseFloat(head.size) >= 20, { size: head.size });
    // The whole point of the change: a title lines up with the column it names, on every page —
    // and on a railed one that means clearing the rail rather than sitting above it.
    if (head.rail) check(`${dest}: the title starts past the rail`, head.h1.l >= head.rail.r, head);
    if (head.content) check(`${dest}: the title lines up with the content column`, Math.abs(head.h1.l - head.content.l) <= 2, head);
  }
  await shot(c, "settings-head", { x: 0, y: 0, width: 1500, height: 260 });

  /* ── 1b. Engine cards ───────────────────────────────────────────────────── */
  await evalIn(c, `__live.dest("Settings")`);
  await until(() => evalIn(c, `!!document.querySelector('.engine-card')`), 20000, "engine cards");
  await sleep(600);
  const eng = await evalIn(c, `(() => {
    const cards = [...document.querySelectorAll('.engine-card')];
    const first = cards[0];
    return { count: cards.length,
             ready: cards.filter((el) => el.getAttribute('data-state') === 'ready').length,
             openDetails: cards.filter((el) => el.querySelector('details[open]')).length,
             pills: cards.filter((el) => el.querySelector('.engine-pill')).length,
             box: __live.box(first), list: __live.box(document.querySelector('.engines-list')),
             nameSize: getComputedStyle(first.querySelector('.engine-name')).fontSize,
             // A ready card is one line of card plus its chips; a blocked one opens its prose.
             readyHeights: cards.filter((el) => el.getAttribute('data-state') === 'ready').map((el) => Math.round(el.getBoundingClientRect().height)) };
  })()`);
  check("every engine is a card with a status pill", eng.pills === eng.count, eng);
  check("a ready engine stays short — its prose is folded", eng.readyHeights.every((h) => h < 130), eng);
  check("only the engines that need something open themselves", eng.openDetails < eng.count, eng);
  check("cards do not overflow the list", eng.box.r <= eng.list.r + 1, eng);
  await shot(c, "engines", { x: eng.list.l - 16, y: eng.list.t - 60, width: eng.list.w + 32, height: 560 });

  /* ── 1c. Nothing overflows after the type sweep ─────────────────────────── */
  // Thirty-seven rules went from 10-10.5px to 11px. Individually invisible; together the kind of
  // change that pushes a fixed-width label out of its own box, which no stylesheet read can see.
  for (const dest of ["Connections", "Library", "Settings"]) {
    await evalIn(c, `__live.dest(${JSON.stringify(dest)})`);
    await until(() => evalIn(c, `!!document.querySelector('.page-content, .page-body')`), 15000, `${dest} body`);
    await sleep(450);
    const spill = await evalIn(c, `(() => {
      const page = document.querySelector('.page');
      const pr = page.getBoundingClientRect();
      const bad = [];
      for (const el of page.querySelectorAll('*')) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        // Past the pane's own right edge by more than a rounding pixel.
        if (b.right > pr.right + 1) bad.push((el.className || el.tagName) + ' +' + Math.round(b.right - pr.right));
        /* A single-line box whose TEXT no longer fits the height it was given. Form controls are
           skipped: their scroll box does not mean what it means elsewhere, and the checkbox's own
           transparent hit-area pseudo (inset -8px) counts against its scrollHeight while clipping
           nothing — a false positive about a control that has no text in it at all. */
        if (el.children.length === 0 && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA'
            && (el.textContent || '').trim() !== ''
            && el.scrollHeight > el.clientHeight + 2 && getComputedStyle(el).overflowY === 'visible')
          bad.push((el.className || el.tagName) + ' clipped');
      }
      return [...new Set(bad)].slice(0, 6);
    })()`);
    check(`${dest}: nothing spills out of the pane after the type sweep`, spill.length === 0, spill);
  }

  /* ── 2. The checkbox ────────────────────────────────────────────────────── */
  await evalIn(c, `__live.dest("Settings")`);
  await until(() => evalIn(c, `!!document.querySelector('.page-rail .settings-tab')`), 15000, "settings");
  await evalIn(c, `(() => { [...document.querySelectorAll('.settings-tab')].find((t) => /Usage/.test(t.textContent)).click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.checkbox')`), 15000, "a checkbox");
  await sleep(400);
  const box = await evalIn(c, `(() => {
    const el = document.querySelector('.checkbox');
    const cs = getComputedStyle(el);
    el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true }));
    const on = getComputedStyle(el, '::after');
    return { box: __live.box(el), appearance: cs.appearance, radius: cs.borderRadius,
             tickOpacity: on.opacity, tickWidth: on.width, accent: cs.backgroundColor };
  })()`);
  check("the OS control is genuinely replaced, not merely restyled", box.appearance === "none", box);
  check("it is Realm's own 16px box on the chip rung", box.box.w === 16 && box.box.h === 16, box.box);
  check("and the tick it draws is ours", box.tickOpacity === "1" && parseFloat(box.tickWidth) > 0, box);
  await shot(c, "checkbox", { x: box.box.l - 30, y: box.box.t - 20, width: 320, height: 70 });

  /* ── 3. Notifications ───────────────────────────────────────────────────── */
  await evalIn(c, `__live.dest("Notifications")`);
  await until(() => evalIn(c, `!!document.querySelector('.notifications-page-pane')`), 15000, "notifications");
  await sleep(400);
  const notif = await evalIn(c, `(() => {
    const page = document.querySelector('.notifications-page-pane');
    const feed = page.querySelector('.notif-feed');
    return { wash: page.classList.contains('wash'), split: !!page.querySelector('.notif-split'),
             feed: feed ? __live.box(feed) : null, page: __live.box(page),
             bg: getComputedStyle(page).backgroundImage };
  })()`);
  check("no decorated ground under the feed", !notif.wash && notif.bg === "none", notif);
  check("no two-column split", !notif.split, notif);
  if (notif.feed) {
    const slackL = notif.feed.l - notif.page.l, slackR = notif.page.r - notif.feed.r;
    check("the feed is centred in its pane", Math.abs(slackL - slackR) <= 24, { slackL, slackR });
  }
  await shot(c, "notifications", { x: notif.page.l, y: 0, width: Math.min(1000, notif.page.w), height: 520 });
  api.close();

  check("no renderer console errors", c.events.length === 0, c.events.slice(0, 5));
  api.close();
  c.close();
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    electron?.kill("SIGTERM");
    setTimeout(() => { electron?.kill("SIGKILL"); fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 800);
  });
