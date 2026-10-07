/**
 * Live check for the transcript's selection bar
 * (run with: node apps/desktop/scripts/selection-bar-live.mjs)
 *
 * This feature IS geometry, and jsdom has none: a `Range` there reports every rect as zero, so the
 * suite can prove the bar mounts and what its buttons do and nothing whatsoever about where it lands.
 * `selection-bar.test.ts` covers the arithmetic as pure numbers. What is left — that the numbers are
 * fed real rects, in the right coordinate space, and that the bar is legible once it gets there —
 * can only be asked of a real window.
 *
 * The reading that matters most is the last one. The bar is deliberately mounted OUTSIDE
 * `.transcript`, because that element carries the edge dissolve and a mask applies to everything its
 * element paints — a bar inside it would fade exactly when the passage it points at is near the top
 * of the pane, which is when the reader most needs it. The DOM says the bar is outside; only a
 * screenshot says it is unfaded. So the bar is sampled against the top edge, and then MOVED inside
 * the scroller and sampled again: if the two readings match, this check is measuring nothing.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9376), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8943);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-selbar-"));
let electron = null, api = null;
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
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  return {
    ready,
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
  /* Select a substring of the first text node inside \`sel\`. Programmatic selection fires
     \`selectionchange\` in Chromium exactly as a drag does, so this drives the real listener. */
  select(sel, from, to, nth = 0) {
    const all = [...document.querySelectorAll(sel)];
    const host = nth < 0 ? all[all.length + nth] : all[nth];
    if (!host) throw new Error('no host: ' + sel + ' #' + nth + ' of ' + all.length);
    const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const node = walk.nextNode();
    if (!node) throw new Error('no text in: ' + sel);
    const range = document.createRange();
    range.setStart(node, from);
    range.setEnd(node, Math.min(to, node.textContent.length));
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(range);
    return range.toString();
  },
  clear() { getSelection().removeAllRanges(); return true; },
  rows() {
    return [...document.querySelectorAll('.transcript-col > *')].map((el) => ({
      cls: el.className, state: el.dataset.state ?? null, text: (el.textContent || '').trim().slice(0, 60),
    }));
  },
  debug() {
    const sel = getSelection();
    const node = sel.rangeCount ? sel.getRangeAt(0).commonAncestorContainer : null;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return {
      text: sel.toString().slice(0, 40), collapsed: sel.isCollapsed, ranges: sel.rangeCount,
      msg: el ? !!el.closest('.msg-assistant, .msg-user') : false,
      streaming: el ? !!el.closest('[data-state="streaming"]') : null,
      rowState: el?.closest('.msg-assistant-row')?.dataset.state ?? null,
      inTranscript: el ? !!el.closest('.transcript') : false,
      bars: document.querySelectorAll('.selection-bar').length,
    };
  },
  bar() {
    const el = document.querySelector('.selection-bar');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const wrap = document.querySelector('.transcript-wrap').getBoundingClientRect();
    const range = getSelection().getRangeAt(0).getBoundingClientRect();
    return {
      left: Math.round(b.left), top: Math.round(b.top), width: Math.round(b.width), height: Math.round(b.height),
      wrapLeft: Math.round(wrap.left), wrapTop: Math.round(wrap.top), wrapRight: Math.round(wrap.right), wrapBottom: Math.round(wrap.bottom),
      selLeft: Math.round(range.left), selTop: Math.round(range.top), selRight: Math.round(range.right), selBottom: Math.round(range.bottom),
      // Centre offsets, so "is it over the passage" is one number rather than four.
      dx: Math.round((b.left + b.width / 2) - (range.left + range.width / 2)),
      inScroller: !!el.closest('.transcript'),
      overflow: Math.round(document.querySelector('.transcript').scrollHeight - document.querySelector('.transcript').clientHeight),
      // The dissolve only arms once the column overflows. Without it the mutant below has nothing to
      // fade the bar WITH, and the contrast check would pass while measuring nothing.
      armed: (document.querySelector('.transcript').dataset.dissolve ?? '').includes('start'),
      /* The depths the MASK is actually drawn from, read off the scroller that wears it. Reading
         --fade-h from the wrapper instead returns nothing for an ordinary transcript — that token is
         only set where a pane overrides it — and the mask's own var() fallback supplies the 68px. */
      fadeTop: Math.round(parseFloat(getComputedStyle(document.querySelector('.transcript')).getPropertyValue('--dissolve-top')) || 0),
      fadeBottom: Math.round(parseFloat(getComputedStyle(document.querySelector('.transcript')).getPropertyValue('--dissolve-bottom')) || 0),
      clip: { x: Math.round(b.left) - 2, y: Math.round(b.top) - 2, width: Math.round(b.width) + 4, height: Math.round(b.height) + 4 },
    };
  },
  scroll(by) { const el = document.querySelector('.transcript'); el.scrollTop += by; return Math.round(el.scrollTop); },
  /* Put the passage where the check needs it, deterministically. Nudging scrollTop is not that: the
     transcript follows its own bottom, so the first run of this check was pushing a scroller that
     was already parked at its maximum and measuring a bar that never moved. */
  reveal(sel, block, nth = 0) {
    const all = [...document.querySelectorAll(sel)];
    const el = nth < 0 ? all[all.length + nth] : all[nth];
    if (!el) throw new Error('no element to reveal: ' + sel);
    el.scrollIntoView({ block });
    return Math.round(document.querySelector('.transcript').scrollTop);
  },
  click(label) {
    const el = [...document.querySelectorAll('.selection-action')].find((b) => b.textContent.trim() === label);
    if (!el) throw new Error('no action: ' + label);
    el.click();
    return true;
  },
  draft() { const t = document.querySelector('.composer textarea'); return { value: t.value, focused: document.activeElement === t, caret: t.selectionStart }; },
  /* THE MUTANT: put the bar inside the scroller, where the edge dissolve can reach it. Nothing else
     moves — same element, same coordinates, re-parented and re-anchored to the scroller's own box. */
  mutate() {
    const el = document.querySelector('.selection-bar');
    const sc = document.querySelector('.transcript');
    const b = el.getBoundingClientRect(), s = sc.getBoundingClientRect();
    sc.style.position = 'relative';
    sc.appendChild(el);
    el.style.left = (b.left - s.left) + 'px';
    el.style.top = (b.top - s.top + sc.scrollTop) + 'px';
    return true;
  },
};
void 0`;

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

/** The passage every check selects: a run of the first finished assistant message. Named once so the
 *  quote asserted against the prompter is literally the string the bar was opened on. */
const SELECT = "__live.select('.msg-assistant-row[data-state=\"complete\"] .msg-assistant', 8, 27)";

/** The same run, of the LAST finished assistant message — what the bottom-edge reading selects. */
const SELECT_LAST = "__live.select('.msg-assistant-row[data-state=\"complete\"] .msg-assistant', 8, 27, -1)";

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

async function shot(c, clip, tag) {
  const r = await c.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
  const out = path.join(os.tmpdir(), `realm-selbar-${tag}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
  return r.data;
}

/** Mean luminance of a clip. A masked bar dissolves toward the ground behind it, so its ink — the
 *  dark surface and the bright labels both — converges on the background's own value. */
const IMAGE_STATS = (b64) => `(async () => {
  const img = new Image();
  img.src = "data:image/png;base64," + ${JSON.stringify(b64)};
  await img.decode();
  const cv = document.createElement("canvas");
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, cv.width, cv.height).data;
  const lum = (i) => 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  let sum = 0, n = 0, max = 0, min = 255;
  for (let i = 0; i < px.length; i += 4) { const l = lum(i); sum += l; n++; if (l > max) max = l; if (l < min) min = l; }
  // The peak is the reading that matters: the brightest thing in the clip is the bar's own label,
  // and a mask takes ALPHA — so a faded bar's label composites toward the dark ground behind it and
  // that peak collapses. Mean and range ride along because one number that moved is worth being
  // able to sanity-check against two that agree.
  return { mean: +(sum / n).toFixed(2), range: +(max - min).toFixed(2), max: +max.toFixed(2) };
})()`;

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

  await c.send("Emulation.setDeviceMetricsOverride", { width: 1180, height: 520, deviceScaleFactor: 2, mobile: false });
  await sleep(400);

  /* Real prose to select, through the real send path: the fake agent's `plan` script answers with an
     assistant message and a plan card, so the transcript holds both a paragraph (quotable) and a
     structured card (deliberately not). */
  api = rpc(SERVER_PORT, await daemonToken(path.join(scratch, "home")));
  await api.ready;
  const session = await until(async () => (await api.call("sessions.listAll", {}))[0], 15000, "a session");
  /* The scripted fake agent, not whichever real one the onboarding picked. Without this the send
     reaches a live CLI, which spends tokens, runs tools and parks on a permission card — so the
     transcript this check needs never arrives, and what does arrive is different every run. */
  await api.call("sessions.setAgent", { id: session.id, agentKind: "fake" });
  /* Four turns, not one: the checks below need the column to OVERFLOW — a transcript that fits has
     nothing to scroll and never arms the edge dissolve, which would let both the follow-on-scroll
     check and the mutant pass while measuring nothing. */
  for (const text of ["plan", "and then?", "what else", "anything more"]) {
    await api.call("sessions.send", { id: session.id, text, attachments: [] });
    await sleep(500);
  }
  /* Waits for the message to be COMPLETE, not merely present: the bar withholds itself from a
     streaming message on purpose, so a check that raced the settle would be testing that rule
     rather than the placement it is here for. */
  try {
    await until(() => evalIn(c, `!!document.querySelector('.msg-assistant-row[data-state="complete"] .msg-assistant p')`), 30000, "a finished assistant message");
  } catch (e) {
    console.log("DIAG rows " + JSON.stringify(await evalIn(c, `__live.rows()`)));
    throw e;
  }
  await sleep(500);

  check("no bar until something is selected", (await evalIn(c, `__live.bar()`)) === null);

  await evalIn(c, `__live.reveal('.msg-assistant-row[data-state="complete"]', 'center')`);
  await sleep(300);
  const quoted = await evalIn(c, SELECT);
  await sleep(300);
  const at = await evalIn(c, `__live.bar()`);
  check("a selection opens the bar", at !== null, at === null ? await evalIn(c, `__live.debug()`) : { quoted });
  if (at === null) return;

  // THE reading jsdom cannot take: real rects, in the wrapper's coordinate space.
  check("it sits above the passage", at.top + at.height <= at.selTop, { barBottom: at.top + at.height, selTop: at.selTop });
  check("it is centred on the passage", Math.abs(at.dx) <= 2, { dx: at.dx });
  check("it is inside the pane on every edge",
    at.left >= at.wrapLeft && at.left + at.width <= at.wrapRight && at.top >= at.wrapTop && at.top + at.height <= at.wrapBottom, at);
  check("it is a real control's size, not a collapsed box", at.width > 100 && at.height >= 24, { width: at.width, height: at.height });
  check("it is outside the scroller, where the edge dissolve cannot reach it", at.inScroller === false);
  await shot(c, at.clip, "bar");

  // Scrolling moves the passage; the bar is positioned against the wrapper, which does not move.
  check("the column actually overflows, so the two checks below are not vacuous", at.overflow > 60, { overflow: at.overflow });
  const before = await evalIn(c, `__live.bar()`);
  /* 24px, not 60. A larger nudge carries the passage high enough that the bar correctly FLIPS to
     below it, and the offset invariant below — which is the thing worth asserting — does not hold
     across a flip. The flip has its own coverage in `selection-bar.test.ts`. */
  await evalIn(c, `__live.scroll(24)`);
  await sleep(350);
  const after = await evalIn(c, `__live.bar()`);
  // The invariant is the OFFSET, not the direction: the bar must keep its distance from the passage
  // it points at. A bar that simply stayed put would pass a "did it move" check on a pane that
  // happened not to scroll — which is exactly what the first run of this script did.
  check("it follows the passage while the reader scrolls",
    after !== null && Math.abs(after.top - before.top) >= 20
      && (after.top - after.selTop) === (before.top - before.selTop) && Math.abs(after.dx) <= 2,
    { before: { top: before.top, sel: before.selTop }, after: after && { top: after.top, sel: after.selTop } });
  await evalIn(c, `__live.scroll(-24)`);
  await sleep(300);

  // Quote, end to end, through the real prompter.
  await evalIn(c, `__live.clear()`);
  await sleep(200);
  const again = await evalIn(c, SELECT);
  await sleep(350);
  await evalIn(c, `__live.click('Quote')`);
  await sleep(450);
  const draft = await evalIn(c, `__live.draft()`);
  check("Quote puts the passage in the prompter, focused, with the caret under it",
    draft.value === `> ${again}\n\n` && draft.focused && draft.caret === draft.value.length, draft);
  check("and the bar stands down once it has", (await evalIn(c, `__live.bar()`)) === null);
  await shot(c, { x: 281, y: 300, width: 899, height: 220 }, "quoted-prompter");

  // A selection in the prompter is not a passage of the transcript.
  await evalIn(c, `(() => { const t = document.querySelector('.composer textarea'); t.focus(); t.setSelectionRange(0, 5); return true; })()`);
  await sleep(300);
  check("it stays shut for a selection in the prompter", (await evalIn(c, `__live.bar()`)) === null);

  /* THE LEGIBILITY READING, and it is last on purpose: the mutant re-parents a React-owned node,
     which leaves the tree in a state nothing after it should be asked to work in.

     The BOTTOM edge, not the top. The top band is 40px and the bar flips BELOW a passage that high,
     so it never sits deep in it — at worst its first few pixels soften. The bottom band is 68px, and
     a passage selected against it puts the bar — placed above, 32px tall — almost entirely inside.
     That is where "the bar fades exactly when the reader wants it" is a real claim, so that is where
     it is measured. */
  await evalIn(c, `(() => { document.querySelector('.composer textarea').blur(); return true; })()`);
  await evalIn(c, `__live.reveal('.msg-assistant-row[data-state="complete"] .msg-assistant', 'end', -1)`);
  await sleep(350);
  await evalIn(c, SELECT_LAST);
  await sleep(400);
  const low = await evalIn(c, `__live.bar()`);
  check("a passage against the bottom edge still gets its bar",
    low !== null && low.armed, low && { top: low.top, wrapBottom: low.wrapBottom, fadeBottom: low.fadeBottom, armed: low.armed });
  if (low === null) return;
  // The reading only means something if the bar is genuinely inside the band the mask draws.
  const intoBand = (low.top + low.height) - (low.wrapBottom - low.fadeBottom);
  check("and it is inside the bottom band, so the mutant below has something to fade it with",
    intoBand > 12, { intoBand, fadeBottom: low.fadeBottom });
  const clean = await evalIn(c, IMAGE_STATS(await shot(c, low.clip, "bar-bottom-edge")));

  await evalIn(c, `__live.mutate()`);
  await sleep(400);
  const moved = await evalIn(c, `__live.bar()`);
  check("the mutant reads the same box, only re-parented",
    moved.inScroller === true && Math.abs(moved.top - low.top) <= 2 && Math.abs(moved.left - low.left) <= 2,
    { was: { top: low.top, left: low.left }, now: { top: moved.top, left: moved.left } });
  const masked = await evalIn(c, IMAGE_STATS(await shot(c, moved.clip, "bar-bottom-edge-mutant")));
  check("the bar keeps its ink at the pane's bottom edge, where inside the scroller the mask takes it",
    clean.max > masked.max * 1.2, { clean, masked, ratio: +(clean.max / masked.max).toFixed(2) });

  c.close();
}

main()
  .catch((e) => { console.log(`FAIL harness ${e.message}`); process.exitCode = 1; })
  .finally(async () => {
    /* The daemon is spawned by the app and re-parented to init, so it OUTLIVES the Electron this
       script kills — and it keeps the server port, which makes the next run refuse to start with a
       message about a port rather than about a daemon. */
    try { await api?.call("daemon.stop", {}); } catch {}
    try { api?.close(); } catch {}
    electron?.kill("SIGTERM");
    setTimeout(() => {
      try { electron?.kill("SIGKILL"); } catch {}
      try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
      process.exit(process.exitCode ?? 0);
    }, 800);
  });
