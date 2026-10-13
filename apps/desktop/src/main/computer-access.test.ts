import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPUTER_FORBIDDEN_BUNDLE_IDS } from "@realm/contracts";
import { describe, expect, it } from "vitest";
import {
  ComputerAccess, computerAccessRows, computerGrantExplanation, isComputerAccessId, isResettableBundleId, isStaleGrant, nextGrantHistory, settingsPlace,
  type ComputerAccessDeps, type ComputerGrantHistory, type ComputerGrantState,
} from "./computer-access";

const rows = (grants: { accessibility: boolean; screenRecording: boolean }, helperAvailable = true) =>
  Object.fromEntries(computerAccessRows(grants, { helperAvailable }).map((r) => [r.id, r]));

describe("computerAccessRows", () => {
  it("offers to ask for a grant that is missing", () => {
    const r = rows({ accessibility: false, screenRecording: false });
    expect(r.accessibility).toMatchObject({ state: "denied", canPrompt: true, needsSettings: true });
    expect(r.screenRecording).toMatchObject({ state: "denied", canPrompt: true, needsSettings: true });
  });

  it("offers nothing for a grant already held", () => {
    const r = rows({ accessibility: true, screenRecording: true });
    expect(r.accessibility).toMatchObject({ state: "granted", canPrompt: false, needsSettings: false });
    expect(r.screenRecording).toMatchObject({ state: "granted", canPrompt: false, needsSettings: false });
  });

  it("still offers to ask for Accessibility with no helper — Electron can raise that prompt alone", () => {
    // Paired with the fallback in main's `computer:request`. If that branch goes, this row's button
    // becomes one that renders and does nothing.
    expect(rows({ accessibility: false, screenRecording: false }, false).accessibility!.canPrompt).toBe(true);
  });

  it("cannot ask for Screen Recording without the helper, since that is the only request path", () => {
    const r = rows({ accessibility: false, screenRecording: false }, false).screenRecording!;
    expect(r.canPrompt).toBe(false);
    // The row must still send the user somewhere that works.
    expect(r.needsSettings).toBe(true);
  });

  it("says Accessibility is required and Screen Recording is not", () => {
    const r = rows({ accessibility: false, screenRecording: false });
    expect(r.accessibility!.detail).toMatch(/Required/);
    expect(r.screenRecording!.detail).toMatch(/Optional/);
  });

  it("admits macOS cannot tell a refusal from never having asked", () => {
    // The honesty rule tcc.ts sets: a row may only claim what it has a basis for.
    expect(rows({ accessibility: false, screenRecording: false }).accessibility!.detail).toMatch(/cannot tell/);
  });

  it("never claims an unknown state — both grants answer definitively", () => {
    // The states are named rather than scanned for the absence of "unknown": `every` is true of an
    // empty array, so a row that stopped being returned would satisfy that scan without existing.
    for (const grants of [{ accessibility: true, screenRecording: false }, { accessibility: false, screenRecording: true }]) {
      expect(computerAccessRows(grants, { helperAvailable: true }).map((r) => r.state))
        .toEqual([grants.accessibility ? "granted" : "denied", grants.screenRecording ? "granted" : "denied"]);
    }
  });

});

describe("computerGrantExplanation", () => {
  it("promises a trip to System Settings rather than a grant", () => {
    // The button must not read as something that can succeed on its own: macOS's Accessibility
    // dialog only deep-links, so a row that stayed red after "Grant" would look broken.
    expect(computerGrantExplanation("accessibility")).toMatch(/nothing is granted until you do/);
    expect(computerGrantExplanation("screenRecording")).toMatch(/System Settings/);
  });

  it("rides on the row, so the user reads it before pressing the button", () => {
    const missing = rows({ accessibility: false, screenRecording: false });
    expect(missing.accessibility!.askExplanation).toBe(computerGrantExplanation("accessibility"));
    // Nothing to explain where there is nothing to ask for.
    expect(rows({ accessibility: true, screenRecording: true }).accessibility!.askExplanation).toBeNull();
    expect(rows({ accessibility: false, screenRecording: false }, false).screenRecording!.askExplanation).toBeNull();
  });
});

describe("where the switch is", () => {
  it("names the pane as this macOS labels it — Device Control and Data Access from macOS 27", () => {
    expect(settingsPlace("accessibility", 27)).toBe("Privacy & Security ▸ Device Control and Data Access");
    expect(settingsPlace("accessibility", 15)).toBe("Privacy & Security ▸ Accessibility");
    expect(settingsPlace("screenRecording", 15)).toBe("Privacy & Security ▸ Screen & System Audio Recording");
    expect(settingsPlace("screenRecording", 14)).toBe("Privacy & Security ▸ Screen Recording");
  });

  it("rides into the Allow button's explanation", () => {
    const r = Object.fromEntries(computerAccessRows({ accessibility: false, screenRecording: false }, { helperAvailable: true, macosMajor: 27 }).map((x) => [x.id, x]));
    expect(r.accessibility!.askExplanation).toContain("Device Control and Data Access");
    expect(r.accessibility!.settingsPlace).toContain("Device Control and Data Access");
  });
});

describe("a grant that outlived its build", () => {
  const none = { accessibility: false, screenRecording: false };

  it("is stale only when refused under a DIFFERENT build than the one that held it", () => {
    const history: ComputerGrantHistory = { accessibility: { build: "2.1.0+1" } };
    expect(isStaleGrant("accessibility", false, history, "2.1.1+2")).toBe(true);
    // Same build: switched off on purpose, not stale.
    expect(isStaleGrant("accessibility", false, history, "2.1.0+1")).toBe(false);
    // Held: nothing to repair.
    expect(isStaleGrant("accessibility", true, history, "2.1.1+2")).toBe(false);
    // Never seen held: an ordinary refusal.
    expect(isStaleGrant("screenRecording", false, history, "2.1.1+2")).toBe(false);
  });

  it("records the build that holds a grant, keeps a stale record, and forgets a deliberate refusal", () => {
    let h = nextGrantHistory({}, { accessibility: true, screenRecording: false }, "A");
    expect(h).toEqual({ accessibility: { build: "A" } });
    // An update to build B that macOS refuses keeps the record: that IS the stale grant.
    h = nextGrantHistory(h, none, "B");
    expect(h).toEqual({ accessibility: { build: "A" } });
    // Back on build A and refused: the user switched it off. Forget it, or the next update calls it stale.
    expect(nextGrantHistory({ accessibility: { build: "A" } }, none, "A")).toEqual({});
  });

  it("leads with Repair and says what happened", () => {
    const [a11y] = computerAccessRows(none, { helperAvailable: true, history: { accessibility: { build: "A" } }, build: "B", canReset: true });
    expect(a11y).toMatchObject({ stale: true, canRepair: true, state: "denied" });
    expect(a11y!.detail).toMatch(/stopped honouring/);
    expect(a11y!.repairExplanation).toMatch(/tccutil reset/);
  });

  it("offers Repair on any refusal it can reset, and never on a grant that works", () => {
    const rows = computerAccessRows({ accessibility: false, screenRecording: true }, { helperAvailable: true, canReset: true });
    expect(rows.find((r) => r.id === "accessibility")!.canRepair).toBe(true);
    expect(rows.find((r) => r.id === "screenRecording")!.canRepair).toBe(false);
    // No bundle id to reset: nothing offered.
    expect(computerAccessRows(none, { helperAvailable: true, canReset: false }).every((r) => !r.canRepair)).toBe(true);
  });

  it("hands tccutil only a reverse-DNS bundle id", () => {
    expect(isResettableBundleId("co.charmtechnologies.realm")).toBe(true);
    expect(isResettableBundleId("com.github.Electron")).toBe(true);
    for (const bad of [null, "", "realm", "co.realm; rm -rf ~", "-all", "co..realm", "All"]) expect(isResettableBundleId(bad as string | null), String(bad)).toBe(false);
  });
});

/**
 * The controller against a scripted helper bridge: `probe` answers from a script of grant states, as a
 * fresh helper would, and every other leg is recorded. The TCC grant itself cannot be flipped from a
 * test, so the script stands in for the user flipping the switch.
 */
function scripted(grants: ComputerGrantState[], over: Partial<ComputerAccessDeps> = {}) {
  const calls: string[] = [];
  let history: ComputerGrantHistory = {};
  let i = 0;
  const deps: ComputerAccessDeps = {
    helperAvailable: () => true,
    probe: async () => { calls.push("probe"); return grants[Math.min(i++, grants.length - 1)]!; },
    request: async (id) => { calls.push(`request:${id}`); },
    reset: async (service, bundleId) => { calls.push(`reset:${service}:${bundleId}`); },
    openSettings: (id) => { calls.push(`open:${id}`); },
    restartHelper: () => { calls.push("restart"); },
    loadHistory: () => history,
    saveHistory: (h) => { history = h; calls.push(`save:${JSON.stringify(h)}`); },
    build: "B",
    bundleId: () => "co.charmtechnologies.realm",
    macosMajor: 27,
    hostName: "Realm",
    packaged: true,
    signed: true,
    ...over,
  };
  return { access: new ComputerAccess(deps), calls, history: () => history, setHistory: (h: ComputerGrantHistory) => { history = h; } };
}

const NONE: ComputerGrantState = { accessibility: false, screenRecording: false };
const A11Y: ComputerGrantState = { accessibility: true, screenRecording: false };

describe("ComputerAccess — the section's loop", () => {
  it("Allow asks macOS and opens the pane in one click, and claims nothing it did not see", async () => {
    const { access, calls } = scripted([NONE]);
    const status = await access.allow("accessibility");
    expect(calls.filter((c) => !c.startsWith("probe") && !c.startsWith("save"))).toEqual(["request:accessibility", "open:accessibility"]);
    expect(status.rows.find((r) => r.id === "accessibility")!.state).toBe("denied");
  });

  it("Allow on a grant already held does nothing", async () => {
    const { access, calls } = scripted([A11Y]);
    await access.allow("accessibility");
    expect(calls.some((c) => c.startsWith("request") || c.startsWith("open"))).toBe(false);
  });

  it("drops the cached helper when the answer moves, so the next op reads the grant afresh", async () => {
    const { access, calls } = scripted([NONE, NONE, A11Y, A11Y]);
    await access.status();
    await access.status();
    expect(calls).not.toContain("restart");
    const flipped = await access.status();
    expect(flipped.rows.find((r) => r.id === "accessibility")!.state).toBe("granted");
    expect(calls.filter((c) => c === "restart")).toHaveLength(1);
    await access.status();
    expect(calls.filter((c) => c === "restart")).toHaveLength(1);
  });

  it("shares one probe between callers that ask at once", async () => {
    const { access, calls } = scripted([NONE]);
    await Promise.all([access.status(), access.status(), access.status()]);
    expect(calls.filter((c) => c === "probe")).toHaveLength(1);
  });

  it("remembers the build that held a grant, and calls it stale after an update macOS refuses", async () => {
    const first = scripted([A11Y], { build: "A" });
    await first.access.status();
    expect(first.history()).toEqual({ accessibility: { build: "A" } });

    const updated = scripted([NONE], { build: "B" });
    updated.setHistory(first.history());
    const row = (await updated.access.status()).rows.find((r) => r.id === "accessibility")!;
    expect(row.stale).toBe(true);
  });

  it("Repair resets ONE service for Realm's bundle id, restarts the helper, forgets the stale record, asks and opens", async () => {
    const { access, calls, setHistory, history } = scripted([NONE]);
    setHistory({ accessibility: { build: "A" } });
    await access.repair("accessibility");
    const legs = calls.filter((c) => !c.startsWith("probe") && !c.startsWith("save"));
    expect(legs).toEqual(["reset:Accessibility:co.charmtechnologies.realm", "restart", "request:accessibility", "open:accessibility"]);
    expect(history()).toEqual({});
  });

  it("names Screen Recording's service as tccutil does", async () => {
    const { access, calls } = scripted([NONE]);
    await access.repair("screenRecording");
    expect(calls).toContain("reset:ScreenCapture:co.charmtechnologies.realm");
  });

  it("refuses to reset a grant that works — it would only take away something that was fine", async () => {
    const { access, calls } = scripted([A11Y]);
    await access.repair("accessibility");
    expect(calls.some((c) => c.startsWith("reset"))).toBe(false);
  });

  it("refuses to reset without a bundle id it can trust", async () => {
    const { access, calls } = scripted([NONE], { bundleId: () => null });
    await access.repair("accessibility");
    expect(calls.some((c) => c.startsWith("reset"))).toBe(false);
  });

  it("reports whether this build is signed, which is what decides if a grant survives the next update", async () => {
    expect((await scripted([NONE], { signed: false }).access.status()).signed).toBe(false);
  });
});

describe("isComputerAccessId", () => {
  it("accepts only the two rows", () => {
    expect(isComputerAccessId("accessibility")).toBe(true);
    expect(isComputerAccessId("screenRecording")).toBe(true);
  });

  it("rejects anything else, so no IPC payload can name an arbitrary target", () => {
    for (const bad of ["fullDisk", "", null, undefined, 7, {}]) expect(isComputerAccessId(bad)).toBe(false);
  });
});

describe("the helper's forbidden-app list", () => {
  // Enforcement is in Swift, which the suite cannot call. Reading the source is the only way to
  // assert the rule at all, and drift here is silent: a bundle id present in one copy and missing
  // from the other reads as "covered" everywhere except the one process that decides.
  const swift = readFileSync(join(import.meta.dirname, "../../native/AxHelper.swift"), "utf8");
  // Anchored on the declaration rather than the name, and comment lines dropped before matching:
  // the doc comment above cites the contract's copy by name, and the prose between the entries
  // quotes an English phrase. A looser read counts either as a bundle id.
  const start = swift.indexOf("private let FORBIDDEN_BUNDLE_IDS");
  const enforced = swift
    .slice(start, swift.indexOf("\n]", start))
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .flatMap((line) => [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));

  it("matches the contract's copy exactly, in both directions", () => {
    expect([...enforced].sort()).toEqual([...COMPUTER_FORBIDDEN_BUNDLE_IDS].sort());
  });

  it("refuses the terminals people actually run, not only the two Apple and iTerm ship", () => {
    // A terminal is a shell: driving one is arbitrary code execution outside every gate Realm has,
    // so the entry that matters is whichever terminal is on THIS machine. The original list named
    // Terminal.app and iTerm only, and its live check asserted their absence from a machine running
    // neither — a green that proved nothing while Ghostty sat in the app list, driveable.
    for (const id of ["com.mitchellh.ghostty", "net.kovidgoyal.kitty", "com.github.wez.wezterm", "org.alacritty"])
      expect(enforced, id).toContain(id);
  });
});
