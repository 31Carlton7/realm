import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMPUTER_FORBIDDEN_BUNDLE_IDS } from "@realm/contracts";
import { describe, expect, it } from "vitest";
import { computerAccessRows, computerGrantExplanation, isComputerAccessId } from "./computer-access";

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
    for (const grants of [{ accessibility: true, screenRecording: false }, { accessibility: false, screenRecording: true }]) {
      expect(computerAccessRows(grants, { helperAvailable: true }).every((r) => r.state !== "unknown")).toBe(true);
    }
  });

  it("lists Accessibility first — it is the one that gates everything", () => {
    expect(computerAccessRows({ accessibility: false, screenRecording: false }, { helperAvailable: true }).map((r) => r.id))
      .toEqual(["accessibility", "screenRecording"]);
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
