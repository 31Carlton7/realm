import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NOTIFICATIONS_IPHONE_KEY, PAGE_REF_IDS, type PairRequest } from "@realm/contracts";
import { SettingsPage } from "./SettingsPage";
import { searchSettings } from "./settings-index";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, pairedPhone, remoteStatus, type FakeData } from "../../state/store.test-fakes";

const pageItem = item("set-s1", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] });

async function mount(overrides: FakeData = {}, page = "Devices") {
  const api = fakeApi(overrides);
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><SettingsPage item={pageItem} visible /></StoreContext.Provider>);
  fireEvent.click(screen.getByRole("radio", { name: page }));
  return { api, store };
}

/** The page once `remote.status` has landed. */
async function devices(overrides: FakeData = {}) {
  const mounted = await mount(overrides);
  await screen.findByRole("button", { name: "Pair an iPhone" });
  return mounted;
}

const phones = () => within(screen.getByRole("list", { name: "Paired iPhones" }));
const sheet = () => within(screen.getByRole("dialog"));
const request = (extra: Partial<PairRequest> = {}): PairRequest =>
  ({ requestId: "r1", windowId: "", name: "Carlton's iPhone", model: "iPhone18,1", ...extra });

/** Open the pairing sheet, and have a phone scan its code: the server's `remote.pairRequest`. */
async function asked(overrides: FakeData = {}) {
  const mounted = await devices(overrides);
  fireEvent.click(screen.getByRole("button", { name: "Pair an iPhone" }));
  await screen.findByRole("img", { name: "Pairing code" });
  const windowId = mounted.api.data.remote.pairing!.windowId;
  const req = request({ windowId });
  mounted.api.data.remoteRequests[req.requestId] = req;
  act(() => { mounted.store.getState().applyPairRequest(req); });
  await screen.findByRole("dialog", { name: "Pair Carlton's iPhone?" });
  return { ...mounted, req };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("Settings ▸ Devices", () => {
  it("is a page of its own in the You group, after Notifications, headed Devices", async () => {
    await mount();
    const you = within(screen.getByRole("group", { name: "You" })).getAllByRole("radio").map((r) => r.closest("label")!.textContent);
    expect(you).toEqual(["General", "Appearance", "Keys", "Notifications", "Devices"]);
    expect(screen.getByRole("heading", { name: "Devices", level: 1 })).toBeInTheDocument();
  });

  it("with no phone: the one action, a card saying what a phone would get, and nothing about the relay", async () => {
    const { api } = await devices();
    expect(api.calls).toContain("remoteStatus");
    expect(phones().getByText("No iPhone paired yet.")).toBeInTheDocument();
    expect(phones().getByText("A paired iPhone can read every session on this Mac and answer for you.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    // Nothing is opened at the relay until someone asks for a code.
    expect(api.calls).not.toContain("startRemotePairing");
  });

  it("says nothing about a link that is up, or has no reason to be", async () => {
    for (const state of ["connected", "off", "connecting"] as const) {
      await devices({ remote: remoteStatus({ state, phones: [pairedPhone("p1")] }) });
      expect(screen.queryByRole("alert"), state).toBeNull();
      cleanup();
    }
  });

  it("says when the relay can't be reached, in the plan's words", async () => {
    await devices({ remote: remoteStatus({ state: "offline", phones: [pairedPhone("p1")] }) });
    expect(screen.getByRole("alert")).toHaveTextContent("Can't reach the relay. Your phone shows this Mac as offline.");
  });

  it("…and with no phone yet, what that stops instead of a phone that does not exist", async () => {
    await devices({ remote: remoteStatus({ state: "offline" }) });
    expect(screen.getByRole("alert")).toHaveTextContent("Can't reach the relay, so a phone can't pair yet.");
  });

  it("says when Realm Mobile is locked, and holds back a Pair that could not open a window", async () => {
    await devices({ remote: remoteStatus({ state: "locked", phones: [pairedPhone("p1")] }) });
    expect(screen.getByRole("alert")).toHaveTextContent("Realm Mobile unlocks once Realm's window has been open since the agent server started.");
    expect(screen.getByRole("alert")).toHaveTextContent("Until then, your phone shows this Mac as offline.");
    expect(screen.getByRole("button", { name: "Pair an iPhone" })).toBeDisabled();
  });

  it("follows the status as it changes, with no refetch", async () => {
    const { store, api } = await devices();
    const reads = api.calls.filter((c) => c === "remoteStatus").length;
    act(() => { store.getState().applyRemoteChanged(remoteStatus({ state: "offline", phones: [pairedPhone("p1")] })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Can't reach the relay.");
    expect(phones().getByText("Carlton's iPhone")).toBeInTheDocument();
    act(() => { store.getState().applyRemoteChanged(remoteStatus({ state: "connected", phones: [pairedPhone("p1")] })); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api.calls.filter((c) => c === "remoteStatus").length).toBe(reads);
  });

  it("says a status it could not read, and reads it again on request", async () => {
    const { api } = await mount({ remoteError: "unknown method remote.status" });
    expect(await screen.findByText(/Realm Mobile's status could not be read: unknown method remote.status/)).toBeInTheDocument();
    // No Pair: a server that cannot say Realm Mobile exists has not offered it.
    expect(screen.queryByRole("button", { name: "Pair an iPhone" })).toBeNull();
    api.data.remoteError = null;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Pair an iPhone" })).toBeInTheDocument();
  });

  it("says once that a sleeping Mac is out of reach, and takes you to the setting that keeps it awake", async () => {
    await devices();
    expect(screen.getByText(/While this Mac sleeps, your phone can't reach it\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep the Mac awake while agents work" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "General" })).toBeChecked());
    await waitFor(() => expect(screen.getByRole("switch", { name: "Keep the Mac awake while agents work" })).toHaveFocus());
  });
});

describe("paired phones", () => {
  const now = Date.now();
  const two = [
    pairedPhone("p1", { name: "Carlton's iPhone", model: "iPhone18,1", lastSeen: now - 4 * 60_000 }),
    pairedPhone("p2", { name: "Test iPhone", model: "iPhone19,3", lastSeen: null, addedAt: now - 2 * 60 * 60_000 }),
  ];

  it("are a row each: name, model by its marketing name, and when it was last seen", async () => {
    await devices({ remote: remoteStatus({ state: "connected", phones: two }) });
    const rows = phones().getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Carlton's iPhone");
    expect(rows[0]).toHaveTextContent("iPhone 17 Pro · Last seen 4 min ago");
    // An identifier Realm has no name for is shown as it is; a phone never seen since says when it paired.
    expect(rows[1]).toHaveTextContent("iPhone19,3 · Paired 2 hours ago");
    expect(screen.queryByText("No iPhone paired yet.")).toBeNull();
    expect(screen.getByText(/While this Mac sleeps, your phones can't reach it\./)).toBeInTheDocument();
  });

  it("Remove asks first, naming the phone and what it loses — and only the confirm removes it", async () => {
    const { api } = await devices({ remote: remoteStatus({ state: "connected", phones: two }) });
    fireEvent.click(phones().getByRole("button", { name: "Remove Carlton's iPhone" }));
    // THE one-click mutant: remove on the row's own button.
    expect(api.calls.filter((c) => c.startsWith("removeRemotePhone"))).toEqual([]);
    const confirm = await screen.findByRole("dialog", { name: "Remove Carlton's iPhone?" });
    expect(confirm).toHaveTextContent("It will no longer see or answer sessions on this Mac.");
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.calls).toContain("removeRemotePhone:p1"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(phones().queryByText("Carlton's iPhone")).toBeNull();
    expect(phones().getByText("Test iPhone")).toBeInTheDocument();
    expect(api.data.remote.phones.map((p) => p.phoneId)).toEqual(["p2"]);
  });

  it("a broadcast while the question is up leaves the keyboard where it was", async () => {
    // The page re-renders on every status change and clock tick; a sheet whose close changed identity
    // with it would take the focus back to its top each time, out from under a person tabbing to Remove.
    const { store } = await devices({ remote: remoteStatus({ state: "connected", phones: two }) });
    fireEvent.click(phones().getByRole("button", { name: "Remove Carlton's iPhone" }));
    const remove = within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" });
    remove.focus();
    act(() => { store.getState().applyRemoteChanged(remoteStatus({ state: "connected", phones: two.map((p) => ({ ...p, lastSeen: Date.now() })) })); });
    expect(remove).toHaveFocus();
  });

  it("Keep it, Escape and the close all put the question away with the phone still paired", async () => {
    const { api } = await devices({ remote: remoteStatus({ state: "connected", phones: two }) });
    const ask = async () => {
      fireEvent.click(phones().getByRole("button", { name: "Remove Carlton's iPhone" }));
      return screen.findByRole("dialog", { name: "Remove Carlton's iPhone?" });
    };
    fireEvent.click(within(await ask()).getByRole("button", { name: "Keep it" }));
    fireEvent.keyDown(await ask(), { key: "Escape" });
    fireEvent.click(within(await ask()).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.calls.filter((c) => c.startsWith("removeRemotePhone"))).toEqual([]);
    expect(phones().getByText("Carlton's iPhone")).toBeInTheDocument();
  });
});

describe("pairing", () => {
  it("Pair an iPhone opens a window and a sheet with its code, the time left, and what to do", async () => {
    const { api } = await devices();
    fireEvent.click(screen.getByRole("button", { name: "Pair an iPhone" }));
    const dialog = await screen.findByRole("dialog", { name: "Pair an iPhone" });
    expect(api.calls).toContain("startRemotePairing");
    expect(within(dialog).getByRole("img", { name: "Pairing code" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Open Realm on your iPhone and scan this.");
    expect(within(dialog).getByText(/^Expires in (5:00|4:5\d)$/)).toBeInTheDocument();
  });

  it("draws the code dark on white in either face, with its quiet zone, the size a module three pixels wide makes", async () => {
    await devices();
    for (const mode of ["dark", "light"]) {
      document.documentElement.dataset.mode = mode;
      fireEvent.click(screen.getByRole("button", { name: "Pair an iPhone" }));
      const code = await screen.findByRole("img", { name: "Pairing code" });
      expect(code.querySelector("rect")!.getAttribute("fill")).toBe("#ffffff");
      expect(code.querySelector("path")!.getAttribute("fill")).toBe("#000000");
      // 85 modules, four of them quiet on each side, three pixels each.
      expect(code.getAttribute("viewBox")).toBe("0 0 85 85");
      expect(code.getAttribute("width")).toBe("255");
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    delete document.documentElement.dataset.mode;
  });

  it("counts the time left down", async () => {
    await devices();
    fireEvent.click(screen.getByRole("button", { name: "Pair an iPhone" }));
    const first = (await screen.findByText(/^Expires in /)).textContent;
    await waitFor(() => expect(screen.getByText(/^Expires in /).textContent).not.toBe(first), { timeout: 3000 });
  });

  it("takes the code away once it has run out, and offers a new one in its place", async () => {
    const { api } = await devices();
    fireEvent.click(screen.getByRole("button", { name: "Pair an iPhone" }));
    await screen.findByRole("img", { name: "Pairing code" });
    const later = Date.now() + 6 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    expect(await screen.findByText("This code has expired.", {}, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Pairing code" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show a new code" }));
    await waitFor(() => expect(api.calls.filter((c) => c === "startRemotePairing")).toHaveLength(2));
    expect(await screen.findByRole("img", { name: "Pairing code" })).toBeInTheDocument();
  });

  it("takes the code away when its window closes at the server — replaced by another window's code, say", async () => {
    const { store } = await devices();
    fireEvent.click(screen.getByRole("button", { name: "Pair an iPhone" }));
    await screen.findByRole("img", { name: "Pairing code" });
    act(() => { store.getState().applyRemoteChanged(remoteStatus({ state: "connected", pairing: { windowId: "elsewhere", url: "https://realm.computer/pair#1.x", expiresAt: Date.now() + 60_000 } })); });
    expect(screen.getByText("This code no longer works.")).toBeInTheDocument();
  });

  it("closing the sheet closes the window, so the code stops working", async () => {
    const { api } = await devices();
    fireEvent.click(screen.getByRole("button", { name: "Pair an iPhone" }));
    await screen.findByRole("img", { name: "Pairing code" });
    fireEvent.click(sheet().getByRole("button", { name: "Close" }));
    await waitFor(() => expect(api.calls).toContain("cancelRemotePairing"));
    expect(api.data.remote.pairing).toBeNull();
  });

  it("…but not a window another Realm window has opened since, which is not this sheet's to close", async () => {
    const { api, store } = await devices();
    fireEvent.click(screen.getByRole("button", { name: "Pair an iPhone" }));
    await screen.findByRole("img", { name: "Pairing code" });
    act(() => { store.getState().applyRemoteChanged(remoteStatus({ pairing: { windowId: "elsewhere", url: "https://realm.computer/pair#1.x", expiresAt: Date.now() + 60_000 } })); });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.calls).not.toContain("cancelRemotePairing");
  });

  it("leaving the page with the sheet up is closing it", async () => {
    const { api, store } = await devices();
    fireEvent.click(screen.getByRole("button", { name: "Pair an iPhone" }));
    await screen.findByRole("img", { name: "Pairing code" });
    // An opener moving the page elsewhere (a notification clicked, say): the panel unmounts.
    act(() => { store.getState().setSettingsPageTab("general"); });
    await waitFor(() => expect(api.calls).toContain("cancelRemotePairing"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("a phone asking to pair", () => {
  it("is asked in the sheet in place of the code: the phone, and what saying yes gives it", async () => {
    await asked();
    const dialog = screen.getByRole("dialog", { name: "Pair Carlton's iPhone?" });
    expect(dialog).toHaveTextContent("iPhone 17 Pro");
    expect(dialog).toHaveTextContent("It can read every session on this Mac and answer for you.");
    expect(within(dialog).queryByRole("img", { name: "Pairing code" })).toBeNull();
    // One sheet, not a second over the first.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("arrives without moving the keyboard onto an answer: no Return meant for the code can pair", async () => {
    await asked();
    const dialog = screen.getByRole("dialog", { name: "Pair Carlton's iPhone?" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Pair" })).not.toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).not.toHaveFocus();
  });

  it("Pair answers yes, closes the window, and the phone is a row once the server says so", async () => {
    const { api, store, req } = await asked();
    fireEvent.click(sheet().getByRole("button", { name: "Pair" }));
    await waitFor(() => expect(api.calls).toContain(`answerRemotePairing:${req.requestId}=true`));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(api.calls).toContain("cancelRemotePairing"));
    expect(store.getState().pairRequest).toBeNull();
    // The server's broadcast, carrying the phone the yes added.
    act(() => { store.getState().applyRemoteChanged(api.data.remote); });
    expect(phones().getByText("Carlton's iPhone")).toBeInTheDocument();
    expect(phones().getByText("iPhone 17 Pro · Last seen just now")).toBeInTheDocument();
  });

  it("Cancel answers no, and pairs nothing", async () => {
    const { api, req } = await asked();
    fireEvent.click(sheet().getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(api.calls).toContain(`answerRemotePairing:${req.requestId}=false`));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.data.remote.phones).toEqual([]);
    expect(api.calls).toContain("cancelRemotePairing");
  });

  it("a dismissal is never an answer: Escape, the close and the scrim leave the phone waiting, asked from the page", async () => {
    for (const dismiss of ["escape", "close", "scrim"] as const) {
      const { api, store, req } = await asked();
      const dialog = screen.getByRole("dialog");
      if (dismiss === "escape") fireEvent.keyDown(dialog, { key: "Escape" });
      if (dismiss === "close") fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      if (dismiss === "scrim") fireEvent.mouseDown(dialog.parentElement!);
      await waitFor(() => expect(screen.queryByRole("dialog"), dismiss).toBeNull());
      // THE mutant: Escape as Cancel. Neither an answer nor a closed window, which would decline it.
      expect(api.calls.filter((c) => c.startsWith("answerRemotePairing")), dismiss).toEqual([]);
      expect(api.calls, dismiss).not.toContain("cancelRemotePairing");
      expect(store.getState().pairRequest, dismiss).toEqual(req);
      // Still asked, where the page can answer it.
      const row = phones().getByRole("listitem", { name: "Carlton's iPhone is waiting to pair" });
      expect(row).toHaveTextContent("Pair Carlton's iPhone?");
      expect(row).toHaveTextContent("It can read every session on this Mac and answer for you.");
      cleanup();
    }
  });

  it("asked from the page, is the page's one accent: Pair an iPhone steps down beside it, and stays usable", async () => {
    await asked();
    expect(screen.getByRole("button", { name: "Pair an iPhone" })).toHaveClass("primary");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    const row = await phones().findByRole("listitem", { name: "Carlton's iPhone is waiting to pair" });
    expect(within(row).getByRole("button", { name: "Pair" })).toHaveClass("primary");
    // Two accents would be two equal calls to act. A new code is still how a question nobody wants is let go.
    const pair = screen.getByRole("button", { name: "Pair an iPhone" });
    expect(pair).not.toHaveClass("primary");
    expect(pair).not.toBeDisabled();
  });

  it("asked from the page, is answered there", async () => {
    const { api, req } = await asked();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    const row = await phones().findByRole("listitem", { name: "Carlton's iPhone is waiting to pair" });
    fireEvent.click(within(row).getByRole("button", { name: "Pair" }));
    await waitFor(() => expect(api.calls).toContain(`answerRemotePairing:${req.requestId}=true`));
    await waitFor(() => expect(phones().queryByRole("listitem", { name: "Carlton's iPhone is waiting to pair" })).toBeNull());
    // Answered, the window it came through closes too.
    await waitFor(() => expect(api.calls).toContain("cancelRemotePairing"));
  });

  it("an answer the server refused stays asked, so it can be given again", async () => {
    const { api, store, req } = await asked();
    delete api.data.remoteRequests[req.requestId];
    fireEvent.click(sheet().getByRole("button", { name: "Pair" }));
    await waitFor(() => expect(store.getState().toasts.some((t) => /no pair request/.test(t.text))).toBe(true));
    expect(store.getState().pairRequest).toEqual(req);
    expect(screen.getByRole("dialog", { name: "Pair Carlton's iPhone?" })).toBeInTheDocument();
    expect(sheet().getByRole("button", { name: "Pair" })).not.toBeDisabled();
  });

  it("is over once its window closes — answered in another window, expired or replaced", async () => {
    const { store } = await asked();
    act(() => { store.getState().applyRemoteChanged(remoteStatus({ state: "connected", phones: [pairedPhone("p9")] })); });
    expect(store.getState().pairRequest).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Pair Carlton's iPhone?" })).toBeNull();
    expect(screen.queryByRole("listitem", { name: "Carlton's iPhone is waiting to pair" })).toBeNull();
  });

  it("arriving with no sheet up — another Realm window's code — is asked from the page", async () => {
    const { store, api } = await devices({ remote: remoteStatus({ pairing: { windowId: "w-other", url: "https://realm.computer/pair#1.x", expiresAt: Date.now() + 60_000 } }) });
    api.data.remoteRequests.r2 = request({ requestId: "r2", windowId: "w-other", name: "Test iPhone" });
    act(() => { store.getState().applyPairRequest(api.data.remoteRequests.r2!); });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(phones().getByRole("listitem", { name: "Test iPhone is waiting to pair" })).toBeInTheDocument();
  });
});

describe("Notifications ▸ Notify my iPhone", () => {
  it("is not drawn while no phone is paired — there is nowhere for a push to go", async () => {
    await mount({}, "Notifications");
    await screen.findByRole("textbox", { name: "Slack webhook URL" });
    await screen.findByRole("switch", { name: "Permission requests" });
    // THE always-drawn mutant.
    expect(screen.queryByRole("switch", { name: "Notify my iPhone" })).toBeNull();
    expect(document.querySelector('[data-setting="relay-iphone"]')).toBeNull();
  });

  it("is drawn beside the iMessage and Slack rows once one is, on by default", async () => {
    await mount({ remote: remoteStatus({ state: "connected", phones: [pairedPhone("p1")] }) }, "Notifications");
    const sw = await screen.findByRole("switch", { name: "Notify my iPhone" });
    expect(sw).toBeChecked();
    // Beside the other two relays: the row after Slack's.
    const slack = screen.getByRole("textbox", { name: "Slack webhook URL" }).closest("li")!;
    expect(slack.nextElementSibling).toBe(sw.closest("li"));
    expect(sw.closest("li")).toHaveTextContent("Held while you're at this Mac, and sent if it's still waiting two minutes later.");
    // …and the note under the relays stops claiming the iPhone waits for Realm to be out of front.
    expect(screen.getByText("Texts and posts go only when Realm is not the app you are in.")).toBeInTheDocument();
    expect(screen.queryByText("Only when Realm is not the app you are in.")).toBeNull();
  });

  it("appears the moment a phone is paired, and goes when the last one is removed", async () => {
    const { store } = await mount({}, "Notifications");
    await screen.findByRole("switch", { name: "Permission requests" });
    act(() => { store.getState().applyRemoteChanged(remoteStatus({ state: "connected", phones: [pairedPhone("p1")] })); });
    expect(screen.getByRole("switch", { name: "Notify my iPhone" })).toBeInTheDocument();
    act(() => { store.getState().applyRemoteChanged(remoteStatus({ state: "off" })); });
    expect(screen.queryByRole("switch", { name: "Notify my iPhone" })).toBeNull();
  });

  it("reads and writes its own key", async () => {
    const { api } = await mount({ remote: remoteStatus({ phones: [pairedPhone("p1")] }), settings: { [NOTIFICATIONS_IPHONE_KEY]: false } }, "Notifications");
    const sw = await screen.findByRole("switch", { name: "Notify my iPhone" });
    expect(sw).not.toBeChecked();
    fireEvent.click(sw);
    await waitFor(() => expect(api.data.settings[NOTIFICATIONS_IPHONE_KEY]).toBe(true));
    expect(sw).toBeChecked();
  });

  it("is found by search only while it is drawn", async () => {
    expect(searchSettings("iphone").map((e) => e.id)).toEqual(["pair-iphone"]);
    expect(searchSettings("iphone", { phonesPaired: true }).map((e) => e.id)).toEqual(["relay-iphone", "pair-iphone"]);
    // …and the page's own search asks with what the store holds.
    await mount({ remote: remoteStatus({ phones: [pairedPhone("p1")] }) }, "General");
    await waitFor(() => expect(screen.getByRole("searchbox", { name: "Search settings" })).toBeInTheDocument());
    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "notify my iphone" } });
    expect(await screen.findByRole("button", { name: "Notify my iPhone, in Notifications" })).toBeInTheDocument();
  });
});
