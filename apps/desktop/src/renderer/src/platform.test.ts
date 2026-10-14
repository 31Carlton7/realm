import { afterEach, describe, expect, it } from "vitest";
import { displayKeyChord, platformCapabilities, setKeyDisplayPlatform } from "@realm/contracts";
import { applyPlatform, capabilities } from "./platform";

const setRealm = (platform: string) => {
  (window as { realm?: unknown }).realm = { platform, capabilities: platformCapabilities(platform) };
};

afterEach(() => {
  delete (window as { realm?: unknown }).realm;
  delete document.documentElement.dataset.windowControls;
  setKeyDisplayPlatform("darwin");
});

describe("capabilities", () => {
  it("answers for a Mac where there is no bridge, so component tests see the app they were written for", () => {
    expect(capabilities().simulators).toBe(true);
  });

  it("answers what the preload reported", () => {
    setRealm("linux");
    expect(capabilities().simulators).toBe(false);
    expect(capabilities().fileManager).toBe("Files");
  });
});

describe("applyPlatform", () => {
  it("leaves a Mac's head row to the traffic lights and its chords to the glyphs", () => {
    setRealm("darwin");
    applyPlatform();
    expect(document.documentElement.dataset.windowControls).toBeUndefined();
    expect(displayKeyChord("mod+k")).toBe("⌘K");
  });

  it("makes room for the system's window controls on Windows, and spells chords out", () => {
    setRealm("win32");
    applyPlatform();
    expect(document.documentElement.dataset.windowControls).toBe("overlay");
    expect(displayKeyChord("mod+k")).toBe("Ctrl+K");
  });
});
