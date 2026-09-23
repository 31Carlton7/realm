import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FanOutSheet, clampCount, pickAgent } from "./FanOutSheet";
import { FAN_OUT_MAX, createAppStore, StoreContext } from "../state/store";
import { fakeApi, item, space, type FakeApi } from "../state/store.test-fakes";

afterEach(() => cleanup());

async function open(api: FakeApi = fakeApi({ spaces: [space("s1", "p1", "Versed")] })) {
  api.data.items.s1 = [item("i1", "s1", { title: "One" })];
  const store = createAppStore(api); await store.getState().boot();
  render(<StoreContext.Provider value={store}><FanOutSheet /></StoreContext.Provider>);
  return { api, store };
}

const brief = () => screen.getByLabelText("Brief");
const startButton = () => screen.getByRole("button", { name: /^Start \d+ agents?$/ });

describe("clampCount", () => {
  it("holds the field inside the range, and answers an empty field with one", () => {
    /* The mutant: pass `valueAsNumber` through. An empty number input hands back NaN, and a field
       showing 900 until submit has told the user something the store will not do. */
    expect(clampCount(Number.NaN)).toBe(1);
    expect(clampCount(0)).toBe(1);
    expect(clampCount(4)).toBe(4);
    expect(clampCount(900)).toBe(FAN_OUT_MAX);
  });
});

describe("pickAgent", () => {
  it("never lands on an agent that is not in the list it is offering", () => {
    /* The mutant: seed the control with `lastAgent` and leave it. A `<select>` whose value names no
       option renders as its FIRST row while still holding the other kind, so the user reads Codex,
       presses Start, and the batch goes to a Claude that is not installed. */
    expect(pickAgent(["codex", "acp:cursor"], null, "claude")).toBe("codex");
    expect(pickAgent(["codex", "acp:cursor"], "claude", "claude")).toBe("codex");
  });

  it("prefers the user's own pick, then the agent they last used", () => {
    expect(pickAgent(["claude", "codex"], "codex", "claude")).toBe("codex");
    expect(pickAgent(["claude", "codex"], null, "codex")).toBe("codex");
    expect(pickAgent(["claude", "codex"], null, null)).toBe("claude");
  });
});

describe("the fan-out sheet", () => {
  it("starts one agent per count, each sent the brief, each in its own worktree", async () => {
    const { api } = await open();
    fireEvent.change(brief(), { target: { value: "Fix the checkpoint flake" } });
    fireEvent.change(screen.getByLabelText("How many agents"), { target: { value: "2" } });
    fireEvent.click(startButton());
    await waitFor(() => expect(api.sent).toHaveLength(2));
    expect(api.sent.map((s) => s.text)).toEqual(["Fix the checkpoint flake", "Fix the checkpoint flake"]);
    expect(api.calls.filter((c) => c.startsWith("createWorktree:"))).toHaveLength(2);
  });

  it("refuses to start on an empty brief rather than sending agents a blank turn", async () => {
    await open();
    expect(startButton()).toBeDisabled();
    fireEvent.change(brief(), { target: { value: "   " } });
    expect(startButton()).toBeDisabled();
    fireEvent.change(brief(), { target: { value: "go" } });
    expect(startButton()).toBeEnabled();
  });

  it("lands the user on the wall, which is the view a batch that just started is legible in", async () => {
    const { store } = await open();
    fireEvent.change(brief(), { target: { value: "Survey the adapters" } });
    fireEvent.click(startButton());
    await waitFor(() => expect(store.getState().agentsView).toBe("wall"));
    expect(store.getState().sheet).toBeNull();
  });

  it("Enter is a newline and ⌘Enter sends, so a brief is never cut off at its first sentence", async () => {
    /* The mutant: submit on plain Enter, as a one-line field would. A brief is a paragraph, and
       cutting it at the first line break costs the whole batch a turn. */
    const { api } = await open();
    fireEvent.change(brief(), { target: { value: "Find the leak" } });
    fireEvent.keyDown(brief(), { key: "Enter" });
    expect(api.sent).toHaveLength(0);
    fireEvent.keyDown(brief(), { key: "Enter", metaKey: true });
    await waitFor(() => expect(api.sent.length).toBeGreaterThan(0));
  });

  it("names what turning the worktree switch off would cost, and only while it is off", async () => {
    /* The one choice here a person can get wrong in a way that silently costs them work. */
    await open();
    const sw = screen.getByRole("checkbox");
    expect(sw).toBeChecked();
    expect(screen.getByText(/so they cannot overwrite each other/)).toBeInTheDocument();
    fireEvent.click(sw);
    expect(screen.getByText(/will edit the same files at once/)).toBeInTheDocument();
  });

  it("offers only the agents this Mac can actually run", async () => {
    /* A control offered on a guess is one whose only outcome is a refusal. `claude` is missing here,
       `codex` is installed, and a kind the probe has said nothing about is not an absence. */
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed")],
      agentProbe: [
        { kind: "claude", available: false, version: null, loggedIn: null, reason: "not on PATH" },
        { kind: "codex", available: true, version: "1", loggedIn: true, reason: null },
      ],
    });
    await open(api);
    const select = screen.getByLabelText("Which agent") as HTMLSelectElement;
    await waitFor(() => expect(select.value).not.toBe("claude"));
    const labels = [...select.querySelectorAll("option")].map((o) => o.textContent);
    expect(labels).not.toContain("Claude");
    expect(labels).toContain("Codex");
    // …and the control sits on one of the kinds it is offering, not on the missing one.
    expect(labels).toContain(select.selectedOptions[0]?.textContent ?? null);
    expect(select.value).not.toBe("claude");
  });

  it("starts the batch on the agent the control is actually showing", async () => {
    /* The pair the bug lived between: what the select renders and what the send is made with. */
    const api = fakeApi({
      spaces: [space("s1", "p1", "Versed")],
      agentProbe: [
        { kind: "claude", available: false, version: null, loggedIn: null, reason: "not on PATH" },
        { kind: "codex", available: true, version: "1", loggedIn: true, reason: null },
      ],
    });
    await open(api);
    const select = screen.getByLabelText("Which agent") as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("codex"));
    fireEvent.change(brief(), { target: { value: "Fix it" } });
    fireEvent.click(startButton());
    await waitFor(() => expect(api.sent).toHaveLength(3));
    expect(api.calls.filter((c) => c.startsWith("createSession:")))
      .toEqual(Array(3).fill(`createSession:${select.value}`));
    expect(select.value).toBe("codex");
  });
});
