import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { COMPUTER_PROVIDER_NAME, PAGE_REF_IDS } from "@realm/contracts";
import { SettingsPage } from "./SettingsPage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, profile, space, type FakeData } from "../../state/store.test-fakes";

const pageItem = item("set-s1", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] });

const computer = (enabled: boolean, offered: boolean | null = true, needs: string | null = null) =>
  [{ name: "realm-browser", enabled: true, offered: true, needs: null }, { name: COMPUTER_PROVIDER_NAME, enabled, offered, needs }];

async function computerUse(overrides: FakeData = {}) {
  const api = fakeApi({
    mcpProvidersBySpace: { s1: computer(true), s2: computer(false) },
    computerAllowedApps: { s1: ["com.apple.Notes", "com.apple.TextEdit"] },
    ...overrides,
  });
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><SettingsPage item={pageItem} visible /></StoreContext.Provider>);
  fireEvent.click(screen.getByRole("radio", { name: "Computer use" }));
  return { api, store };
}

const card = (name: string) => within(screen.getByRole("list", { name: `Computer control in ${name}` }));

describe("Settings ▸ Computer use", () => {
  it("gathers every space's own switch, each reading that space's answer", async () => {
    await computerUse();
    // THE one-list mutant: read the switch from whichever space a Connections panel has open, and
    // every space on the page reads alike.
    await waitFor(() => expect(card("Versed").getByRole("switch", { name: "Let agents in Versed control this Mac" })).toBeChecked());
    expect(card("Homework").getByRole("switch", { name: "Let agents in Homework control this Mac" })).not.toBeChecked();
  });

  it("writes a switch to its own space and no other, and leaves an open panel's list alone", async () => {
    // Both off, and a Connections panel open on Versed saying so.
    const { api, store } = await computerUse({ mcpProvidersBySpace: { s1: computer(false), s2: computer(false) } });
    store.setState({ mcpPanelSpaceId: "s1", mcpProviders: computer(false) });
    const panel = () => store.getState().mcpProviders.find((p) => p.name === COMPUTER_PROVIDER_NAME)?.enabled;
    fireEvent.click(await card("Homework").findByRole("switch", { name: "Let agents in Homework control this Mac" }));
    await waitFor(() => expect(store.getState().computerControl.s2?.enabled).toBe(true));
    expect(api.calls).toContain(`setMcpProviderEnabled:s2:${COMPUTER_PROVIDER_NAME}=true`);
    expect(api.calls.filter((c) => c.startsWith("setMcpProviderEnabled:s1:"))).toEqual([]);
    // THE shared-patch mutant: patch `mcpProviders` by name whatever space it belongs to, and the
    // Versed panel's row turns on with a Homework switch.
    expect(panel()).toBe(false);
    fireEvent.click(card("Versed").getByRole("switch", { name: "Let agents in Versed control this Mac" }));
    await waitFor(() => expect(store.getState().computerControl.s1?.enabled).toBe(true));
    // …and when the switch IS the open panel's space, the panel hears it too.
    expect(panel()).toBe(true);
  });

  it("lists the apps a space lets agents drive under that space, and removes one there", async () => {
    const { api } = await computerUse();
    expect(await card("Versed").findByText("com.apple.Notes")).toBeInTheDocument();
    expect(card("Homework").queryByText("com.apple.Notes")).toBeNull();
    fireEvent.click(card("Versed").getByRole("button", { name: "Remove com.apple.Notes from Versed" }));
    await waitFor(() => expect(api.calls).toContain("setComputerAllowedApps:s1=com.apple.TextEdit"));
    await waitFor(() => expect(card("Versed").queryByText("com.apple.Notes")).toBeNull());
  });

  it("where this Mac cannot honour a space's choice, says why in place of the switch", async () => {
    await computerUse({ mcpProvidersBySpace: { s1: computer(true, false, "the accessibility helper"), s2: computer(false) } });
    expect(await card("Versed").findByText("Needs the accessibility helper")).toBeInTheDocument();
    // THE claiming-switch mutant: draw "on" over tools that do nothing here.
    expect(card("Versed").queryByRole("switch")).toBeNull();
  });

  it("names each space's profile when there is more than one, so two spaces called the same can be told apart", async () => {
    await computerUse({
      profiles: [profile("p1", "Work"), profile("p2", "Home")],
      spaces: [space("s1", "p1", "Notes"), space("s2", "p2", "Notes")],
      mcpProvidersBySpace: { s1: computer(true), s2: computer(false) },
    });
    const lists = await screen.findAllByRole("list", { name: "Computer control in Notes" });
    expect(lists.map((l) => within(l).getByText(/Work|Home/).textContent)).toEqual(["Work", "Home"]);
  });

  it("holds the two macOS grants the tools need, which Permissions no longer repeats", async () => {
    await computerUse();
    expect(document.querySelector(".computer-access-field")).not.toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Permissions" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Permissions" })).toBeChecked());
    expect(document.querySelector(".computer-access-field")).toBeNull();
  });
});
