import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, prAccountKey, type GhAccounts, type GhStatus } from "@realm/contracts";

/** The row's calls, answered from what each test sets, and every one kept. Nothing reaches a socket
 *  — and so nothing reaches gh, or GitHub. */
const calls: { method: string; params: any }[] = [];
let gh: GhAccounts = { accounts: ["carlton", "Mara"], active: "carlton" };
/** Set, gh's list of accounts waits on it — the moment the row has asked and not heard. */
let gate: Promise<void> | null = null;
/** Set, the socket refuses every call: no preload, or a server that has gone. */
let down = false;
/** Set, gh's list alone cannot be read: gh timing out, with the server still there. */
let deaf = false;
/** Set, the store's answer about a pick waits on it — the moment a pick has been asked for and not read. */
let reading: Promise<void> | null = null;
/** Each pick waits on the next of these before gh takes it — picks that are still asking gh about
 *  their accounts, answered in whatever order a test lets them go. */
let taking: Promise<void>[] = [];
let stored: Record<string, unknown> = {};
/** What the row listens for from the server, and `tell` to say it. */
const heard = new Map<string, Set<(payload: any) => void>>();
const tell = (event: string, payload: unknown) => { for (const fn of [...(heard.get(event) ?? [])]) fn(payload); };
vi.mock("../../rpc/client", () => ({
  rpc: () => ({
    on: (event: string, fn: (payload: any) => void) => {
      if (!heard.has(event)) heard.set(event, new Set());
      heard.get(event)!.add(fn);
      return () => { heard.get(event)?.delete(fn); };
    },
    call: async (method: string, params: any) => {
      calls.push({ method, params });
      if (down) throw new Error("the server is not answering");
      switch (method) {
        case "codeReview.accounts":
          if (gate) await gate;
          if (deaf) throw new Error("GitHub took too long to answer");
          return gh;
        case "settings.get": {
          const value = stored[params.key] ?? null;
          if (reading) await reading;
          return { value };
        }
        case "codeReview.setAccount": {
          const wait = taking.shift();
          if (wait) await wait;
          if (down) throw new Error("the server is not answering");
          const known = params.login === null ? null : gh.accounts.find((a) => a.toLowerCase() === params.login.toLowerCase());
          if (known === undefined) throw Object.assign(new Error(`gh is not signed in to GitHub as @${params.login}.`), { code: "GH_ACCOUNT_UNKNOWN" });
          stored[prAccountKey(params.profileId)] = known;
          const status: GhStatus = known === null ? { state: "ready", login: gh.active, reason: null } : { state: "ready", login: known, reason: null, account: known };
          return status;
        }
        default: throw new Error(`unexpected ${method}`);
      }
    },
  }),
}));

import { SettingsPage } from "./SettingsPage";
import { searchSettings } from "./settings-index";
import { forgetHeld, holdStatus, pageHeld, signInSent } from "../code-review/held";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, profile, type FakeData } from "../../state/store.test-fakes";

const pageItem = item("set-s1", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] });
const ACTIVE = "gh's active account";
const NONE = "gh lists no accounts to choose from on this Mac.";
const NOTE = "Realm reads pull requests, posts reviews, and opens pull requests as this account. The account gh uses in a terminal stays the same.";

beforeEach(() => {
  forgetHeld();
  calls.length = 0;
  gh = { accounts: ["carlton", "Mara"], active: "carlton" };
  gate = null;
  down = false;
  deaf = false;
  reading = null;
  taking = [];
  stored = {};
  heard.clear();
});

/** Settings on General, in a window whose profiles are Work (p1) and School (p2) unless a test says. */
async function general(overrides: FakeData = {}) {
  const store = createAppStore(fakeApi(overrides));
  await store.getState().boot();
  const { unmount } = render(<StoreContext.Provider value={store}><SettingsPage item={pageItem} visible /></StoreContext.Provider>);
  return { store, unmount };
}
const row = () => document.querySelector<HTMLDetailsElement>('details[data-setting="github-account"]')!;
const folded = () => row().querySelector(".settings-row-desc")?.textContent ?? null;
const body = () => row().querySelector(".settings-disclosure-body");
const account = (name: string) => screen.getByRole("combobox", { name: `GitHub account for ${name}` }) as HTMLSelectElement;
const options = (name: string) => [...account(name).options].map((o) => o.textContent);
const called = (method: string) => calls.filter((c) => c.method === method);
/** Open the row, the way a person does, and wait for gh's answer to be drawn. */
async function opened(overrides: FakeData = {}) {
  const mounted = await general(overrides);
  fireEvent.click(row().querySelector("summary")!);
  await waitFor(() => expect(body()).not.toBeNull());
  if (!gate) await waitFor(() => expect(called("codeReview.accounts").length).toBeGreaterThan(0));
  await act(async () => { await Promise.resolve(); });
  return mounted;
}
const hold = () => { let go!: () => void; const wait = new Promise<void>((resolve) => { go = resolve; }); return { wait, go }; };

describe("GitHub account — folded, it says what is stored and asks gh nothing", () => {
  it("names each profile's account from what is stored, and does not ask gh for its accounts", async () => {
    stored = { [prAccountKey("p1")]: "Mara" };
    await general();
    await waitFor(() => expect(folded()).toBe(`Work: @Mara · School: ${ACTIVE}`));
    expect(row().open).toBe(false);
    expect(row().querySelector(".settings-row-name")!.textContent).toBe("Account for each profile");
    expect(called("codeReview.accounts")).toEqual([]);
    expect(body()).toBeNull();
  });

  it("says the one profile's account without naming the profile, where there is no other to tell it from", async () => {
    await general({ profiles: [profile("p1", "Work")] });
    await waitFor(() => expect(folded()).toBe(ACTIVE));
    expect(row().querySelector(".settings-row-name")!.textContent).toBe("Account");
  });

  it("reads anything stored that is not a login as no pick", async () => {
    stored = { [prAccountKey("p1")]: 7, [prAccountKey("p2")]: "" };
    await general();
    await waitFor(() => expect(called("settings.get").length).toBeGreaterThanOrEqual(2));
    await act(async () => { await Promise.resolve(); });
    expect(folded()).toBe(`Work: ${ACTIVE} · School: ${ACTIVE}`);
  });

  it("follows a pick announced from elsewhere, reading that profile's again and no other's", async () => {
    await general();
    await waitFor(() => expect(folded()).toBe(`Work: ${ACTIVE} · School: ${ACTIVE}`));
    const before = called("settings.get").length;
    stored = { [prAccountKey("p2")]: "Mara" };
    await act(async () => { tell("codeReview.accountChanged", { profileId: "p2" }); });
    await waitFor(() => expect(folded()).toBe(`Work: ${ACTIVE} · School: @Mara`));
    expect(called("settings.get").slice(before).map((c) => c.params.key)).toEqual([prAccountKey("p2")]);
    expect(called("codeReview.accounts")).toEqual([]);
  });

  it("stops listening when Settings is put away", async () => {
    const { unmount } = await general();
    expect(heard.get("codeReview.accountChanged")?.size).toBe(1);
    unmount();
    expect(heard.get("codeReview.accountChanged")?.size ?? 0).toBe(0);
  });

  it("stands under its own heading after Files, where the other things Realm opens elsewhere are set", async () => {
    await general();
    const heads = [...document.querySelectorAll(".settings-head")].map((h) => h.textContent);
    expect(heads.indexOf("GitHub")).toBe(heads.indexOf("Files") + 1);
    expect(row().closest(".settings-group")!.previousElementSibling!.textContent).toBe("GitHub");
  });

  it("is found by a search for gh, and the result opens the row and asks gh", async () => {
    await general();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search settings" }), { target: { value: "gh" } });
    fireEvent.click(within(screen.getByRole("list", { name: "Matching settings" })).getByRole("button", { name: "Account, in General ▸ GitHub" }));
    await waitFor(() => expect(row().open).toBe(true));
    await waitFor(() => expect(row().querySelector("summary")).toHaveFocus());
    expect(row()).toHaveAttribute("data-found");
    await waitFor(() => expect(options("Work")).toContain("@Mara"));
  });

  it("is found by the words for what it does, and leaves a search for login to the rows that sign an agent in", () => {
    expect(searchSettings("gh").map((e) => e.id)).toEqual(["github-account"]);
    expect(searchSettings("accounts").map((e) => e.id)).toEqual(["github-account"]);
    expect(searchSettings("pull request").map((e) => e.id)).toContain("github-account");
    expect(searchSettings("login").map((e) => e.id)).not.toContain("github-account");
  });
});

describe("GitHub account — opened, each profile picks from gh's accounts", () => {
  it("asks gh for its accounts afresh once it is opened, and gives every profile a select that starts on the account gh has active, saying whose that is", async () => {
    gh = { accounts: ["carlton", "Mara"], active: "Mara" };
    await opened();
    await waitFor(() => expect(options("Work")).toEqual([`${ACTIVE} (@Mara)`, "@carlton", "@Mara"]));
    expect(options("School")).toEqual([`${ACTIVE} (@Mara)`, "@carlton", "@Mara"]);
    expect(account("Work").value).toBe("");
    expect(called("codeReview.accounts").map((c) => c.params)).toEqual([{ force: true }]);
    expect([...row().querySelectorAll(".gh-accounts > .settings-row-name")].map((n) => n.textContent)).toEqual(["Work", "School"]);
    expect(body()!.textContent).toContain(NOTE);
    expect(folded()).toBeNull();
  });

  it("names nobody in the first option where gh has no account active", async () => {
    gh = { accounts: ["carlton", "Mara"], active: null };
    await opened();
    await waitFor(() => expect(options("Work")).toEqual([ACTIVE, "@carlton", "@Mara"]));
  });

  it("gives the one profile its select alone, without a name beside it, in the wrapper that holds it to the row's width", async () => {
    await opened({ profiles: [profile("p1", "Work")] });
    await waitFor(() => expect(options("Work")).toEqual([`${ACTIVE} (@carlton)`, "@carlton", "@Mara"]));
    expect(row().querySelector(".gh-accounts")).toBeNull();
    expect(body()!.querySelector(".settings-row-name")).toBeNull();
    expect(account("Work").parentElement).toHaveClass("gh-account");
  });

  it("shows each profile the pick stored for it, spelled as gh spells the account", async () => {
    stored = { [prAccountKey("p2")]: "mara" };
    await opened();
    await waitFor(() => expect(account("School").value).toBe("Mara"));
    expect(account("Work").value).toBe("");
    expect(options("School")).toEqual([`${ACTIVE} (@carlton)`, "@carlton", "@Mara"]);
  });

  it("sends a pick for the row's own profile, and reads what was stored once gh has taken it", async () => {
    await opened();
    await waitFor(() => expect(options("School")).toContain("@Mara"));
    const before = called("settings.get").length;
    fireEvent.change(account("School"), { target: { value: "Mara" } });
    await waitFor(() => expect(called("codeReview.setAccount").map((c) => c.params)).toEqual([{ profileId: "p2", login: "Mara" }]));
    await waitFor(() => expect(called("settings.get").slice(before).map((c) => c.params.key)).toEqual([prAccountKey("p2")]));
    expect(account("School").value).toBe("Mara");
    expect(account("Work").value).toBe("");
  });

  it("takes a pick back as null when gh's active account is chosen again", async () => {
    stored = { [prAccountKey("p1")]: "Mara" };
    await opened();
    await waitFor(() => expect(account("Work").value).toBe("Mara"));
    fireEvent.change(account("Work"), { target: { value: "" } });
    await waitFor(() => expect(called("codeReview.setAccount").map((c) => c.params)).toEqual([{ profileId: "p1", login: null }]));
    await waitFor(() => expect(stored[prAccountKey("p1")]).toBeNull());
    expect(account("Work").value).toBe("");
  });

  it("shows a pick the moment it is made, while gh is still being asked about the account", async () => {
    const asking = hold();
    await opened();
    await waitFor(() => expect(options("Work")).toContain("@Mara"));
    taking = [asking.wait];
    fireEvent.change(account("Work"), { target: { value: "Mara" } });
    expect(account("Work").value).toBe("Mara");
    expect(stored[prAccountKey("p1")]).toBeUndefined();
    await act(async () => { asking.go(); });
    await waitFor(() => expect(stored[prAccountKey("p1")]).toBe("Mara"));
  });

  it("keeps the last pick on the row while an earlier one is answered and announced, and reads the store when both are", async () => {
    const first = hold(), second = hold();
    await opened();
    await waitFor(() => expect(options("Work")).toContain("@Mara"));
    taking = [first.wait, second.wait];
    fireEvent.change(account("Work"), { target: { value: "Mara" } });
    fireEvent.change(account("Work"), { target: { value: "carlton" } });
    await act(async () => { first.go(); });
    await waitFor(() => expect(stored[prAccountKey("p1")]).toBe("Mara"));
    await act(async () => { tell("codeReview.accountChanged", { profileId: "p1" }); });
    await act(async () => { await Promise.resolve(); });
    expect(account("Work").value).toBe("carlton");
    const before = called("settings.get").length;
    await act(async () => { second.go(); });
    await waitFor(() => expect(stored[prAccountKey("p1")]).toBe("carlton"));
    await waitFor(() => expect(called("settings.get").slice(before).map((c) => c.params.key)).toEqual([prAccountKey("p1")]));
    expect(account("Work").value).toBe("carlton");
  });

  it("does not let the read that follows an answer put back a pick made since", async () => {
    const answer = hold(), next = hold();
    await opened();
    await waitFor(() => expect(options("Work")).toContain("@Mara"));
    reading = answer.wait;
    fireEvent.change(account("Work"), { target: { value: "Mara" } });
    await waitFor(() => expect(stored[prAccountKey("p1")]).toBe("Mara"));
    await waitFor(() => expect(called("settings.get").at(-1)!.params.key).toBe(prAccountKey("p1")));
    taking = [next.wait];
    fireEvent.change(account("Work"), { target: { value: "carlton" } });
    reading = null;
    await act(async () => { answer.go(); });
    await act(async () => { await Promise.resolve(); });
    expect(account("Work").value).toBe("carlton");
    await act(async () => { next.go(); });
    await waitFor(() => expect(stored[prAccountKey("p1")]).toBe("carlton"));
    expect(account("Work").value).toBe("carlton");
  });

  it("does not let that read put back what was read before, either, when it fails", async () => {
    const next = hold();
    let fail!: (e: Error) => void;
    await opened();
    await waitFor(() => expect(options("Work")).toContain("@Mara"));
    reading = new Promise<void>((_, reject) => { fail = reject; });
    fireEvent.change(account("Work"), { target: { value: "Mara" } });
    await waitFor(() => expect(stored[prAccountKey("p1")]).toBe("Mara"));
    await waitFor(() => expect(called("settings.get").at(-1)!.params.key).toBe(prAccountKey("p1")));
    taking = [next.wait];
    fireEvent.change(account("Work"), { target: { value: "carlton" } });
    reading = null;
    await act(async () => { fail(new Error("the server is not answering")); });
    await act(async () => { await Promise.resolve(); });
    expect(account("Work").value).toBe("carlton");
    await act(async () => { next.go(); });
    await waitFor(() => expect(stored[prAccountKey("p1")]).toBe("carlton"));
    expect(account("Work").value).toBe("carlton");
  });

  it("puts the row back to what is stored when gh refuses the pick, says why, and lists the accounts again", async () => {
    stored = { [prAccountKey("p1")]: "carlton" };
    const { store } = await opened();
    await waitFor(() => expect(account("Work").value).toBe("carlton"));
    gh = { accounts: ["carlton"], active: "carlton" };
    fireEvent.change(account("Work"), { target: { value: "Mara" } });
    await waitFor(() => expect(store.getState().toasts.map((t) => t.text)).toEqual(["gh is not signed in to GitHub as @Mara."]));
    await waitFor(() => expect(options("Work")).toEqual([`${ACTIVE} (@carlton)`, "@carlton"]));
    expect(account("Work").value).toBe("carlton");
    expect(called("codeReview.accounts").map((c) => c.params.force)).toEqual([true, true]);
  });

  it("goes on sending picks after one gh refused", async () => {
    const { store } = await opened();
    await waitFor(() => expect(options("Work")).toContain("@Mara"));
    gh = { accounts: ["carlton"], active: "carlton" };
    fireEvent.change(account("Work"), { target: { value: "Mara" } });
    await waitFor(() => expect(store.getState().toasts).toHaveLength(1));
    await waitFor(() => expect(options("Work")).toEqual([`${ACTIVE} (@carlton)`, "@carlton"]));
    fireEvent.change(account("Work"), { target: { value: "carlton" } });
    await waitFor(() => expect(stored[prAccountKey("p1")]).toBe("carlton"));
    expect(account("Work").value).toBe("carlton");
  });

  it("puts the row back to the pick it last read when the server stops answering, the store included", async () => {
    stored = { [prAccountKey("p1")]: "carlton" };
    const { store } = await opened();
    await waitFor(() => expect(account("Work").value).toBe("carlton"));
    down = true;
    fireEvent.change(account("Work"), { target: { value: "Mara" } });
    await waitFor(() => expect(store.getState().toasts.map((t) => t.text)).toEqual(["the server is not answering"]));
    await waitFor(() => expect(account("Work").value).toBe("carlton"));
  });

  it("reads the stored picks again when the server is back after a break", async () => {
    const { store } = await general();
    await waitFor(() => expect(folded()).toBe(`Work: ${ACTIVE} · School: ${ACTIVE}`));
    act(() => store.getState().applyConnectionState("reconnecting"));
    stored = { [prAccountKey("p1")]: "Mara" };
    act(() => store.getState().applyConnectionState("connected"));
    await waitFor(() => expect(folded()).toBe(`Work: @Mara · School: ${ACTIVE}`));
  });

  it("asks gh nothing for a row opened while the server is away, and asks afresh once it is back", async () => {
    const { store } = await general();
    await waitFor(() => expect(folded()).toBe(`Work: ${ACTIVE} · School: ${ACTIVE}`));
    act(() => store.getState().applyConnectionState("reconnecting"));
    down = true;
    fireEvent.click(row().querySelector("summary")!);
    await waitFor(() => expect(body()).not.toBeNull());
    await act(async () => { await Promise.resolve(); });
    expect(called("codeReview.accounts")).toEqual([]);
    expect(body()!.textContent).not.toContain("could not ask");
    down = false;
    act(() => store.getState().applyConnectionState("connected"));
    await waitFor(() => expect(options("Work")).toEqual([`${ACTIVE} (@carlton)`, "@carlton", "@Mara"]));
    expect(called("codeReview.accounts").map((c) => c.params)).toEqual([{ force: true }]);
  });

  it("keeps a pick whose account gh has signed out of, says so, and says what the profile uses meanwhile", async () => {
    stored = { [prAccountKey("p1")]: "nobody-here" };
    await opened();
    await waitFor(() => expect(options("Work")).toEqual([`${ACTIVE} (@carlton)`, "@carlton", "@Mara", "@nobody-here — signed out"]));
    expect(account("Work").value).toBe("nobody-here");
    expect(options("School")).toEqual([`${ACTIVE} (@carlton)`, "@carlton", "@Mara"]);
    expect(body()!.textContent).toContain("A profile whose account gh does not list uses gh's active account until it is back.");
  });

  it("draws a select before gh has answered only where there is a pick to take back, does not call that pick signed out yet, and adds the others when gh has answered", async () => {
    const asking = hold();
    gate = asking.wait;
    stored = { [prAccountKey("p1")]: "nobody-here" };
    await opened();
    await waitFor(() => expect(options("Work")).toEqual([ACTIVE, "@nobody-here"]));
    expect(account("Work").value).toBe("nobody-here");
    expect(screen.queryByRole("combobox", { name: "GitHub account for School" })).toBeNull();
    expect(row().querySelector(".gh-accounts > .settings-row-desc")!.textContent).toBe(ACTIVE);
    expect(body()!.textContent).not.toContain("does not list");
    const work = account("Work");
    await act(async () => { asking.go(); });
    await waitFor(() => expect(options("Work")).toContain("@nobody-here — signed out"));
    expect(account("Work")).toBe(work);
    expect(options("School")).toEqual([`${ACTIVE} (@carlton)`, "@carlton", "@Mara"]);
  });

  it("says nothing of a profile's account, folded or opened, before its stored pick has been read", async () => {
    const answer = hold();
    reading = answer.wait;
    stored = { [prAccountKey("p1")]: "Mara" };
    await general();
    await waitFor(() => expect(called("settings.get").length).toBeGreaterThanOrEqual(2));
    expect(folded()).toBeNull();
    fireEvent.click(row().querySelector("summary")!);
    await waitFor(() => expect(called("codeReview.accounts")).toHaveLength(1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryAllByRole("combobox", { name: /^GitHub account for/ })).toEqual([]);
    expect(row().querySelector(".gh-accounts > .settings-row-desc")).toBeNull();
    reading = null;
    await act(async () => { answer.go(); });
    await waitFor(() => expect(account("Work").value).toBe("Mara"));
    expect(account("School").value).toBe("");
  });

  it("offers no control where gh lists no accounts, and says why in one sentence", async () => {
    gh = { accounts: [], active: null };
    await opened();
    await waitFor(() => expect(body()!.textContent).toBe(NONE));
    expect(screen.queryAllByRole("combobox", { name: /^GitHub account for/ })).toEqual([]);
    expect(within(body() as HTMLElement).getByText(NONE)).toHaveAttribute("title", expect.stringContaining("GH_TOKEN"));
  });

  it("says it could not ask, not that gh lists none, where the list could not be read", async () => {
    deaf = true;
    await opened();
    await waitFor(() => expect(body()!.textContent).toBe("Realm could not ask gh for its accounts."));
    expect(within(body() as HTMLElement).getByText("Realm could not ask gh for its accounts.")).not.toHaveAttribute("title");
  });

  it("does not call a stored pick not listed where gh could not be asked, and still lets it be taken back", async () => {
    deaf = true;
    stored = { [prAccountKey("p1")]: "Mara" };
    await opened();
    await waitFor(() => expect(options("Work")).toEqual([ACTIVE, "@Mara"]));
    expect(body()!.textContent).toContain("Realm could not ask gh for its accounts.");
    expect(body()!.textContent).not.toContain("does not list");
    expect(body()!.textContent).not.toContain(NONE);
  });

  it("keeps the list gh gave when a later ask cannot be answered", async () => {
    stored = { [prAccountKey("p1")]: "Mara" };
    const { store } = await opened();
    await waitFor(() => expect(options("Work")).toEqual([`${ACTIVE} (@carlton)`, "@carlton", "@Mara"]));
    deaf = true;
    act(() => store.getState().setWindowActive(false));
    act(() => store.getState().setWindowActive(true));
    await waitFor(() => expect(called("codeReview.accounts")).toHaveLength(2));
    await act(async () => { await Promise.resolve(); });
    expect(options("Work")).toEqual([`${ACTIVE} (@carlton)`, "@carlton", "@Mara"]);
    expect(account("Work").value).toBe("Mara");
    expect(body()!.textContent).not.toContain("could not ask");
  });

  it("marks a pick not listed, not signed out, where gh lists no accounts at all, keeps the way back, and gives the profile with nothing to choose no control", async () => {
    gh = { accounts: [], active: null };
    stored = { [prAccountKey("p1")]: "Mara" };
    await opened();
    await waitFor(() => expect(options("Work")).toEqual([ACTIVE, "@Mara — not listed"]));
    expect(screen.queryByRole("combobox", { name: "GitHub account for School" })).toBeNull();
    expect(row().querySelector(".gh-accounts > .settings-row-desc")!.textContent).toBe(ACTIVE);
    expect(body()!.textContent).toContain(NONE);
    fireEvent.change(account("Work"), { target: { value: "" } });
    await waitFor(() => expect(stored[prAccountKey("p1")]).toBeNull());
  });

  it("keeps the select a pick was taken back in, where gh lists no accounts, until the row is folded", async () => {
    gh = { accounts: [], active: null };
    stored = { [prAccountKey("p1")]: "Mara" };
    await opened();
    await waitFor(() => expect(options("Work")).toEqual([ACTIVE, "@Mara — not listed"]));
    const work = account("Work");
    work.focus();
    fireEvent.change(work, { target: { value: "" } });
    await waitFor(() => expect(stored[prAccountKey("p1")]).toBeNull());
    await waitFor(() => expect(called("settings.get").at(-1)!.params.key).toBe(prAccountKey("p1")));
    await act(async () => { await Promise.resolve(); });
    expect(account("Work")).toBe(work);
    expect(work).toHaveFocus();
    expect(options("Work")).toEqual([ACTIVE]);
    expect(screen.queryByRole("combobox", { name: "GitHub account for School" })).toBeNull();
    expect(body()!.textContent).toContain(NONE);
    fireEvent.click(row().querySelector("summary")!);
    await waitFor(() => expect(body()).toBeNull());
    fireEvent.click(row().querySelector("summary")!);
    await waitFor(() => expect(body()!.textContent).toBe(NONE));
    expect(screen.queryAllByRole("combobox", { name: /^GitHub account for/ })).toEqual([]);
  });

  it("keeps the selects it has drawn, and the place in them, when gh then lists no accounts, until the row is folded", async () => {
    const { store } = await opened();
    await waitFor(() => expect(options("Work")).toContain("@Mara"));
    const work = account("Work");
    work.focus();
    act(() => store.getState().setWindowActive(false));
    gh = { accounts: [], active: null };
    act(() => store.getState().setWindowActive(true));
    await waitFor(() => expect(body()!.textContent).toContain(NONE));
    expect(account("Work")).toBe(work);
    expect(work).toHaveFocus();
    expect(options("Work")).toEqual([ACTIVE]);
    expect(options("School")).toEqual([ACTIVE]);
    fireEvent.click(row().querySelector("summary")!);
    await waitFor(() => expect(body()).toBeNull());
    fireEvent.click(row().querySelector("summary")!);
    await waitFor(() => expect(body()!.textContent).toBe(NONE));
    expect(screen.queryAllByRole("combobox", { name: /^GitHub account for/ })).toEqual([]);
  });

  it("keeps the select of a pick taken back before gh has answered, when its answer is that it lists no accounts", async () => {
    const asking = hold();
    gate = asking.wait;
    gh = { accounts: [], active: null };
    stored = { [prAccountKey("p1")]: "Mara" };
    await opened();
    await waitFor(() => expect(options("Work")).toEqual([ACTIVE, "@Mara"]));
    const work = account("Work");
    work.focus();
    fireEvent.change(work, { target: { value: "" } });
    await waitFor(() => expect(stored[prAccountKey("p1")]).toBeNull());
    await act(async () => { asking.go(); });
    await waitFor(() => expect(body()!.textContent).toContain(NONE));
    expect(account("Work")).toBe(work);
    expect(work).toHaveFocus();
  });

  it("draws a row opened again at once from the list gh gave last time, and does not keep a select it drew from that alone once gh answers that it lists no accounts", async () => {
    await opened();
    await waitFor(() => expect(options("Work")).toContain("@Mara"));
    fireEvent.click(row().querySelector("summary")!);
    await waitFor(() => expect(body()).toBeNull());
    const asking = hold();
    gate = asking.wait;
    gh = { accounts: [], active: null };
    fireEvent.click(row().querySelector("summary")!);
    await waitFor(() => expect(options("Work")).toEqual([`${ACTIVE} (@carlton)`, "@carlton", "@Mara"]));
    await act(async () => { asking.go(); });
    await waitFor(() => expect(body()!.textContent).toBe(NONE));
    expect(screen.queryAllByRole("combobox", { name: /^GitHub account for/ })).toEqual([]);
  });

  it("does not take an answer that came in after the row was folded for the next opening's own", async () => {
    const first = hold();
    gate = first.wait;
    await opened();
    await waitFor(() => expect(called("codeReview.accounts")).toHaveLength(1));
    fireEvent.click(row().querySelector("summary")!);
    await waitFor(() => expect(body()).toBeNull());
    await act(async () => { first.go(); });
    await act(async () => { await Promise.resolve(); });
    const second = hold();
    gate = second.wait;
    gh = { accounts: [], active: null };
    fireEvent.click(row().querySelector("summary")!);
    await waitFor(() => expect(options("Work")).toEqual([`${ACTIVE} (@carlton)`, "@carlton", "@Mara"]));
    await act(async () => { second.go(); });
    await waitFor(() => expect(body()!.textContent).toBe(NONE));
    expect(screen.queryAllByRole("combobox", { name: /^GitHub account for/ })).toEqual([]);
  });

  it("does not take an ask that failed for gh's answer: selects drawn from the list of an earlier opening still go once gh lists no accounts", async () => {
    const { store } = await opened();
    await waitFor(() => expect(options("Work")).toContain("@Mara"));
    fireEvent.click(row().querySelector("summary")!);
    await waitFor(() => expect(body()).toBeNull());
    deaf = true;
    fireEvent.click(row().querySelector("summary")!);
    await waitFor(() => expect(called("codeReview.accounts")).toHaveLength(2));
    await act(async () => { await Promise.resolve(); });
    expect(options("Work")).toEqual([`${ACTIVE} (@carlton)`, "@carlton", "@Mara"]);
    deaf = false;
    gh = { accounts: [], active: null };
    act(() => store.getState().setWindowActive(false));
    act(() => store.getState().setWindowActive(true));
    await waitFor(() => expect(body()!.textContent).toBe(NONE));
    expect(screen.queryAllByRole("combobox", { name: /^GitHub account for/ })).toEqual([]);
  });

  it("draws no select, once opened, for a pick that was taken back from elsewhere while the row was folded, where gh lists no accounts", async () => {
    gh = { accounts: [], active: null };
    stored = { [prAccountKey("p1")]: "Mara" };
    await general();
    await waitFor(() => expect(folded()).toBe(`Work: @Mara · School: ${ACTIVE}`));
    stored = {};
    await act(async () => { tell("codeReview.accountChanged", { profileId: "p1" }); });
    await waitFor(() => expect(folded()).toBe(`Work: ${ACTIVE} · School: ${ACTIVE}`));
    fireEvent.click(row().querySelector("summary")!);
    await waitFor(() => expect(body()!.textContent).toBe(NONE));
    expect(screen.queryAllByRole("combobox", { name: /^GitHub account for/ })).toEqual([]);
  });

  it("keeps to the one sentence where gh lists no accounts and a pick has not been read yet, and draws no select once it is read as no pick", async () => {
    const answer = hold();
    reading = answer.wait;
    gh = { accounts: [], active: null };
    await general();
    await waitFor(() => expect(called("settings.get").length).toBeGreaterThanOrEqual(2));
    fireEvent.click(row().querySelector("summary")!);
    await waitFor(() => expect(body()!.textContent).toBe(NONE));
    reading = null;
    await act(async () => { answer.go(); });
    await act(async () => { await Promise.resolve(); });
    expect(body()!.textContent).toBe(NONE);
    expect(screen.queryAllByRole("combobox", { name: /^GitHub account for/ })).toEqual([]);
  });

  it("asks afresh again each time the window comes back, since a terminal is where gh's accounts change", async () => {
    const { store } = await opened();
    await waitFor(() => expect(options("Work")).toContain("@Mara"));
    act(() => store.getState().setWindowActive(false));
    gh = { accounts: ["carlton"], active: "carlton" };
    act(() => store.getState().setWindowActive(true));
    await waitFor(() => expect(options("Work")).toEqual([`${ACTIVE} (@carlton)`, "@carlton"]));
    expect(called("codeReview.accounts").map((c) => c.params.force)).toEqual([true, true]);
  });

  it("leaves the page's own fresh ask after a sign-in in a terminal for the page to make", async () => {
    signInSent();
    await opened();
    await waitFor(() => expect(options("Work")).toContain("@Mara"));
    expect(pageHeld.stale).toEqual({ status: true, accounts: true });
  });

  it("follows a pick announced from elsewhere while it is open, and asks for gh's accounts again from what the server holds", async () => {
    await opened();
    await waitFor(() => expect(options("School")).toContain("@Mara"));
    stored = { [prAccountKey("p2")]: "Mara" };
    gh = { accounts: ["carlton", "Mara"], active: "Mara" };
    await act(async () => { tell("codeReview.accountChanged", { profileId: "p2" }); });
    await waitFor(() => expect(account("School").value).toBe("Mara"));
    await waitFor(() => expect(options("Work")[0]).toBe(`${ACTIVE} (@Mara)`));
    expect(called("codeReview.accounts").map((c) => c.params.force)).toEqual([true, false]);
  });

  it("hands Code review gh's answer for the profile it last drew, and for no other", async () => {
    holdStatus("p1", { state: "ready", login: "carlton", reason: null });
    await opened();
    await waitFor(() => expect(options("School")).toContain("@Mara"));
    fireEvent.change(account("School"), { target: { value: "Mara" } });
    await waitFor(() => expect(stored[prAccountKey("p2")]).toBe("Mara"));
    await new Promise((settled) => setTimeout(settled));
    expect(pageHeld.status).toEqual({ state: "ready", login: "carlton", reason: null });
    expect(pageHeld.statusProfile).toBe("p1");
    fireEvent.change(account("Work"), { target: { value: "Mara" } });
    await waitFor(() => expect(pageHeld.status).toEqual({ state: "ready", login: "Mara", reason: null, account: "Mara" }));
    expect(pageHeld.statusProfile).toBe("p1");
  });

  it("writes nothing for Code review once Settings has been put away, where the page that is open hears of the pick itself", async () => {
    const asking = hold();
    holdStatus("p1", { state: "ready", login: "carlton", reason: null });
    const { unmount } = await opened();
    await waitFor(() => expect(options("Work")).toContain("@Mara"));
    taking = [asking.wait];
    fireEvent.change(account("Work"), { target: { value: "Mara" } });
    unmount();
    await act(async () => { asking.go(); });
    await waitFor(() => expect(stored[prAccountKey("p1")]).toBe("Mara"));
    await new Promise((settled) => setTimeout(settled));
    expect(pageHeld.status).toEqual({ state: "ready", login: "carlton", reason: null });
  });

  it("says what is stored again once it is folded", async () => {
    stored = { [prAccountKey("p1")]: "Mara" };
    await opened();
    await waitFor(() => expect(account("Work").value).toBe("Mara"));
    fireEvent.click(row().querySelector("summary")!);
    await waitFor(() => expect(folded()).toBe(`Work: @Mara · School: ${ACTIVE}`));
    expect(body()).toBeNull();
  });
});
