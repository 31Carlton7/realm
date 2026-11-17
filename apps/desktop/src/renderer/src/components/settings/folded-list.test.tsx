import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FoldedList } from "./FoldedList";

const NAMES = ["Ash", "Birch", "Cedar", "Elm", "Fir", "Hazel", "Larch", "Maple", "Oak", "Yew"];

function Trees({ chosen, names = NAMES }: { chosen: string | null; names?: string[] }) {
  return (
    <FoldedList items={names} keyOf={(n) => n} chosen={chosen} listClass="tree-grid" label="Trees"
      render={(n) => <label><input type="radio" name="tree" value={n} checked={chosen === n} readOnly />{n}</label>} />
  );
}

const shownNames = () => [...document.querySelector(".fold-group > .tree-grid")!.querySelectorAll("label")].map((l) => l.textContent);
const rest = () => document.querySelector(".fold-rest")!;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("FoldedList", () => {
  it("shows three rows, then opens the rest in place on Show all and folds it again on Show fewer", () => {
    // THE MUTANTS: a fourth row shown; the rest left reachable while folded; a count of the hidden
    // ones only, where the convention is the whole list's; a Show all that never closes.
    render(<Trees chosen="Ash" />);
    expect(shownNames()).toEqual(["Ash", "Birch", "Cedar"]);
    expect(rest()).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "Show all 10" }));
    expect(rest()).not.toHaveAttribute("inert");
    expect(rest()).toHaveAttribute("data-open");
    expect(screen.getByRole("radio", { name: "Yew" })).toBeInTheDocument();
    const fewer = screen.getByRole("button", { name: "Show fewer" });
    expect(fewer).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(fewer);
    expect(rest()).toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Show all 10" })).toHaveAttribute("aria-expanded", "false");
  });

  it("counts a row as every column the grid lays out", () => {
    // THE MUTANT: three items, whatever the width: a wide pane would show one short row of a grid.
    vi.spyOn(window, "getComputedStyle").mockReturnValue({ gridTemplateColumns: "116px 116px" } as CSSStyleDeclaration);
    render(<Trees chosen="Ash" />);
    expect(shownNames()).toEqual(["Ash", "Birch", "Cedar", "Elm", "Fir", "Hazel"]);
  });

  it("keeps the chosen item in the rows shown, and holds the order still while it is open", () => {
    // THE MUTANTS: a choice past the fold hidden under Show all; the order following the choice while
    // open, which moves the tile just picked out from under the pointer.
    const { rerender } = render(<Trees chosen="Oak" />);
    expect(shownNames()).toEqual(["Ash", "Birch", "Oak"]);
    fireEvent.click(screen.getByRole("button", { name: "Show all 10" }));
    rerender(<Trees chosen="Larch" />);
    expect(shownNames()).toEqual(["Ash", "Birch", "Oak"]);
    fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
    expect(shownNames()).toEqual(["Ash", "Birch", "Larch"]);
  });

  it("draws no Show all for a list that fits in three rows", () => {
    render(<Trees chosen={null} names={NAMES.slice(0, 3)} />);
    expect(screen.queryByRole("button", { name: /^Show all/ })).toBeNull();
    expect(document.querySelector(".fold-rest")).toBeNull();
  });
});
