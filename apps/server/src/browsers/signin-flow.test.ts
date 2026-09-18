import { describe, expect, it } from "vitest";
import { AGENT_CLI_COMMANDS } from "@realm/contracts";
import { SignInFlow, signInUrlOn, type SignInFlowDeps } from "./signin-flow";
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
function setup(opts: { output: string[]; ticketsEnabled?: boolean }) {
  const calls = { opened: [] as string[], writes: [] as string[], minted: [] as { browserId: string; url: string }[] };
  let step = 0;
  const current = () => opts.output[Math.min(step, opts.output.length - 1)] ?? "";

  const deps: SignInFlowDeps = {
    terminals: {
      open: () => { calls.opened.push("terminal"); return { terminalId: "t1", itemId: "i1" }; },
      screen: async () => screenOf(current()),
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

  it("reassembles a URL the terminal wrapped", async () => {
    // 80 columns, a 150-character URL: three rows on screen, one link in the answer.
    const screen = await renderScreen(`Open: ${CONSENT}`, { cols: 80, rows: 24 });
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

  it("opens the pane at the URL the terminal printed", async () => {
    const { flow, calls } = setup({ output: ["$ ", `Open this URL:\r\n${CONSENT}`] });
    const r = await flow.start(SPACE, "claude");
    expect(r).toMatchObject({ ok: true, terminalId: "t1", browserId: "b1", url: CONSENT });
    expect(calls.opened).toEqual(["terminal", CONSENT]);
  });

  it("mints no ticket unless the space asked for one, so the click stays the user's", async () => {
    const { flow, calls } = setup({ output: [`${CONSENT}`] });
    const r = await flow.start(SPACE, "claude");
    expect(r).toMatchObject({ mayAuthorize: false });
    expect(calls.minted).toEqual([]);
  });

  it("mints one for the pane it just opened when the space has it on", async () => {
    const { flow, calls } = setup({ output: [`${CONSENT}`], ticketsEnabled: true });
    const r = await flow.start(SPACE, "claude");
    expect(r).toMatchObject({ mayAuthorize: true });
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
    expect(r.url).toBeUndefined();
    expect(r.browserId).toBeUndefined();
    expect(r.screen.screen[0]).toContain("Checking for updates");
    expect(calls.opened).toEqual(["terminal"]);
  });
});
