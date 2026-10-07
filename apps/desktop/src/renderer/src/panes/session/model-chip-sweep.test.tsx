import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ModelPicker } from "./ModelPicker";
import { modelRows, type FastMode } from "./model-catalog";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); delete document.documentElement.dataset.quiet; });

const rows = modelRows({ kind: "claude", model: null, canSwitchAgent: false, agentProbe: [] });

const chip = () => screen.getByRole("button", { name: "Model" });
/** jsdom has no AnimationEvent, so the name the handler reads is stated on a plain event. */
const ended = (animationName: string) => {
  const e = new Event("animationend", { bubbles: true });
  Object.defineProperty(e, "animationName", { value: animationName });
  act(() => { chip().dispatchEvent(e); });
};
const LEVELS = ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, label: id }));
const fast = (on: boolean): FastMode => ({ on, state: null, reason: null, requested: null, onChange: () => {},
  availability: { state: "offered", source: "session" }, tip: "Fast mode: faster responses, at a higher cost." });
const picker = (effort: string | null, fastOn = false, eggs = false) => (
  <ModelPicker kind="claude" model={null} effort={{ levels: LEVELS, value: effort, defaultId: "high", onChange: () => {} }} rows={rows} info={{}}
    onToggleFavorite={() => {}} onPick={() => {}} fast={fast(fastOn)} eggs={eggs} />
);

describe("the chip answers when the session commits to more", () => {
  it("marks the chip on the way up to Max, and unmarks it when the animation ends", () => {
    // The popover is already closing when this lands, which is why the mark goes on the CHIP: the
    // control that changed outlives the one that changed it.
    const { rerender } = render(picker("high"));
    expect(chip()).not.toHaveAttribute("data-sweep");
    rerender(picker("max"));
    expect(chip()).toHaveAttribute("data-sweep", "max");
    // THE stuck-attribute mutant: set it and never take it off. The gradient would sit on the chip
    // for the rest of the session, and the next heavy pick would replay nothing.
    // …and only on the SWEEP's end. The chip is focusable, so the focus ring's shorter halo can end on
    // it first; that one taking the mark off would cut the sweep short.
    ended("rl-focus-ring");
    expect(chip()).toHaveAttribute("data-sweep", "max");
    ended("rl-chip-sweep");
    expect(chip()).not.toHaveAttribute("data-sweep");
  });

  it("says nothing for the levels that are not heavy, or on a re-render that changed nothing", () => {
    const { rerender } = render(picker("max"));
    // Mounted at Max rather than moved to it: nothing was committed here, so nothing answers.
    expect(chip()).not.toHaveAttribute("data-sweep");
    rerender(picker("low"));
    expect(chip()).not.toHaveAttribute("data-sweep");
    rerender(picker("high"));
    expect(chip()).not.toHaveAttribute("data-sweep");
  });

  it("is everyone's now, the eggs' switch or not — the eggs run the light hot, they do not own it", () => {
    const { rerender } = render(picker("high", false, false));
    rerender(picker("xhigh", false, false));
    expect(chip()).toHaveAttribute("data-sweep", "xhigh");
  });

  it("glints when fast mode is switched on, through the same one mark, and is quiet when it goes off", () => {
    // One mechanism for both: the chip has one `animation`, and a second one claiming it would cancel
    // the first. THE MUTANT: a separate attribute per moment, which is two animations on one property.
    const { rerender } = render(picker("high"));
    rerender(picker("high", true));
    expect(chip()).toHaveAttribute("data-sweep", "fast");
    ended("rl-chip-sweep");
    rerender(picker("high", false));
    expect(chip()).not.toHaveAttribute("data-sweep");
  });

  it("plays nothing with motion held still, by the reader or by Low power", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    const { rerender } = render(picker("high"));
    rerender(picker("max"));
    expect(chip()).not.toHaveAttribute("data-sweep");
    vi.unstubAllGlobals();
    document.documentElement.dataset.quiet = "always";
    rerender(picker("max", true));
    expect(chip()).not.toHaveAttribute("data-sweep");
  });
});
