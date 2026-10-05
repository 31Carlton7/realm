import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { createPortal } from "react-dom";
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

/** `.panel` and `.page` declare `container-type: inline-size`. Layout containment makes such an
 *  element the containing block for `position: fixed` descendants AND — on `.panel`, which also sets
 *  `overflow: hidden` — a clipper. jsdom has no layout, so the geometry is unobservable here; what IS
 *  observable, and what the geometry depends on entirely, is that the backdrop is not a descendant of
 *  the pane that opened it. Drop the `createPortal` in Sheet.tsx and both of these fail. */
describe("Sheet escapes its opener's containment", () => {
  it("MUTANT: the backdrop mounts on document.body, not inside the pane that rendered it", () => {
    const { container } = render(
      <div className="panel">
        <div className="page">
          <Sheet title="Add an MCP server" onClose={() => {}} width={560}>x</Sheet>
        </div>
      </div>);
    const backdrop = document.querySelector(".sheet-backdrop")!;
    expect(backdrop).not.toBeNull();
    expect(backdrop.parentElement).toBe(document.body);
    expect(container.querySelector(".sheet-backdrop")).toBeNull();
    expect(container.querySelector(".page")!.contains(backdrop)).toBe(false);
  });

  it("the panel still rides inside that portalled backdrop", () => {
    render(
      <div className="panel">
        <Sheet title="Nested" onClose={() => {}} width={420}>x</Sheet>
      </div>);
    const panel = screen.getByRole("dialog");
    expect(panel.closest(".sheet-backdrop")).not.toBeNull();
    expect(panel.closest(".panel")).toBeNull(); // the whole point: no containment ancestor above it
  });
});

/** A popover a control in the panel opens is portalled to the body, outside the panel, and answers
 *  its own Escape — the icon picker in the New space sheet is the case. Both listen on window and
 *  the sheet was registered first, so the key that closed the picker closed the sheet under it too. */
describe("Escape, with a popover open over the sheet", () => {
  function Picker() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Change icon</button>
        {open && createPortal(<div role="dialog" aria-label="Choose an icon"><input aria-label="Search icons" /></div>, document.body)}
      </>
    );
  }

  it("MUTANT: while a control's popup is open the key is the popup's — from the popup or from the control — and after, the sheet's", () => {
    const closed: string[] = [];
    render(<Sheet title="New space" onClose={() => closed.push("sheet")}><input aria-label="Name" /><Picker /></Sheet>);
    const search = screen.getByRole("textbox", { name: "Search icons" });
    expect(screen.getByRole("dialog", { name: "New space" }).contains(search)).toBe(false);
    search.focus();
    fireEvent.keyDown(search, { key: "Escape" });
    // Outside jsdom the picker's field may not have the keyboard yet; the trigger still says it is open.
    const trigger = screen.getByRole("button", { name: "Change icon" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(closed).toEqual([]);
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog", { name: "Choose an icon" })).toBeNull();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(closed).toEqual(["sheet"]);
  });
});

describe("closing a sheet gives the keyboard back", () => {
  const outside = (tag: "button" | "textarea") => document.body.appendChild(document.createElement(tag));

  it("to the control that opened it, when the sheet still had it", () => {
    const opener = outside("button"); opener.focus();
    const { unmount } = render(<Sheet title="New space" onClose={() => {}}><input aria-label="Name" /></Sheet>);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("MUTANT: but not away from something outside it that took the keyboard since — the session New space opened", () => {
    const opener = outside("button"); opener.focus();
    const composer = outside("textarea");
    const { unmount } = render(<Sheet title="New space" onClose={() => {}}><input aria-label="Name" /></Sheet>);
    composer.focus();
    unmount();
    expect(document.activeElement).toBe(composer);
    opener.remove(); composer.remove();
  });
});
