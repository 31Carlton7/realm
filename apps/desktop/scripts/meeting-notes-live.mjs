/**
 * Live check: a meeting's notes, from Stop to the Documents pane.
 *
 *   pnpm build && node apps/desktop/scripts/meeting-notes-live.mjs
 *
 * Boots the built app quietly on a scratch Realm home and a scratch HOME, with the scripted agent as
 * the Quick chat model and a stand-in for the calendar helper. Nothing is recorded and no model is
 * called: `meetings.saveNotes` is handed a canned two-speaker transcript, as the assistant's panel
 * will hand it a real one on Stop.
 *
 * Every row has a control: the same reading taken before the call, which must come back empty.
 *
 *   file       one Markdown file under the space's meetings/ folder, its five sections in order
 *   transcript the transcript in the file is the lines that were fed, speaker by speaker
 *   documents  the Documents home lists the file under Meetings, and a click opens it
 *   search     a session's docs_search finds a phrase from the transcript
 *   failure    with the agent scripted to fail, the file is there with its notes, its transcript and
 *              one line where the summary would be
 *   picture    the file open in the Documents pane, dark and light, Plain and Glass
 *
 * LIVE_OUT names the folder the rows and pictures go to.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { desktopRoot, freePort, launchLiveApp, sleep, until } from "./lib/live-app.mjs";
import { noCalendar } from "./quick-chat-panel/no-calendar.mjs";

const OUT_DIR = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-meeting-notes-live");
const js = (v) => JSON.stringify(v);
const rows = [];
const row = (group, name, value, ok) => {
  if (!ok) process.exitCode = 1;
  rows.push({ group, name, value, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${group.padEnd(10)} ${name}  ${js(value)}`);
};

const STARTED = new Date(2026, 10, 20, 14, 5).getTime();
const LINES = [
  { source: "me", text: "Thanks for joining. Shall we move the launch?", start: 0, end: 4_200, at: STARTED },
  { source: "them", text: "Yes, the supplier needs until", start: 6_000, end: 8_100, at: STARTED + 6_000 },
  { source: "them", text: "the ninth of December.", start: 8_900, end: 10_400, at: STARTED + 8_900 },
  { source: "me", text: "Then the ninth it is. I will tell the team today.", start: 15_000, end: 19_000, at: STARTED + 15_000 },
  { source: "them", text: "Good, and send me the revised plan.", start: 22_000, end: 24_500, at: STARTED + 22_000 },
];
const NOTES = "- ask about the revised plan\n- pricing is unchanged";
const SUMMARY = [
  "## Summary", "The launch moves to the ninth of December because the supplier needs until then.", "",
  "## Decisions", "- Launch on the ninth of December.", "",
  "## Action items", "- Me: tell the team today.", "- Me: send the revised plan.",
].join("\n");
const PHRASE = "supplier needs until the ninth";
const FAILS = "The summary service is down for this one.";
const meeting = (over) => ({
  spaceId: null, title: "Launch sync", startedAt: STARTED, endedAt: STARTED + 32 * 60_000, lines: LINES, notes: NOTES,
  customInfo: "They are the supplier's account lead.", ...over,
});

/** The fed lines as the file should show them: a paragraph per run of one speaker, timed from its first line. */
const fed = [];
for (const line of LINES) {
  const who = line.source === "me" ? "Me" : "Them";
  const last = fed.at(-1);
  if (last?.who === who) last.words += ` ${line.text}`;
  else fed.push({ who, at: `${Math.floor(line.start / 60_000)}:${String(Math.floor(line.start / 1000) % 60).padStart(2, "0")}`, words: line.text });
}
const transcriptIn = (text) => (text.split("## Transcript\n")[1] ?? "").split("\n").filter(Boolean)
  .map((p) => /^\*\*(Me|Them)\*\* \(([\d:]+)\) (.*)$/.exec(p)).map((m) => (m ? { who: m[1], at: m[2], words: m[3] } : null));
const headings = (text) => text.match(/^## .*$/gm) ?? [];

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.event) events.push(msg);
  });
  return {
    events,
    ready: new Promise((res) => ws.addEventListener("open", res)),
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(js({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const scriptFile = path.join(OUT_DIR, "fake-script.json");
fs.writeFileSync(scriptFile, js([
  { on: FAILS, emit: [{ kind: "fail", message: "the scripted agent was told to fail" }] },
  { on: "You are writing the notes for a meeting that has just ended.", emit: [{ kind: "text", text: SUMMARY }] },
  { on: "Search the meetings", emit: [{ kind: "call", tool: "realm-docs__docs_search", input: { query: PHRASE } }] },
]));

// Over http, not file://, so the paint worklet that draws the squircles loads.
const httpPort = await freePort();
const web = spawn("python3", ["-m", "http.server", String(httpPort), "--bind", "127.0.0.1"], { cwd: path.join(desktopRoot, "out/renderer"), stdio: "ignore" });
const rendererUrl = `http://127.0.0.1:${httpPort}/index.html`;
await until(() => fetch(rendererUrl).then((r) => r.ok), 10_000, "the renderer over http");

const calendar = noCalendar();
const userHome = fs.mkdtempSync(path.join(os.tmpdir(), "realm-meeting-notes-home-"));
const app = await launchLiveApp({ name: "meeting-notes", rendererUrl, env: { ...calendar.env, HOME: userHome, REALM_FAKE_SCRIPT: scriptFile } });
const api = rpc(app.ports.server, await daemonToken(app.home));
const page = app.page;
const watchdog = setTimeout(() => { console.error("FAIL watchdog: the check ran for five minutes"); void stop().then(() => process.exit(9)); }, 300_000);
async function stop() {
  clearTimeout(watchdog);
  api.close();
  await app.stop().catch(() => {});
  calendar.remove();
  fs.rmSync(userHome, { recursive: true, force: true });
  web.kill();
}

/** A picture of the window laid over the theme's page colour: the capture keeps the panes' alpha. */
async function picture(file) {
  await sleep(600);
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  const flat = await page.eval(`(async () => {
    const img = new Image(); img.src = "data:image/png;base64,${data}"; await img.decode();
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const g = cv.getContext("2d");
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim() || "#000";
    g.fillRect(0, 0, cv.width, cv.height); g.drawImage(img, 0, 0);
    return cv.toDataURL("image/png").split(",")[1];
  })()`);
  fs.writeFileSync(file, Buffer.from(flat, "base64"));
}

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
  fs.writeFileSync(path.join(root, "agenda.md"), "# Agenda\n\n- the launch date\n");
  await sleep(1500);
  await page.send("Page.reload");
  await until(() => page.eval(`document.readyState === "complete" && document.body.innerText.includes("Notes check")`), 30_000, "the window on its space");

  const searcher = (await api.call("sessions.create", { spaceId: space.id, agentKind: "fake" })).session;
  const search = async () => {
    const before = (await api.call("sessions.events", { id: searcher.id, afterSeq: 0 })).filter((e) => e.event.type === "tool_result").length;
    await api.call("sessions.send", { id: searcher.id, text: "Search the meetings" });
    const results = await until(async () => {
      const found = (await api.call("sessions.events", { id: searcher.id, afterSeq: 0 })).filter((e) => e.event.type === "tool_result");
      return found.length > before ? found : null;
    }, 20_000, "the search's result");
    return String(results.at(-1).event.payload.content);
  };

  // The Documents pane, on its home, before any meeting.
  await api.call("documents.openPath", { spaceId: space.id, path: "agenda.md" });
  await until(() => page.eval(`!!document.querySelector(".documents-home-tab .documents-tab-label")`), 20_000, "the Documents pane");
  await page.eval(`document.querySelector(".documents-home-tab .documents-tab-label").click()`);
  await until(() => page.eval(`!!document.querySelector(".docs-home")`), 10_000, "the Documents home");
  await sleep(800);

  /* ── controls: every reading the rows take, before the call ──────────────────────────────── */
  const meetingsDir = path.join(root, "meetings");
  const filePath = path.join(meetingsDir, "2026-11-20 1405 Launch sync.md");
  row("control", "no meetings folder before the call", { exists: fs.existsSync(meetingsDir) }, !fs.existsSync(meetingsDir));
  const listedBefore = (await api.call("meetings.list", { spaceId: space.id })).notes;
  const shownBefore = await meetingsShown();
  row("control", "Documents lists no meeting", { rpc: listedBefore, home: shownBefore }, listedBefore.length === 0 && shownBefore.length === 0);
  const searchedBefore = await search();
  row("control", "the search finds nothing", { result: searchedBefore.slice(0, 120) }, !searchedBefore.includes("meetings/"));

  /* ── the call ────────────────────────────────────────────────────────────────────────────── */
  const saved = await api.call("meetings.saveNotes", meeting({ meetingId: "live-1", spaceId: space.id }));
  const stages = api.events.filter((e) => e.event === "meetings.notesProgress" && e.payload.meetingId === "live-1").map((e) => e.payload.stage);
  row("file", "the call answers with the file's path, and says where it got to", { saved, stages },
    saved.path === "meetings/2026-11-20 1405 Launch sync.md" && saved.summary === "written" && js(stages) === js(["summarising", "saved"]));
  const text = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  fs.writeFileSync(path.join(OUT_DIR, "launch-sync.md"), text);
  row("file", "the file has its five sections in order", { headings: headings(text), first: text.split("\n").slice(0, 3) },
    js(headings(text)) === js(["## Summary", "## Decisions", "## Action items", "## Notes", "## Transcript"])
    && text.startsWith("# Launch sync\n\n2026-11-20 14:05 · 32 min\n"));
  row("file", "the summary, the decision, the action items and the notes are in it", { file: "launch-sync.md" },
    text.includes("## Summary\n\nThe launch moves to the ninth of December because the supplier needs until then.\n")
    && text.includes("## Decisions\n\n- Launch on the ninth of December.\n")
    && text.includes("## Action items\n\n- Me: tell the team today.\n- Me: send the revised plan.\n")
    && text.includes(`## Notes\n\n${NOTES}\n`));
  row("transcript", "the transcript in the file is the lines fed", { inFile: transcriptIn(text), fed }, js(transcriptIn(text)) === js(fed));
  row("transcript", "what was typed for the assistant is not in the file", { customInfo: text.includes("account lead") }, !text.includes("account lead"));

  /* ── Documents ───────────────────────────────────────────────────────────────────────────── */
  const listed = (await api.call("meetings.list", { spaceId: space.id })).notes.map((n) => n.path);
  const shown = await until(async () => { const names = await meetingsShown(); return names.length > 0 ? names : null; }, 10_000, "the Meetings section");
  row("documents", "Documents lists the meeting", { rpc: listed, home: shown },
    js(listed) === js([saved.path]) && js(shown) === js(["2026-11-20 1405 Launch sync.md"]));
  await page.eval(`[...document.querySelectorAll(".docs-home-open")].find((b) => b.querySelector(".docs-home-name")?.textContent === "2026-11-20 1405 Launch sync.md").click()`);
  await until(() => page.eval(`!!document.querySelector(".documents-rich-surface h1")`), 20_000, "the meeting open in the pane");
  const opened = await page.eval(`(() => { const s = document.querySelector(".documents-rich-surface");
    return { title: s.querySelector("h1").textContent, sections: [...s.querySelectorAll("h2")].map((h) => h.textContent), words: s.innerText.includes(${js(PHRASE)}) }; })()`);
  row("documents", "a click opens it in the pane", opened,
    opened.title === "Launch sync" && js(opened.sections) === js(["Summary", "Decisions", "Action items", "Notes", "Transcript"]) && opened.words);

  /* ── search ──────────────────────────────────────────────────────────────────────────────── */
  const searched = await search();
  row("search", "a session's docs_search finds a phrase from the transcript", { result: searched.slice(0, 300) },
    searched.includes(saved.path) && searched.includes("supplier"));

  /* ── failure ─────────────────────────────────────────────────────────────────────────────── */
  const failedPath = path.join(meetingsDir, "2026-11-20 1405 Launch sync (2).md");
  row("control", "no second file before the failing call", { exists: fs.existsSync(failedPath) }, !fs.existsSync(failedPath));
  const failed = await api.call("meetings.saveNotes", meeting({ meetingId: "live-2", spaceId: space.id, customInfo: FAILS }));
  const failedText = fs.existsSync(failedPath) ? fs.readFileSync(failedPath, "utf8") : "";
  fs.writeFileSync(path.join(OUT_DIR, "launch-sync-failed.md"), failedText);
  row("failure", "the file is still written, beside the first", { failed, headings: headings(failedText) },
    failed.path === "meetings/2026-11-20 1405 Launch sync (2).md" && failed.summary === "failed"
    && js(headings(failedText)) === js(["## Summary", "## Notes", "## Transcript"]) && fs.readFileSync(filePath, "utf8") === text);
  row("failure", "one line where the summary would be, with the notes and transcript whole",
    { line: failedText.split("## Summary\n\n")[1]?.split("\n")[0] },
    failedText.includes("## Summary\n\nThe summary could not be written: the scripted agent was told to fail.\n\n## Notes\n")
    && failedText.includes(`## Notes\n\n${NOTES}\n`) && js(transcriptIn(failedText)) === js(fed));

  /* ── words only ──────────────────────────────────────────────────────────────────────────── */
  const holding = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name))
    .filter((f) => fs.statSync(f).size < 200_000_000 && fs.readFileSync(f).toString("latin1").includes("the ninth of December"));
  const elsewhere = [...holding(app.scratch), ...holding(userHome)].filter((f) => !f.startsWith(meetingsDir))
    .map((f) => f.replace(app.scratch, "<scratch>").replace(userHome, "<home>"));
  row("words", "the transcript is in the two files and nowhere else under the scratch homes", { elsewhere, inMeetings: holding(meetingsDir).length },
    elsewhere.length === 0 && holding(meetingsDir).length === 2);

  /* ── pictures ────────────────────────────────────────────────────────────────────────────── */
  // The store reads the theme and the look at boot, so a change over RPC lands with a reload.
  const show = async (mode, look) => {
    await api.call("settings.set", { key: "ui.theme", value: mode });
    await api.call("settings.set", { key: "ui.look", value: look });
    await page.send("Page.reload");
    await until(() => page.eval(`document.readyState === "complete" && document.documentElement.dataset.mode === ${js(mode)}`), 30_000, `the window in ${mode}`);
    await api.call("documents.openPath", { spaceId: space.id, path: saved.path });
    await until(() => page.eval(`document.querySelector(".documents-rich-surface h1")?.textContent === "Launch sync"`), 20_000, "the meeting open in the pane");
  };
  for (const mode of ["dark", "light"]) for (const look of ["plain", "glass"]) {
    await show(mode, look);
    const drawn = await page.eval(`document.documentElement.hasAttribute("data-glass") ? "glass" : "plain"`);
    await picture(path.join(OUT_DIR, `meeting-open-${mode}-${look}.png`));
    row("picture", `${mode} ${look}`, { file: `meeting-open-${mode}-${look}.png`, drawn }, drawn === look);
  }
  await show("dark", "plain");
  await page.eval(`document.querySelector(".documents-home-tab .documents-tab-label").click()`);
  await until(async () => (await meetingsShown()).length === 2, 10_000, "both meetings on the home");
  await picture(path.join(OUT_DIR, "documents-home-meetings.png"));
  row("picture", "the Documents home", { file: "documents-home-meetings.png", meetings: await meetingsShown() }, true);
} catch (err) {
  process.exitCode = 1;
  console.error(`FAIL ${err.stack ?? err}`);
  console.error(`page at the failure: ${await page.eval(`document.body.innerText.slice(0, 600)`).catch(() => "?")}`);
  await picture(path.join(OUT_DIR, "at-failure.png")).catch(() => {});
} finally {
  fs.writeFileSync(path.join(OUT_DIR, "rows.json"), js(rows));
  await stop();
}
console.log(`${rows.filter((r) => r.ok).length}/${rows.length} rows passed; evidence in ${OUT_DIR}`);
