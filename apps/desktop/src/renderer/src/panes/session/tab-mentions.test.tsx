import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { sessionEvent, type Layout, type TabCard, type TabEntry } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session, type FakeData } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";
import { rankTabs } from "./mention-sources";

/**
 * The space's panes in the prompter's `@` list, as cards beside the draft. What must die: a Tabs group
 * that lists a closed pane above the one on screen, a pick that leaves `@pri` in the text instead of a
 * card, a card whose × does nothing, a size that is never shown or a cut that is never said, a send
 * that drops the cards, and a sent card that opens nothing.
 */

const TABS: TabEntry[] = [
  { itemId: "ib1", kind: "browser", title: "Old docs", favicon: "", url: "https://docs.example.com/" },
  { itemId: "it1", kind: "terminal", title: "zsh", favicon: "" },
  { itemId: "ib2", kind: "browser", title: "Pricing", favicon: "", url: "http://127.0.0.1:4100/pricing" },
  { itemId: "id1", kind: "documents", title: "Documents", favicon: "", path: "/repo/notes.md" },
];
const card = (t: TabEntry, extra: Partial<TabCard> = {}): TabCard => ({ itemId: t.itemId, kind: t.kind, title: t.title, ...(t.url ? { url: t.url } : {}), bytes: 12_400, truncated: false, ...extra });
/** On screen: the session and Pricing; behind Pricing in its strip: the document. */
const LAYOUT: Layout = { type: "split", id: "root", dir: "row", sizes: [50, 50], children: [
  { type: "leaf", id: "L1", itemId: "i9" },
  { type: "leaf", id: "L2", itemId: "ib2", tabs: ["ib2", "id1"] },
] };

async function mount(extra: FakeData = {}) {
  const api = fakeApi({
    sessions: [session("se1", "s1", { status: "idle", agentKind: "claude", cwd: "/repo" })],
    items: { s1: [item("i9", "s1", { kind: "session", refId: "se1", title: "s" }), ...TABS.map((t) => item(t.itemId, "s1", { kind: t.kind, refId: `r-${t.itemId}`, title: t.title }))] },
    spaceTabs: { se1: TABS },
    tabCards: { ib2: card(TABS[2]!), id1: card(TABS[3]!, { bytes: 40_000, truncated: true }), ib1: card(TABS[0]!, { bytes: 20_000 }), it1: card(TABS[1]!, { bytes: 900 }) },
    ...extra,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  store.setState({ layout: LAYOUT, sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 0, t: reduceAll([]) } } });
  const r = render(<StoreContext.Provider value={store}><SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "s" })} visible /></StoreContext.Provider>);
  await act(async () => { await new Promise((res) => setTimeout(res, 1)); });
  return { api, store, ...r };
}

const box = () => screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
const type = async (value: string) => {
  fireEvent.change(box(), { target: { value } });
  await act(async () => { await new Promise((res) => setTimeout(res, 0)); });
};
const picker = () => screen.queryByRole("listbox", { name: "Mentions" });
const names = () => Array.from(picker()?.querySelectorAll("[role=option] .mention-row-name") ?? []).map((el) => el.textContent);
const option = (name: string) => Array.from(picker()!.querySelectorAll<HTMLElement>("[role=option]")).find((el) => el.querySelector(".mention-row-name")?.textContent === name)!;
const cards = () => screen.queryByRole("list", { name: "Tabs" });
const cardLines = () => Array.from(cards()?.querySelectorAll(".attach-card-text") ?? []).map((el) => el.textContent);

describe("the @ list's Tabs", () => {
  it("lists the space's panes under Tabs, the ones on screen and open first, after one row for all the open ones", async () => {
    await mount();
    await type("@");
    await waitFor(() => expect(names()).toContain("Pricing"));
    const heads = Array.from(picker()!.querySelectorAll(".mention-head")).map((el) => el.textContent);
    expect(heads).toContain("Tabs");
    const tabRows = names().filter((n) => ["All open tabs", "Old docs", "zsh", "Pricing", "Documents"].includes(n!));
    // THE MUTANT: the server's order kept — a closed tab above the one on screen.
    expect(tabRows).toEqual(["All open tabs", "Pricing", "Documents", "Old docs", "zsh"]);
    // A row says what the pane is: a page by its address, a document by its file.
    expect(option("Pricing").querySelector(".mention-row-desc")?.textContent).toBe("127.0.0.1:4100/pricing");
    expect(option("All open tabs").querySelector(".mention-row-desc")?.textContent).toBe("2 tabs");
  });

  it("ranks on screen, then open behind a tab or off screen with its session, then the rest", () => {
    const off = rankTabs(TABS, { type: "leaf", id: "L", itemId: "it1" }, { i8: { tabs: ["ib1"], itemId: "ib1" } });
    expect(off.map((t) => [t.itemId, t.open])).toEqual([["it1", true], ["ib1", true], ["ib2", false], ["id1", false]]);
  });

  it("finds a tab by a word of its title or its address", async () => {
    await mount();
    await type("@pric");
    await waitFor(() => expect(names()[0]).toBe("Pricing"));
    await type("@docs.ex");
    await waitFor(() => expect(names()[0]).toBe("Old docs"));
  });
});

describe("a picked tab is a card beside the draft", () => {
  it("takes the @ out of the text, shows the card with its size, and × takes it away", async () => {
    const { api } = await mount();
    await type("look at @pric");
    await waitFor(() => expect(names()[0]).toBe("Pricing"));
    fireEvent.click(option("Pricing"));
    // THE MUTANT: the pick inserted as `@[Pricing]` — raw text, not a card.
    expect(box().value).toBe("look at ");
    await waitFor(() => expect(cardLines()).toEqual(["Pricing12 KB"]));
    expect(api.calls).toContain("previewTab:ib2");
    // THE MUTANT: a × that removes nothing.
    fireEvent.click(within(cards()!).getByRole("button", { name: "Remove Pricing" }));
    expect(cards()).toBeNull();
  });

  it("All open tabs puts a card for each open pane, and says which will be cut or are large", async () => {
    await mount();
    await type("@");
    await waitFor(() => expect(names()).toContain("All open tabs"));
    fireEvent.click(option("All open tabs"));
    // THE MUTANT: no flag — a 40 KB document sent cut, and nothing before the send says so.
    await waitFor(() => expect(cardLines()).toEqual(["Pricing12 KB", "Documents39 KB · Cut to fit"]));
    expect(cards()!.querySelector("[data-flag=truncated]")).not.toBeNull();
    expect(cards()!.querySelector(".attach-tip-detail")?.textContent).toBe("Too long to send whole: the agent gets its first 32,000 characters.");
  });

  it("calls a card over the large line Large, and a pane that could not be read Closed", async () => {
    await mount({ tabCards: { ib1: card(TABS[0]!, { bytes: 20_000 }) } });
    await type("@old");
    await waitFor(() => expect(names()[0]).toBe("Old docs"));
    fireEvent.click(option("Old docs"));
    await waitFor(() => expect(cardLines()).toEqual(["Old docs20 KB · Large"]));
    await type("@zsh");
    await waitFor(() => expect(names()[0]).toBe("zsh"));
    fireEvent.click(option("zsh"));
    await waitFor(() => expect(cardLines()).toEqual(["Old docs20 KB · Large", "zshClosed"]));
  });

  it("sends the cards with the message, and a card alone is enough to send", async () => {
    const { api, store } = await mount();
    await type("@pric");
    await waitFor(() => expect(names()[0]).toBe("Pricing"));
    fireEvent.click(option("Pricing"));
    await waitFor(() => expect(cardLines()).toEqual(["Pricing12 KB"]));
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    // THE MUTANT: the send that leaves `tabs` off the wire.
    await waitFor(() => expect(api.sent.at(-1)?.tabs).toEqual([{ itemId: "ib2", kind: "browser", title: "Pricing" }]));
    expect(store.getState().draftTabs.se1).toEqual([]);
  });
});

describe("a sent message's cards", () => {
  const sent = (tabs: TabCard[]) => reduceAll([sessionEvent("user_message", { text: "what does this say", attachments: [], tabs })]);

  it("draw on the message, and a click goes to the pane", async () => {
    const { store } = await mount();
    const openItem = vi.fn(async () => {});
    act(() => store.setState({ openItem, transcripts: { se1: { lastSeq: 1, t: sent([card(TABS[2]!)]) } } }));
    const row = await screen.findByRole("list", { name: "Tabs" });
    expect(row.closest(".msg-user-row")).not.toBeNull();
    expect(row.querySelector(".attach-card-text")?.textContent).toBe("Pricing127.0.0.1:4100/pricing · 12 KB");
    fireEvent.click(within(row).getByRole("button", { name: "Open Pricing" }));
    // THE MUTANT: a card that is only a picture of a link.
    await waitFor(() => expect(openItem).toHaveBeenCalledWith("ib2"));
  });

  it("say the pane is closed when it is gone", async () => {
    const { store } = await mount();
    const openItem = vi.fn(async () => {});
    act(() => store.setState({ openItem, transcripts: { se1: { lastSeq: 1, t: sent([{ itemId: "gone", kind: "terminal", title: "build", bytes: 300, truncated: false }]) } } }));
    const row = await screen.findByRole("list", { name: "Tabs" });
    fireEvent.click(within(row).getByRole("button", { name: "Open build" }));
    await waitFor(() => expect(store.getState().toasts.at(-1)?.text).toBe("build is closed."));
    expect(openItem).not.toHaveBeenCalled();
  });
});
