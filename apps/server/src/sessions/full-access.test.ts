import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter, type FakeScript } from "@realm/adapters";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";

/**
 * What a session in Full access is asked when its agent's own harness asks (#344). Claude Code
 * 2.1.322 sends some Bash commands to the permission callback in every mode; `asksInFullAccess` is
 * the fake's stand-in for that, for any tool. The rule is `fullAccessAllows`; these are an agent
 * other than Claude held to it by the session service.
 */

let app: App;
afterEach(async () => { vi.restoreAllMocks(); await app?.close(); });

/** The two commands that stopped task sessions: `$$(` inside a quoted argument, and work in a folder
 *  outside the session's own. */
const DOLLAR_PAREN = `node cdp.mjs eval '(()=>$$(".menu").length)()'`;
const OUTSIDE_FOLDER = "cd /Users/someone/elsewhere || exit 1; node build.mjs > out.txt";

const asks = (name: string, input: Record<string, unknown>) => ({ kind: "tool" as const, name, input, needsPermission: true, asksInFullAccess: true, result: "ran" });
const SCRIPT: FakeScript = [
  { on: "dollar", emit: [asks("Bash", { command: DOLLAR_PAREN })] },
  { on: "outside", emit: [asks("Bash", { command: OUTSIDE_FOLDER })] },
  { on: "long", emit: [asks("Bash", { command: `${DOLLAR_PAREN} ${"y".repeat(400)} TAIL` })] },
  { on: "delete", emit: [asks("Bash", { command: `cd build && rm -rf $$(ls)` })] },
  { on: "sandbox", emit: [asks("Bash", { command: DOLLAR_PAREN, dangerouslyDisableSandbox: true })] },
  { on: "edit", emit: [asks("Edit", { file_path: "README.md", old_string: "a", new_string: "b" })] },
  { on: "write", emit: [asks("Write", { file_path: "notes.md", content: "x" })] },
  { on: "You are a delegated agent.", emit: [asks("Bash", { command: DOLLAR_PAREN }), { kind: "text", text: "FINAL: done" }] },
  { on: "question", emit: [asks("AskUserQuestion", { questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "a" }, { label: "B", description: "b" }] }] })] },
  { on: "plan", emit: [asks("ExitPlanMode", { plan: "1. do it" })] },
];

async function boot() {
  const home = tempDir("realm-fa-");
  const fake = new FakeAdapter({ script: SCRIPT, delayMs: 5 });
  app = await createApp({ home, port: 0, adapters: { fake, claude: fake },
    agentRun: { timeouts: { baseMs: 5000, perTurnMs: 0, pollMs: 20 } } });
  const profile = new ProfilesStore(app.db).create({ name: "P", icon: "x", color: "#000" });
  const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "S", icon: "folder" });
  const session = (permissionMode: string) => app.sessions.create({ spaceId: space.id, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode }).session.id;
  return { spaceId: space.id, session };
}

const events = (id: string) => app.sessions.events(id, 0, 2_000).map((e) => e.event);
const cards = (id: string) => events(id).flatMap((e) => (e.type === "permission_request" ? [e.payload.toolName] : []));
const answered = (id: string) => events(id).flatMap((e) => (e.type === "permission_response" ? [e.payload] : []));
const ran = (id: string) => events(id).some((e) => e.type === "tool_result");
const everWaited = (id: string) => events(id).some((e) => e.type === "status" && e.payload.status === "waiting_permission");

describe("a session in Full access", () => {
  it.each([["`$$(` inside a quoted argument", "dollar", DOLLAR_PAREN], ["a command in a folder outside its own", "outside", OUTSIDE_FOLDER]])(
    "runs %s with no card, and records that it was asked", async (_shape, prompt, command) => {
      const { session } = await boot();
      const id = session("bypassPermissions");
      await app.sessions.send(id, { text: prompt, attachments: [] });
      await waitFor(() => ran(id));
      expect(cards(id)).toEqual([]);
      expect(answered(id)).toHaveLength(1);
      expect(answered(id)[0]).toMatchObject({ decision: "allow", fullAccess: { toolName: "Bash", title: "Allow Bash?" } });
      expect(events(id).some((e) => e.type === "tool_call" && e.payload.input.command === command)).toBe(true);
    });

  it("says so in the daemon log, with the start of the command and not all of it", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { logged.push(args.join(" ")); });
    const { session } = await boot();
    const id = session("bypassPermissions");
    await app.sessions.send(id, { text: "long", attachments: [] });
    await waitFor(() => ran(id));
    const line = logged.find((l) => l.includes("Full access ran a command without asking"));
    expect(line).toContain(DOLLAR_PAREN);
    expect(line).not.toContain("TAIL");
  });

  it.each([
    ["a command that names rm", "delete", "Bash"],
    ["a command that asks to leave the sandbox", "sandbox", "Bash"],
    ["an edit", "edit", "Edit"],
    ["a new file", "write", "Write"],
    ["a question", "question", "AskUserQuestion"],
    ["a plan to approve", "plan", "ExitPlanMode"],
  ])("still puts %s to the person, and runs nothing until it is answered", async (_what, prompt, tool) => {
    const { session } = await boot();
    const id = session("bypassPermissions");
    await app.sessions.send(id, { text: prompt, attachments: [] });
    await waitFor(() => cards(id).length === 1);
    expect(cards(id)).toEqual([tool]);
    expect(ran(id)).toBe(false);
    expect(answered(id)).toEqual([]);
  });

  it.each(["default", "acceptEdits", "ask", "plan"])("still draws the card in %s, and runs nothing until it is answered", async (mode) => {
    const { session } = await boot();
    const id = session(mode);
    await app.sessions.send(id, { text: "dollar", attachments: [] });
    await waitFor(() => cards(id).length === 1);
    expect(cards(id)).toEqual(["Bash"]);
    expect(ran(id)).toBe(false);
    expect(answered(id)).toEqual([]);
  });

  it("stops answering the moment the session leaves Full access", async () => {
    const { session } = await boot();
    const id = session("bypassPermissions");
    await app.sessions.send(id, { text: "dollar", attachments: [] });
    await waitFor(() => ran(id) && app.sessions.get(id).status === "idle");
    await app.sessions.setOptions(id, { permissionMode: "default" });
    await app.sessions.send(id, { text: "outside", attachments: [] });
    await waitFor(() => cards(id).length === 1);
    expect(events(id).filter((e) => e.type === "tool_result")).toHaveLength(1);
  });

  it("answers a card the person clicks as it always did, with no mark", async () => {
    const { session } = await boot();
    const id = session("bypassPermissions");
    await app.sessions.send(id, { text: "delete", attachments: [] });
    await waitFor(() => cards(id).length === 1);
    const request = events(id).flatMap((e) => (e.type === "permission_request" ? [e.payload.requestId] : []))[0]!;
    app.sessions.respondPermission(id, request, "allow");
    await waitFor(() => ran(id));
    expect(answered(id)).toEqual([{ requestId: request, decision: "allow" }]);
  });
});

describe("a task session started by a Full access parent", () => {
  it("asking for Full access gets it, and is asked nothing a top-level Full access session is not", async () => {
    const { spaceId, session } = await boot();
    const parentId = session("bypassPermissions");
    await app.agentRuns.start({ sessionId: parentId, spaceId }, { goal: "go", constraints: { permissionMode: "bypassPermissions" } });
    const child = app.sessions.list(spaceId).find((s) => s.id !== parentId)!;
    expect(child.permissionMode).toBe("bypassPermissions");
    await waitFor(() => ran(child.id));
    expect(cards(child.id)).toEqual([]);
    await app.agentRuns.wait({ sessionId: parentId, spaceId }, {});

    const top = session("bypassPermissions");
    await app.sessions.send(top, { text: "dollar", attachments: [] });
    await waitFor(() => ran(top));
    expect(cards(top)).toEqual(cards(child.id));
    expect(everWaited(top)).toBe(everWaited(child.id));
  });
});
