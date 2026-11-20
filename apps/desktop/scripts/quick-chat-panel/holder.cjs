// Another app holding the chord, for the quick chat panel's live check
// (../quick-chat-panel-live.mjs): registers the one accelerator the check names
// (REALM_QUIET_GLOBAL_SHORTCUT) and reports each press of it. Quiet, and it opens no window.
require("../lib/quiet-electron.cjs");
const { app, globalShortcut } = require("electron");
const readline = require("node:readline");

const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
let presses = 0;
app.whenReady().then(() => {
  const accelerator = process.env.REALM_QUIET_GLOBAL_SHORTCUT;
  say({ ready: true, registered: globalShortcut.register(accelerator, () => { presses++; }) });
  readline.createInterface({ input: process.stdin }).on("line", (line) => {
    if (line === "presses") return say({ presses });
    globalShortcut.unregisterAll();
    say({ bye: true });
    app.exit(0);
  }).on("close", () => app.exit(0));
});
