import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { sessionEvent, type Goal, type GoalStatus } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";

/** `chat` gives the pane a message, so its prompter is the docked one rather than the hero. */
async function mount(permissionMode = "default", chat = false) {
  const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle", agentKind: "claude", permissionMode })] });
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: chat
    ? { lastSeq: 1, t: reduceAll([sessionEvent("user_message", { text: "hi", attachments: [] })]) }
    : { lastSeq: 0, t: reduceAll([]) } } });
  render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "Claude session" })} visible /></StoreContext.Provider>);
  return { api, store };
}

const goal = (status: GoalStatus): Goal => ({
  sessionId: "se1", objective: "ship the release notes", status,
  tokenBudget: null, tokensUsed: 0, turns: 0, note: null, startedAt: 0, updatedAt: 0,
});

/** The words on the row beside the permission chip, in order. */
const labels = () => [...document.querySelectorAll(".composer-opts .composer-mode-label")].map((el) => el.textContent);

afterEach(cleanup);

describe("the prompter names the session's mode beside the permission chip", () => {
  it("says nothing in Build, whatever the permission", async () => {
    await mount("bypassPermissions");
    expect(labels()).toEqual([]);
  });

  it("says Plan in Plan, after the permission chip, and a click goes back to Build", async () => {
    const { store } = await mount("plan");
    expect(labels()).toEqual(["Plan"]);
    const chip = screen.getByRole("button", { name: "Permission mode" });
    const label = screen.getByRole("button", { name: "Plan" });
    expect(chip.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(label);
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("default"));
    expect(labels()).toEqual([]);
  });

  it("says Ask mode in Ask, never a bare Ask beside Ask each time, and a click goes back to Build", async () => {
    const { store } = await mount("ask");
    expect(labels()).toEqual(["Ask mode"]);
    fireEvent.click(screen.getByRole("button", { name: "Ask mode" }));
    await waitFor(() => expect(store.getState().sessions.se1?.permissionMode).toBe("default"));
  });

  it("says Plan on the hero prompter and on the docked one", async () => {
    await mount("plan");
    expect(document.querySelector(".session-pane")).toHaveAttribute("data-composer", "hero");
    expect(labels()).toEqual(["Plan"]);
    cleanup();
    await mount("plan", true);
    expect(document.querySelector(".session-pane")).toHaveAttribute("data-composer", "docked");
    expect(labels()).toEqual(["Plan"]);
  });

  it("says Goal only while a goal is being pursued, as a word and not a control", async () => {
    const { store } = await mount();
    expect(labels()).toEqual([]);
    act(() => store.getState().applyGoalChanged({ sessionId: "se1", goal: goal("active") }));
    expect(labels()).toEqual(["Goal"]);
    expect(screen.queryByRole("button", { name: "Goal" })).toBeNull();
    for (const status of ["paused", "blocked", "budget_limited", "complete", "abandoned"] as const) {
      act(() => store.getState().applyGoalChanged({ sessionId: "se1", goal: goal(status) }));
      expect(labels(), status).toEqual([]);
    }
  });

  it("says both when a session pursues a goal in Plan", async () => {
    const { store } = await mount("plan");
    act(() => store.getState().applyGoalChanged({ sessionId: "se1", goal: goal("active") }));
    expect(labels()).toEqual(["Plan", "Goal"]);
  });
});
