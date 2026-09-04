/**
 * Live check for inline media (run with: node apps/desktop/scripts/media-live.mjs)
 *
 * Boots the REAL app (built out/main against the built realm-server) on a scratch REALM_HOME and
 * asks the renderer the questions jsdom structurally cannot answer:
 *
 *   1. `img-src realm-media:` admits the scheme and the handler serves the bytes — an <img> decodes
 *      to the fixture's real dimensions
 *   2. `media-src realm-media:` admits it too — a <video> reaches HAVE_METADATA with the fixture's
 *      real dimensions and duration
 *   3. seeking lands, which is only possible if the handler answered the element's Range request —
 *      the whole reason this is a streaming protocol and not a data: URL
 *   4. the gate holds in the REAL handler, discriminatingly: the SAME decodable video bytes, copied
 *      to a non-media extension, are refused
 *   5. nothing was refused by CSP along the way (violations are collected, not merely hoped absent)
 *
 * Everything is driven through real elements rather than `fetch`, because that is how the feature
 * actually loads media — the page's `connect-src` does not admit the scheme, on purpose.
 *
 * Every one of these is a main-process or CSP fact. Under jsdom there is no protocol handler, no
 * CSP enforcement and no decoder, so all five pass vacuously there and can only be checked here.
 *
 * Ports: 9223 (CDP), 8788 (realm-server). Refuses to run if either is taken. Touches only a scratch
 * dir (REALM_HOME + userData); kills only the process it started. Needs ffmpeg for the test video.
 */
import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CDP_PORT = 9223, SERVER_PORT = 8788;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-media-live-"));
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
    try { const v = await fn(); if (v) return v; } catch { /* not ready */ }
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${tag}`);
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

/** A minimal client for the server's WebSocket JSON-RPC. The scripted agent is not offered in the
 *  harness chip — deliberately, it is a dev adapter — so the session is switched onto it here, the
 *  way the UI would if it did. The renderer is subscribed to the same server and renders the result. */
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
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
  results[name] = { pass: !!cond, ...(detail !== undefined ? { detail } : {}) };
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};

/** Mirrors `mediaUrl` in packages/contracts/src/media.ts — deliberately re-spelled rather than
 *  imported, so a change to the URL shape that the unit tests bless still has to work HERE. */
const mediaUrl = (p) => `realm-media://f/${encodeURIComponent(p)}`;

/** A 2×2 red PNG. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z4AATAxQxhAVAAAA//8DAAKrAP8i0m9DAAAAAElFTkSuQmCC";

async function main() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }

  // The fixtures. `shot.png` is a real 400×300 picture — big enough that "the frame has a size" is a
  // meaningful thing to measure; `tiny.png` is 2×2 and exists only to prove nothing gets upscaled.
  const pngPath = path.join(scratch, "shot.png");
  const mk = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=400x300:duration=1",
    "-frames:v", "1", pngPath, "-y"], { encoding: "utf8" });
  if (mk.status !== 0) throw new Error(`ffmpeg could not make the picture fixture: ${mk.stderr}`);
  const tinyPath = path.join(scratch, "tiny.png");
  fs.writeFileSync(tinyPath, Buffer.from(PNG_B64, "base64"));
  const mp4Path = path.join(scratch, "clip.mp4");
  const ff = spawnSync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=15:duration=3",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4Path, "-y",
  ], { encoding: "utf8" });
  if (ff.status !== 0) throw new Error(`ffmpeg could not make the fixture: ${ff.stderr || ff.error?.message}`);
  // The same decodable video bytes under a name the gate must refuse. Copying rather than writing
  // junk is what makes the refusal discriminating: if it 404s, it is the NAME that was refused.
  const disguisedPath = path.join(scratch, "clip.txt");
  fs.copyFileSync(mp4Path, disguisedPath);
  const pngBytes = fs.statSync(pngPath).size, mp4Bytes = fs.statSync(mp4Path).size;

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
      // The scripted adapter, so the visual step below can put a real assistant message through the
      // real transcript without any network or any installed agent CLI.
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
  // CSP refusals are reported as violation events, not exceptions: an <img> that CSP blocked simply
  // never loads, and without this a policy mistake would look like a slow decode.
  await until(() => evalIn(c, `!!document.querySelector('#root')`), 20000, "renderer root");
  await evalIn(c, `(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) =>
      window.__csp.push({ directive: e.violatedDirective, uri: String(e.blockedURI).slice(0, 60) }));
    return true; })()`);

  /** Load `src` in an element of `tag` and report what happened. A CSP refusal and a 404 both land
   *  on `error`; the checks below tell them apart by which paths are supposed to work. */
  const load = (tag, src, extra = "") => evalIn(c, `(async () => {
    const el = document.createElement(${JSON.stringify(tag)});
    ${extra}
    el.src = ${JSON.stringify(src)};
    document.body.appendChild(el);
    const outcome = await new Promise((res) => {
      el.addEventListener(${JSON.stringify(tag === "img" ? "load" : "loadedmetadata")}, () => res('ok'));
      el.addEventListener('error', () => res('error'));
      setTimeout(() => res('timeout'), 12000);
    });
    const meta = { outcome,
      w: el.naturalWidth ?? el.videoWidth, h: el.naturalHeight ?? el.videoHeight,
      duration: el.duration === undefined ? null : Math.round((el.duration || 0) * 10) / 10,
      error: el.error ? el.error.code : null };
    if (${JSON.stringify(tag)} === 'video' && outcome === 'ok') {
      el.currentTime = 2;
      await new Promise((res) => { el.addEventListener('seeked', res, { once: true }); setTimeout(res, 8000); });
      meta.seekedTo = Math.round(el.currentTime * 10) / 10;
    }
    el.remove();
    return meta;
  })()`);

  // 1. The picture: CSP admits the scheme for images and the handler served real bytes.
  const img = await load("img", mediaUrl(pngPath));
  check("an <img> on realm-media:// decodes the real file", img.outcome === "ok" && img.w === 400 && img.h === 300, img);

  // 2 & 3. The video: metadata, duration, and a seek that lands — the seek is what proves the
  // handler answered a Range request, since Chromium cannot seek a source it must download whole.
  const video = await load("video", mediaUrl(mp4Path), "el.preload = 'metadata'; el.muted = true;");
  check("a <video> on realm-media:// loads its metadata", video.outcome === "ok" && video.w === 320 && video.h === 240, video);
  check("it reports the fixture's real duration", Math.abs((video.duration ?? 0) - 3) < 0.5, video.duration);
  check("seeking lands where it was asked to, so Range is being served", Math.abs((video.seekedTo ?? -1) - 2) < 0.3, video.seekedTo);

  // 4. The gate — the same bytes, a name the handler must refuse.
  const disguised = await load("video", mediaUrl(disguisedPath), "el.preload = 'metadata'; el.muted = true;");
  check("the same video bytes under a non-media name are refused", disguised.outcome === "error", disguised);
  const missing = await load("img", mediaUrl(path.join(scratch, "nope.png")));
  check("a path that is not there is refused", missing.outcome === "error", missing);
  // `..` is collapsed before the extension is read, so this resolves to clip.txt and is refused.
  const traversal = await load("video", mediaUrl(path.join(scratch, "clip.mp4", "..", "clip.txt")), "el.preload = 'metadata';");
  check("a traversal cannot dress a refused name up as a media one", traversal.outcome === "error", traversal);

  // 5. Nothing was blocked along the way. The fixtures above are supposed to LOAD, so any violation
  // naming realm-media: on img-src or media-src is a CSP mistake rather than the gate working.
  const csp = await evalIn(c, `window.__csp`);
  const wrong = csp.filter((v) => /img-src|media-src/.test(v.directive));
  check("no CSP violation blocked the media that should load", wrong.length === 0, csp.slice(0, 4));

  /* ── The visual half ───────────────────────────────────────────────────────
     Everything above proves the transport. This drives a REAL session through the REAL transcript:
     the scripted adapter echoes whatever it is sent, so a message shaped like the mockups report
     comes back as an assistant message, and the strip that appears under it is the actual component
     with actual layout. jsdom can assert the strip exists; only this can assert it has a size. */
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  // Put the open session on the scripted adapter. Over RPC rather than through the harness chip:
  // `fake` is not in SELECTABLE_AGENT_KINDS, on purpose — it is a dev adapter, not an offer.
  const api = rpc(SERVER_PORT);
  await api.ready;
  const sessions = await until(async () => {
    const all = await api.call("sessions.listAll", {});
    return all.length ? all : null;
  }, 15000, "a session to drive");
  const sessionId = sessions[0].id;
  await api.call("sessions.setAgent", { id: sessionId, agentKind: "fake" });

  // The message: the shape from the session that motivated this — a directory in prose, filenames
  // in a table. The echo puts the same text back as an assistant message.
  const report = [
    "Done — two clips are in `" + scratch + "/`:",
    "",
    "| File | Length |",
    "|---|---|",
    "| `clip.mp4` | 0:03 |",
    "| `shot.png` | — |",
    "| `tiny.png` | — |",
    "| `clip.txt` | — |",
  ].join("\n");
  // The scripted adapter echoes whatever it is sent, so this comes back as a real assistant message
  // through the real event stream and the real transcript reducer.
  await api.call("sessions.send", { id: sessionId, text: report, attachments: [], mentions: [] });

  const strip = await until(() => evalIn(c, `(() => {
    const s = document.querySelector('.media-strip');
    if (!s) return null;
    // A frame hugs its picture, so it has no width until the picture has decoded — measuring before
    // that would report a collapsed box and call it a layout bug.
    if (![...s.querySelectorAll('img')].every((i) => i.complete && i.naturalWidth > 0)) return null;
    const items = [...s.querySelectorAll('.media-item')].map((li) => {
      const frame = li.querySelector('.media-video, .media-image');
      const b = frame.getBoundingClientRect();
      return { tag: frame.querySelector('video, img')?.tagName,
               name: li.querySelector('.media-name')?.textContent,
               w: Math.round(b.width), h: Math.round(b.height) };
    });
    return items.length ? items : null;
  })()`), 25000, "the media strip");
  check("the message's files became a strip in the real transcript", strip.length === 3, strip);
  check("the video is a player and the picture is a picture",
    strip.some((i) => i.tag === "VIDEO" && i.name === "clip.mp4") && strip.some((i) => i.tag === "IMG" && i.name === "shot.png"), strip);
  // The failure a stylesheet test cannot see: a frame that is in the DOM with no size.
  // The failure a stylesheet test cannot see: a frame that is in the DOM with no size. Measured on
  // the two real-sized fixtures; `tiny.png` is 2×2 and is SUPPOSED to be small.
  check("every frame has real layout", strip.filter((i) => i.name !== "tiny.png").every((i) => i.w > 100 && i.h > 40), strip);
  check("a small picture is not upscaled in the strip either",
    strip.find((i) => i.name === "tiny.png")?.w === 2, strip.find((i) => i.name === "tiny.png"));
  // `clip.txt` was named in the same table and is not media — it must not have become a third item.
  check("a non-media file named in the same table is not in the strip",
    !strip.some((i) => String(i.name).endsWith(".txt")), strip.map((i) => i.name));

  /* The strip appears several frames after its message — main has to confirm the files first — and
     then grows again as each picture decodes. A transcript that only re-pins on new BLOCKS leaves
     the reader looking at the top of a video whose controls are under the prompter. */
  const pinned = await until(() => evalIn(c, `(() => {
    const sc = document.querySelector('.transcript');
    const last = [...document.querySelectorAll('.media-item')].pop();
    const composer = document.querySelector('.composer').getBoundingClientRect();
    const meta = last.querySelector('.media-meta').getBoundingClientRect();
    const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight;
    return atBottom < 4 && meta.bottom <= composer.top ? { atBottom: Math.round(atBottom), clear: true } : null;
  })()`), 8000, "the transcript to re-pin under the new strip");
  check("the strip does not land under the prompter", pinned.clear, pinned);

  /* The generating canvas, CSS only. No adapter in this harness emits a long-running media tool call,
     so the component's own wiring is covered by the unit tests (media-views.test.tsx) and what is
     checked here is the thing they cannot see: that `aspect-ratio` actually produces a box, and that
     the glow — a conic gradient at `inset: -40%` — is clipped by it instead of escaping. */
  const canvas = await evalIn(c, `(() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:20px;top:20px;width:400px';
    const box = (aspect, w) => '<div class="gen-canvas" style="aspect-ratio:' + aspect + ';width:' + w + 'px">' +
      '<span class="gen-glow"></span><span class="gen-dots"></span></div>';
    // The three shapes and the widths GeneratingCanvas computes for them (genWidthPx, max 320).
    host.innerHTML = '<div class="gen-wrap">' + box('1080 / 1920', 180) + box('16 / 9', 320) + box('1 / 1', 320) + '</div>';
    document.body.appendChild(host);
    const out = [...host.querySelectorAll('.gen-canvas')].map((el) => {
      const b = el.getBoundingClientRect();
      return { w: Math.round(b.width), h: Math.round(b.height), ratio: Math.round((b.width / b.height) * 100) / 100 };
    });
    // overflow is asserted rather than measured: a clipped child still reports its full LAYOUT rect,
    // so comparing rectangles would call every glow an escape. This is the declaration that clips it.
    const clip = getComputedStyle(host.querySelector('.gen-canvas')).overflow;
    host.remove();
    return { boxes: out, clip }; })()`);
  const [portrait, wide, square] = canvas.boxes;
  check("a portrait canvas is portrait, not squared off by its own caps",
    Math.abs(portrait.ratio - 1080 / 1920) < 0.02 && portrait.h > 300, portrait);
  check("a wide canvas and a square one keep their shapes too",
    Math.abs(wide.ratio - 16 / 9) < 0.02 && Math.abs(square.ratio - 1) < 0.02, { wide, square });
  check("the canvas clips its glow", canvas.clip === "hidden", canvas.clip);

  // The human verdict on the strip itself, before the lightbox covers it.
  {
    const shot = await c.send("Page.captureScreenshot", { format: "png" });
    const p = path.join(os.tmpdir(), "realm-media-strip.png");
    fs.writeFileSync(p, Buffer.from(shot.data, "base64"));
    console.log("SCREENSHOT " + p);
  }

  // The transport controls have to sit ON the video, inside its frame.
  const controls = await evalIn(c, `(() => {
    const v = document.querySelector('.media-video');
    const f = v.getBoundingClientRect(), t = v.querySelector('.media-controls').getBoundingClientRect();
    return { inside: t.left >= f.left - 1 && t.right <= f.right + 1 && t.bottom <= f.bottom + 1,
             w: Math.round(t.width), h: Math.round(t.height) }; })()`);
  check("the transport is laid out inside the video's frame", controls.inside && controls.w > 100 && controls.h > 10, controls);

  // The lightbox: a portal to <body>, so the transcript's own overflow cannot clip it.
  await evalIn(c, `[...document.querySelectorAll('.media-item')].find((li) => li.querySelector('.media-name').textContent === 'tiny.png').querySelector('.media-image').click()`);
  const light = await until(() => evalIn(c, `(() => {
    const d = document.querySelector('.media-lightbox');
    if (!d) return null;
    const b = d.getBoundingClientRect();
    return { parent: d.parentElement.tagName, w: Math.round(b.width), h: Math.round(b.height),
             coversWindow: Math.abs(b.width - innerWidth) < 2 && Math.abs(b.height - innerHeight) < 2 };
  })()`), 8000, "the lightbox");
  check("the lightbox portals to <body> and fills the window", light.parent === "BODY" && light.coversWindow, light);

  /* A <video> is composited on its own layer, and a layer can paint OVER a translucent overlay that
     is above it in the stacking order — hit-testing says the lightbox is on top while the pixels say
     otherwise. Nothing in the DOM can report that, so this samples the composited screenshot: crop
     the rect where the transcript's video sits, average it to one pixel, and ask whether the
     lightbox's dim is what is actually painted there. */
  const behind = await evalIn(c, `(() => {
    const b = document.querySelector('.transcript video').getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 4), y: Math.round(b.top + b.height / 4),
             w: Math.max(8, Math.round(b.width / 2)), h: Math.max(8, Math.round(b.height / 2)) }; })()`);
  const overlayShot = await c.send("Page.captureScreenshot", { format: "png" });
  const overlayPath = path.join(scratch, "overlay.png");
  fs.writeFileSync(overlayPath, Buffer.from(overlayShot.data, "base64"));
  const dpr = await evalIn(c, "devicePixelRatio");
  const avg = spawnSync("ffmpeg", [
    "-v", "error", "-i", overlayPath,
    "-vf", `crop=${Math.round(behind.w * dpr)}:${Math.round(behind.h * dpr)}:${Math.round(behind.x * dpr)}:${Math.round(behind.y * dpr)},scale=1:1`,
    "-pix_fmt", "rgb24", "-f", "rawvideo", "-",
  ], { maxBuffer: 1 << 20 });
  const [r, g, bl] = avg.stdout ?? [0, 0, 0];
  // A control sample: the same overlay where there is provably nothing behind it but the sidebar.
  // Without this, "dark enough" could be passing on a dimmed-but-still-bleeding video.
  const ctrlRect = { x: 8, y: 8, w: 40, h: 40 };
  const ctrl = spawnSync("ffmpeg", ["-v", "error", "-i", overlayPath,
    "-vf", `crop=${Math.round(ctrlRect.w * dpr)}:${Math.round(ctrlRect.h * dpr)}:${Math.round(ctrlRect.x * dpr)}:${Math.round(ctrlRect.y * dpr)},scale=1:1`,
    "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { maxBuffer: 1 << 20 });
  const [cr, cg, cb] = ctrl.stdout ?? [0, 0, 0];
  console.log("SAMPLES", JSON.stringify({ overVideo: [r, g, bl], control: [cr, cg, cb] }));
  // The lightbox dims to near-black. Video bleeding through shows as brightness and, for the
  // testsrc fixture, as colour — so both are checked.
  // Compared against the CONTROL, not against an absolute: the overlay has a colour of its own, and
  // the question is only whether the video adds anything to it.
  const delta = Math.max(Math.abs(r - cr), Math.abs(g - cg), Math.abs(bl - cb));
  check("the lightbox actually covers the video behind it", delta <= 6, { overVideo: [r, g, bl], control: [cr, cg, cb], delta });

  const stage = await evalIn(c, `(() => {
    const el = document.querySelector('.media-lightbox .media-stage .media-el');
    const b = el.getBoundingClientRect();
    return { tag: el.tagName, w: Math.round(b.width), h: Math.round(b.height), natural: el.naturalWidth ?? null }; })()`);
  // A picture is shown at its own size, never blown up: an upscaled 2×2 fixture is a smear, and an
  // upscaled icon in a real transcript is the same mistake at a size nobody notices is wrong.
  check("a small picture is not upscaled to fill the stage", stage.w === stage.natural, stage);

  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(os.tmpdir(), "realm-media-live.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log("SCREENSHOT " + shotPath);

  const errs = c.events.filter((e) => !e.includes("Autofill"));
  check("no renderer console errors", errs.length === 0, errs.slice(0, 5));
  console.log("fixtures", { pngBytes, mp4Bytes, scratch });
  api.close();
  c.close();
}

main().catch((e) => {
  console.error("FATAL", e.message);
  process.exitCode = 1;
}).finally(() => {
  electron?.kill();
  setTimeout(() => { fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode ?? 0); }, 500);
});
