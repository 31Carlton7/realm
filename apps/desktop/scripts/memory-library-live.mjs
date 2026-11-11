/**
 * Live check for the Library's Memory page (run with: pnpm build && node apps/desktop/scripts/memory-library-live.mjs)
 *
 * A scratch Mac: Realm's home, and a stand-in for the user's home holding each agent's own memory
 * files. The server is started through a wrapper that points its HOME there, and CLAUDE_CONFIG_DIR and
 * CODEX_HOME there too, so the real `~/.claude`, `~/.codex`, `~/.cursor` and `~/.gemini` are never
 * read. Electron keeps the real HOME: pointed elsewhere, its main process waits on a login keychain
 * that is not there and the window never comes up. The profile's repo gets several
 * memories through `memory.library.create`, one space's folder gets a CLAUDE.md and an AGENTS.md, and
 * then the page is driven the way a person uses it — the Library button, the Memory row, a source, the
 * search, a [[link]], Edit and Save (one commit), New memory, Delete (one commit), and a file outside
 * Realm written only after its question is answered — in both faces, with a screenshot of each state.
 *
 * Nothing is billed: Claude and Codex are the scripted agent's stand-ins (REALM_FAKE_STANDS_IN) and
 * nothing is sent. Ports: LIVE_SERVER_PORT / LIVE_CDP_PORT (8793 / 9233). Scratch under LIVE_SCRATCH,
 * screenshots under LIVE_SHOTS. Kills only what holds its own two ports, and only if it is this run's.
 */
import { execFileSync, execSync } from "node:child_process";
import { connect } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { daemonToken, stopDaemons, tokenProtocols } from "./lib/daemon-token.mjs";
import { spawnLiveElectron } from "./lib/live-app.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_PORT = Number(process.env.LIVE_SERVER_PORT ?? 8793);
const CDP_PORT = Number(process.env.LIVE_CDP_PORT ?? 9233);
const UNTHROTTLED = ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"];
const VIEW = { width: 1440, height: 900 };
const scratch = process.env.LIVE_SCRATCH ?? fs.mkdtempSync(path.join(os.tmpdir(), "realm-memory-library-live-"));
const SHOTS = process.env.LIVE_SHOTS ?? path.join(scratch, "shots");
const home = path.join(scratch, "home");
/** The stand-in for the user's home: every agent's folder is in here. */
const user = path.join(scratch, "user");
let electron = null;
let api = null;
const daemonPids = [];
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
    close: () => s.ws.close(),
  };
}

function rpc(port, token) {
  const s = socket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  return {
    ready: s.ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(s.next());
      const timer = setTimeout(() => { s.pending.delete(i); rej(new Error(`${method}: no answer in 30s`)); }, 30000);
      s.pending.set(i, (msg) => { clearTimeout(timer); s.pending.delete(i); return msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`)); });
      s.ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => s.ws.close(),
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

const park = (c) => c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: VIEW.width - 4, y: VIEW.height - 4 });
/** Hold the window key: an unkeyed window greys its accent, and the live window opens behind. */
const holdKey = (c) => evalIn(c, `(() => { const r = document.documentElement; const hold = () => r.removeAttribute('data-window-inactive');
  hold(); if (!globalThis.__keyHeld) { new MutationObserver(hold).observe(r, { attributes: true, attributeFilter: ['data-window-inactive'] }); globalThis.__keyHeld = true; } return true; })()`);
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

/** Where to press it, once it is scrolled into view the way a person would scroll to it first. */
const centreOf = (c, expr, tag) => until(() => evalIn(c, `(() => { const el = ${expr}; if (!el) return null;
  el.scrollIntoView({ block: "nearest" });
  const r = el.getBoundingClientRect(); return r.width > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`), 10_000, tag);
/** A real press at the middle of it — the only kind of click that exercises hit-testing. */
async function pressAt(c, expr, tag) {
  const b = await centreOf(c, expr, tag);
  await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: b.x, y: b.y });
  await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: b.x, y: b.y, button: "left", clickCount: 1 });
  await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
}
const byText = (sel, text) => `[...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)})`;
const pressText = (c, sel, text) => pressAt(c, byText(sel, text), `${sel} "${text}"`);
const readerTitle = (c) => evalIn(c, `document.querySelector('.memory-reader-title')?.textContent ?? null`);
const waitTitle = (c, title) => until(async () => (await readerTitle(c)) === title, 10_000, `the reader on ${title}`);

/** The theme setting is read at load, so a face is a reload away; the page is opened again after it. */
async function setFace(c, mode) {
  if (await evalIn(c, `document.documentElement?.dataset.mode === '${mode}'`)) return;
  await api.call("settings.set", { key: "ui.theme", value: mode });
  await c.send("Page.reload", {});
  await until(() => evalIn(c, `!!document.querySelector('.composer, .page') && document.documentElement?.dataset.mode === '${mode}'`), 30_000, `the ${mode} face`);
  await evalIn(c, `globalThis.__keyHeld = false, true`);
  await holdKey(c);
}

/** The whole window, laid over the face's page colour first: a capture holds the DOM's alpha and none
 *  of the window's material behind it (design.md). */
async function shot(c, tag) {
  await park(c);
  await sleep(450);
  const r = await c.send("Page.captureScreenshot", { format: "png" });
  const data = await evalIn(c, `(async () => {
    const img = new Image(); img.src = "data:image/png;base64," + ${JSON.stringify(r.data)}; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d");
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim(); g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(img, 0, 0);
    return cv.toDataURL("image/png").split(",")[1];
  })()`);
  const out = path.join(SHOTS, `${tag}.png`);
  fs.writeFileSync(out, Buffer.from(data, "base64"));
  console.log(`SCREENSHOT ${tag} ${out}`);
}

const put = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const fact = (name, description, type, body) => `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;

/** Each agent's own files, outside Realm, in the stand-in home. */
function seedAgents() {
  put(path.join(user, ".claude", "CLAUDE.md"), "# House rules\n\n- Prefer small, reviewable pull requests.\n- Run the tests you touched before you say a change is done.\n- Never push to main without CI green.\n");
  const project = path.join(user, ".claude", "projects", "-Users-carlton-code-stora", "memory");
  put(path.join(project, "deploy-steps.md"), fact("deploy-steps", "How Stora ships a release", "project", "Tag on main, then the pipeline builds and notarizes the app.\n\nNever ship on a Friday afternoon."));
  put(path.join(project, "MEMORY.md"), "- [deploy-steps](deploy-steps.md) — how Stora ships a release\n");
  put(path.join(user, ".codex", "AGENTS.md"), "# Working agreements\n\nKeep diffs small. Explain any migration before running it.\n");
  put(path.join(user, ".cursor", "rules", "typescript.mdc"), "---\ndescription: TypeScript style\nglobs: \"*.ts,*.tsx\"\nalwaysApply: false\n---\n\n- Prefer `type` over `interface`.\n- No default exports.\n");
  put(path.join(user, ".gemini", "GEMINI.md"), "# Gemini\n\nAnswer in short paragraphs. Cite the file you read.\n");
}

async function launch() {
  for (const p of [CDP_PORT, SERVER_PORT]) {
    if (!(await portFree(p))) throw new Error(`port ${p} is in use — refusing to run`);
  }
  const mainEntry = path.join(repoRoot, "apps/desktop/out/main/index.js");
  if (!fs.existsSync(mainEntry)) throw new Error("apps/desktop/out is missing — run `pnpm build` first");
  const wrapper = path.join(scratch, "wrapper.mjs");
  fs.writeFileSync(wrapper, ['import { app } from "electron";', 'app.setPath("userData", process.env.LIVE_USER_DATA);', "await import(process.env.LIVE_MAIN);"].join("\n"));
  const serverWrapper = path.join(scratch, "server.mjs");
  fs.writeFileSync(serverWrapper, ["process.env.HOME = process.env.LIVE_SERVER_HOME;", "await import(process.env.LIVE_SERVER_MAIN);"].join("\n"));
  // LIVE_ELECTRON: a checkout whose Electron was never downloaded can run one already on the Mac.
  electron = spawnLiveElectron([wrapper, ...UNTHROTTLED], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: path.join(user, ".claude"),
      CODEX_HOME: path.join(user, ".codex"),
      REALM_HOME: home,
      REALM_ENABLE_FAKE_AGENT: "1",
      REALM_HTML_MENUS: "1",
      REALM_FAKE_STANDS_IN: "claude,codex",
      REALM_MEMORY_FALLBACK_DIR: path.join(scratch, "memory-fallback"),
      REALM_PORT: String(SERVER_PORT),
      REALM_DEVTOOLS_PORT: String(CDP_PORT),
      REALM_SERVER_ENTRY: serverWrapper,
      LIVE_SERVER_MAIN: path.join(repoRoot, "apps/server/dist/main.js"),
      LIVE_SERVER_HOME: user,
      LIVE_USER_DATA: path.join(scratch, "userData"),
      LIVE_MAIN: mainEntry,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const log = fs.createWriteStream(path.join(scratch, "electron.log"));
  electron.stderr.pipe(log); electron.stdout.pipe(log);
  const targets = () => fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json()).catch(() => []);
  const renderer = await until(async () => (await targets()).find((t) => t.type === "page" && t.url.startsWith("file://")), 60_000, "renderer target");
  const c = cdp(renderer.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Runtime.enable");
  await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 2, mobile: false });
  return c;
}

/** The CodeMirror view in the reader, by the DOM it draws, its whole text replaced. */
const setEditor = (c, text) => evalIn(c, `(() => {
  const content = document.querySelector('.memory-editor .cm-content');
  const view = content?.cmView?.view ?? content?.cmView?.rootView?.view;
  if (view) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: ${JSON.stringify(text)} } }); return "view"; }
  content.focus(); document.execCommand("selectAll"); document.execCommand("insertText", false, ${JSON.stringify(text)}); return "typed";
})()`);

async function main() {
  // A run starts from nothing but its screenshots: the last run's home and stand-in are its own.
  for (const d of ["home", "user", "userData", "memory-fallback"]) fs.rmSync(path.join(scratch, d), { recursive: true, force: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  seedAgents();
  const c = await launch();
  await holdKey(c);
  await until(() => evalIn(c, `!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await evalIn(c, `(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Realm');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.closest('form').requestSubmit();
    return true; })()`);
  await until(() => evalIn(c, `!!document.querySelector('.composer')`), 30_000, "composer");
  api = rpc(SERVER_PORT, await daemonToken(home));
  await api.ready;
  const daemon = JSON.parse(fs.readFileSync(path.join(home, "daemon.json"), "utf8"));
  if (daemon.pid) daemonPids.push(daemon.pid);
  for (const s of await api.call("sessions.listAll", { profileId: null })) await api.call("sessions.setAgent", { id: s.id, agentKind: "fake" });
  await api.call("settings.set", { key: "ui.lastAgentKind", value: "fake" });

  // ── The profile's memory, made the way the page makes it ────────────────────────────────────────
  const [profile] = await api.call("profiles.list", {});
  const realm = (await api.call("spaces.list", {})).find((sp) => sp.name === "Realm");
  const stora = await api.call("spaces.create", { profileId: profile.id, name: "Stora" });
  const [repo] = (await api.call("memory.repo.get", { profileId: profile.id })).repos;
  const REPO = `realm-repo-profile-${profile.id}`;
  const make = (o) => api.call("memory.library.create", { sourceId: REPO, ...o });
  await make({ name: "Contacts", description: "Who to ask about partnerships, payouts and the press kit", type: "reference",
    body: "- **Maya** runs creator partnerships and signs off every brief.\n- **Jon** handles payouts; invoices go to finance@stora.app.\n- The press kit lives in Drive ▸ Brand ▸ Press." });
  await make({ name: "Prefers short answers", description: "Lead with the answer, then the one reason that matters", type: "feedback",
    body: "Carlton reads on his phone between meetings. Put the decision first, keep it to a few sentences, and offer detail only when asked." });
  await make({ spaceId: realm.id, name: "Uses pnpm", description: "The monorepo is pnpm workspaces — never npm or yarn", type: "project",
    body: "Run `pnpm install` at the root. Filter a package with `pnpm --filter @realm/desktop …`." });
  await make({ spaceId: stora.id, name: "Release train", description: "Stora ships every other Tuesday from main", type: "project",
    body: "Freeze on the Monday before. The release notes come from the merged PR titles." });
  await make({ name: "Spring creator campaign", description: "Where the spring campaign's briefs, contacts and logins are kept", type: "reference",
    body: "## Where things are\n\n- Briefs: Drive ▸ Campaigns ▸ Spring 2026, one doc per creator.\n- Creator logins: 1Password, vault **Creators** — never paste a password into memory.\n- Contracts: signed copies in Drive ▸ Legal ▸ Creators.\n\n## People\n\nAsk [[contacts]] for who signs off. Payouts follow the [[prefers-short-answers]] rule when you report them.\n\n## Dates\n\n| Milestone | Date |\n| --- | --- |\n| Briefs out | Mar 3 |\n| First posts | Mar 17 |\n| Wrap-up report | Apr 14 |\n" });
  // One space's folder holds Claude's and Codex's own files too, and a document of Realm's own.
  put(path.join(stora.folderPath, "CLAUDE.md"), "# Stora\n\nThe Stora app: Expo + a Fastify API. Run `pnpm dev` in `apps/api` before the app.\n");
  put(path.join(stora.folderPath, "AGENTS.md"), "# Stora for Codex\n\nThe API's tests need Postgres from `docker compose up db`.\n");
  await api.call("memory.set", { spaceId: realm.id, doc: "Realm is a local-first Mac workspace for coding agents.\n\nKeep design.md open while working on UI.\n" });
  const commits = () => Number(git(repo.path, "rev-list", "--count", "HEAD").trim());
  console.log(`EVIDENCE repo ${repo.path}: ${commits()} commits\n${git(repo.path, "log", "--format=%h %s")}`);
  console.log(`EVIDENCE MEMORY.md:\n${fs.readFileSync(path.join(repo.path, "MEMORY.md"), "utf8")}`);
  check("each memory made is one commit, linked from MEMORY.md", git(repo.path, "log", "--format=%s").split("\n").filter((s) => s.startsWith("Remember ")).length === 5
    && fs.readFileSync(path.join(repo.path, "MEMORY.md"), "utf8").includes("[[spring-creator-campaign]]"));

  const sources = (await api.call("memory.library.sources", { profileId: profile.id })).sources;
  console.log(`EVIDENCE memory.library.sources → ${JSON.stringify(sources.map((s) => [s.group, s.label, s.count, s.pointed]))}`);
  check("every agent's source is found in the scratch home, and only there", ["realm", "claude", "codex", "cursor", "gemini"].every((g) => sources.some((s) => s.group === g))
    && sources.every((s) => !s.path.startsWith(os.homedir()) || s.path.startsWith(scratch)), sources.map((s) => s.path));

  // ── The page, the way a person reaches it ──────────────────────────────────────────────────────
  const openMemory = async () => {
    await evalIn(c, `(() => { const s = document.querySelector('.app-rail .rail-btn[aria-label^="Library"]'); if (s?.getAttribute('aria-pressed') !== 'true') s.click(); return true; })()`);
    await until(() => evalIn(c, `!!document.querySelector('.sb-page-nav .page-rail')`), 10_000, "the Library's column");
    await pressText(c, ".sb-page-nav .page-rail .settings-tab", "Memory");
    await until(() => evalIn(c, `document.querySelectorAll('.memory-row').length > 0 && !!document.querySelector('.memory-reader-title')`), 10_000, "the Memory page");
  };
  const pick = async (title) => { await pressText(c, ".memory-row .memory-row-title", title); await waitTitle(c, title); await sleep(500); };

  for (const face of ["dark", "light"]) {
    await setFace(c, face);
    await openMemory();
    const rows = await evalIn(c, `[...document.querySelectorAll('.memory-row-title')].map((t) => t.textContent)`);
    check(`the list holds Realm's memories and each agent's (${face})`, ["Spring creator campaign", "House rules", "deploy-steps", "Working agreements", "typescript", "Gemini", "Realm"].every((t) => rows.includes(t)), rows);
    const column = await evalIn(c, `[...document.querySelectorAll('.memory-source-group')].map((g) => g.querySelector('.group-label').textContent + ': ' + [...g.querySelectorAll('.memory-source-name')].map((n) => n.textContent).join(', '))`);
    console.log(`EVIDENCE column (${face}): ${JSON.stringify(column)}`);
    await pick("Spring creator campaign");
    await shot(c, `1-library-memory-${face}`);

    // A source from the column narrows the list, and says how agents reach it.
    await pressAt(c, `[...document.querySelectorAll('.memory-source')].find((b) => b.closest('.memory-source-group')?.getAttribute('aria-label') === 'Claude' && b.textContent.includes('User memory'))`, "Claude ▸ User memory");
    await until(() => evalIn(c, `document.querySelector('.memory-lib-title')?.textContent === 'User memory'`), 10_000, "the source's list");
    await waitTitle(c, "House rules");
    check(`a source says how agents reach it (${face})`, (await evalIn(c, `document.querySelector('.memory-source-note')?.textContent ?? ''`)).includes("Claude Code loads it in every session."));
    await shot(c, `2-source-claude-${face}`);
    await pressText(c, ".sb-page-nav .page-rail .settings-tab", "Memory");
    await until(() => evalIn(c, `document.querySelector('.memory-lib-title')?.textContent === 'Memory'`), 10_000, "every source again");

    // Search, as it is typed.
    await evalIn(c, `(() => { const i = document.querySelector('.memory-lib-search input'); i.focus(); return true; })()`);
    await c.send("Input.insertText", { text: "logins" });
    await until(() => evalIn(c, `document.querySelectorAll('.memory-row').length === 1`), 10_000, "the search's one hit");
    await pick("Spring creator campaign");
    check(`the search shows the line it matched (${face})`, (await evalIn(c, `document.querySelector('.memory-row-line').textContent`)).includes("logins"));
    await shot(c, `3-search-${face}`);
    await evalIn(c, `(() => { const i = document.querySelector('.memory-lib-search input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); i.blur(); return true; })()`);
    await until(() => evalIn(c, `document.querySelectorAll('.memory-row').length > 5`), 10_000, "the whole list again");

    // The editor, on the memory being read.
    await pick("Spring creator campaign");
    await pressText(c, ".memory-reader-actions .btn", "Edit");
    await until(() => evalIn(c, `!!document.querySelector('.memory-editor .cm-content')`), 10_000, "the editor");
    await shot(c, `4-editor-${face}`);
    await pressText(c, ".memory-reader-actions .btn", "Cancel");

    // New memory.
    await pressAt(c, `document.querySelector('.memory-lib-new')`, "New memory");
    await until(() => evalIn(c, `!!document.querySelector('.memory-new')`), 10_000, "the new memory form");
    await evalIn(c, `(() => { const set = (sel, v) => { const i = document.querySelector(sel); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); };
      set('.memory-new-name input', 'Payout schedule'); set('.memory-new-desc input', 'Creators are paid on the 1st and the 15th'); return true; })()`);
    await shot(c, `5-new-memory-${face}`);
    await pressText(c, ".memory-reader-actions .btn", "Cancel");

    // Delete names what it does.
    await pick("Prefers short answers");
    await pressAt(c, `document.querySelector('.memory-reader-actions [aria-label^="Delete"]')`, "Delete");
    await until(() => evalIn(c, `!!document.querySelector('.memory-confirm')`), 5_000, "the delete question");
    await shot(c, `6-delete-confirm-${face}`);
    await pressText(c, ".memory-confirm .btn", "Cancel");
  }

  // ── What the controls do, once, in the light face ──────────────────────────────────────────────
  // A [[link]] opens the memory it names.
  await pick("Spring creator campaign");
  await pressAt(c, `[...document.querySelectorAll('.memory-reader-body a')].find((a) => a.textContent === 'contacts')`, "the [[contacts]] link");
  await waitTitle(c, "Contacts");
  check("a [[link]] opens the memory it names", true);

  // Edit and Save: one commit, with the folder's index line kept.
  const before = commits();
  await pick("Uses pnpm");
  await pressText(c, ".memory-reader-actions .btn", "Edit");
  await until(() => evalIn(c, `!!document.querySelector('.memory-editor .cm-content')`), 10_000, "the editor");
  const file = path.join(repo.path, "spaces", "realm", "uses-pnpm.md");
  const edited = fs.readFileSync(file, "utf8").replace("never npm or yarn", "never npm, yarn or bun");
  console.log(`EVIDENCE editor set by ${await setEditor(c, edited)}`);
  await pressText(c, ".memory-reader-actions .btn", "Save");
  await until(() => commits() === before + 1, 10_000, "the save's commit");
  await until(() => evalIn(c, `!!document.querySelector('.memory-reader-actions .btn') && [...document.querySelectorAll('.memory-reader-actions .btn')].some((b) => b.textContent.trim() === 'Edit')`), 10_000, "the reader again");
  check("Save writes the file as one commit, tree clean", fs.readFileSync(file, "utf8") === edited && git(repo.path, "log", "-1", "--format=%s").trim() === "Update spaces/realm/uses-pnpm.md" && git(repo.path, "status", "--porcelain") === "",
    git(repo.path, "log", "-1", "--format=%s"));
  check("…and the folder's index line says the new description", fs.readFileSync(path.join(repo.path, "spaces", "realm", "MEMORY.md"), "utf8").includes("never npm, yarn or bun"));

  // A file outside Realm is written only after its question is answered.
  const claudeMd = path.join(user, ".claude", "CLAUDE.md");
  const original = fs.readFileSync(claudeMd, "utf8");
  await pick("House rules");
  await pressText(c, ".memory-reader-actions .btn", "Edit");
  await until(() => evalIn(c, `!!document.querySelector('.memory-editor .cm-content')`), 10_000, "the editor");
  await setEditor(c, `${original}- Squash when you merge.\n`);
  await pressText(c, ".memory-reader-actions .btn", "Save");
  await until(() => evalIn(c, `!!document.querySelector('.memory-confirm')`), 5_000, "the question about Claude's file");
  check("Save on Claude's own file asks first, and has written nothing", fs.readFileSync(claudeMd, "utf8") === original,
    await evalIn(c, `document.querySelector('.memory-confirm p').textContent`));
  await shot(c, "7-outside-realm-confirm-light");
  await pressText(c, ".memory-confirm .btn", "Write it");
  await until(() => fs.readFileSync(claudeMd, "utf8").includes("Squash when you merge."), 10_000, "Claude's file written");
  check("…and writes it once told", true);

  // New memory, saved: one commit in the chosen folder.
  const beforeNew = commits();
  await pressAt(c, `document.querySelector('.memory-lib-new')`, "New memory");
  await until(() => evalIn(c, `!!document.querySelector('.memory-new')`), 10_000, "the new memory form");
  await evalIn(c, `(() => { const set = (sel, v) => { const i = document.querySelector(sel); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, v); i.dispatchEvent(new Event('input', { bubbles: true })); };
    set('.memory-new-name input', 'Payout schedule'); set('.memory-new-desc input', 'Creators are paid on the 1st and the 15th'); return true; })()`);
  await pressText(c, ".memory-reader-actions .btn", "Save memory");
  await waitTitle(c, "Payout schedule");
  check("Save memory makes it in the page's space's folder, as one commit", commits() === beforeNew + 1 && fs.existsSync(path.join(repo.path, "spaces", "realm", "payout-schedule.md")),
    git(repo.path, "log", "-1", "--format=%s"));

  // Delete from the repo: one commit, the index line gone.
  const beforeDelete = commits();
  await pick("Prefers short answers");
  await pressAt(c, `document.querySelector('.memory-reader-actions [aria-label^="Delete"]')`, "Delete");
  await pressText(c, ".memory-confirm .btn", "Delete");
  await until(() => commits() === beforeDelete + 1, 10_000, "the delete's commit");
  check("Delete removes it with a commit, and its MEMORY.md line", !fs.existsSync(path.join(repo.path, "prefers-short-answers.md"))
    && !fs.readFileSync(path.join(repo.path, "MEMORY.md"), "utf8").includes("[[prefers-short-answers]]") && git(repo.path, "status", "--porcelain") === "");
  await until(() => evalIn(c, `![...document.querySelectorAll('.memory-row-title')].some((t) => t.textContent === 'Prefers short answers')`), 10_000, "the row gone");
  console.log(`EVIDENCE git log:\n${git(repo.path, "log", "--format=%h %s")}`);

  // The way in from Profile settings ▸ Memory.
  await setFace(c, "dark");
  await evalIn(c, `document.querySelector('.sb-profile')?.click(), true`).catch(() => null);
  const viaSettings = await until(() => evalIn(c, `(() => { const m = [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.trim() === 'Profile settings…'); if (!m) return false; m.click(); return true; })()`), 5_000, "Profile settings…").catch(() => false);
  if (viaSettings) {
    await until(() => evalIn(c, `(() => { const t = [...document.querySelectorAll('.page-rail .settings-tab')].find((e) => e.textContent.trim() === 'Memory'); if (!t) return false; t.click(); return true; })()`), 10_000, "the profile's Memory");
    // At the foot of a long page, whose scroller springs back under a synthetic press: clicked as the DOM's.
    await until(() => evalIn(c, `(() => { const b = ${byText(".btn", "Open in Library")}; if (!b) return false; b.scrollIntoView({ block: "center" }); return true; })()`), 10_000, "Open in Library");
    await sleep(400);
    await shot(c, "8-profile-settings-link-dark");
    await evalIn(c, `${byText(".btn", "Open in Library")}.click(), true`);
    await until(() => evalIn(c, `!!document.querySelector('.memory-lib') && document.querySelector('.memory-lib-title')?.textContent === 'Memory'`), 10_000, "the Library's Memory page");
    check("Profile settings ▸ Memory opens the memory library", true);
  } else {
    console.log("NOTE the profile menu was not reachable from the sidebar head; the link is covered by the component test");
  }
  c.close();
}

/** Kill whatever still listens on one of this run's ports, but only if it is this run's. */
function killPort(port) {
  const pids = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`, { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  for (const pid of pids) {
    const cmd = execSync(`ps -o command= -p ${pid} || true`, { encoding: "utf8" });
    if (cmd.includes(scratch) || cmd.includes(path.join(repoRoot, "node_modules/.pnpm/electron@")) || (process.env.LIVE_ELECTRON && cmd.includes(process.env.LIVE_ELECTRON))) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  }
}

async function teardown() {
  try { await api?.call("daemon.stop", {}); } catch { /* already gone */ }
  try { api?.close(); } catch { /* gone */ }
  electron?.kill("SIGTERM");
  await sleep(1200);
  electron?.kill("SIGKILL");
  await stopDaemons(home, daemonPids);
  for (const port of [SERVER_PORT, CDP_PORT]) killPort(port);
}

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { void teardown().finally(() => process.exit(130)); });

main()
  .catch((e) => { console.error("ERROR", e.stack ?? e.message); process.exitCode = 1; })
  .finally(async () => {
    await teardown();
    process.exit(process.exitCode ?? 0);
  });
