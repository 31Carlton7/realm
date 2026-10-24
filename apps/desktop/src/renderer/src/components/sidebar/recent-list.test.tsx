import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Session } from "@realm/contracts";
import { Sidebar } from "./Sidebar";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, profile, session, space } from "../../state/store.test-fakes";

/**
 * The Recent lens (Plan 27): the profile's sessions by when they last moved, under day headings, each
 * naming its space and wearing its state. It replaces the chat feed, whose rows carried a status that
 * nothing styled. Every test names the one-line change that would make it fail.
 */

const DAY = 86_400_000;
const chat = (id: string, spaceId: string, at: number, over: Partial<Session> = {}): Session =>
  session(id, spaceId, { title: `chat ${id}`, activityAt: at, createdAt: at, ...over });

async function mount(sessions: Session[], extra: { archived?: string[] } = {}) {
  const spaces = [space("s1", "p1", "Work"), space("s2", "p1", "Homework"), space("s3", "p2", "Lectures")];
  const items: Record<string, ReturnType<typeof item>[]> = {};
  for (const s of sessions) (items[s.spaceId] ??= []).push(item(`i-${s.id}`, s.spaceId, { kind: "session", refId: s.id, title: s.title, archived: extra.archived?.includes(s.id) ?? false }));
  const api = fakeApi({ profiles: [profile("p1", "Work"), profile("p2", "School")], spaces, items, sessions, settings: { "ui.sidebarLens": "recent" } });
  const store = createAppStore(api);
  await store.getState().boot();
  const r = render(<StoreContext.Provider value={store}><Sidebar /></StoreContext.Provider>);
  await waitFor(() => expect(store.getState().sidebarLens).toBe("recent"));
  await waitFor(() => expect(api.calls).toContain("listAllItems"));
  return { api, store, ...r };
}

const recent = (container: HTMLElement) => container.querySelector<HTMLElement>(".sb-recent")!;
const rows = (container: HTMLElement) => [...recent(container).querySelectorAll(".item-row")].map((b) => b.getAttribute("aria-label"));

afterEach(() => cleanup());

describe("Recent", () => {
  it("lists every session of the profile, from every one of its spaces, the newest first", async () => {
    // THE MUTANT: the active space alone — Recent would answer "what is open here", which Spaces does.
    const now = Date.now();
    const { container } = await mount([chat("a", "s1", now - 3000), chat("b", "s2", now - 1000), chat("c", "s3", now)]);
    await waitFor(() => expect(rows(container)).toEqual(["chat b in Homework", "chat a in Work"]));
  });

  it("cuts them into days, under a heading for each", async () => {
    const now = Date.now();
    const { container } = await mount([chat("a", "s1", now), chat("b", "s1", now - 2 * DAY)]);
    await waitFor(() => expect(rows(container)).toHaveLength(2));
    const headings = [...recent(container).querySelectorAll(".sb-day > .group-label")].map((h) => h.textContent);
    expect(headings).toHaveLength(2);
    expect(headings[0]).toBe("Today");
  });

  it("names each card's space on a line of its own, so a long title never cuts it", async () => {
    const { container } = await mount([chat("a", "s2", Date.now(), { title: "A title long enough that it has to give way to something" })]);
    await waitFor(() => expect(within(recent(container)).getByText("Homework").closest(".sb-card-head")).not.toBeNull());
  });

  it("wears each row's state at its far end — the marks the feed never drew", async () => {
    const { container } = await mount([chat("a", "s1", Date.now(), { status: "running" }), chat("b", "s2", Date.now() - 1000, { status: "waiting_permission" })]);
    await waitFor(() => expect(rows(container)).toEqual(["chat a in Work — running", "chat b in Homework — needs permission"]));
    const marks = [...recent(container).querySelectorAll(".sb-card .item-trail .status-dot")].map((d) => d.getAttribute("data-status"));
    expect(marks).toEqual(["running", "waiting_permission"]);
  });

  it("leaves out what is put away and what is a sub-agent", async () => {
    const now = Date.now();
    const { container } = await mount(
      [chat("a", "s1", now), chat("old", "s1", now - 1000), chat("kid", "s1", now - 2000, { dispatchedBy: { kind: "agent_run", sessionId: "a" } })],
      { archived: ["old"] },
    );
    await waitFor(() => expect(rows(container)).toEqual(["chat a in Work"]));
  });

  it("opens a session in its own space", async () => {
    const { container, store } = await mount([chat("b", "s2", Date.now())]);
    const row = await within(recent(container)).findByRole("button", { name: "chat b in Homework" });
    fireEvent.click(row);
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
  });

  it("brings a session made from it into view, however far down the list was scrolled", async () => {
    // The owner, 10-23: "Fix creating a new session while in activity view mode." A new session is the
    // newest card, so it lands at the very top of the list; scrolled down among older days, the card
    // you were on went dark and nothing you could see in the list said where the new one went.
    // THE MUTANT: RecentList without its scroll to the card handed the keyboard.
    const scrolled: Element[] = [];
    // jsdom has no layout, so no scrollIntoView of its own: record which element asked to be shown.
    const original = Element.prototype.scrollIntoView;
    onTestFinished(() => { Element.prototype.scrollIntoView = original; });
    Element.prototype.scrollIntoView = vi.fn(function (this: Element, arg?: boolean | ScrollIntoViewOptions) {
      expect(arg).toEqual({ block: "nearest" });
      scrolled.push(this);
    });
    const now = Date.now();
    const { container } = await mount([chat("a", "s1", now - 1000), chat("old", "s1", now - 9 * DAY)]);
    fireEvent.click(await within(recent(container)).findByRole("button", { name: "chat old in Work" }));
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const made = await within(recent(container)).findByRole("button", { name: "Fake agent session in Work" });
    await waitFor(() => expect(scrolled.at(-1)).toBe(made.closest(".sb-card")));
  });

  it("says the list is empty rather than drawing nothing", async () => {
    await mount([]);
    expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
  });
});
