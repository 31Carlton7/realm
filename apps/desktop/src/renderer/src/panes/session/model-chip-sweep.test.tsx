import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ModelPicker } from "./ModelPicker";
import { modelRows } from "./model-rows";

afterEach(cleanup);

const rows = modelRows({ kind: "claude", model: null, canSwitchAgent: false, agentProbe: [] });

const chip = () => screen.getByRole("button", { name: "Model" });
const picker = (effort: string | null, eggs: boolean) => (
  <ModelPicker kind="claude" model={null} effort={effort} rows={rows} info={{}}
    onToggleFavorite={() => {}} onPick={() => {}} effortItems={[]} eggs={eggs} />
);

describe("the chip answers when the session commits to a heavy effort", () => {
  it("marks the chip on the way up to Max, and unmarks it when the animation ends", () => {
    // The popover is already closing when this lands, which is why the mark goes on the CHIP: the
    // control that changed outlives the one that changed it.
    const { rerender } = render(picker("high", true));
    expect(chip()).not.toHaveAttribute("data-sweep");
    rerender(picker("max", true));
    expect(chip()).toHaveAttribute("data-sweep", "max");
    // THE stuck-attribute mutant: set it and never take it off. The gradient would sit on the chip
    // for the rest of the session, and the next heavy pick would replay nothing.
    fireEvent.animationEnd(chip());
    expect(chip()).not.toHaveAttribute("data-sweep");
  });

  it("says nothing for the levels that are not heavy, or on a re-render that changed nothing", () => {
    const { rerender } = render(picker("max", true));
    // Mounted at Max rather than moved to it: nothing was committed here, so nothing answers.
    expect(chip()).not.toHaveAttribute("data-sweep");
    rerender(picker("low", true));
    expect(chip()).not.toHaveAttribute("data-sweep");
    rerender(picker("high", true));
    expect(chip()).not.toHaveAttribute("data-sweep");
  });

  it("stays out of it entirely with the eggs off", () => {
    const { rerender } = render(picker("high", false));
    rerender(picker("max", false));
    expect(chip()).not.toHaveAttribute("data-sweep");
  });
});
