import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { NeedsYou } from "./NeedsYou";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, profile, session, space } from "../../state/store.test-fakes";

/**
 * Needs you (Plan 27): the one list of what waits on you, from every space and profile, answered in
 * place. It replaces the head band's "N need you" pill and the Active section. Every test names the
 * one-line change that would make it fail.
 */

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const permit = (sessionId: string, requestId: string, title: string) =>
  ({ seq: 1, sessionId, event: sessionEvent("permission_request", { requestId, toolName: "Bash", input: { command: "rm -rf build" }, title, suggestions: [] }) });
const asks = (sessionId: string, requestId: string) =>
  ({ seq: 1, sessionId, event: sessionEvent("permission_request", { requestId, toolName: "AskUserQuestion", title: "Which database?", suggestions: [],
    input: { questions: [{ question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] }] } }) });

/** Work holds Versed (the lead, idle; "Build", waiting on a permission) and Homework ("Schema",
 *  waiting on a question, longer); School holds Lectures ("Notes", failed and never read). */
async function mount(over: { waiting?: boolean } = {}) {
  const waiting = over.waiting ?? true;
  const api = fakeApi({
    profiles: [profile("p1", "Work"), profile("p2", "School")],
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework"), space("s3", "p2", "Lectures")],
    items: {
      s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" }), item("i-build", "s1", { kind: "session", refId: "build", title: "Build" })],
      s2: [item("i-schema", "s2", { kind: "session", refId: "schema", title: "Schema" })],
      s3: [item("i-notes", "s3", { kind: "session", refId: "notes", title: "Notes" })],
    },
    sessions: [
      session("lead", "s1", { title: "Lead" }),
      session("build", "s1", { title: "Build", status: waiting ? "waiting_permission" : "idle", updatedAt: 10 }),
      session("schema", "s2", { title: "Schema", status: waiting ? "waiting_permission" : "idle", updatedAt: 5 }),
      session("notes", "s3", { title: "Notes", status: waiting ? "error" : "idle", updatedAt: 1, lastEventSeq: 4, seenSeq: 0 }),
    ],
    sessionEvents: waiting ? { build: [permit("build", "r1", "Remove build/?")], schema: [asks("schema", "q1")] } : {},
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().refreshAllItems();
  await store.getState().openItem("i-lead");
  render(<StoreContext.Provider value={store}><NeedsYou /></StoreContext.Provider>);
  return { api, store };
}
const section = () => screen.getByRole("region", { name: "Needs you" });
const rowNames = () => within(section()).getAllByRole("button", { name: / — / }).map((b) => b.getAttribute("aria-label"));
const answer = (title: string) => within(section()).getByRole("button", { name: `Answer ${title} here` });

describe("Needs you", () => {
  it("is not drawn at all while nothing waits", async () => {
    // THE MUTANT: draw the heading over an empty list — chrome for a state that is usually nothing.
    await mount({ waiting: false });
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });

  it("lists what waits from every space and profile, the longest-waiting first, then what failed", async () => {
    // THE MUTANT: the active space or profile only, and Homework's question and Lectures' failure
    // are invisible here.
    await mount();
    expect(rowNames()).toEqual([
      "Schema in Homework — waiting on you",
      "Build in Versed — waiting on you",
      "Notes in Lectures · School — error",
    ]);
  });

  it("names the profile only when it is not the one on screen", async () => {
    await mount();
    const where = within(section()).getAllByText(/Versed|Homework|Lectures/).map((el) => el.textContent);
    expect(where).toEqual(["Homework", "Versed", "Lectures · School"]);
  });

  it("opens a row's session in its own space", async () => {
    // THE MUTANT: a row that opens nothing, or the session in the room on screen.
    const { store } = await mount();
    fireEvent.click(within(section()).getByRole("button", { name: "Schema in Homework — waiting on you" }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
  });

  it("answers a permission in place, on that session's own request", async () => {
    // THE MUTANT: answer the session's first pending request rather than this card's — or answer it
    // on the session this window is looking at.
    const { api } = await mount();
    fireEvent.click(answer("Build"));
    expect(answer("Build")).toHaveAttribute("aria-expanded", "true");
    const card = await within(section()).findByRole("group", { name: "Permission request" });
    expect(card).toHaveTextContent("Remove build/?");
    fireEvent.click(within(card).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(api.calls).toContain("respondPermission:build:r1:deny"));
  });

  it("answers a question with one of its own options", async () => {
    const { api } = await mount();
    const answered: unknown[] = [];
    api.respondPermission = async (id, requestId, decision, answers) => { answered.push({ id, requestId, decision, answers }); };
    fireEvent.click(answer("Schema"));
    fireEvent.click(await within(section()).findByRole("button", { name: /SQLite/ }));
    await waitFor(() => expect(answered).toEqual([{ id: "schema", requestId: "q1", decision: "allow", answers: { "Which database?": "SQLite" } }]));
  });

  it("folds the card on Escape and answers nothing", async () => {
    // The cards deny on Escape. THE MUTANT: a card that still owns Escape here denies the request the
    // person only meant to look at.
    const { api } = await mount();
    fireEvent.click(answer("Build"));
    const card = await within(section()).findByRole("group", { name: "Permission request" });
    expect(within(card).queryByText("esc")).toBeNull();
    fireEvent.keyDown(within(card).getByRole("button", { name: "Allow" }), { key: "Escape" });
    await waitFor(() => expect(within(section()).queryByRole("group", { name: "Permission request" })).toBeNull());
    expect(answer("Build")).toHaveAttribute("aria-expanded", "false");
    expect(api.calls.some((c) => c.startsWith("respondPermission"))).toBe(false);
  });

  it("gives a failed row nothing to answer, and drops it once it is read", async () => {
    const { store } = await mount();
    expect(within(section()).queryByRole("button", { name: "Answer Notes here" })).toBeNull();
    const notes = store.getState().allSessions.notes!;
    act(() => store.setState({ allSessions: { ...store.getState().allSessions, notes: { ...notes, seenSeq: notes.lastEventSeq } } }));
    await waitFor(() => expect(rowNames()).toEqual(["Schema in Homework — waiting on you", "Build in Versed — waiting on you"]));
  });

  it("drops a row the moment its question is answered anywhere", async () => {
    const { store } = await mount();
    act(() => { store.getState().applySessionStatus("schema", "running"); store.getState().applySessionStatus("build", "running"); });
    expect(rowNames()).toEqual(["Notes in Lectures · School — error"]);
  });
});
