import { afterEach, describe, expect, it } from "vitest";
import { platformCapabilities } from "@realm/contracts";
import { searchSettings, tabAvailable, visibleSettingsGroups } from "./panes/settings/settings-index";
import { sideToolOffered } from "./components/side-tools";
import { canQuickLook, canShare } from "./components/file-actions";
import { canChooseAppIcon } from "./components/settings/AppIconPicker";

/** A preload as each OS's would be, with every bridge present — the gates must come from the
 *  capabilities, since the preload exposes the Mac's bridges everywhere. */
const onOs = (platform: string) => {
  (window as { realm?: unknown }).realm = {
    platform, capabilities: platformCapabilities(platform),
    files: { quickLook: async () => {}, share: async () => {} },
    appIcon: { set: async () => {}, saved: async () => null },
  };
};
afterEach(() => { delete (window as { realm?: unknown }).realm; });

describe("what Linux and Windows are not offered", () => {
  it("keeps every Mac page on a Mac", () => {
    onOs("darwin");
    expect(visibleSettingsGroups().flatMap((g) => g.tabs.map((t) => t.id))).toEqual(expect.arrayContaining(["permissions", "computer-use", "lab"]));
    expect(sideToolOffered("simulator")).toBe(true);
    expect(canQuickLook() && canShare() && canChooseAppIcon()).toBe(true);
  });

  it.each(["linux", "win32"])("on %s, drops the Computer pages, the simulator, Quick Look, Share and the Dock icon", (platform) => {
    onOs(platform);
    for (const tab of ["permissions", "computer-use", "lab"] as const) expect(tabAvailable(tab), tab).toBe(false);
    // The heading goes with its last page rather than standing over nothing.
    expect(visibleSettingsGroups().map((g) => g.label)).not.toContain("Computer");
    expect(visibleSettingsGroups().map((g) => g.label)).toContain("Engines");
    // Search never lands on a page that is not drawn, or on Laya's rows.
    expect(searchSettings("computer use").filter((e) => e.tab === "computer-use")).toEqual([]);
    expect(searchSettings("laya")).toEqual([]);
    expect(searchSettings("app icon").map((e) => e.id)).not.toContain("app-icon");
    expect(sideToolOffered("simulator")).toBe(false);
    expect(sideToolOffered("terminal")).toBe(true);
    expect(canQuickLook()).toBe(false);
    expect(canShare()).toBe(false);
    expect(canChooseAppIcon()).toBe(false);
  });
});
