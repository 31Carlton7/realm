import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { PANEL_MIN_WIDTH, PANE_DIVIDER } from "@realm/contracts";
import { PanelEdge } from "./PanelEdge";

/**
 * The side panel's left edge: a separator whose range is the room — the panel's floor at one end, the
 * main panes at theirs at the other — and whose value is remembered as a share of the main area.
 */
function edge(over: Partial<Parameters<typeof PanelEdge>[0]> = {}) {
  const onResize = vi.fn();
  const column = createRef<HTMLDivElement>();
  render(<PanelEdge width={600} roomWidth={1200} need={281} column={column} onResize={onResize} {...over} />);
  return { onResize, sep: screen.getByRole("separator", { name: "Side panel width" }) };
}

describe("the side panel's edge", () => {
  it("is a separator with the panel's width as its value and the room as its range", () => {
    const { sep } = edge();
    expect(sep).toHaveAttribute("aria-valuenow", "600");
    expect(sep).toHaveAttribute("aria-valuemin", String(PANEL_MIN_WIDTH));
    expect(sep).toHaveAttribute("aria-valuemax", String(1200 - 281 - PANE_DIVIDER));
    expect(sep).toHaveAttribute("aria-orientation", "vertical");
  });

  it("moves with the arrows — left widens, since it is the panel's left edge — and commits a share", () => {
    const { sep, onResize } = edge();
    fireEvent.keyDown(sep, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenLastCalledWith(616 / 1200, { commit: true });
    fireEvent.keyDown(sep, { key: "ArrowRight", shiftKey: true });
    expect(onResize).toHaveBeenLastCalledWith(599 / 1200, { commit: true });
  });

  it("stops at both ends of the room: the panel's floor, and the main panes at theirs", () => {
    // THE MUTANT: no clamp. Home would take the panes below their floor; End the panel below its own.
    const { sep, onResize } = edge();
    fireEvent.keyDown(sep, { key: "Home" });
    expect(onResize).toHaveBeenLastCalledWith((1200 - 281 - PANE_DIVIDER) / 1200, { commit: true });
    fireEvent.keyDown(sep, { key: "End" });
    expect(onResize).toHaveBeenLastCalledWith(PANEL_MIN_WIDTH / 1200, { commit: true });
  });

  it("an arrow at the panes' end stays there", () => {
    const max = 1200 - 281 - PANE_DIVIDER;
    const wide = edge({ width: max });
    fireEvent.keyDown(wide.sep, { key: "ArrowLeft" });
    expect(wide.onResize).toHaveBeenLastCalledWith(max / 1200, { commit: true });
  });

  it("an arrow at the panel's floor stays at the floor", () => {
    const narrow = edge({ width: PANEL_MIN_WIDTH });
    fireEvent.keyDown(narrow.sep, { key: "ArrowRight" });
    expect(narrow.onResize).toHaveBeenLastCalledWith(PANEL_MIN_WIDTH / 1200, { commit: true });
  });

  it("goes back to half on a double-click", () => {
    const { sep, onResize } = edge();
    fireEvent.doubleClick(sep);
    expect(onResize).toHaveBeenLastCalledWith(0.5, { commit: true });
  });
});
