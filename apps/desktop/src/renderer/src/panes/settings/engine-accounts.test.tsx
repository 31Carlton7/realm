import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, type Account } from "@realm/contracts";
import { SettingsPage } from "./SettingsPage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, type FakeData } from "../../state/store.test-fakes";

const pageItem = item("set-s1", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] });

const account = (id: string, label: string, over: Partial<Account> = {}): Account =>
  ({ id, kind: "claude", label, configDir: id.startsWith("default-") ? null : `/realm/accounts/claude/${id}`, signedIn: true, email: null, plan: null, createdAt: 0, ...over });

async function mount(overrides: FakeData = {}) {
  const api = fakeApi({
    agentProbe: [{ kind: "claude", available: true, version: "2.1.316", loggedIn: true, reason: null }],
    accounts: [account("default-claude", "Default", { email: "me@example.com" }), account("work", "Work", { email: "work@example.com", signedIn: false })],
    ...overrides,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><SettingsPage item={pageItem} visible /></StoreContext.Provider>);
  fireEvent.click(screen.getByRole("radio", { name: "Engines" }));
  const accounts = await screen.findByRole("group", { name: "Claude accounts" });
  return { store, api, accounts };
}

afterEach(cleanup);

describe("an engine's accounts", () => {
  it("lists each login with who it is and whether it is signed in, and asks the CLI as it opens", async () => {
    const { api, accounts } = await mount();
    const rows = within(accounts).getAllByRole("listitem");
    await waitFor(() => expect(rows[0]).toHaveTextContent("Defaultme@example.comSigned inRename"));
    expect(rows[1]).toHaveTextContent("Workwork@example.comSigned outSign inRenameRemove");
    expect(api.calls).toContain("listAccounts:true");
  });

  it("adds an account and follows its sign-in on the row", async () => {
    const { api, accounts } = await mount();
    await act(async () => { fireEvent.click(within(accounts).getByRole("button", { name: "Add account" })); });
    expect(api.calls).toContain("addAccount:claude");
    await waitFor(() => expect(within(accounts).getByText("Finish signing in to Account 3 in your browser.")).toBeInTheDocument());
  });

  it("renames in place, and removes only after naming what goes", async () => {
    const { api, accounts } = await mount();
    const work = within(accounts).getAllByRole("listitem")[1]!;
    fireEvent.click(within(work).getByRole("button", { name: "Rename" }));
    const field = within(work).getByRole("textbox", { name: "Name for Work" });
    fireEvent.change(field, { target: { value: "Client" } });
    await act(async () => { fireEvent.keyDown(field, { key: "Enter" }); });
    expect(api.calls).toContain("renameAccount:work:Client");

    fireEvent.click(within(work).getByRole("button", { name: "Remove" }));
    expect(api.calls.some((c) => c.startsWith("removeAccount"))).toBe(false);
    const confirm = within(work).getByRole("group", { name: /^Remove/ });
    expect(confirm).toHaveTextContent("Realm signs it out and deletes its folder. Sessions on it move to the default account.");
    await act(async () => { fireEvent.click(within(confirm).getByRole("button", { name: /^Remove / })); });
    expect(api.calls).toContain("removeAccount:work");
  });

  it("never offers to remove the CLI's own account", async () => {
    const { accounts } = await mount();
    const own = within(accounts).getAllByRole("listitem")[0]!;
    expect(within(own).queryByRole("button", { name: "Remove" })).toBeNull();
  });
});
