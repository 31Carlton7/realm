import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, type SavedTurn } from "@realm/contracts";
import { LibraryPage } from "./LibraryPage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session, space } from "../../state/store.test-fakes";

const pageItem = (spaceId: string) =>
  item(`lib-${spaceId}`, spaceId, { kind: "library-page", title: "Library", refId: PAGE_REF_IDS["library-page"] });

const T = new Date(2026, 9, 5, 9, 30).getTime();
const turn = (over: Partial<SavedTurn> & Pick<SavedTurn, "sessionId" | "seq">): SavedTurn => ({
  savedAt: T, ts: T, text: "", attachments: [], goal: null, reply: null, sessionTitle: "Org access", spaceId: "s1", ...over,
});

/** Two sessions in two spaces of the Work profile, with three turns saved between them. */
async function mount() {
  const api = fakeApi({
    spaces: [space("s1", "p1", "Versed"), space("s2", "p1", "Homework")],
    items: {
      s1: [item("i-org", "s1", { kind: "session", refId: "se-org", title: "Org access" })],
      s2: [item("i-bill", "s2", { kind: "session", refId: "se-bill", title: "Billing split" })],
    },
    sessions: [session("se-org", "s1"), session("se-bill", "s2")],
    savedTurns: { "se-org": [11, 13], "se-bill": [21] },
    savedEntries: [
      turn({ sessionId: "se-bill", seq: 21, spaceId: "s2", sessionTitle: "Billing split", text: "Split the billing service\ninto reads and writes",
        reply: "## Here is the split:\n\n1. `billing/reads.ts` — invoices", savedAt: T + 300 }),
      turn({ sessionId: "se-org", seq: 13, text: "", attachments: ["/w/shots/crash.png"], savedAt: T + 200 }),
      turn({ sessionId: "se-org", seq: 11, text: "Fix the org access crash", reply: "Fixed — the check ran before the org loaded.", savedAt: T + 100 }),
    ],
  });
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><LibraryPage item={pageItem("s1")} visible /></StoreContext.Provider>);
  fireEvent.click(screen.getByRole("radio", { name: "Saved" }));
  await screen.findByRole("heading", { name: "Saved", level: 1 });
  return { api, store };
}

const cards = () => [...document.querySelectorAll<HTMLElement>(".saved-turn")];

describe("the Library's Saved section", () => {

  it("lists every saved turn across the profile's sessions, newest saved first: the prompt, its answer, whose it was", async () => {
    const { api } = await mount();
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(api.calls).toContain("librarySaved:p1");
    const read = cards().map((c) => [c.querySelector(".saved-turn-title")!.textContent, c.querySelector(".saved-turn-reply")?.textContent ?? null,
      c.querySelector(".saved-turn-where")!.textContent!.split(" · ").slice(0, 2).join(" · ")]);
    expect(read).toEqual([
      ["Split the billing service", "Here is the split:\nbilling/reads.ts — invoices", "Billing split · Homework"],
      ["crash.png", null, "Org access · Versed"],
      ["Fix the org access crash", "Fixed — the check ran before the org loaded.", "Org access · Versed"],
    ]);
  });

  it("opens a saved turn's session at that prompt", async () => {
    const { store } = await mount();
    await waitFor(() => expect(cards()).toHaveLength(3));
    fireEvent.click(within(cards()[0]!).getByRole("button", { name: /^Split the billing service/ }));
    await waitFor(() => expect(store.getState().promptFor).toMatchObject({ sessionId: "se-bill", seq: 21 }));
    // Its session is the one on screen now, brought from the other space.
    expect(store.getState().activeSpaceId).toBe("s2");
  });

  it("unsaves from the ribbon, and the turn leaves the list", async () => {
    const { api, store } = await mount();
    await waitFor(() => expect(cards()).toHaveLength(3));
    const ribbon = within(cards()[2]!).getByRole("button", { name: "Save turn: Fix the org access crash" });
    expect(ribbon).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(ribbon);
    await waitFor(() => expect(api.calls).toContain("setTurnSaved:se-org:11=false"));
    await waitFor(() => expect(cards()).toHaveLength(2));
    expect(store.getState().savedTurns["se-org"]).toEqual([13]);
  });

  it("drops a turn unsaved anywhere else — a track in this window or another", async () => {
    const { api, store } = await mount();
    await waitFor(() => expect(cards()).toHaveLength(3));
    api.data.savedTurns["se-bill"] = [];
    act(() => store.getState().applySavedTurns("se-bill", []));
    await waitFor(() => expect(cards()).toHaveLength(2));
  });

  it("says how to save one when nothing is saved", async () => {
    const { api, store } = await mount();
    await waitFor(() => expect(cards()).toHaveLength(3));
    api.data.savedTurns = {};
    act(() => store.getState().applySavedTurns("se-org", []));
    expect(await screen.findByText(/Nothing saved yet\. Point at a tick on the track/)).toBeInTheDocument();
  });
});
