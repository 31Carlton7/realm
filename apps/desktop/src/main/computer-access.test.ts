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
