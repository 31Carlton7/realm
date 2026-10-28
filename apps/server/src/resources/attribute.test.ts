import { describe, expect, it } from "vitest";
import { appName, attribute, engineBin, resumedConversation, sameBoot, simulatorLaunchd, type Owners } from "./attribute";
import type { ProcRow } from "./machine";

/* A Realm the way `ps` showed the real one at 02:15 on 2026-10-28, cut down: a server, Claude engines
   (one resumed, one fresh), a shared Codex app-server, an ACP agent, a terminal whose prompt helpers
   forked onto its tty, an MCP server, Laya, a simulator Realm booted and one it did not, and the
   app's own processes — plus somebody else's Chrome. */

const MB = 1024 ** 2;
const T0 = new Date(2026, 9, 27, 2, 8, 7).getTime();
const UUID = "deef1bf5-aaa4-4f29-ab46-1521d7c153e9";
const SIM = "D94F0FDE-7C84-42F1-A328-97EF12A91866";
const OTHER_SIM = "CDA45F4D-4FDD-40A9-8259-D58BE3BEF20C";
const CLAUDE = "/Applications/Realm.app/Contents/Resources/server/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";

const row = (pid: number, ppid: number, mb: number, command: string, o: { tty?: string; startedAt?: number } = {}): ProcRow =>
  ({ pid, ppid, tty: o.tty ?? null, residentBytes: mb * MB, startedAt: o.startedAt ?? T0, command });

const TABLE: ProcRow[] = [
  row(1, 0, 20, "/sbin/launchd"),
  row(100, 1, 300, "/Applications/Realm.app/Contents/MacOS/Realm"), // Electron main
  row(101, 100, 900, "/Applications/Realm.app/Contents/Frameworks/Realm Helper (GPU).app/Contents/MacOS/Realm Helper (GPU)"),
  row(102, 100, 400, "/Applications/Realm.app/Contents/Frameworks/Realm Helper (Renderer).app/Contents/MacOS/Realm Helper (Renderer)"),
  row(103, 100, 250, "/Applications/Realm.app/Contents/Frameworks/Realm Helper (Renderer).app/Contents/MacOS/Realm Helper (Renderer)"),
  row(104, 100, 20, "/Applications/Realm.app/Contents/Frameworks/Realm Helper.app/Contents/MacOS/Realm Helper --type=utility"),
  row(105, 100, 5, "/Applications/Realm.app/Contents/Resources/axhelper"),
  // The server, detached (a daemon), and what it started.
  row(200, 1, 150, "/Applications/Realm.app/Contents/MacOS/Realm /Applications/Realm.app/Contents/Resources/server/dist/main.js"),
  row(201, 200, 360, `${CLAUDE} --output-format stream-json --resume=${UUID} --model claude-opus-5-5`, { startedAt: T0 + 60_000 }),
  row(202, 200, 140, `${CLAUDE} --output-format stream-json --model claude-opus-5-5`, { startedAt: T0 + 120_000 }),
  row(203, 202, 900, "node /repo/node_modules/.bin/vitest run", { startedAt: T0 + 130_000 }), // the engine's own test run
  row(204, 200, 500, "/opt/homebrew/bin/codex app-server", { startedAt: T0 + 30_000 }),
  row(205, 200, 200, "/usr/local/bin/node /Users/me/.local/bin/cursor-agent acp", { startedAt: T0 + 200_000 }),
  row(210, 200, 3, "/bin/zsh -l", { tty: "ttys001" }),
  row(211, 1, 0.3, "/bin/zsh -l", { tty: "ttys001" }), // p10k's helper, reparented to launchd
  row(212, 211, 0.7, "/Users/me/.cache/gitstatus/gitstatusd-darwin-arm64 -s -1", { tty: "ttys001" }),
  row(213, 210, 50, "pnpm dev", { tty: "ttys001" }),
  row(220, 200, 2, "/usr/local/bin/node /usr/local/lib/node_modules/@mobilenext/mobile-mcp/lib/index.js"),
  row(230, 200, 24, "/opt/homebrew/Cellar/python@3.13/Python.app/Contents/MacOS/Python -c import os, sys"),
  row(240, 200, 4, "/usr/bin/git status --porcelain"),
  row(241, 200, 4, "/usr/bin/git diff --stat"),
  // A simulator Realm booted (its launchd started with Realm's boot), and its stream.
  row(300, 1, 10, `launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${SIM}/data/var/run/launchd_bootstrap.plist`, { startedAt: T0 + 5_000 }),
  row(301, 300, 700, "/Library/Developer/CoreSimulator/Volumes/iOS_27/SpringBoard"),
  row(302, 1, 50, `/usr/local/bin/node /Users/me/.npm/_npx/x/node_modules/.bin/serve-sim ${SIM} --port 3100`),
  // One somebody booted in Xcode: not Realm's.
  row(310, 1, 10, `launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${OTHER_SIM}/data/var/run/launchd_bootstrap.plist`),
  row(311, 310, 600, "/Library/Developer/CoreSimulator/Volumes/iOS_27/SpringBoard"),
  // Somebody else's apps.
  row(400, 1, 700, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  row(401, 400, 60, "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)"),
  row(402, 1, 460, "/usr/local/mysql/bin/mysqld --user=_mysql"),
];

const OWNERS: Owners = {
  serverPid: 200,
  engines: [
    { sessionId: "s-resumed", title: "Fix the sidebar", kind: "claude", providerSessionId: UUID, startedAt: T0 + 60_000, detail: "Idle 12 min" },
    { sessionId: "s-fresh", title: "Write the tests", kind: "claude", providerSessionId: null, startedAt: T0 + 119_500, detail: "Working" },
    { sessionId: "s-codex", title: "Port the parser", kind: "codex", providerSessionId: "t1", startedAt: T0 + 29_000, detail: "Idle 3 min" },
    { sessionId: "s-cursor", title: "Review copy", kind: "acp:cursor", providerSessionId: null, startedAt: T0 + 199_000, detail: "Idle 1 min" },
  ],
  terminals: [{ terminalId: "t-1", title: "realm", pid: 210, tty: "/dev/ttys001" }],
  mcp: [{ serverId: "m-1", name: "mobile-mcp", pid: 220, detail: null }],
  laya: { pid: 230, detail: "Shadow, ready" },
  simulators: [{ udid: SIM, name: "Persona Onboarding", bootedAt: T0 + 4_000, detail: "Booted by Realm" }],
  app: [
    { pid: 100, kind: "main", label: "Realm", ownerId: null, detail: null },
    { pid: 101, kind: "gpu", label: "GPU", ownerId: null, detail: null },
    { pid: 102, kind: "window", label: "Personal", ownerId: null, detail: null },
    { pid: 103, kind: "browser", label: "Linear", ownerId: "b-1", detail: null },
    { pid: 104, kind: "utility", label: "Network Service", ownerId: null, detail: null },
  ],
};

const run = (o: Partial<Parameters<typeof attribute>[0]> = {}) =>
  attribute({ table: TABLE, owners: OWNERS, footprint: new Map(), allFootprint: null, footprintMeasured: true, ...o });
const part = (r: ReturnType<typeof run>, id: string) => r.parts.find((p) => p.id === id);

describe("whose each process is", () => {
  it("gives a resumed Claude engine to the session whose conversation its command line names", () => {
    const r = run();
    expect(part(r, "engines:s-resumed")).toMatchObject({ label: "Fix the sidebar", detail: "Idle 12 min", processes: 1, residentBytes: 360 * MB });
  });

  it("gives a fresh engine to the session that started just before it, with what its tools are running", () => {
    // The test run under the engine is the session's cost. THE MUTANT: claiming only the engine's own
    // process, which hides the 900 MB vitest a session's agent started.
    expect(part(r(), "engines:s-fresh")).toMatchObject({ processes: 2, residentBytes: (140 + 900) * MB });
    function r() { return run(); }
  });

  it("counts Codex's one app-server once, for every Codex session", () => {
    expect(part(run(), "engines:codex")).toMatchObject({ label: "Codex", detail: "Port the parser", residentBytes: 500 * MB });
  });

  it("matches an engine run under an interpreter by its script, and only to a session of its kind", () => {
    expect(part(run(), "engines:s-cursor")).toMatchObject({ label: "Review copy", residentBytes: 200 * MB });
  });

  it("never gives an engine to a session that started after it", () => {
    // The fresh engine started at +120 s. A session that started at +125 s cannot own it.
    const late = { ...OWNERS, engines: OWNERS.engines.map((e) => (e.sessionId === "s-fresh" ? { ...e, startedAt: T0 + 125_000 } : e)) };
    const r = run({ owners: late });
    expect(part(r, "engines:s-fresh")).toBeUndefined();
    expect(r.parts.find((p) => p.label === "claude (no session)")).toMatchObject({ residentBytes: (140 + 900) * MB });
  });

  it("counts a terminal's shell, what it runs, and the prompt helpers that forked away onto its tty", () => {
    // gitstatusd's parent zsh is reparented to launchd, so no tree walk from the shell finds it.
    expect(part(run(), "terminals:t-1")).toMatchObject({ label: "realm", processes: 4, residentBytes: (3 + 0.3 + 0.7 + 50) * MB });
  });

  it("counts MCP servers and Laya as themselves", () => {
    const r = run();
    expect(part(r, "mcp:m-1")).toMatchObject({ label: "mobile-mcp", residentBytes: 2 * MB });
    expect(part(r, "laya:laya")).toMatchObject({ detail: "Shadow, ready", residentBytes: 24 * MB });
  });

  it("counts a simulator Realm booted, with its stream, and leaves one Realm did not boot to its owner", () => {
    const r = run();
    expect(part(r, `simulators:${SIM}`)).toMatchObject({ label: "Persona Onboarding", processes: 3, residentBytes: (10 + 700 + 50) * MB });
    expect(r.parts.some((p) => p.ownerId === OTHER_SIM)).toBe(false);
    expect(r.others.find((o) => o.name === "Simulator")).toMatchObject({ processes: 2 });
  });

  it("does not count a later boot of a device Realm once booted", () => {
    // Shut down and booted again from Xcode an hour later: the record is Realm's, the boot is not.
    const reboot = { ...OWNERS, simulators: [{ ...OWNERS.simulators[0]!, bootedAt: T0 - 3_600_000 }] };
    expect(run({ owners: reboot }).parts.some((p) => p.category === "simulators")).toBe(false);
  });

  it("names the app's processes as main does, browser panes in their own category", () => {
    const r = run();
    expect(part(r, "browsers:b-1")).toMatchObject({ label: "Linear", residentBytes: 250 * MB });
    expect(part(r, "app:gpu:GPU")).toMatchObject({ residentBytes: 900 * MB });
    expect(part(r, "app:app:helpers")).toMatchObject({ label: "Helpers", residentBytes: 5 * MB });
  });

  it("never counts the server among main's helpers when main is its parent", () => {
    // `pnpm dev` and the live checks run the server as main's child.
    const child = TABLE.map((p) => (p.pid === 200 ? { ...p, ppid: 100 } : p));
    const r = run({ table: child });
    expect(part(r, "app:app:helpers")).toMatchObject({ processes: 1 });
    expect(part(r, "server:server")).toMatchObject({ residentBytes: 150 * MB });
  });

  it("groups whatever else the server ran by what it is", () => {
    expect(part(run(), "other:other:git")).toMatchObject({ label: "git", processes: 2 });
  });

  it("reports nobody else's process as Realm's, and other apps by name and size only", () => {
    const r = run();
    expect(r.others.map((o) => o.name)).toEqual(expect.arrayContaining(["Google Chrome", "mysqld"]));
    expect(r.others.find((o) => o.name === "Google Chrome")).toEqual({ name: "Google Chrome", processes: 2, residentBytes: 760 * MB, footprintBytes: null });
    expect(r.claimed).not.toContain(400);
    expect(r.claimed).not.toContain(311);
  });
});

describe("the totals", () => {
  it("count every Realm process once, and add up to the parts", () => {
    const r = run();
    const claimed = new Set(r.claimed);
    expect(claimed.size).toBe(r.claimed.length);
    const sum = r.parts.reduce((n, p) => n + p.processes, 0);
    expect(sum).toBe(r.realm.processes);
    expect(sum).toBe(claimed.size);
    expect(r.categories.reduce((n, c) => n + (c.footprintBytes ?? 0), 0)).toBe(r.realm.footprintBytes);
  });

  it("are footprints where they were read, and resident sizes where a process left before it was read", () => {
    const footprint = new Map([[201, 375 * MB], [202, 200 * MB]]);
    const r = run({ footprint });
    expect(part(r, "engines:s-resumed")).toMatchObject({ residentBytes: 360 * MB, footprintBytes: 375 * MB });
    // 203 (vitest) had no footprint read: its resident size stands in.
    expect(part(r, "engines:s-fresh")!.footprintBytes).toBe((200 + 900) * MB);
  });

  it("say they are resident only where footprint is not this platform's measure", () => {
    const r = run({ footprintMeasured: false });
    expect(r.measure).toBe("resident");
    expect(r.realm.footprintBytes).toBeNull();
    expect(r.parts.every((p) => p.footprintBytes === null)).toBe(true);
  });

  it("list the heaviest part first", () => {
    const weights = run().parts.map((p) => p.footprintBytes ?? p.residentBytes);
    expect(weights).toEqual([...weights].sort((a, b) => b - a));
  });

  it("count nothing of the app's when no app is attached", () => {
    const r = run({ owners: { ...OWNERS, app: null } });
    expect(r.parts.some((p) => p.category === "app" || p.category === "browsers")).toBe(false);
    expect(r.others.find((o) => o.name === "Realm")).toBeDefined();
  });
});

describe("the readings these rest on", () => {
  it("names the engine a command runs, through an interpreter", () => {
    expect(engineBin(`${CLAUDE} --resume=x`)).toBe("claude");
    expect(engineBin("/usr/local/bin/node /x/bin/gemini --acp")).toBe("gemini");
    expect(engineBin("node /x/@anthropic-ai/claude-code/cli.js --print")).toBe("claude");
    expect(engineBin("/usr/bin/git status")).toBeNull();
    expect(engineBin("node /x/vitest.mjs run")).toBeNull();
  });

  it("reads a resumed conversation in either flag form", () => {
    expect(resumedConversation(`claude --resume ${UUID}`)).toBe(UUID);
    expect(resumedConversation(`claude --session-id=${UUID}`)).toBe(UUID);
    expect(resumedConversation("claude --model x")).toBeNull();
  });

  it("reads a simulator's udid off its launchd, and nothing else's", () => {
    expect(simulatorLaunchd(`launchd_sim /U/Library/Developer/CoreSimulator/Devices/${SIM}/data/var/run/launchd_bootstrap.plist`)).toBe(SIM);
    expect(simulatorLaunchd(`/bin/cat /U/Devices/${SIM}/x`)).toBeNull();
  });

  it("tells one boot from the next by when the device's launchd started", () => {
    expect(sameBoot(T0, T0 + 30_000)).toBe(true);
    expect(sameBoot(T0, T0 + 30 * 60_000)).toBe(false);
    expect(sameBoot(T0, null)).toBe(false);
  });

  it("names an app by its outermost bundle", () => {
    expect(appName("/Applications/Google Chrome.app/Contents/Frameworks/X.framework/Helpers/Google Chrome Helper.app/Contents/MacOS/h")).toBe("Google Chrome");
    expect(appName("/usr/local/mysql/bin/mysqld --user=_mysql")).toBe("mysqld");
  });
});
