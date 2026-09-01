import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Sheet } from "./Sheet";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi } from "../state/store.test-fakes";

/** jsdom window is 1024×768; rects are seeded through the store like the real pane does. */
const withRects = (rects: { x: number; y: number; width: number; height: number }[]) => {
  const store = createAppStore(fakeApi());
  rects.forEach((r, i) => store.getState().setBrowserRect(`b${i}`, r));
  return store;
};

describe("Sheet no-overlay centering (W2)", () => {
  it("without browser rects: plain CSS centering, only the width is inline", () => {
    render(<Sheet title="Plain" onClose={() => {}} width={420}>x</Sheet>);
    const panel = screen.getByRole("dialog");
    expect(panel.style.width).toBe("420px");
    expect(panel.style.position).toBe(""); // the backdrop's grid centering stays in charge
  });

  it("MUTANT: with a browser view on the right half, the sheet must NOT center over it", () => {
    const view = { x: 512, y: 40, width: 512, height: 728 };
    render(
      <StoreContext.Provider value={withRects([view])}>
        <Sheet title="Avoiding" onClose={() => {}} width={420}>x</Sheet>
      </StoreContext.Provider>);
    const panel = screen.getByRole("dialog");
    // Window-centered would be (1024-420)/2 = 302 → right edge 722, deep inside the view.
    expect(panel.style.left).toBe("46px"); // centered over the 0–512 complement: (512-420)/2
    expect(panel.style.width).toBe("420px");
    const left = parseFloat(panel.style.left);
    expect(left + 420).toBeLessThanOrEqual(view.x); // fully clear of the view
  });

  it("column narrower than the sheet: the sheet shrinks into the column (backstop under the snap)", () => {
    render(
      <StoreContext.Provider value={withRects([{ x: 300, y: 0, width: 724, height: 768 }])}>
        <Sheet title="Squeezed" onClose={() => {}} width={420}>x</Sheet>
      </StoreContext.Provider>);
    const panel = screen.getByRole("dialog");
    expect(panel.style.width).toBe("276px"); // 300 - 2*12
    expect(parseFloat(panel.style.left) + 276).toBeLessThanOrEqual(300);
  });

  it("MUTANT: TWO browser panes — centered against the union's complement, not the seam", () => {
    const views = [{ x: 200, y: 0, width: 400, height: 768 }, { x: 600, y: 0, width: 424, height: 768 }];
    render(
      <StoreContext.Provider value={withRects(views)}>
        <Sheet title="Two panes" onClose={() => {}} width={420}>x</Sheet>
      </StoreContext.Provider>);
    const panel = screen.getByRole("dialog");
    const left = parseFloat(panel.style.left);
    const w = parseFloat(panel.style.width);
    expect(left + w).toBeLessThanOrEqual(200); // entirely inside the only truly free column
  });
});
