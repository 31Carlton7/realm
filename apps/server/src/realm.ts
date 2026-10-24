// `realm`: the command line for Realm's server (ctl/commands.ts). Built beside main.js, so `serve`
// can boot the very server bundle it was shipped with.
import { fileURLToPath } from "node:url";
import { connect } from "./ctl/client";
import { runCtl } from "./ctl/commands";

const code = await runCtl(process.argv.slice(2), {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
  env: process.env, cwd: process.cwd(), connect,
  serve: async (home, port) => {
    process.env.REALM_HOME = home;
    if (port !== null) process.env.REALM_PORT = String(port);
    // main.js names its bundle from argv[1] (the state file's `bundleId`, which a launcher compares
    // against the app it ships with), so it must read as itself, not as this file.
    const main = new URL("./main.js", import.meta.url);
    process.argv[1] = fileURLToPath(main);
    await import(main.href);
  },
});
if (code !== null) process.exit(code);
