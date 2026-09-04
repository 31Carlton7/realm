import { describe, expect, it } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { GitInfo } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";
import { SUGGESTIONS } from "./suggestions";

/**
 * The suggested prompt, wired up. `prompt-hint.test.ts` proves WHICH sentence a session gets; this
 * proves it reaches the screen in the box's own place, that ⇥ types it, and — the thing a new key
 * binding breaks first — that ⇥ still means what it always did everywhere else in the textarea.
 */
const git = (extra: Partial<GitInfo> = {}): GitInfo =>
  ({ branch: "main", additions: 0, deletions: 0, dirty: 0, ahead: 0, behind: 0, ...extra });

/** The session's cwd from `store.test-fakes`; `gitInfo` is keyed by it. */
const CWD = "/tmp";
/** What a fresh session in a dirty checkout is offered (`prompt-hint.ts`, first rung). */
const HINT = "Audit the 3 uncommitted files on main; find the edge case most likely to escape review.";

async function mount(gitInfo: GitInfo | null = git({ dirty: 3 })) {
  const it0 = item("i9", "s1", { kind: "session", refId: "se1", title: "s" });
  const api = fakeApi({
    sessions: [session("se1", "s1", { status: "idle", agentKind: "fake" })],
    items: { s1: [it0] },
    gitInfo: { [CWD]: gitInfo },
  });
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
  render(
    <StoreContext.Provider value={store}>
      <SessionPane item={it0} visible />
    </StoreContext.Provider>,
  );
  await waitFor(() => expect(store.getState().gitInfo[CWD]).toEqual(gitInfo));
  await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
  return { api, store };
}

const box = () => screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
const hint = () => document.querySelector(".composer-hint");
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const tab = (extra: Record<string, unknown> = {}) => fireEvent.keyDown(box(), { key: "Tab", ...extra });

describe("the prompter's suggested prompt", () => {
  it("shows the session's own suggestion where the placeholder would be, with its ⇥ cap", async () => {
    await mount();
    expect(hint()?.textContent).toContain(HINT);
    expect(hint()?.querySelector("kbd")?.textContent).toBe("Tab");
    // The native placeholder steps aside — the two must never stack in the same box.
    expect(box().placeholder).toBe("");
    // …and the textarea points at it, so the offer is not a sighted-only affordance.
    expect(box().getAttribute("aria-describedby")).toBe(hint()!.id);
  });

  it("fills the draft on ⇥, with the caret at the end and nothing sent", async () => {
    const { api, store } = await mount();
    tab();
    await waitFor(() => expect(store.getState().drafts.se1).toBe(HINT));
    expect(box().value).toBe(HINT);
    // Ready to keep typing, not parked at 0 — the prompt is a starting point, not a finished message.
    expect(box().selectionStart).toBe(HINT.length);
    // ⇥ fills; Enter sends. Accepting a suggestion must never be the thing that talks to the agent.
    expect(api.sent).toHaveLength(0);
  });

  it("retires the hint the moment there is a draft, and gives ⇥ back", async () => {
    await mount();
    type("my own question");
    expect(hint()).toBeNull();
    expect(box().placeholder).toMatch(/^Ask /);
    expect(box().getAttribute("aria-describedby")).toBeNull();
    // ⇥ on real text must not be hijacked into overwriting it.
    tab();
    expect(box().value).toBe("my own question");
  });

  it("leaves ⇧⇥ alone, so focus can still walk backwards out of the box", async () => {
    const { store } = await mount();
    tab({ shiftKey: true });
    await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
    expect(store.getState().drafts.se1 ?? "").toBe("");
  });

  it("still indents a list on ⇥ — the older meaning survives inside one", async () => {
    await mount();
    type("- one");
    box().setSelectionRange(5, 5);
    fireEvent.select(box());
    tab();
    await waitFor(() => expect(box().value).toBe("  - one"));
  });

  it("says nothing mid-turn, and comes back when the turn settles", async () => {
    const { store } = await mount();
    act(() => { store.setState({ sessionStatus: { se1: "running" } }); });
    expect(hint()).toBeNull();
    act(() => { store.setState({ sessionStatus: { se1: "idle" } }); });
    expect(hint()?.textContent).toContain(HINT);
  });

  describe("with nothing session-specific to say", () => {
    it("keeps the plain placeholder, and ⇥ promises nothing", async () => {
      await mount(null); // not a git checkout
      expect(hint()).toBeNull();
      expect(box().placeholder).toBe("Ask Fake agent anything…");
      tab();
      await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
      expect(box().value).toBe("");
    });

    it("leaves the hero's chips exactly as they were — the hint never competes with them", async () => {
      // The fake agent has ONE starter. A hint drawn from the same list would have to either
      // duplicate that chip or empty the hero; it does neither, because it never draws from it.
      await mount(null);
      const chips = Array.from(document.querySelectorAll(".suggestion-chip"));
      expect(chips).toHaveLength(SUGGESTIONS.fake.length);
      fireEvent.click(chips[0]!);
      expect(box().value).toBe(SUGGESTIONS.fake[0]!.prompt);
    });
  });
});
