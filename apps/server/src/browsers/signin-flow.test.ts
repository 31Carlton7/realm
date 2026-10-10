import { describe, expect, it } from "vitest";
import { AGENT_CLI_COMMANDS } from "@realm/contracts";
import { SignInFlow, announceSignIn, signInUrlOn, type SignInFlowDeps } from "./signin-flow";
import { renderScreen } from "../terminals/screen";

const SPACE = "space1";
const CONSENT = "https://claude.ai/oauth/authorize?code=true&client_id=abc123&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback";

const screenOf = (data: string) => renderScreen(data, { cols: 100, rows: 30 });

/**
 * The flow with the pty and the pane faked, and the real emulator in between — so what the flow
 * reads is what a terminal would really have shown.
 *
 * `output` is a script: each entry is what the terminal is showing after that many reads, so a test
 * can make a login command print its banner first and its URL a beat later, which is what they all
 * actually do.
 */
function setup(opts: { output: string[]; ticketsEnabled?: boolean; screenThrows?: Error; claudeHome?: SignInFlowDeps["claudeHome"] }) {
  const calls = { opened: [] as string[], terminals: [] as object[], writes: [] as string[], minted: [] as { browserId: string; url: string }[] };
  let step = 0;
  const current = () => opts.output[Math.min(step, opts.output.length - 1)] ?? "";

  const deps: SignInFlowDeps = {
    terminals: {
      open: (p) => { calls.opened.push("terminal"); calls.terminals.push(p); return { terminalId: "t1", itemId: "i1" }; },
      screen: async () => { if (opts.screenThrows) throw opts.screenThrows; return screenOf(current()); },
      quiet: async () => { step += 1; return true; },
      manager: { writeWhenQuiet: async (_id, data) => { calls.writes.push(data); } },
    },
    browsers: {
      open: ({ url }) => { calls.opened.push(url); return { browserId: "b1", itemId: "i2", url }; },
    },
    tickets: {
      enabled: () => opts.ticketsEnabled ?? false,
      mint: (_spaceId, browserId, url) => { if (opts.ticketsEnabled) calls.minted.push({ browserId, url }); },
    },
    claudeHome: opts.claudeHome,
    // A clock that runs out after a handful of polls, so the timeout test does not take 45 seconds.
    now: () => step * 10_000,
  };
  return { flow: new SignInFlow(deps), calls };
}

describe("signInUrlOn", () => {
  it("prefers the consent URL over any other link on screen", async () => {
    // THE MUTANT: take the first URL. Every one of these CLIs prints a docs or status link in its
    // banner before it prints the one that matters, so the flow would open documentation and then
    // wait for a consent that was never coming.
    const screen = await screenOf(`Claude Code v2.4\r\nDocs: https://docs.claude.com/cli\r\n\r\nOpen this URL:\r\n${CONSENT}\r\n`);
    expect(signInUrlOn(screen)).toBe(CONSENT);
  });

  it("leaves a sentence's punctuation out of the URL", async () => {
    const screen = await screenOf("Visit https://example.com/login to continue.");
    expect(signInUrlOn(screen)).toBe("https://example.com/login");
    const parens = await screenOf("Open it (https://example.com/login).");
    expect(signInUrlOn(parens)).toBe("https://example.com/login");
  });

  it("keeps a bracket the URL genuinely contains", async () => {
    const screen = await screenOf("https://example.com/a(b)");
    expect(signInUrlOn(screen)).toBe("https://example.com/a(b)");
  });

  it("is null for a screen with no link on it", async () => {
    expect(signInUrlOn(await screenOf("$ "))).toBeNull();
  });
});

describe("starting a sign-in", () => {
  it("runs the command the presets name, never one a caller chose", async () => {
    const { flow, calls } = setup({ output: ["$ ", `Open this URL:\r\n${CONSENT}`] });
    const r = await flow.start(SPACE, "claude");
    expect(r.ok).toBe(true);
    // THE MUTANT: take the command as an argument. The URL this flow later reads is only
    // provenanced because Realm chose the program that printed it — a caller-supplied command would
    // make the ticket a laundering step for any URL an agent wanted opened.
    expect(calls.writes).toEqual([`${AGENT_CLI_COMMANDS.claude.login}\r`]);
  });

  it("signs a named Claude config folder in by name, so the login lands where the session looks", async () => {
    const asked: [string, string | null][] = [];
    const { flow, calls } = setup({ output: ["$ "], claudeHome: (spaceId, sessionId) => { asked.push([spaceId, sessionId]); return "/Users/me/.claude-work"; } });
    const r = await flow.start(SPACE, "claude", "session1");
    expect(asked).toEqual([[SPACE, "session1"]]);
    expect(calls.writes).toHaveLength(1);
    expect(calls.writes[0]).toMatch(/^env CLAUDE_CONFIG_DIR='\/Users\/me\/\.claude-work' (claude|'.+') auth login\r$/);
    expect(r).toMatchObject({ ok: true, command: calls.writes[0]!.slice(0, -1) });
  });

  it("types the table's own line where the folder is the default one, and asks with no session when none asked", async () => {
    const asked: (string | null)[] = [];
    const plain = setup({ output: ["$ "] });
    await plain.flow.start(SPACE, "claude");
    const { flow, calls } = setup({ output: ["$ "], claudeHome: (_spaceId, sessionId) => { asked.push(sessionId); return null; } });
    await flow.start(SPACE, "claude");
    expect(asked).toEqual([null]);
    expect(calls.writes).toEqual(plain.calls.writes);
  });

  it("asks about no folder for another agent's sign-in", async () => {
    const claudeHome = (): string => { throw new Error("asked about a folder for an agent that has none"); };
    const { flow, calls } = setup({ output: ["$ "], claudeHome });
    expect((await flow.start(SPACE, "codex", "session1")).ok).toBe(true);
    expect(calls.writes).toEqual([`${AGENT_CLI_COMMANDS.codex.login}\r`]);
  });

  it("opens the terminal for the folder the sign-in lands in, the default one included, so a sandboxed login can write there", async () => {
    const named = setup({ output: ["$ "], claudeHome: () => "/Users/me/.claude-work" });
    await named.flow.start(SPACE, "claude", "session1");
    expect(named.calls.terminals).toEqual([{ spaceId: SPACE, cols: 100, rows: 30, claudeDir: "/Users/me/.claude-work" }]);
    const byDefault = setup({ output: ["$ "], claudeHome: () => null });
    await byDefault.flow.start(SPACE, "claude", "session1");
    expect(byDefault.calls.terminals).toEqual([{ spaceId: SPACE, cols: 100, rows: 30, claudeDir: null }]);
  });

  it("opens the terminal as it always did for another agent's sign-in, and where nothing says which folder", async () => {
    const other = setup({ output: ["$ "], claudeHome: () => "/Users/me/.claude-work" });
    await other.flow.start(SPACE, "codex", "session1");
    const unasked = setup({ output: ["$ "] });
    await unasked.flow.start(SPACE, "claude", "session1");
    expect([...other.calls.terminals, ...unasked.calls.terminals]).toEqual([{ spaceId: SPACE, cols: 100, rows: 30 }, { spaceId: SPACE, cols: 100, rows: 30 }]);
  });

  it("refuses with the reason when the folder has gone, and opens no terminal that would make it", async () => {
    const { flow, calls } = setup({ output: ["$ "], claudeHome: () => { throw new Error("~/.claude-work, the Claude config folder for this profile, is missing."); } });
    expect(await flow.start(SPACE, "claude", "session1")).toEqual({ ok: false, reason: "~/.claude-work, the Claude config folder for this profile, is missing." });
    expect(calls.opened).toEqual([]);
    expect(calls.writes).toEqual([]);
  });

  it("opens the pane at the URL the terminal printed", async () => {
    const { flow, calls } = setup({ output: ["$ ", `Open this URL:\r\n${CONSENT}`] });
    const r = await flow.start(SPACE, "claude");
    // With each pane's item, which is what a client opens beside the session that asked.
    expect(r).toMatchObject({ ok: true, terminalId: "t1", terminalItemId: "i1" });
    if (!r.ok) return;
    expect(await r.settled).toMatchObject({ browserId: "b1", browserItemId: "i2", url: CONSENT });
    expect(calls.opened).toEqual(["terminal", CONSENT]);
  });

  /**
   * THE MUTANT: await the URL inside `start`. The terminal is open and visible the instant it is
   * spawned, so a button wired to a call that blocked until the CLI printed would leave the user
   * watching a pane that was already working while the thing they clicked stayed busy.
   */
  it("returns as soon as the terminal is running, before any URL has arrived", async () => {
    const { flow, calls } = setup({ output: ["Checking for updates…"] });
    const r = await flow.start(SPACE, "claude");
    expect(r.ok).toBe(true);
    // The terminal exists and the command has been typed; the pane has not been opened yet.
    expect(calls.opened).toEqual(["terminal"]);
    expect(calls.writes.length).toBe(1);
  });

  it("settles rather than rejecting when the terminal cannot be read at all", async () => {
    // Nobody is required to await `settled`, so it must never be able to reject into nothing.
    const { flow } = setup({ output: ["$ "], screenThrows: new Error("pty vanished") });
    const r = await flow.start(SPACE, "claude");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await expect(r.settled).resolves.toMatchObject({ url: null, browserId: null });
  });

  it("mints no ticket unless the space asked for one, so the click stays the user's", async () => {
    const { flow, calls } = setup({ output: [`${CONSENT}`] });
    const r = await flow.start(SPACE, "claude");
    if (!r.ok) throw new Error("expected a start");
    expect(await r.settled).toMatchObject({ mayAuthorize: false });
    expect(calls.minted).toEqual([]);
  });

  it("mints one for the pane it just opened when the space has it on", async () => {
    const { flow, calls } = setup({ output: [`${CONSENT}`], ticketsEnabled: true });
    const r = await flow.start(SPACE, "claude");
    if (!r.ok) throw new Error("expected a start");
    expect(await r.settled).toMatchObject({ mayAuthorize: true });
    expect(calls.minted).toEqual([{ browserId: "b1", url: CONSENT }]);
  });

  it("refuses an agent with no sign-in command, and says what to do instead", async () => {
    // Gemini is the one with `login: null` — Google discontinued the free personal tier, so the
    // answer is an API key or Vertex credentials, which is a sentence rather than a line to run.
    const { flow, calls } = setup({ output: ["$ "] });
    const r = await flow.start(SPACE, "acp:gemini");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("API key");
    // Nothing was spawned: an agent with no login command has nothing for a terminal to run.
    expect(calls.opened).toEqual([]);
  });

  it("hands back the terminal and the screen when no URL ever arrives", async () => {
    // The CLI may be asking something first, or be wedged. Either way the terminal is real and open
    // in front of the user, and the screen says what it is doing — which is the useful answer.
    const { flow, calls } = setup({ output: ["Checking for updates…"] });
    const r = await flow.start(SPACE, "claude");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.terminalId).toBe("t1");
    const settled = await r.settled;
    expect(settled.url).toBeNull();
    expect(settled.browserId).toBeNull();
    expect(settled.screen.screen[0]).toContain("Checking for updates");
    expect(calls.opened).toEqual(["terminal"]);
  });
});

describe("announcing a sign-in's panes", () => {
  it("names the terminal as the session's at once and the page only once it is open", async () => {
    const { flow } = setup({ output: ["Checking for updates…", `Open this link: ${CONSENT}`] });
    const r = await flow.start(SPACE, "claude");
    if (!r.ok) throw new Error(r.reason);
    const said: { event: string; payload: unknown }[] = [];
    const pending = announceSignIn({ broadcast: (event, payload) => { said.push({ event, payload }); } }, SPACE, "se1", r);
    expect(said).toEqual([{ event: "terminal.agentOpened", payload: { spaceId: SPACE, terminalId: "t1", itemId: "i1", openedBy: "se1" } }]);
    const settled = await pending;
    expect(settled.browserId).toBe("b1");
    expect(said[1]).toEqual({ event: "browser.agentOpened", payload: { spaceId: SPACE, browserId: "b1", itemId: "i2", openedBy: "se1" } });
  });
});
