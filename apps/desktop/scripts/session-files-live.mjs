/**
 * Live check for the session's file browser (run with: node apps/desktop/scripts/session-files-live.mjs)
 *
 * Boots the REAL app on a scratch REALM_HOME, writes files into the space's folder the way an agent's
 * shell command would, opens a session and presses Files.
 *
 * What only a real run can show: the panel reads the DISK. Every other list of a session's files in
 * this app is folded out of the transcript — the summary's Outputs, the Library's index — so a file
 * produced by a script or a shell line is in none of them. The files this script writes are made by
 * `fs`, with no tool call anywhere in the session, which is the same thing as far as the app is
 * concerned. If they appear in the panel, the chain works end to end: main's directory read, the
 * preload bridge, the panel's own listing.
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
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9397), SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8961);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-session-files-"));
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

async function evalIn(c, expr) {
  const r = await c.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page exception: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const check = (name, cond, detail) => {
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
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 950, deviceScaleFactor: 2, mobile: false });

  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 20000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    set.call(input, 'Live'); input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 20000, "composer");

  // A session to press the button on. The fake agent needs no CLI on this machine.
  await evalIn(c, `(() => { document.querySelector('button[aria-label="New session"]')?.click(); return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.panel-bar [aria-label^="Files for"]')`), 20000, "the Files button");

  const before = await evalIn(c, `!!document.querySelector('.session-files')`);
  check("the panel is closed until it is asked for", before === false);

  /* Clicked, then CONFIRMED open — and pressed again if it is not. A session that has only just
     arrived is still settling (its pane re-renders as the transcript, the title and the environment
     land), and a click that lands mid-settle can be spent on a button that is about to be replaced.
     A person would simply press it again; so does this. */
  await sleep(1200);
  await until(async () => {
    const open = await evalIn(c, `(() => {
      if (document.querySelector('.session-files')) return true;
      document.querySelector('.panel-bar [aria-label^="Files for"]')?.click();
      return !!document.querySelector('.session-files');
    })()`);
    return open || null;
  }, 12000, "the files panel");
  /* Which folder the panel is showing, asked of the panel rather than guessed from the home's
     directory listing — a home holds the profile's folder as well as the space's, and writing the
     files into the wrong one produced a test that failed while the feature worked. */
  const crumb = await until(() => evalIn(c, `document.querySelector('.session-files .files-crumb')?.textContent ?? null`), 10000, "the root crumb")
    .catch(async (e) => {
      console.error("DIAGNOSTIC", JSON.stringify(await evalIn(c, `(() => {
        const el = document.querySelector('.session-files');
        return { panel: !!el, html: el ? el.innerHTML.slice(0, 400) : null,
                 button: !!document.querySelector('.panel-bar [aria-label^="Files for"]'),
                 pressed: document.querySelector('.panel-bar [aria-label^="Files for"]')?.getAttribute('aria-expanded') ?? null };
      })()`)));
      throw e;
    });
  /* A space's folder is `<home>/<profile>/<space>`, so the crumb's basename has to be found rather
     than joined — writing to `<home>/<space>` puts the files one level above where the panel is
     looking, and the panel is then correctly reporting an empty folder. */
  const findFolder = (from, name, depth = 3) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const abs = path.join(from, e.name);
      if (e.name === name) return abs;
      if (depth > 1) { const hit = findFolder(abs, name, depth - 1); if (hit) return hit; }
    }
    return null;
  };
  const spaceFolder = findFolder(path.join(scratch, "home"), crumb);
  check("the panel names the space's own folder", spaceFolder !== null, { crumb, spaceFolder });
  if (!spaceFolder) throw new Error(`no folder named ${crumb} under the scratch home`);

  /* The files. Written with `fs`, deliberately: nothing in the session's transcript will ever mention
     them, which is exactly the case the summary's Outputs list cannot see and this panel must. */
  fs.writeFileSync(path.join(spaceFolder, "handwriting-starter.zip"), Buffer.alloc(48 * 1024));
  fs.writeFileSync(path.join(spaceFolder, "blank-handwriting-sheet.pdf"), "%PDF-1.4\n");
  fs.mkdirSync(path.join(spaceFolder, "sheet"), { recursive: true });
  fs.writeFileSync(path.join(spaceFolder, "sheet", "manifest.json"), "{}\n");

  // …and the button that re-reads the folder, which is the only way to see a file that arrived from
  // outside the session.
  const refreshed = await evalIn(c, `(() => {
    const el = document.querySelector('.session-files');
    if (!el) return { panel: false };
    const btn = el.querySelector('[aria-label="Refresh this folder"]');
    btn?.click();
    return { panel: true, clicked: !!btn, head: [...el.querySelectorAll('.summary-panel-head button')].map((b) => b.getAttribute('aria-label')) };
  })()`);
  check("the panel offers a way to re-read the folder", refreshed.clicked === true, refreshed);
  const trace = [];
  const rows = await until(async () => {
    const seen = await evalIn(c, `(() => {
      const btn = document.querySelector('.panel-bar [aria-label^="Files for"]');
      return { open: !!document.querySelector('.session-files'), expanded: btn?.getAttribute('aria-expanded') ?? null,
               names: [...document.querySelectorAll('.session-files .summary-row-name')].map((n) => n.textContent) };
    })()`);
    trace.push(`${seen.open ? "panel" : "gone"}/${seen.expanded}/${seen.names.length}`);
    return seen.names.length ? seen.names : null;
  }, 6000, "the folder's rows").catch(async (e) => {
    /* A failure here says WHERE it looked, because "no rows" has three causes and they need telling
       apart: the panel never opened, it read a different folder than the one written to, or the
       bridge answered nothing at all. */
    const seen = await evalIn(c, `(async () => {
      const el = document.querySelector('.session-files');
      /* The bridge itself, asked directly: it separates "the panel did not re-read" from "main
         answered nothing", which look identical from the outside and have different fixes. */
      const bridge = typeof window.realm?.files?.browse === "function"
        ? await window.realm.files.browse(${JSON.stringify(spaceFolder)}, "").catch((e) => "threw: " + e.message)
        : "no bridge";
      return { open: !!el, note: el?.querySelector('.files-note')?.textContent ?? null,
               crumbs: [...(el?.querySelectorAll('.files-crumb') ?? [])].map((x) => x.textContent), bridge };
    })()`);
    console.error("DIAGNOSTIC", JSON.stringify({ wroteTo: spaceFolder, seen }));
    throw e;
  });

  /* The claim. These three exist on disk and in no transcript, so every other list in the app is
     empty for them — which is the bug report this feature answers. */
  check("it lists files nothing in the transcript ever mentioned",
    ["handwriting-starter.zip", "blank-handwriting-sheet.pdf", "sheet"].every((n) => rows.includes(n)), rows);

  const meta = await evalIn(c, `[...document.querySelectorAll('.session-files .summary-row')]
    .map((r) => [r.querySelector('.summary-row-name').textContent, r.querySelector('.summary-row-meta')?.textContent])`);
  check("each row says what it is and how big", meta.some(([n, m]) => n === "handwriting-starter.zip" && m === "48 KB"), meta);
  check("and a folder says so rather than a size", meta.some(([n, m]) => n === "sheet" && m === "Folder"), meta);

  // Descend, and come back by the crumb — the two halves of being a browser rather than a list.
  await evalIn(c, `(() => { [...document.querySelectorAll('.session-files .summary-row')].find((r) => r.textContent.includes('sheet')).click(); return true; })()`);
  const inner = await until(async () => {
    const names = await evalIn(c, `[...document.querySelectorAll('.session-files .summary-row-name')].map((n) => n.textContent)`);
    return names.includes("manifest.json") ? names : null;
  }, 8000, "the subfolder");
  check("it descends into a folder", inner.includes("manifest.json"), inner);
  const crumbs = await evalIn(c, `[...document.querySelectorAll('.session-files .files-crumb')].map((e) => [e.tagName, e.textContent])`);
  check("the trail says where you are, and only the way back is a button",
    crumbs.length === 2 && crumbs[0][0] === "BUTTON" && crumbs[1][0] === "SPAN" && crumbs[1][1] === "sheet", crumbs);
  await evalIn(c, `(() => { document.querySelector('.session-files .files-crumb').click(); return true; })()`);
  await until(async () => (await evalIn(c, `[...document.querySelectorAll('.session-files .summary-row-name')].map((n) => n.textContent)`)).includes("handwriting-starter.zip"), 8000, "back at the root");
  check("and the crumb walks back out", true);

  /* Docked like the summary, not floating over the transcript: same class, same pinned rule. A pane
     this wide must pin, or the panel is covering the thing it is about. */
  const geo = await evalIn(c, `(() => {
    const el = document.querySelector('.session-files');
    const pane = document.querySelector('.session-pane');
    const r = el.getBoundingClientRect(), p = pane.getBoundingClientRect();
    return { pinned: el.hasAttribute('data-pinned'), dock: el.classList.contains('pane-dock'),
             right: Math.round(p.right - r.right), inside: r.top >= p.top - 1 && r.bottom <= p.bottom + 1 };
  })()`);
  check("it docks to the pane's edge, pinned, like the summary it sits beside",
    geo.pinned === true && geo.dock === true && geo.inside === true && geo.right >= 0 && geo.right < 24, geo);

  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  const out = path.join(os.tmpdir(), "realm-session-files.png");
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`SCREENSHOT ${out}`);

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
