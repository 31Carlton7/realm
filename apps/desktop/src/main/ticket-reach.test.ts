import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Methods } from "@realm/contracts/src/rpc";

/**
 * Nothing an agent can call makes a team's act ticket go out. An agent proposes work for Review; a
 * person approves it, and then presses each act on its sheet.
 *
 * The press is made by exactly one door: the post sheet's `team:press-ticket` IPC handler here in
 * Electron main, which only the top frame of Realm's own window can invoke, whose button carries
 * `data-no-agent` (review-pane.test.tsx), and which `app-drive.ts` refuses to press by ref or by the
 * focused element. realm-server acts only on a press main hands it (`ActService.post`, its own suite).
 * What this file pins down is that no OTHER door exists. Read as text, like vault-allow-reach.
 */

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try { if (statSync(join(dir, "pnpm-workspace.yaml")).isFile()) return dir; } catch { /* keep climbing */ }
    dir = dirname(dir);
  }
  throw new Error(`cannot find the repo root from ${process.cwd()}`);
}
const root = repoRoot();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function sourceFiles(rel: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === "fixtures") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
    }
  };
  walk(join(root, rel));
  return out;
}
const rel = (f: string) => f.slice(root.length + 1);

describe("nothing an agent can call fires an act ticket", () => {
  it("the RPC surface lists, posts on a press, and otherwise only takes acts back", () => {
    // THE MUTANT: a `team.ticketForce` or `team.ticketPress` method — anything holding daemon.json's
    // token could call it.
    expect(Object.keys(Methods).filter((m) => /^team\./.test(m) && /ticket|acts|press/i.test(m)).sort())
      .toEqual(["team.actsHold", "team.ticketCancel", "team.ticketPost", "team.tickets"]);
  });

  it("no MCP tool posts, sends, DMs or presses — agents only propose", () => {
    const names = (dir: string) => sourceFiles(dir)
      .flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\bname:\s*"([a-z]+_[a-z_]+)"/g)].map((m) => m[1]!));
    // THE MUTANT: a `review_act` or `ticket_post` tool on the team's provider.
    expect(names("apps/server/src/team").sort()).toEqual(["record_list", "record_read", "record_update", "review_status", "review_submit", "team_roles", "vault_http", "vault_list"]);
    expect(names("apps/server/src").filter((n) => /ticket|publish|^post_|_post$|send_dm|^dm_|_dm$|social/i.test(n))).toEqual([]);
  });

  it("only the tickets' RPC module makes a ticket act, and only the service's own clock runs one", () => {
    const posts = sourceFiles("apps/server/src").filter((f) => /\bacts!?\??\.post\(/.test(readFileSync(f, "utf8"))).map(rel);
    expect(posts).toEqual(["apps/server/src/team/acts/rpc.ts"]);
    const runs = sourceFiles("apps/server/src").filter((f) => /\.execute\(\s*(t\.id|id)\b/.test(readFileSync(f, "utf8"))).map(rel);
    expect(runs).toEqual(["apps/server/src/team/acts/service.ts"]);
  });

  it("the bridge carries one ticket op, and it only reads a press", () => {
    const bridge = read("apps/server/src/browsers/host-bridge.ts");
    const ops = [...bridge.slice(bridge.indexOf("export const TEAM_HOST_OPS")).split("] as const")[0]!.matchAll(/^\s+"(\w+)",/gm)].map((m) => m[1]);
    expect(ops).toEqual(["teamTicketPress"]);
  });

  it("main makes a press from the post sheet's IPC handler and nowhere else, and only consumes one for the bridge", () => {
    const pressers = sourceFiles("apps/desktop/src/main").filter((f) => /ticketPresses\.press\(/.test(readFileSync(f, "utf8"))).map(rel);
    expect(pressers).toEqual(["apps/desktop/src/main/index.ts"]);
    const main = read("apps/desktop/src/main/index.ts").split("\n");
    const handler = main.findIndex((l) => l.includes('ipcMain.handle("team:press-ticket"'));
    const press = main.findIndex((l) => l.includes("ticketPresses.press("));
    expect(handler).toBeGreaterThan(-1);
    expect(press - handler).toBeGreaterThan(0);
    expect(press - handler).toBeLessThan(5);
    // The handler takes a press only from the top frame of one of Realm's own windows.
    expect(main.slice(handler, press).join("\n")).toMatch(/senderFrame !== e\.sender\.mainFrame/);
    const op = main.findIndex((l) => l.includes('op === "teamTicketPress"'));
    expect(main.slice(op, op + 4).join("\n")).toMatch(/ticketPresses\.consume\(/);
    expect(main.slice(op, op + 4).join("\n")).not.toMatch(/ticketPresses\.press\(/);
  });

  it("the server holds no way to make a press", () => {
    const hits = sourceFiles("apps/server/src").filter((f) => /team:press-ticket|ticketPresses|pressTicket/.test(readFileSync(f, "utf8"))).map(rel);
    expect(hits).toEqual([]);
  });
});
