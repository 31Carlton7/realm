// @vitest-environment node
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@realm/test-utils";
import { spawnDaemon, startServer } from "./server-process";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/nowhere" } }));

/**
 * The app's token reaches realm-server over the spawn pipe and nowhere else. A command line is in
 * `ps -axww` and an environment is in `ps -E`, both readable by every agent the server runs.
 */
const TOKEN = "full-power-app-token-0123456789abcdef";

let dir: string;
const saved = { entry: process.env.REALM_SERVER_ENTRY, node: process.env.REALM_NODE, out: process.env.FAKE_SERVER_OUT };
beforeEach(() => {
  dir = tempDir("realm-spawn-token-");
  // A stand-in for realm-server that records what it was started with, then says it is ready.
  writeFileSync(join(dir, "fake-server.mjs"), [
    'import { writeFileSync } from "node:fs";',
    "let stdin = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (c) => { stdin += c; });",
    "process.stdin.on('end', () => {",
    "  writeFileSync(process.env.FAKE_SERVER_OUT, JSON.stringify({ argv: process.argv, env: process.env, stdin }));",
    "  process.stdout.write(JSON.stringify({ type: 'ready', port: 1, home: process.env.REALM_HOME }) + '\\n');",
    "});",
  ].join("\n"));
  process.env.REALM_SERVER_ENTRY = join(dir, "fake-server.mjs");
  process.env.REALM_NODE = process.execPath;
  process.env.FAKE_SERVER_OUT = join(dir, "seen.json");
});
afterEach(() => {
  for (const [k, v] of Object.entries({ REALM_SERVER_ENTRY: saved.entry, REALM_NODE: saved.node, FAKE_SERVER_OUT: saved.out })) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const seen = async (): Promise<{ argv: string[]; env: Record<string, string>; stdin: string }> => {
  const file = join(dir, "seen.json");
  for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 50));
  return JSON.parse(readFileSync(file, "utf8"));
};

function expectOnlyOnThePipe(s: { argv: string[]; env: Record<string, string>; stdin: string }): void {
  expect(s.stdin.trim()).toBe(TOKEN);
  expect(s.argv.join(" ")).not.toContain(TOKEN);
  expect(Object.entries(s.env).filter(([, v]) => v.includes(TOKEN))).toEqual([]);
  expect(s.env.REALM_APP_TOKEN_STDIN).toBe("1");
}

describe("handing realm-server the app's token", () => {
  it("goes over the pipe of a server the app keeps as its child", async () => {
    const { ready } = startServer({ home: dir, appToken: TOKEN });
    await ready;
    expectOnlyOnThePipe(await seen());
  });

  it("goes over the pipe of a detached daemon too, which outlives the app", async () => {
    const fd = openSync(join(dir, "server.log"), "a");
    try { spawnDaemon({ home: dir, logFd: fd, appToken: TOKEN }); } finally { closeSync(fd); }
    expectOnlyOnThePipe(await seen());
  });
});
