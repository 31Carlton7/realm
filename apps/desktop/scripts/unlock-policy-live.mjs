/**
 * Live check for sign-in unlock policies (run with: node apps/desktop/scripts/unlock-policy-live.mjs)
 *
 * Runs the REAL secret store, the REAL fill executor (BrowserAgentHost's `fillCredential` op, typing
 * over CDP into a real page in a real Electron window) and the REAL `deviceowner` helper, and proves:
 *
 *   1. Under the default, a fill asks for Touch ID; cancelled, nothing is typed.
 *   2. Turned to "Without asking" (the user's confirmation stood in for), a fill types the password
 *      with no prompt of any kind, and the audit says it was unattended.
 *   3. Turned back to Touch ID — without being asked anything — the next fill asks again.
 *   4. A weakening raises the REAL macOS device-owner prompt (seen on screen as LocalAuthentication's
 *      window), and cancelling it changes nothing.
 *   5. The same files read with another Mac's hardware id do not unlock.
 *
 * Two things are stood in for, because a script cannot be a person: pressing Touch ID (a spy records
 * that it was asked for, then answers "cancelled") and typing the login password (a stand-in helper
 * answers "confirmed" for step 2). Everything between the policy and the page is real.
 *
 * Never the user's Keychain: Electron runs with `--use-mock-keychain`, so safeStorage's key is
 * Chromium's mock and no Keychain item is read or written — checked before and after. Scratch
 * REALM_HOME and userData, one port on 127.0.0.1, and everything is removed at the end.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const desktop = path.join(repoRoot, "apps/desktop");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "realm-unlock-policy-live-"));
const realHelper = path.join(desktop, "native/bin/deviceowner");
if (!fs.existsSync(realHelper)) throw new Error("native/bin/deviceowner is missing — run `node apps/desktop/scripts/build-native.mjs`");

function esbuild() {
  const pnpm = path.join(repoRoot, "node_modules/.pnpm");
  for (const d of fs.readdirSync(pnpm)) {
    if (!d.startsWith("esbuild@")) continue;
    const p = path.join(pnpm, d, "node_modules/esbuild/lib/main.js");
    if (fs.existsSync(p)) return p;
  }
  throw new Error("esbuild not found");
}
const { buildSync } = (await import(esbuild())).default;
for (const [rel, name] of [
  ["apps/desktop/src/main/secret-store.ts", "secret-store.cjs"],
  ["apps/desktop/src/main/browser-agent-host.ts", "browser-agent-host.cjs"],
  ["apps/desktop/src/main/device-owner.ts", "device-owner.cjs"],
]) {
  buildSync({ entryPoints: [path.join(repoRoot, rel)], bundle: true, platform: "node", format: "cjs", external: ["electron"], outfile: path.join(scratch, name), logLevel: "error" });
}

/* The device-owner helper `device-owner.ts` will find at <app>/native/bin/deviceowner. In `real`
   mode it IS the real helper; in `yes` mode it is the user typing their password. Every call is
   logged, so the check can say which prompt was raised and why. */
const control = path.join(scratch, "owner-mode");
const ownerLog = path.join(scratch, "owner-asks.log");
fs.mkdirSync(path.join(scratch, "native/bin"), { recursive: true });
fs.writeFileSync(path.join(scratch, "native/bin/deviceowner"), `#!/bin/bash
mode=$(cat ${JSON.stringify(control)} 2>/dev/null)
[ "$1" = "can" ] && { exec ${JSON.stringify(realHelper)} can; }
echo "$mode|$2" >> ${JSON.stringify(ownerLog)}
[ "$mode" = "yes" ] && exit 0
exec ${JSON.stringify(realHelper)} "$@"
`, { mode: 0o755 });

/* LocalAuthentication's window, seen from outside: the one honest way to say a real prompt was up. */
const listwin = path.join(scratch, "listwin");
fs.writeFileSync(`${listwin}.swift`, `import CoreGraphics
let ws = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
print(ws.filter { ($0[kCGWindowOwnerName as String] as? String ?? "") == "coreautha" }.count)
`);
execFileSync("swiftc", ["-O", "-o", listwin, `${listwin}.swift`], { stdio: "ignore" });

/* The Keychain, before: Electron's and Realm's safe-storage items, by modification date only. */
const keychainItem = (service) => {
  try { return execFileSync("security", ["find-generic-password", "-s", service], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).match(/"mdat"<timedate>=0x[0-9A-F]+\s+"([^"]+)"/)?.[1] ?? "present"; }
  catch { return null; }
};
const SERVICES = ["Electron Safe Storage", "Realm Safe Storage", "Realm Vault Live Safe Storage"];
const keychainBefore = Object.fromEntries(SERVICES.map((s) => [s, keychainItem(s)]));

const home = path.join(scratch, "home");
fs.mkdirSync(home);
fs.writeFileSync(path.join(scratch, "package.json"), JSON.stringify({ name: "realm-unlock-policy-live", main: "main.cjs" }));
fs.writeFileSync(path.join(scratch, "main.cjs"), MAIN_SOURCE());

const electronBin = path.join(repoRoot, "node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const child = spawn(electronBin, [scratch, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"], {
  env: { ...process.env, LIVE_SCRATCH: scratch, LIVE_HOME: home, LIVE_CONTROL: control, LIVE_OWNER_LOG: ownerLog, LIVE_LISTWIN: listwin, LIVE_REAL_HELPER: realHelper },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => { out += d; });
child.stderr.on("data", (d) => { if (process.env.LIVE_VERBOSE) process.stderr.write(d); });
const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
await new Promise((r) => child.on("exit", r));
clearTimeout(timer);

const line = out.split("\n").find((l) => l.startsWith("LIVE "));
const result = line ? JSON.parse(line.slice(5)) : { error: "no result", out: out.slice(-2000) };
const keychainAfter = Object.fromEntries(SERVICES.map((s) => [s, keychainItem(s)]));
result.checks = result.checks ?? [];
result.checks.push({ name: "no Keychain item was created or changed (mock keychain)", pass: JSON.stringify(keychainBefore) === JSON.stringify(keychainAfter), detail: { keychainBefore, keychainAfter } });
for (const c of result.checks) console.log(`${c.pass ? "PASS" : "FAIL"} ${c.name}${c.detail !== undefined ? " " + JSON.stringify(c.detail) : ""}`);
if (result.error) console.log(`FAIL ${result.error}`);
const auditFile = path.join(home, "logs/credential-audit.log");
if (fs.existsSync(auditFile)) {
  const keep = path.join(os.tmpdir(), "realm-unlock-policy-live-audit.log");
  fs.copyFileSync(auditFile, keep);
  console.log(`AUDIT ${keep}`);
}
process.exitCode = result.error || result.checks.some((c) => !c.pass) ? 1 : 0;
try { execFileSync("pkill", ["-f", path.join(scratch, "native/bin/deviceowner")]); } catch { /* none left */ }
fs.rmSync(scratch, { recursive: true, force: true });

function MAIN_SOURCE() {
  return String.raw`
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");
const { execFileSync, execFile } = require("node:child_process");
const { app, BrowserWindow, safeStorage, systemPreferences } = require("electron");
app.commandLine.appendSwitch("use-mock-keychain");
app.setPath("userData", path.join(process.env.LIVE_SCRATCH, "userData"));
const { SecretStore } = require(path.join(process.env.LIVE_SCRATCH, "secret-store.cjs"));
const { BrowserAgentHost } = require(path.join(process.env.LIVE_SCRATCH, "browser-agent-host.cjs"));
const owner = require(path.join(process.env.LIVE_SCRATCH, "device-owner.cjs"));

const SECRET = "live-check: correct horse battery staple";
const LAB = "pLab";
const PAGE = '<!doctype html><meta charset=utf8><title>Sign in</title><form><label>Username <input id=u name=username autocomplete=username></label><label>Password <input id=pw type=password name=password autocomplete=current-password></label></form>';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
const setMode = (m) => fs.writeFileSync(process.env.LIVE_CONTROL, m);
const ownerAsks = () => (fs.existsSync(process.env.LIVE_OWNER_LOG) ? fs.readFileSync(process.env.LIVE_OWNER_LOG, "utf8").trim().split("\n").filter(Boolean) : []);
const authWindows = () => Number(execFileSync(process.env.LIVE_LISTWIN, { encoding: "utf8" }).trim());

app.whenReady().then(async () => {
  const server = http.createServer((_q, s) => { s.writeHead(200, { "content-type": "text/html" }); s.end(PAGE); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + server.address().port;
  try {
    const touchAsks = [];
    const audit = path.join(process.env.LIVE_HOME, "logs", "credential-audit.log");
    const file = path.join(process.env.LIVE_HOME, "secrets.json");
    const deps = (machineId) => ({
      safeStorage,
      readFile: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null),
      writeFile: (t) => fs.writeFileSync(file, t, { mode: 0o600 }),
      appendAudit: (l) => { fs.mkdirSync(path.dirname(audit), { recursive: true }); fs.appendFileSync(audit, l); },
      // Touch ID: the person's finger is the one thing a script cannot supply. The spy records that the
      // prompt was asked for, with its reason, and answers as a press of Cancel does.
      promptPresence: async (reason) => { touchAsks.push(reason); return false; },
      promptDeviceOwner: owner.promptDeviceOwner,
      canPromptDeviceOwner: owner.canPromptDeviceOwner,
      canPromptTouchID: () => systemPreferences.canPromptTouchID(),
      machineId,
      now: () => Date.now(),
      newId: () => "cred-" + Math.random().toString(36).slice(2, 10),
      defaultProfileId: () => LAB,
    });
    const store = new SecretStore(deps(owner.machineId));
    check("safeStorage encrypts (mock keychain)", safeStorage.isEncryptionAvailable(), null);
    check("this Mac's hardware id is readable", /^[0-9A-F-]{36}$/.test(owner.machineId() || ""), owner.machineId());
    check("the device-owner check can run here", owner.canPromptDeviceOwner(), null);
    check("info: Touch ID sensor present", true, systemPreferences.canPromptTouchID());

    const win = new BrowserWindow({ width: 640, height: 360, x: 40, y: 40, show: true });
    await win.loadURL(origin + "/");
    const host = new BrowserAgentHost({
      attach: () => {
        const wc = win.webContents;
        if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        return { send: (m, p) => wc.debugger.sendCommand(m, p), onEvent: (cb) => wc.debugger.on("message", (_e, m, p) => cb(m, p)) };
      },
      hasView: () => true, touch: () => {}, navigate: () => null,
      pageState: () => ({ url: win.webContents.getURL(), title: win.webContents.getTitle(), loading: false, error: null }),
      secrets: {
        listCredentials: (p) => store.listCredentials(p),
        getCredential: (p, id) => store.getCredential(p, id),
        withCredentialValue: (p, id, use) => store.withCredentialValue(p, id, use),
        withGeneratedCredentialValue: (p, i, use) => store.withGeneratedCredentialValue(p, i, use),
        audit: (e) => store.audit(e),
      },
      profileOf: () => LAB,
    });
    const cred = store.addCredential(LAB, { origin, username: "lab", label: "Live", value: SECRET });
    const fieldValue = () => win.webContents.executeJavaScript("document.getElementById('pw').value");
    const clearField = () => win.webContents.executeJavaScript("document.getElementById('pw').value = ''; true");
    const passwordRef = async () => {
      const snap = await host.handleOp("snapshot", { browserId: "b1" });
      const el = (snap.elements ?? []).find((e) => e.password);
      if (!el) throw new Error("no password field in the snapshot: " + snap.text);
      return el.ref;
    };
    const fill = async () => host.handleOp("fillCredential", { browserId: "b1", ref: await passwordRef(), profileId: LAB, credentialId: cred.id });

    /* 1. The default asks for Touch ID; cancelled, nothing is typed. */
    let r = await fill();
    check("default: the fill asked for Touch ID", touchAsks.length === 1 && /fill your saved sign-in for lab on/.test(touchAsks[0]), touchAsks.slice());
    check("default: cancelled Touch ID refuses the fill and types nothing", r.ok === false && r.refused === "no_presence" && (await fieldValue()) === "", r);

    /* 2. Without asking, confirmed by the user: no prompt of any kind, and the password is typed. */
    setMode("yes");
    const set = await store.setUnlockPolicy({ kind: "profile", id: LAB }, { kind: "unattended" });
    check("turning on Without asking was confirmed through the device-owner check first", set.ok === true && ownerAsks().some((l) => /without asking/.test(l)), { set, asks: ownerAsks() });
    const sealedOnDisk = JSON.parse(fs.readFileSync(file, "utf8")).unlock;
    check("the policy on disk is sealed, not readable text", Object.keys(sealedOnDisk).join() === "profile:pLab" && !/unattended/.test(JSON.stringify(sealedOnDisk)), sealedOnDisk);
    const touchBefore = touchAsks.length; const ownerBefore = ownerAsks().length; const winsBefore = authWindows();
    r = await fill();
    const typed = await fieldValue();
    check("unattended: the fill went through", r.ok === true, r);
    check("unattended: the password reached the page", typed === SECRET, typed === SECRET ? "typed" : "not typed");
    check("unattended: no Touch ID, no password prompt, no LocalAuthentication window", touchAsks.length === touchBefore && ownerAsks().length === ownerBefore && authWindows() === winsBefore, { touch: touchAsks.length - touchBefore, owner: ownerAsks().length - ownerBefore });
    check("unattended: the result carries no value", !JSON.stringify(r).includes(SECRET), null);
    await clearField();

    /* 5. The same files on another Mac do not unlock. */
    const elsewhere = new SecretStore(deps(() => "00000000-0000-0000-0000-000000000000"));
    check("another Mac's hardware id reads the copied policy as Touch ID", elsewhere.unlockPolicy({ kind: "profile", id: LAB }).kind === "touch-id", elsewhere.unlockPolicy({ kind: "profile", id: LAB }));
    check("this Mac still reads it as Without asking", new SecretStore(deps(owner.machineId)).unlockPolicy({ kind: "profile", id: LAB }).kind === "unattended", null);

    /* 3. Revoking asks nothing and restores prompting at once. */
    setMode("real");
    const ownerBeforeRevoke = ownerAsks().length;
    const revoked = await store.setUnlockPolicy({ kind: "profile", id: LAB }, { kind: "touch-id" });
    check("revoking needed no prompt", revoked.ok === true && ownerAsks().length === ownerBeforeRevoke && authWindows() === 0, revoked);
    const touchBeforeRevoked = touchAsks.length;
    r = await fill();
    check("after revoking: the next fill asks for Touch ID again", touchAsks.length === touchBeforeRevoked + 1, touchAsks.slice(touchBeforeRevoked));
    check("after revoking: cancelled, nothing is typed", r.ok === false && r.refused === "no_presence" && (await fieldValue()) === "", r);

    /* 4. A weakening raises the REAL macOS prompt; cancelled, nothing changes. */
    const pending = store.setUnlockPolicy({ kind: "profile", id: LAB }, { kind: "device-password" });
    let seen = 0;
    for (let i = 0; i < 40 && seen === 0; i++) { await sleep(150); seen = authWindows(); }
    check("a weakening raised macOS's own LocalAuthentication window", seen > 0, { windows: seen });
    try { execFileSync("pkill", ["-TERM", "-f", process.env.LIVE_REAL_HELPER + " ask"]); } catch {}
    const cancelled = await pending;
    await sleep(800);
    check("cancelling it changed nothing, and the window closed", cancelled.ok === false && store.unlockPolicy({ kind: "profile", id: LAB }).kind === "touch-id" && authWindows() === 0, cancelled);

    const lines = fs.readFileSync(audit, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const unlocks = lines.filter((l) => l.kind === "unlock").map((l) => l.policy + ":" + l.how);
    check("every unlock is in the audit, the unattended one named as such", JSON.stringify(unlocks) === JSON.stringify(["touch-id:refused", "unattended:unattended", "touch-id:refused"]), unlocks);
    check("policy changes are in the audit", JSON.stringify(lines.filter((l) => l.kind === "unlock-policy").map((l) => l.to + ":" + l.outcome)) === JSON.stringify(["unattended:set", "touch-id:set", "device-password:refused"]), lines.filter((l) => l.kind === "unlock-policy"));
    check("no audit line carries the value", !fs.readFileSync(audit, "utf8").includes(SECRET), null);
    console.log("LIVE " + JSON.stringify({ checks }));
  } catch (e) {
    console.log("LIVE " + JSON.stringify({ checks, error: String((e && e.stack) || e) }));
  } finally {
    server.close();
    setTimeout(() => app.exit(0), 200);
  }
});
`;
}
