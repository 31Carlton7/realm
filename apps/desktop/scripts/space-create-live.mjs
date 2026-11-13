/**
 * Live check for `space_create` (run with: node apps/desktop/scripts/space-create-live.mjs;
 * `pnpm build` first). The BUILT app on a scratch home, quiet, with the scripted agent standing in for
 * Claude and Codex, and Phase 1's test phone paired through a local relay, so nothing reaches a real
 * engine or a real phone.
 *
 * The person asks the Lead for a space: it shows on the rail, with a line in the Lead's chat, and on
 * the phone's Home. Asked again for the same name, nothing new is made. Asked for one with
 * `switchTo`, the window moves there, onto a new session as the New space sheet leaves it. Each step is pictured, dark and light, to LIVE_OUT_DIR as
 * `<step>-<mode>.png`, and the phone's list is written beside them as `phone-home.json`.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { daemonToken, tokenProtocols } from "./lib/daemon-token.mjs";
import { freePort, launchLiveApp, repoRoot, sleep, until } from "./lib/live-app.mjs";

const OUT_DIR = process.env.LIVE_OUT_DIR ?? path.resolve(process.cwd(), ".verify/space-create");
const js = (v) => JSON.stringify(v);

const create = (input) => [
  { kind: "call", tool: "realm-workspace__space_create", input },
  { kind: "text", text: "Asked Realm for the space." },
];
const SCRIPT = [
  { on: "make me a space for taxes", emit: create({ name: "Taxes 2026", icon: "calendar" }) },
  { on: "make the taxes space again", emit: create({ name: "taxes 2026" }) },
  { on: "make an errands space and take me there", emit: create({ name: "Errands", icon: "store", switchTo: true }) },
];

function rpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, tokenProtocols(token));
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  const ready = new Promise((res) => ws.addEventListener("open", res));
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
    else if (msg.event) for (const l of [...listeners]) l(msg.event, msg.payload);
  });
  return {
    ready,
    call: (method, params) => new Promise((res, rej) => {
      const i = String(++id);
      pending.set(i, (msg) => (msg.ok ? res(msg.result) : rej(new Error(`${method}: ${msg.error?.message}`))));
      ws.send(JSON.stringify({ id: i, method, params }));
    }),
    next: (event, ms = 30_000) => new Promise((res, rej) => {
      const timer = setTimeout(() => { listeners.delete(l); rej(new Error(`timeout:${event}`)); }, ms);
      const l = (e, p) => { if (e === event) { clearTimeout(timer); listeners.delete(l); res(p); } };
      listeners.add(l);
    }),
    close: () => ws.close(),
  };
}

/** Phase 1's TestPhone and local relay, under tsx, driven over stdin. */
async function startPhone(scratch, relayPort) {
  const file = path.join(scratch, "phone-rig.mts");
  fs.writeFileSync(file, `import { createInterface } from "node:readline";
import { startLocalRelay } from ${js(path.join(repoRoot, "services/relay/src/node.ts"))};
import { TestPhone } from ${js(path.join(repoRoot, "apps/server/src/remote/test-phone.ts"))};
const relay = await startLocalRelay({ port: Number(process.env.RELAY_PORT) });
console.log("relay " + relay.url);
const phone = new TestPhone();
const handle = async (cmd: string, args: string[]) => {
  if (cmd === "pair") {
    const r = await phone.pair(args[0]!, { name: "Space iPhone", model: "iPhone18,1", timeoutMs: 60_000 });
    console.log(r.ok ? "paired ok" : "paired no " + r.reason);
  }
  if (cmd === "connect") console.log("connected " + (await phone.connect()).mac);
  if (cmd === "home") console.log("home " + JSON.stringify(await phone.call("home.get")));
};
for await (const line of createInterface({ input: process.stdin })) {
  const [cmd, ...args] = line.split("\\t");
  handle(cmd!, args).catch((e) => console.log("error " + cmd + " " + (e as Error).message));
}
`);
  const tsx = path.join(repoRoot, "apps/server/node_modules/.bin/tsx");
  const child = spawn(tsx, [file], { cwd: path.join(repoRoot, "apps/server"), env: { ...process.env, RELAY_PORT: String(relayPort) }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = [];
  const waiters = new Set();
  createInterface({ input: child.stdout }).on("line", (line) => { lines.push(line); for (const w of [...waiters]) w(); });
  child.stderr.on("data", (d) => process.stderr.write(`    [phone] ${d}`));
  const next = (pattern, ms, tag) => new Promise((resolve, reject) => {
    const scan = () => { const i = lines.findIndex((l) => pattern.test(l)); if (i < 0) return false; waiters.delete(scan); clearTimeout(timer); resolve(lines.splice(i, 1)[0]); return true; };
    const timer = setTimeout(() => { waiters.delete(scan); reject(new Error(`timeout:${tag}`)); }, ms);
    if (!scan()) waiters.add(scan);
  });
  const url = (await next(/^relay /, 30_000, "local relay")).slice("relay ".length);
  return { child, url, next, send: (...parts) => child.stdin.write(`${parts.join("\t")}\n`) };
}

const check = (name, cond, detail) => {
  if (!cond) process.exitCode = 1;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail !== undefined ? ` ${js(detail)}` : ""}`);
};

fs.mkdirSync(OUT_DIR, { recursive: true });
const app = await launchLiveApp({
  name: "space-create", inspect: true,
  env: { REALM_FAKE_STANDS_IN: "claude,codex", REALM_LIVE_SCRATCH: "1", REALM_HTML_MENUS: "1", REALM_FAKE_SCRIPT: writeScript() },
  args: ["--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling"],
});
function writeScript() {
  const file = path.join(OUT_DIR, "fake-script.json");
  fs.writeFileSync(file, js(SCRIPT));
  return file;
}
let api = null;
let phone = null;
try {
  const page = app.page;
  const ev = (expr) => page.eval(expr);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await app.main.eval(`(() => { const w = require("electron").BrowserWindow.getAllWindows()[0]; w.setContentSize(1280, 820); return true; })()`);

  await until(() => ev(`!!document.querySelector('.onboarding input:not([type=radio])')`), 30_000, "onboarding");
  await ev(`(() => { const input = document.querySelector('.onboarding input:not([type=radio])');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Realm"); input.dispatchEvent(new Event("input", { bubbles: true }));
    input.closest("form").requestSubmit(); return true; })()`);
  await until(() => ev(`!!document.querySelector('.composer')`), 30_000, "composer");
  api = rpc(app.ports.server, await daemonToken(app.home));
  await api.ready;
  const [first] = await until(async () => { const all = await api.call("sessions.listAll", {}); return all.length ? all : null; }, 15_000, "onboarding session");
  await api.call("sessions.setAgent", { id: first.id, agentKind: "fake" });
  const home = (await api.call("spaces.list", {})).find((s) => s.id === first.spaceId);
  const captain = await api.call("teammates.create", { spaceId: home.id, agentKind: "fake", name: "Captain", handle: "captain", lead: true,
    permissionMode: "bypassPermissions", icon: { shape: "circle", color: "graphite" }, brief: "You lead this team." });

  phone = await startPhone(app.scratch, await freePort());
  await api.call("settings.set", { key: "remote.relay", value: phone.url });
  const asked = api.next("remote.pairRequest");
  const { url } = await api.call("remote.pair.start", {});
  phone.send("pair", url);
  await api.call("remote.pair.answer", { requestId: (await asked).requestId, accept: true });
  check("the test phone pairs with the Mac's server", (await phone.next(/^paired /, 60_000, "paired")) === "paired ok");
  phone.send("connect");
  await phone.next(/^connected /, 30_000, "connected");

  const transcript = () => ev(`document.querySelector('.transcript')?.textContent ?? ''`);
  const railNames = () => ev(`[...document.querySelectorAll('.rail-spaces .rail-space')].map((b) => b.getAttribute('aria-label'))`);
  const shown = async () => (await api.call("settings.get", { key: "ui.activeSpaceId" })).value;
  const results = async () => (await api.call("sessions.events", { id: captain.homeSessionId, afterSeq: 0, limit: 500 }))
    .filter((s) => s.event.type === "tool_result").map((s) => s.event.payload);
  const answered = async (n) => {
    await until(async () => (await results()).length >= n, 20_000, `tool result ${n}`);
    await until(async () => (await api.call("teammates.get", { id: captain.id })).state === "idle", 10_000, "the Lead settled");
    return (await results())[n - 1];
  };
  async function shots(step) {
    for (const mode of ["dark", "light"]) {
      await ev(`(() => { document.documentElement.dataset.mode = ${js(mode)}; document.documentElement.removeAttribute("data-window-inactive"); return true; })()`);
      await sleep(400);
      await ev(`(() => { const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = "none"; return true; })()`);
      const shot = await page.send("Page.captureScreenshot", { format: "png" });
      await ev(`(() => { const b = document.getElementById("live-scratch-banner"); if (b) b.style.display = ""; return true; })()`);
      // The capture keeps the DOM's alpha and none of the window's material: lay it on the page colour.
      const data = await ev(`(async () => {
        const img = new Image(); img.src = "data:image/png;base64," + ${js(shot.data)}; await img.decode();
        const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height; const g = cv.getContext("2d");
        g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--page").trim(); g.fillRect(0, 0, cv.width, cv.height);
        g.drawImage(img, 0, 0); return cv.toDataURL("image/png").split(",")[1]; })()`);
      const file = path.join(OUT_DIR, `${step}-${mode}.png`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      console.log(`SHOT ${file}`);
    }
    await ev(`(() => { document.documentElement.dataset.mode = "dark"; return true; })()`);
  }

  await until(() => ev(`document.querySelectorAll('.sb-teammate').length === 1`), 15_000, "the Lead's row");
  await ev(`(() => { document.querySelector('.sb-teammate .item-row').click(); return true; })()`);
  await until(() => ev(`document.querySelector('.tm-head-name')?.textContent === "Captain"`), 10_000, "the Lead's page");
  const before = await railNames();
  await until(async () => (await shown()) === home.id, 10_000, "the window saying it shows the first space");

  // 1. The person asks for a space.
  const changed = api.next("spaces.changed");
  await api.call("teammates.message", { id: captain.id, text: "Please make me a space for taxes." });
  const made = await answered(1);
  check("space_create made the space", made.isError === false && /Made the space "Taxes 2026" — spaceId /.test(made.content), made.content);
  await changed;
  const taxes = (await api.call("spaces.list", {})).find((s) => s.name === "Taxes 2026");
  check("in the caller's profile, with the sheet's folder and the icon asked for", taxes && taxes.profileId === home.profileId && taxes.icon === "calendar"
    && path.dirname(path.dirname(taxes.folderPath)) === app.home && path.basename(taxes.folderPath) === "taxes-2026" && fs.existsSync(taxes.folderPath), taxes);
  await until(async () => (await railNames()).some((n) => n.includes("Taxes 2026")), 10_000, "Taxes 2026 on the rail");
  check("the rail gained exactly the new space", (await railNames()).length === before.length + 1, { before, after: await railNames() });
  await until(async () => /Made the space Taxes 2026/.test(await transcript()), 10_000, "the line in the Lead's chat");
  check("the line offers Open", await ev(`document.querySelector('[data-space-made] .msg-handoff-link')?.textContent === "Open"`));
  check("the window stayed where it was", (await shown()) === home.id);
  await sleep(500);
  await shots("1-made-taxes");

  phone.send("home");
  const phoneHome = JSON.parse((await phone.next(/^home /, 30_000, "home.get")).slice("home ".length));
  const phoneSpaces = phoneHome.spaces.map((s) => ({ id: s.id, name: s.name, icon: s.icon, profileId: s.profileId }));
  fs.writeFileSync(path.join(OUT_DIR, "phone-home.json"), js({ spaces: phoneSpaces }, null, 2));
  check("the phone's Home lists the new space", phoneSpaces.some((s) => s.id === taxes.id && s.name === "Taxes 2026"), phoneSpaces);

  // 2. Asked again, in any case: nothing new.
  await api.call("teammates.message", { id: captain.id, text: "Please make the taxes space again." });
  const twin = await answered(2);
  check("a twin name makes nothing and names the one there is", twin.content.includes(`There is already a space "Taxes 2026" in this profile (spaceId ${taxes.id}`), twin.content);
  check("still one Taxes 2026", (await api.call("spaces.list", {})).filter((s) => s.name.toLowerCase() === "taxes 2026").length === 1);

  // 3. switchTo: the window moves there.
  await api.call("teammates.message", { id: captain.id, text: "Please make an errands space and take me there." });
  const moved = await answered(3);
  const errands = (await api.call("spaces.list", {})).find((s) => s.name === "Errands");
  check("space_create with switchTo moved the window", moved.isError === false && moved.content.includes(`The window is in "Errands" now.`), moved.content);
  check("the window says it shows Errands", errands && (await shown()) === errands.id);
  await until(async () => (await railNames()).some((n) => n.includes("Errands")), 10_000, "Errands on the rail");
  const landed = await until(async () => (await api.call("sessions.listAll", {})).find((x) => x.spaceId === errands.id) ?? null, 10_000, "a session in Errands");
  await until(() => ev(`!!document.querySelector('.hero-greeting') && !!document.querySelector('.composer')`), 10_000, "the new session's greeting and prompter");
  check("it lands on a new session in Errands, as the New space sheet does, not on the space's Overview",
    landed && await ev(`!document.body.textContent.includes("Delete space")`), landed);
  check("the rail marks Errands as the current space", await ev(`[...document.querySelectorAll('.rail-spaces .rail-space')].find((b) => b.getAttribute('aria-label').includes("Errands"))?.getAttribute('aria-pressed') === "true"`));
  await sleep(500);
  await shots("2-switched-to-errands");
} finally {
  phone?.child.kill();
  try { await api?.call("daemon.stop", {}); } catch { /* going anyway */ }
  api?.close();
  await app.stop();
}
