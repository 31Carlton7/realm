import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Rail } from "./sidebar/Rail";
import { WhatsNewBridge, WhatsNewSheet } from "./WhatsNewSheet";
import { StoreContext, createAppStore, useApp } from "../state/store";
import { appCommands } from "../keys/commands";
import { fakeApi, type FakeData } from "../state/store.test-fakes";

const NEWS: WhatsNew = {
  version: "2.1.0",
  url: "https://realm.computer/changelog",
  notes: { version: "2.1.0", date: "2026-10-12", groups: [
    { title: "Teams", items: [[{ text: "A space can have a team." }]] },
    { title: "Sessions", items: [[{ text: "Unread sessions", strong: true }, { text: " show a bold title." }]] },
  ] },
};

let bridge: { notes: ReturnType<typeof vi.fn>; claim: ReturnType<typeof vi.fn>; seen: ReturnType<typeof vi.fn> };
function setBridge(owed: boolean, news: WhatsNew = NEWS) {
  bridge = { notes: vi.fn(async () => news), claim: vi.fn(async () => owed), seen: vi.fn(async () => {}) };
  (window as { realm?: unknown }).realm = { whatsNew: bridge };
}
beforeEach(() => setBridge(false));
afterEach(() => { cleanup(); delete (window as { realm?: unknown }).realm; });

/** The rail, the bridge that opens the sheet after an update, and the sheet when the store has it up. */
function Harness() {
  const open = useApp((s) => s.sheet?.kind === "whats-new");
  return <><Rail /><WhatsNewBridge />{open && <WhatsNewSheet />}</>;
}
async function mount(over: FakeData = {}) {
  const store = createAppStore(fakeApi(over));
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><Harness /></StoreContext.Provider>);
  return store;
}
const dialog = () => screen.findByRole("dialog", { name: "What's new" });

describe("What's new", () => {
  it("sits at the foot of the rail directly above the profile button, an icon with a name and a tooltip", async () => {
    await mount();
    const foot = document.querySelector(".rail-foot")!;
    const buttons = within(foot as HTMLElement).getAllByRole("button");
    const at = buttons.findIndex((b) => b.getAttribute("aria-label") === "What's new");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(buttons[at + 1]).toHaveAttribute("aria-haspopup", "menu"); // the person: their page and Settings
    expect(buttons[at + 1]).toBe(buttons[buttons.length - 1]);
    expect(buttons[at]).toHaveAttribute("title");
    expect(buttons[at]!.textContent).toBe("");
  });

  it("reopens the notes from the button: the icon, the version, the list and the changelog link", async () => {
    await mount();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    const sheet = await dialog();
    expect(sheet.querySelector("img.whats-new-icon")).not.toBeNull();
    expect(within(sheet).getByText("Realm 2.1.0")).toBeInTheDocument();
    expect(within(sheet).getByText("October 12, 2026")).toBeInTheDocument();
    expect(within(sheet).getByRole("heading", { name: "Teams" })).toBeInTheDocument();
    const items = within(sheet).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["A space can have a team.", "Unread sessions show a bold title."]);
    expect(within(sheet).getByText("Unread sessions").tagName).toBe("STRONG");
    const link = within(sheet).getByRole("link", { name: "Full changelog" });
    expect(link).toHaveAttribute("href", NEWS.url);
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("marks the version seen when it is closed", async () => {
    const store = await mount();
    fireEvent.click(screen.getByRole("button", { name: "What's new" }));
    fireEvent.click(within(await dialog()).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(store.getState().sheet).toBeNull());
    expect(bridge.seen).toHaveBeenCalledTimes(1);
  });

  it("opens on its own once after an update", async () => {
    setBridge(true);
    await mount();
    await dialog();
    expect(bridge.claim).toHaveBeenCalledTimes(1);
  });

  it("does not open on its own when main owes nothing", async () => {
    await mount();
    await waitFor(() => expect(bridge.claim).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not ask while first run is up — an update never lands there", async () => {
    setBridge(true);
    await mount({ spaces: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.claim).not.toHaveBeenCalled();
  });

  it("says so honestly when the changelog has no section for this version", async () => {
    setBridge(true, { ...NEWS, version: "2.1.2", notes: null });
    await mount();
    const sheet = await dialog();
    expect(within(sheet).getByText("Realm 2.1.2")).toBeInTheDocument();
    expect(within(sheet).queryByRole("list")).toBeNull();
    expect(within(sheet).getByText(/full changelog/)).toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: "Full changelog" })).toBeInTheDocument();
  });

  it("is a command, so Help ▸ What's New and a keybinding open it too", async () => {
    const store = await mount();
    appCommands(store)["app.whatsNew"]!();
    await dialog();
  });

  it("draws no button where there is no bridge to read the notes from", async () => {
    delete (window as { realm?: unknown }).realm;
    await mount();
    expect(screen.queryByRole("button", { name: "What's new" })).toBeNull();
  });
});
