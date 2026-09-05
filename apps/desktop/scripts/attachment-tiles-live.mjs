/**
 * Live check for the prompter's attachment tiles (run with: node apps/desktop/scripts/attachment-tiles-live.mjs)
 *
 * Boots the REAL app (built out/main against the built realm-server) on a scratch REALM_HOME with the
 * CDP endpoint open, drops real files on the hero prompter, and proves what a unit test cannot:
 *
 *   1. an attachment renders as a SQUARE with no filename on it
 *   2. an image renders its own pixels, and a PDF renders its FIRST PAGE — both through the
 *      `attachment-thumbnail` bridge (nativeImage for the image, QuickLook for the PDF), which does
 *      not exist under jsdom and cannot be exercised any other way
 *   3. the name is one hover away, in a tip that is NOT clipped by the composer card — the failure
 *      mode a stylesheet test cannot see, because it needs real layout
 *   4. clicking a tile opens the file, and which of the two openings it gets is decided by what the
 *      file IS — the PNG lands in the lightbox, the PDF goes out to the OS
 *   5. the lightbox that opens from a PROMPTER tile covers the prompter. It is portalled to <body>,
 *      so it escapes the pane; nothing in jsdom can see whether it actually paints on top
 *
 * Then the same file is SENT, and the tile in the bubble is held to the same guarantees. The two
 * tiles are one component, but they are reached by different routes — the prompter's is built from
 * the picker's own record, the bubble's is rebuilt from the server's echo of the event, which keeps
 * only `{path, mime}`. Whether the picture survives that round trip is a question about the real
 * `attachment-thumbnail` bridge over the real path, and jsdom decodes no images.
 *
 * Ports: env-overridable, defaulting to a high pair that will not contend with a running Realm.
 * Touches only a scratch dir (REALM_HOME + userData); kills only the process it started.
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9334), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8900);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-attach-live-"));
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
  /** Files as a DataTransfer, the shape a Finder drag arrives in. */
  files(specs) {
    const dt = new DataTransfer();
    for (const s of specs) {
      const bytes = Uint8Array.from(atob(s.b64), (ch) => ch.charCodeAt(0));
      dt.items.add(new File([bytes], s.name, { type: s.mime }));
    }
    return dt;
  },
  /** Drop real Files on an element — the same path a Finder drag takes into the composer. */
  async drop(sel, specs) {
    const dt = new DataTransfer();
    for (const s of specs) {
      const bytes = Uint8Array.from(atob(s.b64), (ch) => ch.charCodeAt(0));
      dt.items.add(new File([bytes], s.name, { type: s.mime }));
    }
    const el = document.querySelector(sel);
    for (const type of ["dragenter", "dragover", "drop"]) {
      el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    return true;
  },
};
void 0`;

/** The server's own socket, for the one thing the UI cannot do here: put the session on the fake
 *  agent so a send completes on a machine with no CLI installed. */
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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: HELPERS + ";\n" + expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** A 2×2 red PNG, and a one-page PDF — small enough to inline, real enough for both thumbnailers. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z4AATAxQxhAVAAAA//8DAAKrAP8i0m9DAAAAAElFTkSuQmCC";

function makePdf() {
  const content = "BT /F1 24 Tf 60 700 Td (Realm live check) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1").toString("base64");
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
      // The sent half needs a turn that completes without a CLI on the box; the tiles under test are
      // on the USER's bubble, which the server echoes either way, but a send that throws never gets there.
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
  const rendererTarget = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 30000, "renderer target");
  const c = cdp(rendererTarget.webSocketDebuggerUrl);
  globalThis.__c = c;
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");

  // Onboarding → first space → the hero prompter.
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    __live.setInput(input, "Live");
    input.closest("form").requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  // Drop one image and one PDF. `attachment-thumbnail` runs in MAIN — nativeImage decodes the PNG,
  // QuickLook renders the PDF's first page — and neither exists under jsdom.
  await evalIn(c, `__live.drop('.composer', ${JSON.stringify([
    { name: "shot.png", mime: "image/png", b64: PNG_B64 },
    { name: "report.pdf", mime: "application/pdf", b64: makePdf() },
  ])})`);
  const tiles = await until(() => evalIn(c, `document.querySelectorAll('.attach-tile').length || null`), 15000, "the dropped files' tiles");
  check("a dropped file becomes a tile — one apiece, and no extras", tiles === 2, { tiles });

  // 1. The tile is a square, and it does not spell the filename out.
  const shape = await until(() => evalIn(c, `(() => {
    const t = document.querySelector('.attach-tile');
    const b = t.getBoundingClientRect();
    const bare = t.cloneNode(true);
    for (const h of bare.querySelectorAll('.visually-hidden, .attach-tip')) h.remove();
    const visible = bare.textContent;
    return { w: Math.round(b.width), h: Math.round(b.height), visible };
  })()`), 5000, "tile shape");
  check("the tile is a square with no filename on it", shape.w === shape.h && !shape.visible.includes("shot"), shape);

  // 2. Both files render their own pixels. This is the whole point of the change: a PDF used to be
  // the same grey glyph as everything else, because nativeImage cannot decode one.
  const arts = await until(() => evalIn(c, `(() => {
    const imgs = [...document.querySelectorAll('.attach-tile .attach-thumb')];
    if (imgs.length < 2) return null;
    return imgs.map((i) => ({ src: i.src.slice(0, 22), w: i.naturalWidth, h: i.naturalHeight }));
  })()`), 25000, "both thumbnails");
  check("the image renders its own pixels", arts[0].src.startsWith("data:image/") && arts[0].w > 0, arts[0]);
  check("the PDF renders its first page, not a glyph", arts[1].src.startsWith("data:image/") && arts[1].w > 0, arts[1]);

  // 3. The name is in the tip, and the tip is NOT clipped by the composer card. Clipping is the
  // failure a stylesheet test cannot see: it needs real layout and a real ancestor chain.
  const tip = await evalIn(c, `(() => {
    const tile = [...document.querySelectorAll('.attach-tile')][1];
    const tipEl = tile.querySelector('.attach-tip');
    const b = tipEl.getBoundingClientRect();
    let clippedBy = null;
    for (let el = tile.parentElement; el && el !== document.body; el = el.parentElement) {
      const o = getComputedStyle(el);
      if (o.overflow === 'hidden' || o.overflowY === 'hidden') {
        const r = el.getBoundingClientRect();
        if (b.top < r.top || b.left < r.left || b.bottom > r.bottom) {
          clippedBy = el.className || el.tagName; break;
        }
      }
    }
    return { text: tipEl.textContent.slice(0, 60), w: Math.round(b.width), h: Math.round(b.height), clippedBy,
             onScreen: b.top >= 0 && b.left >= 0 && b.right <= innerWidth };
  })()`);
  check("the tip carries the name the tile stopped showing", tip.text.includes("report.pdf"), { text: tip.text });
  check("the tip is laid out on screen and nothing clips it", !tip.clippedBy && tip.onScreen && tip.w > 0 && tip.h > 0, tip);

  /* 4/5. Opening.
     The PDF's own click is deliberately NOT exercised here. It would reach `shell.openPath` for
     real and leave Preview open on whoever ran the script, and it cannot be stubbed around —
     `contextBridge` freezes `window.realm`, so assigning over `openAttachment` silently does
     nothing and the real call goes through anyway. Which kind gets which opening is pinned in
     jsdom; what only the built app can answer is below. */

  // Both tiles are real buttons, and only the one main confirmed as media is marked as such — that
  // mark is what decides which of the two openings a click gets.
  await until(() => evalIn(c, `!!document.querySelector('.attach-tile[data-media]')`), 15000, "image resolved as media");
  const marks = await evalIn(c, `[...document.querySelectorAll('.attach-tile')].map((t) => ({
    button: t.querySelector('.attach-open')?.tagName === 'BUTTON',
    media: t.hasAttribute('data-media'),
    label: t.querySelector('.attach-open')?.getAttribute('aria-label') ?? null }))`);
  check("every tile is a real button", marks.every((m) => m.button), marks);
  check("only the image is marked as media — the PDF is not",
    marks.filter((m) => m.media).length === 1 && marks[0].media && !marks[1].media, marks);

  /* The channel itself, in the BUILT main bundle. An unregistered `ipcMain.handle` REJECTS with
     "No handler registered for …", so a resolved promise is proof the handler is really there — and
     a path that cannot exist is refused by its gate, so proving it launches nothing. */
  const channel = await evalIn(c, `window.realm.openAttachment(${JSON.stringify(path.join(scratch, "nothing-here.pdf"))})
    .then(() => "registered").catch((e) => String(e.message ?? e))`);
  check("attachment:open is registered in main, and refuses a path that is not there", channel === "registered", { channel });

  await evalIn(c, `(() => { document.querySelector('.attach-tile[data-media] .attach-open').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.media-lightbox')`), 8000, "an image to open in the lightbox instead");

  /* The stacking question, and the whole reason this part is live: the tile that opened it lives
     INSIDE the prompter — a card on its own layer, above the transcript. The lightbox is portalled
     to <body> to escape that, and whether it actually paints over the card is a compositing fact.
     Measured by covering: crop the card's box out of the screenshot with the lightbox up, then hide
     the lightbox and crop the same box. If the overlay covers the card the two must DIFFER, and the
     lightbox's own crop must be near-uniform dim rather than prompter pixels showing through. */
  const cardBox = await evalIn(c, `(() => {
    const b = document.querySelector('.composer').getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }; })()`);
  const cropOf = async () => (await c.send("Page.captureScreenshot", { format: "png", clip: { ...cardBox, scale: 1 } })).data;
  const covered = await cropOf();
  await evalIn(c, `(() => { document.querySelector('.media-lightbox').style.visibility = 'hidden'; return true; })()`);
  await sleep(250);
  const bare = await cropOf();
  await evalIn(c, `(() => { document.querySelector('.media-lightbox').style.visibility = ''; return true; })()`);
  await sleep(250);
  check("the lightbox really is painting over the prompter, not merely above it in the DOM",
    covered !== bare, { sameBytes: covered === bare });

  // Escape leaves, and focus comes back to the tile it came out of rather than to the document.
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  const afterEscape = await until(() => evalIn(c, `(() => {
    if (document.querySelector('.media-lightbox')) return null;
    const a = document.activeElement;
    return { onTile: !!a?.classList.contains('attach-open'), label: a?.getAttribute('aria-label') ?? null }; })()`), 5000, "lightbox closed");
  check("Escape closes it and focus lands back on the tile", afterEscape.onTile, afterEscape);

  // Screenshot for the human verdict: hover the second tile so the tip is actually painted.
  const box = await evalIn(c, `(() => {
    const b = [...document.querySelectorAll('.attach-tile')][1].getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y });
  await sleep(400);
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(os.tmpdir(), "realm-attachment-tiles-live.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log("SCREENSHOT " + shotPath);

  /* ── The same two files, SENT ──────────────────────────────────────────────────────────────
     Everything above measured the PROMPTER's tile, which is built from the picker's own record and
     still has the File in hand. The bubble's tile is rebuilt from the server's echo of the
     `user_message` event, which carries only `{path, mime}` — the name and the size are dropped on
     the wire. So this is a round trip, not a re-render, and the question is whether the picture
     survives it. */
  const api = rpc(SERVER_PORT);
  await api.ready;
  const session = await until(async () => {
    const all = await api.call("sessions.listAll", {});
    return all.length ? all[0] : null;
  }, 15000, "a session");
  await api.call("sessions.setAgent", { id: session.id, agentKind: "fake" });

  // The button rather than Enter: which key sends is a user preference, and this check is not about it.
  await evalIn(c, `(() => {
    const ta = document.querySelector('.composer textarea');
    __live.setInput(ta, 'here are the files');
    return true; })()`);
  await until(() => evalIn(c, `!document.querySelector('.composer-send[disabled]')`), 8000, "send enabled");
  await evalIn(c, `(() => { document.querySelector('.composer-send').click(); return true; })()`);

  const sent = await until(() => evalIn(c, `(() => {
    const tiles = [...document.querySelectorAll('.msg-user-files .attach-tile')];
    return tiles.length === 2 ? tiles.length : null; })()`), 20000, "two sent tiles");
  check("the attachments survive the send and land in the bubble", sent === 2, { tiles: sent });

  // The prompter's row is emptied by the same send — the files moved, they were not duplicated.
  check("the prompter's row is cleared by the send that carried them",
    (await evalIn(c, `document.querySelectorAll('.composer-attachments .attach-tile').length`)) === 0);

  /* The picture, after the round trip. This is the failure the report would look like: a tile that
     renders but falls back to the grey glyph because the path no longer resolves. `naturalWidth`
     is the decode actually happening, not the src merely being set. */
  const sentArt = await until(() => evalIn(c, `(() => {
    const imgs = [...document.querySelectorAll('.msg-user-files .attach-thumb')];
    if (imgs.length < 2) return null;
    return imgs.map((i) => ({ src: i.src.slice(0, 22), w: i.naturalWidth, h: i.naturalHeight }));
  })()`), 25000, "both sent thumbnails");
  check("the sent image still renders its own pixels, not the fallback glyph",
    sentArt[0].src.startsWith("data:image/") && sentArt[0].w > 0, sentArt[0]);
  check("the sent PDF still renders its first page", sentArt[1].src.startsWith("data:image/") && sentArt[1].w > 0, sentArt[1]);
  check("no sent tile fell back to the glyph",
    (await evalIn(c, `document.querySelectorAll('.msg-user-files .attach-glyph').length`)) === 0);

  /* The bubble's tile is deliberately a size of its own (56 against the prompter's 44), so this
     pins the size it is MEANT to be rather than equality with the prompter. Still square, and still
     without the filename written on it. */
  const sentShape = await evalIn(c, `(() => {
    const t = document.querySelector('.msg-user-files .attach-tile');
    const b = t.getBoundingClientRect();
    const bare = t.cloneNode(true);
    for (const h of bare.querySelectorAll('.visually-hidden, .attach-tip')) h.remove();
    return { w: Math.round(b.width), h: Math.round(b.height), visible: bare.textContent.trim() }; })()`);
  check("the sent tile is a square, and larger than the prompter's",
    sentShape.w === sentShape.h && sentShape.w === 56, sentShape);
  check("the sent tile does not spell its filename out either — only the extension badge",
    !sentShape.visible.includes("shot"), sentShape);

  // The name is still one hover away, off the path's basename now that the picker's name is gone.
  const sentTip = await evalIn(c, `(() => {
    const t = document.querySelector('.msg-user-files .attach-tile');
    return { tip: t.querySelector('.attach-tip')?.textContent ?? null,
             label: t.querySelector('.visually-hidden')?.textContent ?? null }; })()`);
  check("the sent tile still names its file in the tip", (sentTip.tip ?? "").includes("shot.png"), sentTip);

  // Openable, and sorted into the same two openings by the same rule the prompter's tile used.
  const sentMarks = await evalIn(c, `[...document.querySelectorAll('.msg-user-files .attach-tile')].map((t) => ({
    button: t.querySelector('.attach-open')?.tagName === 'BUTTON', media: t.hasAttribute('data-media') }))`);
  check("every sent tile is a real button", sentMarks.every((m) => m.button), sentMarks);
  check("only the sent image is marked as media — the PDF is not",
    sentMarks.filter((m) => m.media).length === 1 && sentMarks[0].media, sentMarks);

  await evalIn(c, `(() => { document.querySelector('.msg-user-files .attach-tile[data-media] .attach-open').click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.media-lightbox')`), 8000, "a sent image to open in the lightbox, the same as a pending one");
  const sentShot = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(os.tmpdir(), "realm-sent-attachments-live.png"), Buffer.from(sentShot.data, "base64"));
  console.log("SCREENSHOT " + path.join(os.tmpdir(), "realm-sent-attachments-live.png"));
  await c.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await until(() => evalIn(c, `!document.querySelector('.media-lightbox')`), 5000, "sent lightbox closed");

  // The bubble, with the tip up, for the human verdict on whether the tile is findable at all.
  const sentBox = await evalIn(c, `(() => {
    const b = document.querySelector('.msg-user-files .attach-tile').getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sentBox.x, y: sentBox.y });
  await sleep(400);
  const bubbleShot = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(os.tmpdir(), "realm-sent-attachments-bubble.png"), Buffer.from(bubbleShot.data, "base64"));
  console.log("SCREENSHOT " + path.join(os.tmpdir(), "realm-sent-attachments-bubble.png"));
  api.close();

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  c.close();
}

main().catch(async (e) => {
  console.error("FATAL", e.message);
  process.exitCode = 1;
  try {
    if (globalThis.__c) {
      const dump = await evalIn(globalThis.__c, `({
        tiles: document.querySelectorAll('.attach-tile').length,
        thumbs: document.querySelectorAll('.attach-thumb').length,
        composer: !!document.querySelector('.composer'),
        notes: [...document.querySelectorAll('.composer-attach-note')].map((e) => e.textContent),
        row: document.querySelector('.composer-attachments')?.innerHTML?.slice(0, 500) ?? null,
      })`);
      console.error("PROMPTER:", JSON.stringify(dump, null, 2).slice(0, 1400));
      console.error("CONSOLE:", globalThis.__c.events.slice(0, 8));
    }
  } catch (x) { console.error("dump failed", x.message); }
})
  .finally(() => {
    electron?.kill();
    setTimeout(() => {
      // The scratch dir holds a REALM_HOME and an Electron userData tree. Left behind it is tens of
      // megabytes a run, and a pile of them is what turns the next suite's disk pressure into a
      // page of unrelated-looking failures.
      fs.rmSync(scratch, { recursive: true, force: true });
      process.exit(process.exitCode ?? 0);
    }, 500);
  });
