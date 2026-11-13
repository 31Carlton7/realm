// Starts each Swift helper in <dir> the way the app would, with a request that reads nothing and asks
// for no permission, and prints whether it ran. dyld does not refuse a binary for its minos alone, but
// one that links a Swift library this macOS lacks never reaches its own code: dyld aborts it at launch
// and says why on stderr, as v2.12.0's scrollphase and phonescreen did on macOS 15.
//
//   node scripts/start-native-helpers.mjs <dir>
//
// Exits 1 when any helper did not start. With GITHUB_STEP_SUMMARY set, the table is written there too.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";

/** binary → how to start it, and the exits that mean its own code ran. */
const STARTS = {
  // Quits when stdin closes; 2 when macOS refuses the event tap, which a runner without Input Monitoring may.
  scrollphase: { args: [], input: "", exits: [0, 2] },
  axhelper: { args: [], input: '{"id":1,"method":"ping"}\n', exits: [0] },
  phonescreen: { args: ["status"], exits: [0] },
  deviceowner: { args: ["can"], exits: [0] },
  // Both refuse a call without arguments before touching the Keychain.
  policystamp: { args: [], exits: [2] },
  realmkeychain: { args: [], exits: [2] },
};

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node scripts/start-native-helpers.mjs <dir>");
  process.exit(64);
}

const macos = spawnSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim();
const rows = [];
for (const [binary, start] of Object.entries(STARTS)) {
  const path = join(dir, binary);
  if (!existsSync(path)) {
    rows.push({ binary, started: false, exit: "missing", message: "" });
    continue;
  }
  const run = spawnSync(path, start.args, { input: start.input ?? "", encoding: "utf8", timeout: 20_000 });
  const exit = run.signal ?? run.status;
  const message = run.stderr.trim().split("\n").filter(Boolean).slice(0, 3).join(" / ");
  rows.push({ binary, started: start.exits.includes(run.status) && !/dyld/.test(run.stderr), exit, message });
}

const lines = [
  `macOS ${macos} (Darwin ${release()}), helpers from ${dir}`,
  "",
  "| helper | started | exit | stderr |",
  "| --- | --- | --- | --- |",
  ...rows.map((r) => `| ${r.binary} | ${r.started ? "yes" : "**no**"} | ${r.exit} | ${r.message.replaceAll("|", "\\|")} |`),
];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n\n`);
if (rows.some((r) => !r.started)) process.exit(1);
