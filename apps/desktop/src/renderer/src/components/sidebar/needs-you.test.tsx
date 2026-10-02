import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { NeedsYou } from "./NeedsYou";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session, space } from "../../state/store.test-fakes";

/**
 * "N need you" (W11c): the count of sessions waiting on a permission or a question in any space, in
 * the sidebar's head band, and a list that answers each card where it stands. Every test names the
 * one-line change that would make it fail.
 */

beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const permit = (sessionId: string, requestId: string, title: string) =>
  ({ seq: 1, sessionId, event: sessionEvent("permission_request", { requestId, toolName: "Bash", input: { command: "rm -rf build" }, title, suggestions: [] }) });
const asks = (sessionId: string, requestId: string) =>
  ({ seq: 1, sessionId, event: sessionEvent("permission_request", { requestId, toolName: "AskUserQuestion", title: "Which database?", suggestions: [],
    input: { questions: [{ question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "Postgres" }, { label: "SQLite" }] }] } }) });

/** Versed holds the lead (idle) and "Build" (waiting on a permission); Homework holds "Schema"
 *  (waiting on a question). */
async function mount(over: { waiting?: boolean } = {}) {
  const waiting = over.waiting ?? true;
  const api = fakeApi({
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework")],
    items: {
      s1: [item("i-lead", "s1", { kind: "session", refId: "lead", title: "Lead" }), item("i-build", "s1", { kind: "session", refId: "build", title: "Build" })],
      s2: [item("i-schema", "s2", { kind: "session", refId: "schema", title: "Schema" })],
    },
    sessions: [
      session("lead", "s1", { title: "Lead" }),
      session("build", "s1", { title: "Build", status: waiting ? "waiting_permission" : "idle", updatedAt: 10 }),
      session("schema", "s2", { title: "Schema", status: waiting ? "waiting_permission" : "idle", updatedAt: 5 }),
    ],
    sessionEvents: waiting ? { build: [permit("build", "r1", "Remove build/?")], schema: [asks("schema", "q1")] } : {},
  });
  const store = createAppStore(api);
  await store.getState().boot();
  await store.getState().openItem("i-lead");
  render(<StoreContext.Provider value={store}><NeedsYou /></StoreContext.Provider>);
  return { api, store };
}
const chip = () => screen.getByRole("button", { name: /need/ });
const list = async () => within(await screen.findByRole("dialog", { name: "Waiting on you" }));

describe("the need-you count", () => {
  it("is absent when no session in any space is waiting", async () => {
    // THE MUTANT: draw it at zero — a permanent "0 need you" is the dead chrome the head band bans.
    await mount({ waiting: false });
    expect(screen.queryByRole("button", { name: /need/ })).toBeNull();
  });

  it("counts the sessions waiting in every space, not just this one", async () => {
    // THE MUTANT: count the active space's sessions only, and Homework's question is invisible here.
    await mount();
    expect(chip()).toHaveAccessibleName("2 sessions need you");
    expect(chip()).toHaveTextContent("2 need you");
  });

  it("says it in the singular for one", async () => {
    const { store } = await mount();
    act(() => store.getState().applySessionStatus("schema", "running"));
    expect(chip()).toHaveAccessibleName("1 session needs you");
    expect(chip()).toHaveTextContent("1 needs you");
  });

  it("gives up its words, not its number, in a narrow sidebar", async () => {
    // THE MUTANT: keep the words at every width, and at the narrowest column they run under the
    // traffic lights.
    const { store } = await mount();
    act(() => store.setState({ sidebarWidth: 220 }));
    expect(chip()).toHaveTextContent(/^2$/);
    expect(chip()).toHaveAccessibleName("2 sessions need you");
  });

  it("goes away when the last card is answered", async () => {
    const { store } = await mount();
    act(() => { store.getState().applySessionStatus("schema", "running"); store.getState().applySessionStatus("build", "running"); });
    expect(screen.queryByRole("button", { name: /need/ })).toBeNull();
  });
});

describe("its list", () => {
  it("names each waiting session and its space, the longest-waiting first", async () => {
    await mount();
    fireEvent.click(chip());
    const l = await list();
    await waitFor(() => expect(l.getAllByRole("group", { name: /, in / }).map((g) => g.getAttribute("aria-label"))).toEqual(["Schema, in Homework", "Build, in Versed"]));
  });

  it("answers a permission in place, on that session's own request", async () => {
    // THE MUTANT: answer the session's first pending request rather than this card's — or answer it
    // on the session this window is looking at.
    const { api } = await mount();
    fireEvent.click(chip());
    const build = within(await (await list()).findByRole("group", { name: "Build, in Versed" }));
    const card = await build.findByRole("group", { name: "Permission request" });
    expect(card).toHaveTextContent("Remove build/?");
    fireEvent.click(within(card).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(api.calls).toContain("respondPermission:build:r1:deny"));
  });

  it("answers a question with one of its own options", async () => {
    const { api } = await mount();
    const answered: unknown[] = [];
    api.respondPermission = async (id, requestId, decision, answers) => { answered.push({ id, requestId, decision, answers }); };
    fireEvent.click(chip());
    const schema = within(await (await list()).findByRole("group", { name: "Schema, in Homework" }));
    fireEvent.click(await schema.findByRole("button", { name: /SQLite/ }));
    await waitFor(() => expect(answered).toEqual([{ id: "schema", requestId: "q1", decision: "allow", answers: { "Which database?": "SQLite" } }]));
  });

  it("goes to the session, in its own space, and closes", async () => {
    // THE MUTANT: a Go that only closes the list.
    const { store } = await mount();
    fireEvent.click(chip());
    fireEvent.click(await (await list()).findByRole("button", { name: "Go to Schema" }));
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Waiting on you" })).toBeNull());
  });

  it("closes on Escape without answering anything", async () => {
    // The cards deny on Escape. THE MUTANT: a list whose Escape reaches a card denies the request the
    // person only meant to look at.
    const { api } = await mount();
    fireEvent.click(chip());
    const card = await (await list()).findByRole("group", { name: "Permission request" });
    // Nor does the card offer Escape as Deny: in this list the key closes it.
    expect(within(card).queryByText("esc")).toBeNull();
    fireEvent.keyDown(within(card).getByRole("button", { name: "Allow" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Waiting on you" })).toBeNull());
    expect(api.calls.some((c) => c.startsWith("respondPermission"))).toBe(false);
  });
});
