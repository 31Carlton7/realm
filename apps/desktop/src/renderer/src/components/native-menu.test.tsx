import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { Menu, type MenuItem } from "./Menu";
import { acceleratorFor, menuLabelText } from "./native-menu";

type Bridge = { popupMenu: ReturnType<typeof vi.fn>; closeMenu: ReturnType<typeof vi.fn> };
const install = (answers: (string | null)[]): Bridge => {
  const bridge = {
    popupMenu: vi.fn(() => Promise.resolve(answers.shift() ?? null)),
    closeMenu: vi.fn(() => Promise.resolve()),
  };
  (window as { realm?: unknown }).realm = bridge;
  return bridge;
};
afterEach(() => { cleanup(); delete (window as { realm?: unknown }).realm; });

describe("shortcut hints as accelerators", () => {
  it("reads every hint the app prints, and drops the ones it cannot", () => {
    expect(acceleratorFor("⌘W")).toBe("Command+W");
    expect(acceleratorFor("⌘⇧F")).toBe("Command+Shift+F");
    expect(acceleratorFor("⌘⇧Space")).toBe("Command+Shift+Space");
    expect(acceleratorFor("⌘\\")).toBe("Command+\\");
    expect(acceleratorFor("⌘⌫")).toBe("Command+Backspace");
    expect(acceleratorFor("⇧⏎")).toBe("Shift+Return");
    expect(acceleratorFor("⏎")).toBe("Return");
    expect(acceleratorFor("⌘u")).toBe("Command+U");
    // A wrong shortcut on a menu is worse than none.
    expect(acceleratorFor("⌘click")).toBeUndefined();
    expect(acceleratorFor("")).toBeUndefined();
  });

  it("joins a label's separate runs of text the way a menu joins a name to its detail", () => {
    const el = document.createElement("span");
    el.innerHTML = '<span>Mode <span class="v"><svg></svg>Ask</span></span>';
    expect(menuLabelText(el)).toBe("Mode — Ask");
  });
});

describe("Menu as an OS menu", () => {
  it("sends the rows as the OS can draw them, then runs the pick and closes", async () => {
    const bridge = install(["2"]);
    const rename = vi.fn(), pin = vi.fn(), onClose = vi.fn();
    const items: MenuItem[] = [
      { label: <strong>Rename</strong>, kbd: "⌘R", onSelect: rename },
      { kind: "separator" },
      { label: "Pinned", checked: true, title: "Keep it at the top", onSelect: pin },
      { label: "Archive", disabled: true, onSelect: () => {} },
    ];
    render(<Menu items={items} onClose={onClose} at={{ x: 40, y: 60 }} />);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    const [spec, at] = bridge.popupMenu.mock.calls[0]!;
    expect(at).toEqual({ x: 40, y: 60 });
    expect(spec).toEqual([
      { id: "0", label: "Rename", enabled: true, accelerator: "Command+R" },
      { separator: true },
      { id: "2", label: "Pinned", enabled: true, checked: true, toolTip: "Keep it at the top" },
      { id: "3", label: "Archive", enabled: false },
    ]);
    expect(pin).toHaveBeenCalledOnce();
    expect(rename).not.toHaveBeenCalled();
    // The drawn menu never appeared: there is one menu, and it is the OS's.
    expect(document.querySelector(".menu")).toBeNull();
  });

  it("closes without running anything when nothing was picked", async () => {
    install([null]);
    const pick = vi.fn(), onClose = vi.fn();
    render(<Menu items={[{ label: "A", onSelect: pick }]} onClose={onClose} at={{ x: 0, y: 0 }} />);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(pick).not.toHaveBeenCalled();
  });

  /* THE mutant: a keepOpen pick closing the menu, which would turn every two-step confirm into a
     one-step menu that silently did nothing. */
  it("opens again with the rebuilt rows after a keepOpen pick", async () => {
    const bridge = install(["0", "0"]);
    const onClose = vi.fn(), del = vi.fn();
    function Confirming() {
      const [armed, setArmed] = useState(false);
      const items: MenuItem[] = armed
        ? [{ label: "Really delete?", danger: true, onSelect: del }]
        : [{ label: "Delete", keepOpen: true, onSelect: () => setArmed(true) }];
      return <Menu items={items} onClose={onClose} at={{ x: 0, y: 0 }} />;
    }
    render(<Confirming />);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(bridge.popupMenu).toHaveBeenCalledTimes(2);
    expect(bridge.popupMenu.mock.calls[1]![0]).toEqual([{ id: "0", label: "Really delete?", enabled: true }]);
    expect(del).toHaveBeenCalledOnce();
  });

  it("anchors under its control, and takes the OS menu down if its owner goes first", async () => {
    let settle: (v: string | null) => void = () => {};
    const bridge = install([]);
    bridge.popupMenu.mockImplementation(() => new Promise((r) => { settle = r; }));
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    anchor.getBoundingClientRect = () => ({ left: 10, bottom: 30, top: 0, right: 40, width: 30, height: 30, x: 10, y: 0, toJSON: () => ({}) });
    const { unmount } = render(<Menu items={[{ label: "A", onSelect: () => {} }]} onClose={() => {}} anchorRef={{ current: anchor }} />);
    await waitFor(() => expect(bridge.popupMenu).toHaveBeenCalledOnce());
    expect(bridge.popupMenu.mock.calls[0]![1]).toEqual({ x: 10, y: 34 });
    unmount();
    expect(bridge.closeMenu).toHaveBeenCalledOnce();
    await act(async () => settle(null));
    anchor.remove();
  });
});
