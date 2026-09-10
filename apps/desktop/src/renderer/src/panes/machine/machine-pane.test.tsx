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
   * A determinate meter appears where a fraction is REAL, and nowhere else.
   *
   * design.md: "where a figure genuinely cannot be stated, draw nothing at all rather than an empty
   * meter, which is itself a claim." A download has a real fraction. Reaching a machine does not —
   * a remote Mac that is asleep and a guest still in its firmware are indistinguishable from here,
   * and a bar creeping across either would be inventing progress.
   *
   * The mutant is one shared "loading" body for both, which is the obvious simplification.
   */
  it("meters a download and never a boot", () => {
    const pane = SOURCES["./MachinePane.tsx"]!;
    // The download body has the only meter in the file…
    const download = pane.slice(pane.indexOf("function DownloadBody"), pane.indexOf("function human"));
    expect(download).toContain('role="progressbar"');
    expect(download).toContain("aria-valuenow");
    // …and the connecting body has the app's one spinner and no meter at all.
    const screen = pane.slice(pane.indexOf("function Screen"));
    expect(screen).toContain('className="spinner"');
    expect(screen).not.toMatch(/progressbar|aria-valuenow|<progress/);
  });

  /** The password goes one way. Nothing here reads one back, because there is no method that
   *  returns one — and a field pre-filled from the server would mean there was. */
  it("never asks the server for a password back", () => {
    const pane = SOURCES["./MachinePane.tsx"]!;
    expect(pane).toContain("hasPassword");        // the boolean, which is all the row carries
    expect(pane).not.toMatch(/machine\.password|state\.password|\.password\b\s*\?\?/);
  });
});

describe("the keyboard", () => {
  const HOTKEYS = strip(Object.values(import.meta.glob("../../hotkeys.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>)[0]!);

  /**
   * Two properties of `hotkeys.ts` that make a machine pane work with no edit to it at all — and
   * both are one line from breaking, which is why they are asserted here rather than trusted.
   */
  it("lets Escape reach the guest, because the global binding acts only on a session", () => {
    // Esc is a key a guest needs — it is how you leave a dialog in any OS. The global binding is
    // "interrupt the running session", and widening its guard past `kind === "session"` would make
    // pressing Esc in a machine pane interrupt whatever session happened to be focused.
    expect(HOTKEYS).toContain('e.key === "Escape"');
    expect(HOTKEYS).toContain('it?.kind === "session"');
  });

  it("treats a focused canvas as not editable, so the grab is what decides — not a tag name", () => {
    // `isEditableTarget` exempts INPUT, TEXTAREA, contenteditable and `.xterm`. A canvas is none of
    // them, so Realm's bindings fire over a machine pane by default and the grab toggle is the ONE
    // thing that changes it. Adding "canvas" to that list would make the toggle a no-op that still
    // lights up.
    expect(HOTKEYS).toContain('t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable');
    expect(HOTKEYS).not.toContain('"CANVAS"');
    expect(HOTKEYS).not.toContain(".machine-screen");
  });

  /**
   * The grab has to win, and capture is the only thing that guarantees it.
   *
   * `hotkeys.ts` listens on `window` in the BUBBLE phase. Capture on the same target always runs
   * first, so `stopPropagation` in capture means the global handler never runs at all. A bubble-
   * phase listener — on the pane or on `window` — would be a coin toss decided by registration
   * order, and the losing side of that toss is a lit toggle that changes nothing.
   *
   * Two mutants: dropping the `true`, and hotkeys moving to capture itself (which would put them
   * back in a race). Both are asserted, because only one of them lives in this file.
   */
  it("swallows in the capture phase, which is the only thing that beats a bubble listener", () => {
    const pane = SOURCES["./MachinePane.tsx"]!;
    expect(pane).toContain('window.addEventListener("keydown", swallow, true)');
    expect(pane).toContain("e.stopPropagation()");
    expect(HOTKEYS).toContain('window.addEventListener("keydown", onKey)');
    expect(HOTKEYS, "hotkeys moved to capture — the grab is now a race").not.toMatch(/addEventListener\("keydown",\s*onKey,\s*true\)/);
    /* Never preventDefault IN THE SWALLOW: the key still has to reach the canvas for noVNC to send
       it on. Scoped to the handler rather than the file, because the connect form's submit legitimately
       prevents its own default and a file-wide assertion would be testing the wrong function. */
    const swallow = pane.slice(pane.indexOf("const swallow ="), pane.indexOf("window.addEventListener"));
    expect(swallow).toContain("stopPropagation");
    expect(swallow).not.toContain("preventDefault");
  });

  /* ⌘Q can never reach a guest and the pane must not pretend otherwise. A menu accelerator fires in
     MAIN before the renderer sees a keydown — `hotkeys.ts` writes that down for ⌘W — so this is a
     structural guarantee rather than a handler, and the mutant is deleting `{ role: "appMenu" }`
     from `installMenu`, which would hand ⌘Q to the page instead of quitting. */
  it("cannot capture what the platform ate first, and the app menu is what guarantees it", () => {
    const main = strip(Object.values(import.meta.glob("../../../../main/index.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>)[0]!);
    expect(main).toContain('{ role: "appMenu" }');
  });
});

describe("one scaler, and it is driven by fit.ts", () => {
  /**
   * The mutant is `scaleViewport = false`, and it is tempting: `fit.ts` owns the geometry, so
   * letting noVNC scale too reads like two things sizing one canvas.
   *
   * It is the opposite. noVNC's `Display` maps a click as CSS offsets inside the canvas's bounding
   * rect and then divides by its own `_scale` — which only `scaleViewport` ever sets. CSS-scale the
   * canvas from outside with that flag off and the PICTURE is correct while every CLICK is wrong by
   * exactly the scale factor: no visible symptom, and the presses land somewhere else.
   *
   * With it on, noVNC fits the canvas to its container, and the container is sized to the fit's own
   * CSS box — so the ratio it derives is the ratio `fitFramebuffer` computed, and its click map and
   * `toFramebuffer` agree by construction.
   */
  it("hands noVNC the scaling rather than fighting it", async () => {
    const hub = await import("./machine-hub");
    const src = strip(await import("./machine-hub?raw").then((m) => (m as { default: string }).default));
    expect(src).toContain("rfb.scaleViewport = true");
    expect(src).not.toContain("scaleViewport = false");
    expect(typeof hub.MachineHub).toBe("function");
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
