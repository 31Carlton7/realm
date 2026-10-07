import { describe, expect, it } from "vitest";
import { registerMethods, type Deps } from "./methods";
import type { SignInSettled } from "../browsers/signin-flow";

/**
 * The session card's Sign in button over its method, with the flow faked: booting the real app would
 * type a real `claude auth login` into a real shell. What is under test is the announcing — the
 * sidebar lists sessions, so a terminal and a consent page announced as nobody's are on no screen.
 */
describe("signin.start", () => {
  const screen = { screen: [], scrollback: [], cursor: { row: 0, col: 0 }, cols: 100, rows: 30, altScreen: false };
  function harness(page: { browserId: string; browserItemId: string } | null) {
    const handlers = new Map<string, (p: unknown) => Promise<unknown>>();
    const broadcasts: { event: string; payload: unknown }[] = [];
    let settle!: (s: SignInSettled) => void;
    const settled = new Promise<SignInSettled>((r) => { settle = r; });
    const rpc = {
      register: (name: string, _schema: unknown, fn: (p: unknown) => Promise<unknown>) => { handlers.set(name, fn); },
      broadcast: (event: string, payload: unknown) => { broadcasts.push({ event, payload }); },
    };
    const signIn = { start: async () => ({ ok: true as const, terminalId: "t9", terminalItemId: "it9", command: "claude auth login", settled }) };
    registerMethods({ rpc, signIn } as unknown as Deps);
    const opened = () => broadcasts.filter((b) => b.event.endsWith(".agentOpened"));
    const finish = async () => {
      settle({ url: page ? "https://x/authorize?client_id=a&redirect_uri=b" : null, browserId: page?.browserId ?? null, browserItemId: page?.browserItemId ?? null, mayAuthorize: false, screen });
      await settled; await new Promise((r) => setTimeout(r, 0));
    };
    return { call: (p: unknown) => handlers.get("signin.start")!(p), opened, finish };
  }

  it("announces the terminal as the asking session's at once, and its consent page once it opens", async () => {
    // THE MUTANTS: drop the session id on the way through, or announce either pane not at all.
    const h = harness({ browserId: "b9", browserItemId: "ib9" });
    expect(await h.call({ spaceId: "sp1", kind: "claude", sessionId: "se1" })).toEqual({ terminalId: "t9", command: "claude auth login" });
    // Answered before the CLI has printed anything — the terminal is already the session's.
    expect(h.opened()).toEqual([{ event: "terminal.agentOpened", payload: { spaceId: "sp1", terminalId: "t9", itemId: "it9", openedBy: "se1" } }]);
    await h.finish();
    expect(h.opened()[1]).toEqual({ event: "browser.agentOpened", payload: { spaceId: "sp1", browserId: "b9", itemId: "ib9", openedBy: "se1" } });
  });

  it("announces only the terminal when the login printed no URL", async () => {
    const h = harness(null);
    await h.call({ spaceId: "sp1", kind: "claude", sessionId: "se1" });
    await h.finish();
    expect(h.opened().map((b) => b.event)).toEqual(["terminal.agentOpened"]);
  });

  it("announces nothing as anyone's when no session asked", async () => {
    const h = harness({ browserId: "b9", browserItemId: "ib9" });
    await h.call({ spaceId: "sp1", kind: "claude" });
    await h.finish();
    expect(h.opened()).toEqual([]);
  });
});
