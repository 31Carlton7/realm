import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Menu, type MenuItem } from "./Menu";

function mount(items: MenuItem[], over: Partial<Parameters<typeof Menu>[0]> = {}) {
  const onClose = vi.fn();
  const r = render(<Menu items={items} onClose={onClose} label="Test menu" {...over} />);
  return { onClose, ...r };
}

const plain = (label: string, onSelect = () => {}): MenuItem => ({ label, onSelect });

describe("Menu keyboard (U-M10/A-H3)", () => {
  it("focuses the first enabled item on open; ArrowDown/Up cycle with wrap, skipping disabled items", () => {
    mount([
      { label: "First", onSelect: () => {}, disabled: true },
      plain("Second"), plain("Third"),
    ]);
    expect(screen.getByRole("menuitem", { name: "Second" })).toHaveFocus(); // first *enabled*
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Third" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" }); // wraps past the disabled head
    expect(screen.getByRole("menuitem", { name: "Second" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" }); // wraps backwards
    expect(screen.getByRole("menuitem", { name: "Third" })).toHaveFocus();
  });

  it("Home/End jump to the first/last enabled item", () => {
    mount([plain("A"), plain("B"), plain("C")]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "End" });
    expect(screen.getByRole("menuitem", { name: "C" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Home" });
    expect(screen.getByRole("menuitem", { name: "A" })).toHaveFocus();
  });

  it("Enter and Space select the focused item and close the menu", () => {
    const picked: string[] = [];
    const { onClose } = mount([plain("A", () => picked.push("A")), plain("B", () => picked.push("B"))]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Enter" });
    expect(picked).toEqual(["B"]);
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowUp" });
    fireEvent.keyDown(screen.getByRole("menu"), { key: " " });
    expect(picked).toEqual(["B", "A"]);
  });

  it("restores focus to the element focused at mount (the trigger) when it closes", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = mount([plain("A")]);
    expect(screen.getByRole("menuitem", { name: "A" })).toHaveFocus(); // focus moved in
    unmount();
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it("returnFocusRef wins over the captured element", () => {
    const other = document.createElement("button");
    document.body.appendChild(other);
    const { unmount } = mount([plain("A")], { returnFocusRef: { current: other } });
    unmount();
    expect(other).toHaveFocus();
    other.remove();
  });

  it("checked items are menuitemcheckbox with aria-checked and an icon check (no ✓ glyph)", () => {
    mount([
      { label: "Dark", checked: true, onSelect: () => {} },
      { label: "Light", checked: false, onSelect: () => {} },
      plain("Plain"),
    ]);
    expect(screen.getByRole("menuitemcheckbox", { name: "Dark" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemcheckbox", { name: "Light" })).toHaveAttribute("aria-checked", "false");
    const plainItem = screen.getByRole("menuitem", { name: "Plain" });
    expect(plainItem).not.toHaveAttribute("aria-checked");
    expect(screen.getByRole("menuitemcheckbox", { name: "Dark" }).querySelector("svg")).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Light" }).querySelector("svg")).toBeNull();
  });

  it("renders the kbd hint column from the item's kbd prop", () => {
    mount([{ label: "Close", kbd: "⌘W", onSelect: () => {} }]);
    const item = screen.getByRole("menuitem", { name: /Close/ });
    expect(item.querySelector("kbd.menu-kbd")).toHaveTextContent("⌘W");
  });
});
