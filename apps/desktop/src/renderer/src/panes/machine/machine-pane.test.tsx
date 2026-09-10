import { describe, expect, it } from "vitest";
import { MACHINE_WORDS, machineMeta } from "./MachinePane";
import { dotFor } from "./MachineBar";

/**
 * The two pane sources, as text. The claims below are about what the pane does NOT do, and an
 * absence is not a thing a render can be asked about.
 *
 * Comments are stripped first, and the reason is the same one `styles.test.ts` gives about
 * `transition: all`: this file's own doc comments say the words "browserRect" and "no-overlay" while
 * explaining why the pane has neither, and prose about a thing must not read as a use of it. The
 * first run of this test failed on its own explanation.
 */
const strip = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const SOURCES = Object.fromEntries(
  Object.entries(import.meta.glob("./*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>)
    .filter(([name]) => !name.includes(".test."))
    .map(([name, src]) => [name, strip(src)]),
);
const STORE = import.meta.glob("../../state/store.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const store = strip(Object.values(STORE)[0]!);

describe("the machine pane is DOM, not a native view", () => {
  it("scans the real sources", () => {
    expect(Object.keys(SOURCES).sort()).toEqual(["./MachineBar.tsx", "./MachinePane.tsx"]);
    expect(store).toContain("browserRects");
  });

  /**
   * The pane registers no `browserRect`, and this is the highest-value assertion in the file.
   *
   * `browserRects` is the no-overlay machinery: every sheet and the command palette are placed into
   * the COMPLEMENT of the rects it holds, and a sheet with nowhere left to go makes the whole layout
   * snap browser leaves to a half split for its lifetime. All of that exists because a
   * `WebContentsView` composites above the window's DOM unconditionally.
   *
   * A canvas has none of that. It cannot paint outside its own box, and menus, sheets and the
   * palette open over it correctly with no help. Registering a rect "for consistency" would make
   * every sheet in the app start dodging a pane that composites nothing — and worse, would reshape
   * the user's layout to get out of the way of a surface that was never in the way.
   */
  it("registers no browser rect, and is not swept up by the one that reshapes layouts", () => {
    for (const [name, src] of Object.entries(SOURCES)) {
      expect(src, name).not.toContain("browserRect");
      expect(src, name).not.toContain("no-overlay");
    }
    // …and the store's snap is keyed on the browser kind by NAME rather than on "has a native view",
    // so widening it is a visible edit rather than an accident.
    expect(store).toContain('i.kind === "browser"');
    expect(store).not.toMatch(/kind === "browser" \|\| .*kind === "machine"/);
  });

  /**
   * There is no measurable fraction in reaching a machine, so nothing draws one.
   *
   * design.md: "where a figure genuinely cannot be stated, draw nothing at all rather than an empty
   * meter, which is itself a claim." A remote Mac that is asleep and a guest still in its firmware
   * are indistinguishable from here, and a bar creeping across would be inventing progress.
   */
  it("shows a spinner while connecting, never a progress bar", () => {
    const pane = SOURCES["./MachinePane.tsx"]!;
    expect(pane).toContain('className="spinner"');
    expect(pane).not.toMatch(/<progress|role="progressbar"|aria-valuenow/);
  });

  /** The password goes one way. Nothing here reads one back, because there is no method that
   *  returns one — and a field pre-filled from the server would mean there was. */
  it("never asks the server for a password back", () => {
    const pane = SOURCES["./MachinePane.tsx"]!;
    expect(pane).toContain("hasPassword");        // the boolean, which is all the row carries
    expect(pane).not.toMatch(/machine\.password|state\.password|\.password\b\s*\?\?/);
  });
});

describe("what a machine's state is called", () => {
  /* Plain sentence case, and Realm's words rather than the protocol's. "Powered on" and "halted" are
     QEMU's vocabulary for a thing the user thinks of as connected or not. */
  it("uses plain words, in sentence case", () => {
    for (const [status, word] of Object.entries(MACHINE_WORDS)) {
      expect(word, status).toBe(word.toLowerCase());
      expect(word, status).not.toMatch(/powered|halted|runlevel/);
    }
    expect(MACHINE_WORDS.booting).toBe("starting up");
    expect(MACHINE_WORDS.failed).toBe("failed to connect");
  });

  /* Every status maps to a dot, and `off` is DECLARED rather than falling out of a default — a typo
     in a status would otherwise render as "not connected", which is the one state a reader would
     never question. */
  it("gives every status a dot of its own, with off declared rather than defaulted", () => {
    expect(Object.keys(MACHINE_WORDS).map(dotFor)).toEqual(["machine-off", "machine-booting", "running", "machine-suspended", "error"]);
    // The two that reuse the existing vocabulary do so because the semantics genuinely match.
    expect(dotFor("running")).toBe("running");
    expect(dotFor("failed")).toBe("error");
    // …and `booting` does NOT borrow `driving`, which means an agent act is in flight — a different
    // fact about a different actor.
    expect(dotFor("booting")).not.toBe("driving");
  });
});

describe("the pane bar's subtitle", () => {
  it("says the guest's own resolution, and nothing at all before there is one", () => {
    expect(machineMeta(undefined)).toBeNull();
    expect(machineMeta({ machineId: "m", status: "booting", wsUrl: null, width: null, height: null, error: null, detail: null })).toBeNull();
    expect(machineMeta({ machineId: "m", status: "running", wsUrl: null, width: 1712, height: 1069, error: null, detail: null }, 1)).toBe("1712×1069");
  });
});
