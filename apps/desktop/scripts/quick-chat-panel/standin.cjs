// The app in front, for the quick chat panel's live check (../quick-chat-panel-live.mjs): a second
// Electron process with one hushed window that is really made the front app for a moment, so the
// check can read what its page is told when the panel opens over it and takes the keyboard. Started
// through lib/live-app.mjs with `frontApp`, so it is never a Dock app; it hushes its own window
// (1/255 opacity, click-through, no shadow). One JSON command per stdin line, one JSON answer each.
const { app, BrowserWindow, screen } = require("electron");
const readline = require("node:readline");

app.setPath("userData", process.env.STANDIN_USER_DATA);
for (const s of ["mute-audio", "use-mock-keychain", "disable-backgrounding-occluded-windows", "disable-renderer-backgrounding"]) app.commandLine.appendSwitch(s);
app.dock?.hide();
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
for (const e of ["did-become-active", "did-resign-active"]) app.on(e, () => events.push(`app ${e}`));

app.whenReady().then(async () => {
  app.setActivationPolicy("accessory");
  const b = screen.getPrimaryDisplay().workArea;
  const win = new BrowserWindow({ frame: false, show: false, hasShadow: false, opacity: 1 / 255, width: 320, height: 200, x: b.x + b.width - 326, y: b.y + 100, skipTaskbar: true });
  win.setIgnoreMouseEvents(true);
  for (const e of ["focus", "blur"]) win.on(e, () => events.push(`window ${e}`));
  await win.loadURL(`data:text/html,<input autofocus><script>window.log=[];for(const t of ['focus','blur'])window.addEventListener(t,()=>log.push(t));document.addEventListener('visibilitychange',()=>log.push('visibility '+document.visibilityState));document.addEventListener('keydown',e=>log.push('keydown '+e.key))</script>`);
  const page = () => win.webContents.executeJavaScript("({ log: window.log.splice(0), hasFocus: document.hasFocus(), visibility: document.visibilityState })");
  say({ ready: true, pid: process.pid });
  readline.createInterface({ input: process.stdin }).on("line", async (line) => {
    const cmd = JSON.parse(line);
    if (cmd.do === "activate") { win.show(); app.focus({ steal: true }); win.focus(); }
    else if (cmd.do === "yield") app.hide();
    else if (cmd.do === "quit") { say({ bye: true }); return app.exit(0); }
    await sleep(cmd.wait ?? 200);
    say({ did: cmd.do, windowFocused: win.isFocused(), appEvents: events.splice(0), page: await page() });
  }).on("close", () => app.exit(0));
});
