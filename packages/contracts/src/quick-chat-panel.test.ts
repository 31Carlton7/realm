import { describe, expect, it } from "vitest";
import { QUICK_CHAT_SHORTCUT_DEFAULT, acceleratorForChord, quickChatShortcutFrom } from "./quick-chat-panel";

describe("acceleratorForChord", () => {
  it("spells a chord the way globalShortcut reads one", () => {
    expect(acceleratorForChord("ctrl+alt+space")).toBe("Control+Alt+Space");
    expect(acceleratorForChord("mod+shift+k")).toBe("Command+Shift+K");
    expect(acceleratorForChord("⌃⌥F19")).toBe("Control+Alt+F19");
    expect(acceleratorForChord("alt+,")).toBe("Alt+,");
    expect(acceleratorForChord("mod+enter")).toBe("Command+Return");
  });

  it("puts mod on Control and ctrl on Super off a Mac", () => {
    expect(acceleratorForChord("mod+alt+space", "linux")).toBe("Control+Alt+Space");
    expect(acceleratorForChord("ctrl+space", "win32")).toBe("Super+Space");
  });

  it("refuses a key that would be taken from every app's typing", () => {
    expect(acceleratorForChord("space")).toBeNull();
    expect(acceleratorForChord("shift+a")).toBeNull();
  });

  it("refuses what is not a chord, and a key with no accelerator name", () => {
    expect(acceleratorForChord("ctrl+k ctrl+c")).toBeNull();
    expect(acceleratorForChord("ctrl+é")).toBeNull();
  });
});

describe("quickChatShortcutFrom", () => {
  it("is the default until one is stored", () => {
    expect(quickChatShortcutFrom(null)).toBe(QUICK_CHAT_SHORTCUT_DEFAULT);
    expect(quickChatShortcutFrom(undefined)).toBe(QUICK_CHAT_SHORTCUT_DEFAULT);
  });

  it("keeps a stored chord, and an empty string as no shortcut", () => {
    expect(quickChatShortcutFrom("mod+shift+j")).toBe("mod+shift+j");
    expect(quickChatShortcutFrom("")).toBeNull();
  });

  it("falls back to the default for a value that cannot be registered", () => {
    expect(quickChatShortcutFrom("shift+a")).toBe(QUICK_CHAT_SHORTCUT_DEFAULT);
    expect(quickChatShortcutFrom(7)).toBe(QUICK_CHAT_SHORTCUT_DEFAULT);
  });
});
