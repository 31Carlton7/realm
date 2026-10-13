import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerWhatsNew, WhatsNewState, WHATS_NEW_FILE, type WhatsNewFs } from "./whats-new";

/** userData as a map, shared between "launches" the way the real folder is. */
function disk(seen?: string | null) {
  const files = new Map<string, string>();
  if (seen) files.set(`/ud/${WHATS_NEW_FILE}`, JSON.stringify({ seen }));
  const fs: WhatsNewFs = {
    read: (p) => { const v = files.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
    write: (p, d) => { files.set(p, d); },
  };
  const launch = (version: string, ranBefore = true) => new WhatsNewState({ dir: "/ud", version, ranBefore, fs });
  return { files, fs, launch };
}

describe("what's new after an update", () => {
  it("shows nothing on a brand-new install, and records the version so the next launch is quiet too", () => {
    const { launch } = disk();
    const first = launch("2.1.1", false);
    expect(first.claim()).toBe(false);
    expect(first.lastSeen()).toBe("2.1.1");
    expect(launch("2.1.1").claim()).toBe(false);
  });

  it("records a new install even before userData exists, so its second launch is quiet", () => {
    const root = mkdtempSync(join(tmpdir(), "realm-whats-new-"));
    try {
      const dir = join(root, "userData");
      expect(new WhatsNewState({ dir, version: "2.1.1", ranBefore: false }).claim()).toBe(false);
      // The second launch finds the window's saved place, as any install that has run once does.
      expect(new WhatsNewState({ dir, version: "2.1.1", ranBefore: true }).claim()).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("shows once after an update — to the first window that asks, not a second", () => {
    const { launch } = disk("2.1.0");
    const run = launch("2.1.1");
    expect(run.claim()).toBe(true);
    expect(run.claim()).toBe(false);
  });

  /* THE mutant: claiming writes the version down. Then a Realm quit with the sheet still up would
     never show it — dismissing is what records it. */
  it("keeps owing the sheet until it is dismissed, and dismissing is remembered", () => {
    const { launch } = disk("2.1.0");
    expect(launch("2.1.1").claim()).toBe(true);
    // Quit without closing it: the next launch shows it again.
    const again = launch("2.1.1");
    expect(again.claim()).toBe(true);
    again.markSeen();
    expect(again.lastSeen()).toBe("2.1.1");
    expect(launch("2.1.1").claim()).toBe(false);
  });

  it("does not show for the version it has already shown", () => {
    expect(disk("2.1.1").launch("2.1.1").claim()).toBe(false);
  });

  it("shows once for an install that ran Realm before this record existed", () => {
    const { launch } = disk();
    expect(launch("2.1.1", true).claim()).toBe(true);
    // An unreadable record on an install that has run before is the same case, not a new install.
    const broken = disk();
    broken.files.set(`/ud/${WHATS_NEW_FILE}`, "{not json");
    expect(broken.launch("2.1.1", true).claim()).toBe(true);
  });

  it("answers the renderer's three asks", async () => {
    const { launch } = disk("2.1.0");
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>();
    const state = launch("2.1.1");
    const notes = { version: "2.1.1", notes: null, url: "https://realm.computer/changelog" };
    registerWhatsNew({ handle: (c, fn) => handlers.set(c, fn), state, notes });
    expect(handlers.get("whats-new:notes")!(null)).toBe(notes);
    expect(handlers.get("whats-new:claim")!(null)).toBe(true);
    expect(handlers.get("whats-new:claim")!(null)).toBe(false);
    handlers.get("whats-new:seen")!(null);
    expect(state.lastSeen()).toBe("2.1.1");
  });
});
