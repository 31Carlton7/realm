import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AppShell } from "../../App";
import { PageOverlay } from "../PageOverlay";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";

/**
 * Two spaces, an agent at work in each, and one that is not. The one that matters most is "Mail" in
 * the OTHER space: an agent you cannot see from where you are is the whole reason for a rail.
 */
const fixture = () => fakeApi({
  sessions: [
    session("waiting", "s1", { status: "waiting_permission", title: "Fix the build" }),
    session("idle", "s1", { status: "idle", title: "Old chat" }),
    session("mail", "s2", { status: "running", title: "Draft the mail" }),
  ],
  items: {
    s1: [
      item("i-waiting", "s1", { kind: "session" as const, refId: "waiting", title: "Fix the build" }),
      item("i-idle", "s1", { kind: "session" as const, refId: "idle", title: "Old chat" }),
    ],
    s2: [item("i-mail", "s2", { kind: "session" as const, refId: "mail", title: "Draft the mail" })],
  },
});

async function mountShell(api = fixture()) {
  const store = createAppStore(api);
  await store.getState().boot();
  /* The page overlay is a window-level surface, rendered beside the shell rather than inside it —
     mounted here too so the page test sees what the app does. */
  const r = render(<StoreContext.Provider value={store}><AppShell /><PageOverlay /></StoreContext.Provider>);
  return { store, api, ...r };
}

const rail = () => document.querySelector(".rail") as HTMLElement;
const railToggles = () => screen.getAllByRole("button", { name: /agents at work/ });

describe("the agents rail", () => {
  it("starts closed and inert, with the way in waiting in the top-right corner", async () => {
    await mountShell();
    /* Mounted but shut. `inert` is the half that matters: a closed column that still answered the
       keyboard would be a list of invisible buttons. */
    expect(rail()).not.toHaveAttribute("data-open");
    expect(rail()).toHaveAttribute("inert");
    expect(document.querySelector(".rail-corner")).not.toBeNull();
    // THE MUTANT: render the toggle only inside the rail. Closed, there would be no way back in.
    expect(railToggles()).toHaveLength(1);
    expect(railToggles()[0]).toHaveAccessibleName("Show agents at work (⌥⌘B)");
    expect(railToggles()[0]).toHaveAttribute("aria-expanded", "false");
  });

  it("opens from the corner, and the toggle MOVES into its head — one control at a time", async () => {
    const { store } = await mountShell();
    fireEvent.click(railToggles()[0]!);
    await waitFor(() => expect(store.getState().railOpen).toBe(true));
    expect(rail()).toHaveAttribute("data-open");
    expect(rail()).not.toHaveAttribute("inert");
    expect(document.querySelector(".rail-corner")).toBeNull();
    // Still exactly one, now inside the rail and offering the way out.
    expect(railToggles()).toHaveLength(1);
    expect(rail().contains(railToggles()[0]!)).toBe(true);
    expect(railToggles()[0]).toHaveAccessibleName("Hide agents at work (⌥⌘B)");
    // And it never borrows the left sidebar's name, which a test elsewhere counts on being unique.
    expect(screen.getAllByRole("button", { name: /(Hide|Show) sidebar/ })).toHaveLength(1);
  });

  it("lists the agents at work in EVERY space, in the Agents page's order, and nothing idle", async () => {
    const { store } = await mountShell();
    act(() => { void store.getState().toggleRail(); });
    await waitFor(() => expect(within(rail()).getByText("Draft the mail")).toBeInTheDocument());
    const groups = [...rail().querySelectorAll(".rail-group-label")].map((h) => h.textContent);
    expect(groups).toEqual(["Needs you", "Working"]);
    expect(within(rail()).getByText("Fix the build")).toBeInTheDocument();
    // The other space's agent names its space, since the rail is the only place it shows from here.
    expect(within(rail()).getByText("Homework")).toBeInTheDocument();
    expect(within(rail()).queryByText("Old chat")).toBeNull();
  });

  it("takes you to an agent in another space, and opens its session there", async () => {
    const { store } = await mountShell();
    act(() => { void store.getState().toggleRail(); });
    expect(store.getState().activeSpaceId).toBe("s1");
    fireEvent.click(await within(rail()).findByRole("button", { name: /Draft the mail/ }));
    /* THE MUTANT: switch space and stop. The space changes and nothing opens — the jump looks like it
       worked and leaves you hunting for the session in a sidebar. */
    await waitFor(() => expect(store.getState().activeSpaceId).toBe("s2"));
    await waitFor(() => {
      const open = store.getState().items.find((i) => i.refId === "mail");
      expect(open && JSON.stringify(store.getState().layout)).toContain(open!.id);
    });
    // The rail survives the switch — it is not in any space.
    expect(rail()).toHaveAttribute("data-open");
  });

  it("marks the session under the keyboard as the one you are in", async () => {
    const { store } = await mountShell();
    act(() => { void store.getState().toggleRail(); });
    await act(async () => { await store.getState().openItem("i-waiting"); });
    const row = await within(rail()).findByRole("button", { name: /Fix the build/ });
    await waitFor(() => expect(row).toHaveAttribute("aria-current", "true"));
    expect(within(rail()).getByRole("button", { name: /Draft the mail/ })).not.toHaveAttribute("aria-current");
  });

  it("says plainly when nothing is at work, rather than listing history", async () => {
    const { store } = await mountShell(fakeApi({
      sessions: [session("idle", "s1", { status: "idle", title: "Old chat" })],
      items: { s1: [item("i-idle", "s1", { kind: "session" as const, refId: "idle", title: "Old chat" })] },
    }));
    act(() => { void store.getState().toggleRail(); });
    await waitFor(() => expect(within(rail()).getByText("No agent is working right now.")).toBeInTheDocument());
    expect(rail().querySelector(".rail-count")).toBeNull();
  });
});

describe("a page opened over the panes", () => {
  it("carries the sidebar's live width and stops short of the open rail", async () => {
    const { store } = await mountShell();
    /* THE BUG this closes: the overlay is portalled to <body>, and `--sidebar-w` was only ever
       painted on `.app`, so a page read the stylesheet's 280px default however wide the sidebar
       had been dragged — sitting under the column, or leaving a gap beside it. */
    act(() => { store.setState({ sidebarWidth: 333 }); });
    act(() => { store.getState().openSpacePage("s1"); });
    const page = await waitFor(() => {
      const el = document.querySelector(".page-overlay") as HTMLElement | null;
      if (!el) throw new Error("no page overlay");
      return el;
    });
    expect(page.style.getPropertyValue("--sidebar-w")).toBe("333px");
    expect(page).not.toHaveAttribute("data-rail-open");
    act(() => { void store.getState().toggleRail(); });
    await waitFor(() => expect(page).toHaveAttribute("data-rail-open"));
  });
});
