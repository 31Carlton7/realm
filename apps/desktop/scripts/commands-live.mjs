/**
 * Live check: the prompter's `/` list takes the command files Claude would.
 *
 *   pnpm build && node apps/desktop/scripts/commands-live.mjs
 *
 * Boots the built app quietly on a scratch home AND a scratch HOME (so `~/.claude/commands` is a
 * fixture, never the real one), with the scripted agent. It writes a nested `git/commit.md`, an
 * upper-case `Plain_Name.md`, a plain file with no frontmatter, a 150 KB command, a file whose name
 * has a space, and a repo command in the session folder's `.claude/commands`, then types `/` in a
 * scripted session's prompter and reads the list, in light and dark. Pictures go to LIVE_OUT.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { cdp, launchLiveApp, sleep, until } from "./lib/live-app.mjs";

const OUT = process.env.LIVE_OUT ?? path.join(os.tmpdir(), "realm-commands-live");
fs.mkdirSync(OUT, { recursive: true });
const log = (name, value) => fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(value, null, 2));
const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? " " + JSON.stringify(detail) : ""}`);
};
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(String(msg.id))?.(msg);
  });
  return {
    ready: new Promise((res) => ws.addEventListener("open", res)),
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    close: () => ws.close(),
  };
}

const userHome = fs.mkdtempSync(path.join(os.tmpdir(), "realm-commands-home-"));
const claudeDir = path.join(userHome, ".claude");
write(path.join(claudeDir, "commands", "git", "commit.md"), "---\ndescription: Commit the staged work with a message\nargument-hint: <message>\n---\nCommit what is staged as: $ARGUMENTS\n");
write(path.join(claudeDir, "commands", "Plain_Name.md"), "---\ndescription: An upper-case name with an underscore\n---\nSay hello to $0.\n");

const app = await launchLiveApp({ name: "commands", env: { HOME: userHome, CLAUDE_CONFIG_DIR: claudeDir } });
let page = app.page;
try {
  await until(() => page.eval(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await page.eval(`(() => {
    const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => page.eval(`!!document.querySelector('.composer')`), 30_000, "composer");
  const api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  const space = (await api.call("spaces.list", {}))[0];
  // The onboarding session is Claude's, which is signed out under a scratch HOME, and its sign-in card
  // takes the prompter's place once the probe lands. A scripted session keeps the prompter.
  const { session } = await api.call("sessions.create", { spaceId: space.id, agentKind: "fake", title: "Commands" });
  log("session", session);
  const card = `[...document.querySelectorAll('.sb-row .item-row')].find((b) => b.textContent.startsWith("Commands"))`;
  await until(() => page.eval(`!!${card}`), 20_000, "the session's row");
  await page.eval(`(() => { ${card}.click(); return true; })()`);

  const userCmds = path.join(app.home, "commands");
  write(path.join(userCmds, "standup-notes.md"), "\n# Write today's standup from the commits since yesterday\n\nKeep it to three lines.\n");
  write(path.join(userCmds, "big-context.md"), `---\ndescription: Paste the 150 KB design brief, then ask about $ARGUMENTS\n---\n${"The brief, line by line. ".repeat(6_200)}\nNow: $ARGUMENTS\n`);
  write(path.join(userCmds, "has space.md"), "A name nobody can type.\n");
  write(path.join(session.cwd, ".claude", "commands", "repo-review.md"), "---\ndescription: Review this repo's diff against its own conventions\n---\nReview the diff.\n");
  check("the 150 KB command is over the old 100 KB cap", fs.statSync(path.join(userCmds, "big-context.md")).size > 150_000, fs.statSync(path.join(userCmds, "big-context.md")).size);

  const listed = await api.call("commands.list", { spaceId: space.id, cwd: session.cwd });
  log("commands-list", listed);
  const row = (name) => listed.commands.find((c) => c.name === name);
  check("the nested file is /git:commit", row("git:commit")?.valid === true, row("git:commit"));
  check("an upper-case, underscored name runs", row("Plain_Name")?.valid === true);
  check("a plain file runs, described by its first line", row("standup-notes")?.valid === true && row("standup-notes").description.startsWith("Write today's standup"), row("standup-notes"));
  check("the 150 KB command runs", row("big-context")?.valid === true, row("big-context"));
  check("the repo's .claude/commands is read", row("repo-review")?.origin.kind === "project", row("repo-review")?.origin);
  check("a name with a space is listed with its reason", row("has space")?.valid === false && /space/.test(row("has space").reason), row("has space"));
  check("the list carries no template", listed.commands.every((c) => !("body" in c)));
  const big = await api.call("commands.expand", { spaceId: space.id, name: "big-context", args: "the auth flow", cwd: session.cwd });
  check("expanding the 150 KB command sends all of it", big.text.length > 150_000 && big.text.trimEnd().endsWith("Now: the auth flow"), big.text.length);
  const nested = await api.call("commands.expand", { spaceId: space.id, name: "GIT:COMMIT", args: "fix the parser", cwd: session.cwd });
  check("/GIT:COMMIT expands git/commit.md", nested.text.trim() === "Commit what is staged as: fix the parser", nested.text);

  /** The page after a reload. A theme change can re-make the window, so this is whichever page target
   *  has a fresh document with a prompter, not necessarily the one first attached to. */
  async function attachReloaded() {
    for (const t of (await app.targets()).filter((t) => t.type === "page" && t.url.startsWith("file://"))) {
      const p = t.webSocketDebuggerUrl === undefined ? null : await cdp(t.webSocketDebuggerUrl).catch(() => null);
      if (p && await p.eval(`!window.__beforeReload && !!document.querySelector('.composer-input')`).catch(() => false)) return p;
      p?.close();
    }
    return null;
  }
  const shot = async (file, clip) => {
    const { data } = await page.send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { scale: 1, ...clip } } : {}) });
    fs.writeFileSync(file, Buffer.from(data, "base64"));
  };
  const type = (value) => page.eval(`(() => {
    const el = document.querySelector('.composer-input');
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.setSelectionRange(${value.length}, ${value.length});
    el.dispatchEvent(new Event("select", { bubbles: true }));
    return true; })()`);
  const rows = () => page.eval(`[...document.querySelectorAll(".slash-row .mention-row-id")].map((n) => n.textContent)`);
  const pickerBox = () => page.eval(`(() => { const r = document.querySelector('#slash-list')?.getBoundingClientRect(); return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null; })()`);

  for (const theme of ["light", "dark"]) {
    await api.call("settings.set", { key: "ui.theme", value: theme });
    // A theme set over RPC lands on the next load, and a load is also what re-reads the commands.
    await page.eval(`window.__beforeReload = true`);
    await page.send("Page.reload", {}).catch(() => {});
    page = await until(attachReloaded, 30_000, `composer (${theme})`).catch(async (err) => {
      const seen = [];
      for (const t of await app.targets()) {
        const p = t.webSocketDebuggerUrl ? await cdp(t.webSocketDebuggerUrl).catch(() => null) : null;
        seen.push({ type: t.type, url: t.url, dom: await p?.eval(`({ before: !!window.__beforeReload, composer: !!document.querySelector('.composer-input'), text: document.body.innerText.slice(0, 400) })`).catch((e) => String(e)) });
        p?.close();
      }
      log(`${theme}-reload-failure`, seen);
      throw err;
    });
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
    await sleep(800);
    for (const [tag, draft] of [["all", "/"], ["nested", "/git:"], ["case", "/plain_"]]) {
      await type(draft);
      const shown = await until(async () => { const r = await rows(); return r.length ? r : null; }, 10_000, `the picker for ${draft}`);
      log(`${theme}-${tag}-rows`, shown);
      if (theme === "light") {
        if (tag === "all") {
          for (const name of ["/git:commit", "/Plain_Name", "/standup-notes", "/big-context", "/repo-review"]) check(`the picker offers ${name}`, shown.includes(name), shown);
          check("the picker leaves out the name with a space", !shown.includes("/has space"), shown);
        }
        if (tag === "nested") check("/git: narrows to /git:commit", shown.length === 1 && shown[0] === "/git:commit", shown);
        if (tag === "case") check("/plain_ finds /Plain_Name", shown.includes("/Plain_Name"), shown);
      }
      await sleep(300);
      await shot(path.join(OUT, `${theme}-${tag}.png`));
      const box = await pickerBox();
      if (box) await shot(path.join(OUT, `${theme}-${tag}-picker.png`), { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 24), width: box.width + 48, height: box.height + 110 });
      if (tag === "all" && box) {
        // The user's commands follow Realm's own, below the list's fold.
        await page.eval(`(() => {
          const list = document.querySelector('#slash-list');
          for (const el of [list, ...list.querySelectorAll('*')]) if (el.scrollHeight > el.clientHeight + 1) el.scrollTop = el.scrollHeight;
          document.querySelector('.slash-row:last-of-type')?.scrollIntoView({ block: "end" });
          return true; })()`);
        await sleep(300);
        await shot(path.join(OUT, `${theme}-all-end-picker.png`), { x: Math.max(0, box.x - 24), y: Math.max(0, box.y - 24), width: box.width + 48, height: box.height + 110 });
      }
    }
  }
  await type("");
  api.close();
} finally {
  await app.stop();
  fs.rmSync(userHome, { recursive: true, force: true });
}
