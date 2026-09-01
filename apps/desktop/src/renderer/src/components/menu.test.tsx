import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { Menu, type MenuItem } from "./Menu";
import { StoreContext, createAppStore } from "../state/store";
import { fakeApi } from "../state/store.test-fakes";

function mount(items: MenuItem[], over: Partial<Parameters<typeof Menu>[0]> = {}) {
  const onClose = vi.fn();
  const r = render(<Menu items={items} onClose={onClose} label="Test menu" {...over} />);
  return { onClose, ...r };
}

const plain = (label: string, onSelect = () => {}): MenuItem => ({ label, onSelect });

describe("Menu placement", () => {
  const rect = (top: number, height: number, left = 100, width = 50) =>
    ({ top, bottom: top + height, left, right: left + width, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

  /** jsdom has no layout, so BOTH rects have to be faked: the anchor's (own property, per element)
   *  and the menu's own (prototype spy, since the element is created inside the portal). A 0-height
   *  menu would make `top = a.top - height - 4` indistinguishable from `top = a.top - 4` — i.e. it
   *  would not test up-placement at all. */
  const MENU_H = 120;
  const anchor = (top = 500, left = 100) => {
    const el = document.createElement("button");
    el.getBoundingClientRect = () => rect(top, 20, left);
    document.body.appendChild(el);
    return { current: el };
  };
  const withMenuHeight = () => {
    const orig = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return this.classList.contains("menu") ? rect(0, MENU_H, 0, 160) : orig.call(this);
    });
  };
  afterEach(() => vi.restoreAllMocks());

  it("default placement opens below the anchor", () => {
    withMenuHeight();
    mount([plain("A")], { anchorRef: anchor() });
    expect(screen.getByRole("menu").style.top).toBe("524px"); // anchor.bottom + 4
  });

  it("placement='up' subtracts the menu's own height so it clears the trigger", () => {
    withMenuHeight();
    mount([plain("A")], { anchorRef: anchor(), placement: "up" });
    // 500 - 120 - 4: the menu's BOTTOM sits 4px above the trigger's top. Forgetting the height term
    // yields 496 and the menu covers its own chip.
    expect(screen.getByRole("menu").style.top).toBe("376px");
  });

  it("placement='up' flips below when there is no room above", () => {
    withMenuHeight();
    mount([plain("A")], { anchorRef: anchor(2), placement: "up" }); // 2 - 120 - 4 is off-screen
    expect(screen.getByRole("menu").style.top).toBe("26px"); // flipped: anchor.bottom + 4
  });

  /** W2 (Plan 11): the same placement, with browser view rects to avoid. The store carries the
   *  rects; the MENU's own rect is mocked non-zero (a 0×0 menu would make every position "clear"
   *  and the tests hollow — the exact failure a past review caught). jsdom window: 1024×768. */
  describe("browser-rect avoidance (no-overlay)", () => {
    const withRects = (rects: { x: number; y: number; width: number; height: number }[]) => {
      const store = createAppStore(fakeApi());
      rects.forEach((r2, i) => store.getState().setBrowserRect(`b${i}`, r2));
      return store;
    };
    const mountAvoiding = (rects: { x: number; y: number; width: number; height: number }[], over: Partial<Parameters<typeof Menu>[0]>) => {
      render(
        <StoreContext.Provider value={withRects(rects)}>
          <Menu items={[plain("A")]} onClose={() => {}} label="Avoiding menu" {...over} />
        </StoreContext.Provider>);
    };

    it("a menu whose normal below-placement lands in a view flips above instead", () => {
      withMenuHeight();
      mountAvoiding([{ x: 0, y: 330, width: 1024, height: 400 }], { anchorRef: anchor(300) });
      const m = screen.getByRole("menu");
      expect(m.style.top).toBe("176px"); // 300 - 120 - 4: rect-driven flip, not window-driven
      expect(m.style.left).toBe("100px");
      expect(m.style.transformOrigin).toBe("bottom left");
    });

    it("MUTANT: near the bottom edge it must not flip INTO the view above — it slides along the edge", () => {
      withMenuHeight();
      // No room below (window 768); the view covers x0–600 over the whole flip zone. The pre-W2
      // rule would put the menu at (100, 576) — inside the view. It must slide clear instead.
      const view = { x: 0, y: 200, width: 600, height: 560 };
      mountAvoiding([view], { anchorRef: anchor(700) });
      const m = screen.getByRole("menu");
      expect(m.style.left).toBe("606px"); // just past the view's right edge (600 + 6)
      expect(m.style.top).toBe("576px"); // still on the preferred (flipped-up) side of the anchor
      // The placed rect really is clear of the view.
      const left = parseFloat(m.style.left), top = parseFloat(m.style.top);
      const overlaps = left < view.x + view.width && view.x < left + 160 && top < view.y + view.height && view.y < top + 120;
      expect(overlaps).toBe(false);
    });

    it("TWO views: the seam between them is not treated as clear (union, not per-rect)", () => {
      withMenuHeight();
      // Two views tile 200–1024; the only clear column is 0–200. A per-rect slide could land at
      // 446 (right of view 1, "clear" of it) — inside view 2.
      mountAvoiding(
        [{ x: 200, y: 0, width: 400, height: 768 }, { x: 600, y: 0, width: 424, height: 768 }],
        { anchorRef: anchor(300, 400) });
      const m = screen.getByRole("menu");
      expect(m.style.left).toBe("34px"); // 200 - 160 - 6: left of the whole union
    });
  });

  /** §6 wants the 140ms scale-in "origin-aware": the menu has to grow out of the corner it is
   *  anchored to, which means the origin has to follow both `align` and whichever way it flipped. */
  describe("transform-origin follows where the menu actually landed", () => {
    const origin = () => screen.getByRole("menu").style.transformOrigin;

    it("below a left-aligned trigger: grows down from its top-left", () => {
      withMenuHeight();
      mount([plain("A")], { anchorRef: anchor() });
      expect(origin()).toBe("top left");
    });

    it("right-aligned: grows from the right edge, where the trigger is", () => {
      withMenuHeight();
      mount([plain("A")], { anchorRef: anchor(), align: "right" });
      expect(origin()).toBe("top right");
    });

    it("opening upward: grows from the BOTTOM edge — the corner nearest the trigger", () => {
      withMenuHeight();
      mount([plain("A")], { anchorRef: anchor(), placement: "up" });
      expect(origin()).toBe("bottom left");
    });

    it("a menu that flips below because there is no room above grows downward again", () => {
      withMenuHeight();
      mount([plain("A")], { anchorRef: anchor(2), placement: "up" });
      expect(origin()).toBe("top left");
    });

    it("a point-placed context menu grows from the click point", () => {
      withMenuHeight();
      mount([plain("A")], { at: { x: 40, y: 40 } });
      expect(origin()).toBe("top left");
    });
  });
});

describe("Menu dismissal by its own trigger (I6)", () => {
  /** The regression: Menu's window pointerdown handler fires on the trigger — which lives outside the
   *  portal — closing the menu just before the trigger's own click reopens it. Net effect for the user:
   *  the menu never dismisses, it flickers and focus ping-pongs. Reproduced as the real event sequence. */
  function Harness() {
    const btn = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    return (
      <>
        <button ref={btn} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Trigger</button>
        {open && <Menu items={[plain("A")]} onClose={() => setOpen(false)} anchorRef={btn} label="Harness menu" />}
      </>
    );
  }
  /** What a real pointer does: pointerdown (which Menu listens for on window) then click. */
  const press = (el: HTMLElement) => { fireEvent.pointerDown(el); fireEvent.click(el); };
  /** Menu attaches its outside-pointerdown listener on a 0ms timeout (so the opening click doesn't
   *  immediately close it). Without flushing that, this test would pass with the bug still present. */
  const armed = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  it("a second press on the trigger closes the menu instead of reopening it", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Trigger" });
    press(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await armed();
    press(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
    press(trigger); // and it still opens again afterwards — not stuck closed
    expect(screen.getByRole("menu")).toBeInTheDocument();
  });

  it("a pointerdown anywhere else still closes it", async () => {
    render(<Harness />);
    press(screen.getByRole("button", { name: "Trigger" }));
    await armed();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

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
