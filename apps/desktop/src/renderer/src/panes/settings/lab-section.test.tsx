import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PAGE_REF_IDS, type LabCheck, type LabStatus } from "@realm/contracts";
import { createAppStore, StoreContext } from "../../state/store";
import { fakeApi, item, teamSpace, type FakeData } from "../../state/store.test-fakes";
import { LabSection } from "./LabSection";
import { SettingsPage } from "./SettingsPage";

/**
 * Settings ▸ Lab. What must die: a check that needs an administrator offered as a click, a command
 * described rather than shown, the login item's switch saying something macOS did not, the Touch ID
 * row ignoring the profile's unlock policy, the update line out of step with the window, a fourth
 * account on a phone, and a device's team lost on the way to the server.
 */

afterEach(() => cleanup());

const SLEEP: LabCheck = {
  id: "sleep", label: "Never sleeps", state: "attention", fact: "This Mac sleeps after 1 minute idle, and a team's clock stops with it.",
  fix: "Run this once in Terminal. Until then, Realm can keep it awake while agents are working.",
  command: "sudo pmset -a sleep 0 disksleep 0", settingsPane: "energy", action: "keep-awake",
};
const DISK: LabCheck = { id: "disk", label: "At least 50 GB free", state: "ok", fact: "120 GB free.", fix: null, command: null, settingsPane: null, action: null };
const RESTART: LabCheck = { id: "power-failure", label: "Starts after a power failure", state: "na", fact: "This Mac has no such setting.", fix: null, command: null, settingsPane: null, action: null };

async function mount(over: FakeData = {}) {
  const api = fakeApi({ labChecks: [SLEEP, DISK, RESTART], ...over });
  const store = createAppStore(api);
  await store.getState().boot();
  render(<StoreContext.Provider value={store}><LabSection /></StoreContext.Provider>);
  await waitFor(() => expect(store.getState().labChecks).not.toBeNull());
  return { api, store };
}
const row = (label: RegExp | string) => screen.getByRole("listitem", { name: label });

describe("Settings ▸ Lab", () => {
  it("is a page of its own under Computer", async () => {
    const api = fakeApi({});
    const store = createAppStore(api);
    await store.getState().boot();
    render(<StoreContext.Provider value={store}><SettingsPage item={item("set", "s1", { kind: "settings-page", refId: PAGE_REF_IDS["settings-page"] })} visible /></StoreContext.Provider>);
    fireEvent.click(screen.getByRole("radio", { name: "Lab" }));
    expect(await screen.findByRole("heading", { name: "Ready to be left alone" })).toBeInTheDocument();
    await waitFor(() => expect(api.calls).toEqual(expect.arrayContaining(["labStatus", "labReadiness", "labScan"])));
  });

  it("shows an admin fix as the command to run, with the stopgap switch and System Settings, never a click that runs it", async () => {
    const { api } = await mount();
    const sleep = row(/^Never sleeps: Needs attention/);
    expect(within(sleep).getByText("sudo pmset -a sleep 0 disksleep 0")).toBeInTheDocument();
    expect(within(sleep).getByRole("button", { name: "Copy command" })).toBeInTheDocument();
    expect(within(sleep).queryByRole("button", { name: /pmset|Fix|Run/ })).toBeNull();
    fireEvent.click(within(sleep).getByRole("button", { name: "Open System Settings" }));
    await waitFor(() => expect(api.calls).toContain("labOpenSettings:energy"));
    // The stopgap is Realm's own setting, and it is the same switch as General ▸ Power's.
    const awake = within(sleep).getByRole("switch", { name: "Keep the Mac awake while agents work" });
    expect(awake).not.toBeChecked();
    fireEvent.click(awake);
    await waitFor(() => expect(awake).toBeChecked());
    // Ready rows say so and offer nothing; a check that does not apply is not counted.
    expect(within(row(/^At least 50 GB free: Ready/)).queryByRole("button")).toBeNull();
    // Touch ID passes on this fake Mac, so: sleep and the login item need attention, of four that apply.
    expect(screen.getByText("2 of 4 ready")).toBeInTheDocument();
  });

  it("judges Touch ID by the profile's unlock policy and this Mac's sensor", async () => {
    await mount({ credentialStatus: { available: true, canPromptTouchID: false, canPromptDeviceOwner: true, presenceTtlMs: 0 } });
    expect(row(/^Sign-ins can be unlocked: Needs attention/)).toHaveTextContent("Attach a Magic Keyboard with Touch ID, or choose another way to unlock in Sign-ins.");
    cleanup();
    await mount({ credentialStatus: { available: true, canPromptTouchID: false, canPromptDeviceOwner: true, presenceTtlMs: 0 }, unlockPolicies: { p1: { kind: "device-password" } } });
    expect(row(/^Sign-ins can be unlocked: Ready/)).toHaveTextContent("unlock with the login password");
  });

  it("turns Realm's login item on and back off, showing what main reports", async () => {
    const { api } = await mount();
    const login = row(/^Realm opens at login: Needs attention/);
    const sw = within(login).getByRole("switch", { name: "Open Realm at login" });
    fireEvent.click(sw);
    await waitFor(() => expect(row(/^Realm opens at login: Ready/)).toBeInTheDocument());
    fireEvent.click(within(row(/^Realm opens at login/)).getByRole("switch", { name: "Open Realm at login" }));
    await waitFor(() => expect(api.calls.filter((c) => c.startsWith("labSetLoginItem"))).toEqual(["labSetLoginItem:true", "labSetLoginItem:false"]));
    await waitFor(() => expect(row(/^Realm opens at login: Needs attention/)).toBeInTheDocument());
  });

  it("offers no login-item switch from a development build", async () => {
    await mount({ labLoginItem: { openAtLogin: false, canSet: false } });
    const login = row(/^Realm opens at login/);
    expect(within(login).queryByRole("switch")).toBeNull();
    expect(login).toHaveTextContent("A development build can't add itself; the installed Realm can.");
  });

  it("says where the update window stands, and opens it on Update now", async () => {
    const waiting: LabStatus = { enabled: true, updateHour: 4, updateCapMinutes: 30, hostName: "lab-mini.local",
      update: { kind: "waiting", version: "2.1.0", from: "2.0.3", readyAt: 0, opensAt: new Date(2099, 0, 1, 4).getTime() } };
    const { api } = await mount({ lab: waiting });
    expect(screen.getByText("Realm v2.1.0 is ready. It installs at 4:00 AM, once team runs have finished.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(api.calls).toContain("labUpdateNow"));
    fireEvent.change(screen.getByRole("combobox", { name: "Install updates at" }), { target: { value: "2" } });
    await waitFor(() => expect(api.calls).toContain("labSetUpdateWindow:2:30"));
  });

  it("says an update asks before restarting while lab mode is off", async () => {
    await mount();
    expect(screen.getByText("Lab mode is off, so an update asks before it restarts, as on any Mac.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update now" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "This Mac is a lab" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "This Mac is a lab" })).toBeChecked());
  });

  it("adds a phone a scan found, gives it to a team and its accounts, and stops at three", async () => {
    const { api } = await mount({
      teams: [teamSpace("s1", [])],
      labOnCable: [{ udid: "00008150-AAAA", kind: "iphone", name: "Lab iPhone 1", runtime: "iOS 27.0" }],
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add to lab" }));
    const device = await screen.findByRole("listitem", { name: /^Lab iPhone 1, iPhone, On the cable/ });
    fireEvent.change(within(device).getByRole("combobox", { name: "Team for Lab iPhone 1" }), { target: { value: "s1" } });
    await waitFor(() => expect(api.calls).toContain("labDeviceUpdate:0000000000000000000000DEV0"));
    for (const handle of ["@a", "@b", "@c"]) {
      const d = screen.getByRole("listitem", { name: /^Lab iPhone 1/ });
      fireEvent.change(within(d).getByRole("combobox", { name: "Service for an account on Lab iPhone 1" }), { target: { value: "TikTok" } });
      fireEvent.change(within(d).getByRole("textbox", { name: "Handle for an account on Lab iPhone 1" }), { target: { value: handle } });
      fireEvent.click(within(d).getByRole("button", { name: "Add account" }));
      await waitFor(() => expect(within(screen.getByRole("listitem", { name: /^Lab iPhone 1/ })).getByText(handle)).toBeInTheDocument());
    }
    const full = screen.getByRole("listitem", { name: /^Lab iPhone 1/ });
    expect(within(full).queryByRole("button", { name: "Add account" })).toBeNull();
    expect(within(full).getByText("3 of 3 accounts")).toBeInTheDocument();
    expect(within(full).getByRole("combobox", { name: "Team for Lab iPhone 1" })).toHaveValue("s1");
  });

  it("names this Mac for the laptop's Machine pane", async () => {
    await mount();
    expect(screen.getByText("lab-mini.local")).toBeInTheDocument();
    expect(screen.getByText(/open a Machine, choose Another Mac, and enter this address/)).toBeInTheDocument();
  });
});
