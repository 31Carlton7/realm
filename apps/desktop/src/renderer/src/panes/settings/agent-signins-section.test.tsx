import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PAGE_REF_IDS, type AgentSigninsStatus, type SecurityCodesStatus } from "@realm/contracts";
import { SettingsPage } from "./SettingsPage";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item } from "../../state/store.test-fakes";

const pageItem = item("set-s1", "s1", { kind: "settings-page", title: "Settings", refId: PAGE_REF_IDS["settings-page"] });

/** Main's switches, stood in: agent sign-ins and Security codes, each answering what it was set to. */
function bridge(signins: AgentSigninsStatus, codes: SecurityCodesStatus, codesOn: SecurityCodesStatus = codes) {
  const sets: string[] = [];
  (window as unknown as { realm: unknown }).realm = {
    ...saved,
    credentials: {
      signinsStatus: async () => signins,
      setSignins: async (on: boolean) => { sets.push(`signins:${on}`); return { ...signins, enabled: on }; },
      codesStatus: async () => codes,
      setCodes: async (on: boolean) => { sets.push(`codes:${on}`); return on ? codesOn : { enabled: false, sources: null }; },
    },
  };
  return sets;
}
const saved = window.realm;
afterEach(() => { (window as unknown as { realm: unknown }).realm = saved; });

async function mount(over: Parameters<typeof fakeApi>[0] = {}) {
  const api = fakeApi(over);
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><SettingsPage item={pageItem} visible /></StoreContext.Provider>);
  act(() => { store.getState().openSettingsPage("signins"); });
  return { api, store };
}
const row = (name: string) => screen.getByLabelText(new RegExp(`^${name}: `));

describe("Settings ▸ Sign-ins ▸ Let agents finish sign-ins", () => {
  it("is one switch an agent cannot press, and turning it on turns on Security codes too", async () => {
    const ok = { Messages: "ok", Mail: "ok", Notifications: "ok" } as const;
    const sets = bridge({ enabled: false, fills: [] }, { enabled: false, sources: null }, { enabled: true, sources: ok });
    await mount();
    const toggle = await screen.findByRole("switch", { name: "Let agents finish sign-ins" });
    expect(toggle).not.toBeChecked();
    expect(toggle.closest("[data-no-agent]")).not.toBeNull();
    expect(screen.queryByText("Read sign-in codes from Messages and Mail")).toBeNull();
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(sets).toEqual(["signins:true", "codes:true"]);
    expect(await screen.findByLabelText("Read sign-in codes from Messages and Mail: Granted")).toBeInTheDocument();
  });

  it("walks the grants not yet in place, each with the step that puts it there", async () => {
    bridge({ enabled: true, fills: [] }, { enabled: true, sources: { Messages: "no_access", Mail: "ok", Notifications: "no_access" } });
    await mount();
    await screen.findByRole("switch", { name: "Let agents finish sign-ins" });
    expect(row("Read sign-in codes from Messages and Mail")).toHaveTextContent("Needs Full Disk Access");
    expect(row("Read sign-in codes from Messages and Mail")).toHaveTextContent("Show app in Finder");
    expect(row("Codes from notifications on this Mac")).toHaveTextContent("Needs Full Disk Access");
    expect(row("Use apps on this Mac for a sign-in")).toHaveTextContent("Allow in System Settings");
    // Touch ID stays the default; the 8-hour unlock is offered, never chosen for the person.
    await waitFor(() => expect(row("Unlock passwords for agents")).toHaveTextContent("Unlock for 8 hours"));
    expect(row("Unlock passwords for agents")).toHaveTextContent("Touch ID");
  });

  it("says notifications can't be read where Full Disk Access is already on", async () => {
    bridge({ enabled: true, fills: [] }, { enabled: true, sources: { Messages: "ok", Mail: "ok", Notifications: "no_access" } });
    await mount();
    await screen.findByRole("switch", { name: "Let agents finish sign-ins" });
    expect(row("Read sign-in codes from Messages and Mail")).toHaveTextContent("Granted");
    expect(row("Codes from notifications on this Mac")).toHaveTextContent("Realm can't read notifications on this Mac.");
    expect(row("Codes from notifications on this Mac")).not.toHaveTextContent("Full Disk Access");
  });

  it("offers the 8-hour unlock in one press, and says so once it is on", async () => {
    bridge({ enabled: true, fills: [] }, { enabled: true, sources: { Messages: "ok", Mail: "ok", Notifications: "ok" } });
    const { api } = await mount();
    await screen.findByRole("switch", { name: "Let agents finish sign-ins" });
    const unlock = await screen.findByRole("button", { name: "Unlock for 8 hours" });
    fireEvent.click(unlock);
    await waitFor(() => expect(row("Unlock passwords for agents")).toHaveTextContent("For 8 hours"));
    expect(api.calls.filter((c) => c.startsWith("credentialSetUnlockPolicy:"))).toEqual([expect.stringMatching(/:session$/)]);
  });
});
