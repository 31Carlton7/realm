/**
 * Live check: a meeting's notes, from the Documents pane of a session in a worktree.
 *
 *   pnpm build && node apps/desktop/scripts/meeting-notes-worktree-live.mjs
 *
 * Boots the built app quietly on a scratch Realm home and a scratch HOME, with the scripted agent as
 * the Quick chat model and a stand-in for the calendar helper. A meeting is saved into the space's
 * folder; a session is started in a second checkout of the space (a worktree), and the Documents
 * home in its side pane, which is rooted at the worktree, is asked for the meeting.
 *
 *   lists   the home lists the meeting under Meetings
 *   draws   a click draws the file, which is in the space's folder and outside the pane's root
 *
 * LIVE_CONTROL=1 is the same click on a build from before the fix, where the row must fail: the
 * click draws nothing. LIVE_OUT names the folder the rows and the picture go to.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { desktopRoot, freePort, launchLiveApp, sleep, until } from "./lib/live-app.mjs";
import { noCalendar } from "./quick-chat-panel/no-calendar.mjs";

const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-meeting-notes-worktree-live");
const CONTROL = process.env.LIVE_CONTROL === "1";
const LABEL = CONTROL ? "control" : "after";
const js = (v) => JSON.stringify(v);
const rows = [];
const row = (name, value, ok) => {
  if (!ok) process.exitCode = 1;
  rows.push({ build: LABEL, name, value, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${LABEL.padEnd(8)} ${name}  ${js(value)}`);
};

const STARTED = new Date(2026, 10, 20, 14, 5).getTime();
const NAME = "2026-11-20 1405 Launch sync.md";
const SUMMARY = ["## Summary", "The launch moves to the ninth of December.", "", "## Decisions", "- Launch on the ninth of December.", "", "## Action items", "- Me: tell the team today."].join("\n");
const MEETING = {
  meetingId: "live-wt", title: "Launch sync", startedAt: STARTED, endedAt: STARTED + 32 * 60_000, notes: "- pricing is unchanged", customInfo: "",
  lines: [
    { source: "me", text: "Shall we move the launch?", start: 0, end: 4_200, at: STARTED },
    { source: "them", text: "Yes, to the ninth of December.", start: 6_000, end: 8_100, at: STARTED + 6_000 },
  ],
};

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => { const msg = JSON.parse(m.data); if (msg.id !== undefined) pending.get(msg.id)?.(msg); });
  return {
    ready: new Promise((res) => ws.addEventListener("open", res)),
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(js({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

/** The React tree's store, found through the root's fiber: a harness's reach, used to put the
 *  Documents item in the session's side pane the way its bar's button does. */
const FIND_STORE = `(() => {
  if (window.__liveStore) return true;
  const root = document.getElementById("root");
  const key = root && Object.keys(root).find((k) => k.startsWith("__reactContainer$"));
  if (!key) return false;
  const stack = [root[key]];
  for (let n = 0; stack.length && n < 400000; n++) {
    const f = stack.pop();
    const v = f && f.memoizedProps && f.memoizedProps.value;
    if (v && typeof v.getState === "function" && typeof v.setState === "function" && v.getState() && typeof v.getState().openInSidePane === "function") { window.__liveStore = v; return true; }
    if (f && f.sibling) stack.push(f.sibling);
    if (f && f.child) stack.push(f.child);
  }
  return false; })()`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const scriptFile = path.join(OUT_DIR, `worktree-fake-script.json`);
fs.writeFileSync(scriptFile, js([{ on: "You are writing the notes for a meeting that has just ended.", emit: [{ kind: "text", text: SUMMARY }] }]));

// Over http, not file://, so the paint worklet that draws the squircles loads.
const httpPort = await freePort();
const web = spawn("python3", ["-m", "http.server", String(httpPort), "--bind", "127.0.0.1"], { cwd: path.join(desktopRoot, "out/renderer"), stdio: "ignore" });
const rendererUrl = `http://127.0.0.1:${httpPort}/index.html`;
await until(() => fetch(rendererUrl).then((r) => r.ok), 10_000, "the renderer over http");

const calendar = noCalendar();
const userHome = fs.mkdtempSync(path.join(os.tmpdir(), "realm-meeting-notes-wt-home-"));
const app = await launchLiveApp({ name: "meeting-notes-wt", rendererUrl, env: { ...calendar.env, HOME: userHome, REALM_FAKE_SCRIPT: scriptFile } });
const api = rpc(app.ports.server, await daemonToken(app.home));
const page = app.page;
const watchdog = setTimeout(() => { console.error("FAIL watchdog: the check ran for four minutes"); void stop().then(() => process.exit(9)); }, 240_000);
async function stop() {
  clearTimeout(watchdog);
  api.close();
  await app.stop().catch(() => {});
  calendar.remove();
  fs.rmSync(userHome, { recursive: true, force: true });
  web.kill();
}
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Live check", "-c", "user.email=live@example.invalid", ...args], { cwd, stdio: "pipe" });

const meetingsShown = () => page.eval(`(() => {
  const section = [...document.querySelectorAll(".docs-home-section")].find((s) => s.getAttribute("aria-label") === "Meetings");
  return section ? [...section.querySelectorAll(".docs-home-name, .docs-card-name")].map((n) => n.textContent) : [];
})()`);

try {
  await api.ready;
  const profile = (await api.call("profiles.list", {}))[0];
  const space = await api.call("spaces.create", { profileId: profile.id, name: "Notes check" });
  await api.call("settings.set", { key: "ui.activeSpaceId", value: space.id });
  await api.call("settings.set", { key: "quickChatModel", value: { agentKind: "fake", model: null } });
  await api.call("settings.set", { key: "sessions.defaultPermissionMode", value: "bypassPermissions" });
  await api.call("settings.set", { key: "ui.theme", value: "dark" });
  const { root } = await api.call("documents.spaceRoot", { spaceId: space.id });
  if (!root.startsWith(app.scratch) && !root.startsWith(userHome)) throw new Error("the space's folder is not under the scratch homes");
  fs.writeFileSync(path.join(root, "agenda.md"), "# Agenda\n\n- the launch date\n");
  git(root, "init", "-q");
  git(root, "add", "agenda.md");
  git(root, "commit", "-q", "-m", "agenda");

  const saved = await api.call("meetings.saveNotes", { ...MEETING, spaceId: space.id });
  const file = path.join(root, saved.path);
  const worktree = await api.call("environments.createWorktree", { spaceId: space.id, title: "Second checkout" });
  if (!worktree.path.startsWith(app.scratch) && !worktree.path.startsWith(userHome)) throw new Error("the worktree is not under the scratch homes");
  const { session, itemId: sessionItem } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", environmentId: worktree.id, title: "Worktree session" });
  const docs = await api.call("documents.create", { spaceId: space.id, environmentId: worktree.id });
  row("the meeting is in the space's folder and not in the worktree the pane is rooted at",
    { savedPath: saved.path, inSpaceFolder: fs.existsSync(file), inWorktree: fs.existsSync(path.join(worktree.path, saved.path)), paneRootIsSpaceFolder: worktree.path === root, sessionCwdIsWorktree: session.cwd === worktree.path },
    fs.existsSync(file) && !fs.existsSync(path.join(worktree.path, saved.path)) && worktree.path !== root);

  await sleep(1500);
  await page.send("Page.reload");
  await until(() => page.eval(`document.readyState === "complete" && document.body.innerText.includes("Notes check")`), 30_000, "the window on its space");
  await until(() => page.eval(FIND_STORE), 20_000, "the renderer's store");
  await page.eval(`(async () => { const s = window.__liveStore.getState(); await s.refreshItems?.(); await s.openItem(${js(sessionItem)}); await window.__liveStore.getState().openInSidePane(${js(session.id)}, ${js(docs.itemId)}); return true; })()`);
  await until(() => page.eval(`!!document.querySelector(".docs-home")`), 20_000, "the Documents home in the session's side pane");

  const shown = await until(async () => { const names = await meetingsShown(); return names.length > 0 ? names : null; }, 10_000, "the Meetings section");
  row("the worktree session's Documents home lists the meeting", { home: shown }, js(shown) === js([NAME]));

  await page.eval(`[...document.querySelectorAll(".docs-home-open")].find((b) => b.querySelector(".docs-home-name, .docs-card-name")?.textContent === ${js(NAME)}).click()`);
  const drawn = await until(() => page.eval(`document.querySelector(".documents-rich-surface h1")?.textContent === "Launch sync"`), 8_000, "the meeting drawn").then(() => true, () => false);
  const pane = await page.eval(`(() => { const s = document.querySelector(".documents-rich-surface"); const p = document.querySelector(".documents-pane");
    return { title: s?.querySelector("h1")?.textContent ?? null, sections: s ? [...s.querySelectorAll("h2")].map((h) => h.textContent) : [],
      saysOutsideReadOnly: !!p && p.innerText.includes("Outside this space"), editable: s?.querySelector("[contenteditable]")?.getAttribute("contenteditable") ?? s?.getAttribute("contenteditable") ?? null }; })()`);
  // The Documents pane only: the session beside it greets the Mac's owner by name.
  const box = await page.eval(`(() => { const r = document.querySelector(".documents-pane").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const { data } = await page.send("Page.captureScreenshot", { format: "png", clip: { ...box, scale: 1 } });
  fs.writeFileSync(path.join(OUT_DIR, `worktree-click-${LABEL}.png`), Buffer.from(data, "base64"));
  if (CONTROL) row("CONTROL (before the fix): the click draws nothing", { drawn, ...pane }, !drawn);
  else row("a click draws it, from the space's folder", { drawn, ...pane }, drawn && js(pane.sections) === js(["Summary", "Decisions", "Action items", "Notes", "Transcript"]));
} catch (err) {
  process.exitCode = 1;
  console.error(`FAIL ${err.stack ?? err}`);
  console.error(`page at the failure: ${await page.eval(`document.body.innerText.slice(0, 400)`).catch(() => "?")}`);
} finally {
  fs.writeFileSync(path.join(OUT_DIR, `worktree-rows-${LABEL}.json`), JSON.stringify(rows, null, 1));
  await stop();
}
console.log(`${rows.filter((r) => r.ok).length}/${rows.length} rows passed; evidence in ${OUT_DIR}`);
