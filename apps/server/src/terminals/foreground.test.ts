import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import type { TerminalProgram } from "@realm/contracts";
import { openDatabase, type Db } from "../db/database";
import { RpcServer } from "../rpc/server";
import { EnvironmentsStore } from "../store/environments";
import { ItemsStore } from "../store/items";
import { ProfilesStore } from "../store/profiles";
import { SettingsStore } from "../store/settings";
import { SpacesStore } from "../store/spaces";
import { TerminalsStore } from "../store/terminals";
import { waitFor } from "../test-utils";
import { FOREGROUND_POLL_MS, FOREGROUND_REFRESH_MS, FOREGROUND_SETTLE_MS, ForegroundWatcher, readForegroundArgv } from "./foreground";
import { TerminalService } from "./service";

/** A pty whose foreground is whatever the test says, and a `ps` that counts how often it is run. */
function fakeSource() {
  const state = { name: "zsh" as string | null, argv: ["-zsh"] as string[] | null };
  const reads: string[] = [];
  return {
    state, reads,
    source: {
      name: () => state.name,
      argv: async (id: string) => { reads.push(id); return state.argv; },
    },
  };
}

function setup(now = () => 0) {
  const fake = fakeSource();
  const changes: [string, TerminalProgram | null][] = [];
  const w = new ForegroundWatcher({ source: fake.source, onChange: (id, p) => changes.push([id, p]), now });
  w.watch("t1");
  return { ...fake, changes, w };
}

afterEach(() => { vi.useRealTimers(); });

describe("ForegroundWatcher", () => {
  it("announces the program when the foreground changes, and the shell's return as null", async () => {
    const { w, state, changes } = setup();
    await w.look("t1");
    expect(changes).toEqual([]); // a shell at its prompt is where every terminal starts

    state.name = "2.1.283"; state.argv = ["claude"];
    await w.look("t1");
    expect(changes).toEqual([["t1", expect.objectContaining({ id: "claude", agent: true })]]);
    expect(w.programs()).toEqual({ t1: expect.objectContaining({ id: "claude" }) });

    state.name = "zsh"; state.argv = ["-zsh"];
    await w.look("t1");
    expect(changes.at(-1)).toEqual(["t1", null]);
    expect(w.programs()).toEqual({});
  });

  it("runs ps only when the kernel's name changes — never for a shell, never twice for one program", async () => {
    // THE mutant: drop the `name === t.name` guard. Every look then spawns `ps`, and an agent
    // redrawing its spinner pokes several looks a second, in every terminal it runs in.
    const { w, state, reads } = setup();
    await w.look("t1");
    expect(reads).toEqual([]); // the shell needs no argv
    state.name = "htop"; state.argv = ["htop"];
    await w.look("t1"); await w.look("t1"); await w.look("t1");
    expect(reads).toEqual(["t1"]);
  });

  it("re-reads an interpreter's argv now and then, because one name can run two programs in a row", async () => {
    let clock = 0;
    const { w, state, reads, changes } = setup(() => clock);
    state.name = "node"; state.argv = ["node", "server.js"];
    await w.look("t1");
    expect(changes.at(-1)?.[1]).toMatchObject({ id: "node" });
    // `node server.js; node /opt/homebrew/bin/codex` — the kernel says "node" throughout.
    state.argv = ["node", "/opt/homebrew/bin/codex"];
    clock += FOREGROUND_REFRESH_MS - 1;
    await w.look("t1");
    expect(reads).toHaveLength(1);
    clock += 1;
    await w.look("t1");
    expect(reads).toHaveLength(2);
    expect(changes.at(-1)?.[1]).toMatchObject({ id: "codex" });
  });

  it("looks once a burst of output settles, not once per chunk", async () => {
    vi.useFakeTimers();
    const { w, state, reads, changes } = setup();
    state.name = "python3"; state.argv = ["python3", "-c", "import", "time;", "time.sleep(30)"];
    for (let i = 0; i < 50; i++) w.poke("t1");
    expect(reads).toEqual([]);
    await vi.advanceTimersByTimeAsync(FOREGROUND_SETTLE_MS);
    expect(reads).toEqual(["t1"]);
    expect(changes.at(-1)?.[1]).toMatchObject({ id: "python", label: "python3" });
  });

  it("finds a program that started without printing anything, on the backstop timer", async () => {
    // `sleep 30` prints nothing after the echoed Return, so nothing pokes; the clock is all there is.
    vi.useFakeTimers();
    const { w, state, changes } = setup();
    state.name = "sleep"; state.argv = ["sleep", "30"];
    await vi.advanceTimersByTimeAsync(FOREGROUND_POLL_MS);
    expect(changes.at(-1)?.[1]).toMatchObject({ id: "wait", label: "sleep" });
    w.stop();
  });

  it("says nothing about a terminal closed while ps was reading it", async () => {
    const { w, state, changes, source } = setup();
    let release!: (v: string[]) => void;
    source.argv = () => new Promise((r) => { release = r; });
    state.name = "claude";
    const look = w.look("t1");
    w.forget("t1");
    release(["claude"]);
    await look;
    expect(changes).toEqual([]);
  });

  it("asks again after a read that was overtaken, so the last look wins", async () => {
    const { w, state, changes, source } = setup();
    let release!: (v: string[]) => void;
    source.argv = () => new Promise((r) => { release = r; });
    state.name = "vim";
    const first = w.look("t1");
    state.name = "zsh"; // the editor quit while ps was still reading it
    await w.look("t1"); // overtaken: queued, not run beside the first
    release(["vim"]);
    await first;
    await waitFor(() => changes.at(-1)?.[1] === null);
    expect(changes.map(([, p]) => p?.id ?? null)).toEqual(["editor", null]);
  });
});

describe("readForegroundArgv", () => {
  // `ps -o pid=,pgid=,tpgid=,args= -t ttys012` for a shell running `pnpm dev`, whose dev server is a
  // child in the same group.
  const ps = [
    "  401   401   812 -zsh",
    "  812   812   812 node /opt/homebrew/bin/pnpm dev",
    "  830   812   812 node /repo/node_modules/.bin/vite",
  ].join("\n");

  it("reads the leader of the foreground group, not the shell and not the leader's children", async () => {
    const calls: string[][] = [];
    const argv = await readForegroundArgv("/dev/ttys012", async (_file, args) => { calls.push(args); return ps; });
    expect(argv).toEqual(["node", "/opt/homebrew/bin/pnpm", "dev"]);
    expect(calls[0]).toEqual(["-ww", "-o", "pid=,pgid=,tpgid=,args=", "-t", "ttys012"]);
  });

  it("stands a member in for a leader that has already exited", async () => {
    const argv = await readForegroundArgv("ttys012", async () => "  401   401   812 -zsh\n  830   812   812 node /repo/vite.js\n");
    expect(argv).toEqual(["node", "/repo/vite.js"]);
  });

  it("answers null rather than throwing when ps fails", async () => {
    expect(await readForegroundArgv("ttys012", async () => { throw new Error("ps: illegal option"); })).toBeNull();
  });
});

/** The whole path on a real pty: output pokes a look, node-pty names the leader, `ps` reads its
 *  argv, and the service broadcasts what the tab should say. */
describe("a real terminal's foreground", () => {
  const dbs: Db[] = [];
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

  it("broadcasts the program a shell starts, and null when the prompt comes back", async () => {
    const home = tempDir("realm-term-fg-");
    const db = openDatabase(join(home, "realm.db"));
    dbs.push(db);
    const profile = new ProfilesStore(db).create({ name: "P", icon: "x", color: "#000" });
    const spaces = new SpacesStore(db, home);
    const space = spaces.create({ profileId: profile.id, name: "Work", icon: "folder" });
    const rpc = new RpcServer();
    const sent: { terminalId: string; program: TerminalProgram | null }[] = [];
    const broadcast = rpc.broadcast.bind(rpc);
    rpc.broadcast = ((event: string, payload: unknown) => {
      if (event === "terminal.program") sent.push(payload as (typeof sent)[number]);
      return broadcast(event as never, payload as never);
    }) as typeof rpc.broadcast;
    const svc = new TerminalService({
      db, rpc, spaces, items: new ItemsStore(db), terminals: new TerminalsStore(db),
      environments: new EnvironmentsStore(db), settings: new SettingsStore(db),
    });
    const prevShell = process.env.SHELL;
    process.env.SHELL = "/bin/sh";
    try {
      const { terminalId } = svc.open({ spaceId: space.id, cwd: home, cols: 80, rows: 24 });
      svc.write(terminalId, "sleep 5\n");
      await waitFor(() => sent.some((s) => s.program?.label === "sleep"), { timeout: 8_000 });
      expect(svc.programs()[terminalId]).toMatchObject({ id: "wait", label: "sleep", mark: "clock" });
      svc.write(terminalId, "\x03"); // Ctrl-C: sleep dies, sh redraws its prompt
      await waitFor(() => sent.at(-1)?.program === null, { timeout: 8_000 });
      expect(svc.programs()).toEqual({});
    } finally {
      process.env.SHELL = prevShell;
      svc.closeAll();
    }
  }, 20_000);
});
