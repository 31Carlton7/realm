import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTooltips, splitShortcut, TIP_DELAY_MS, TIP_WARM_MS } from "./tooltips";
import type { Rect } from "./state/no-overlay";

let uninstall: () => void = () => {};
let views: Rect[] = [];
beforeEach(() => { vi.useFakeTimers(); views = []; });
afterEach(() => { uninstall(); document.body.innerHTML = ""; vi.useRealTimers(); });

const setup = (html: string) => {
  document.body.innerHTML = html;
  uninstall = installTooltips(document, { avoid: () => views });
};
const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const tip = () => $(".tooltip");
const open = () => tip().hasAttribute("data-open");
/** jsdom has no PointerEvent; a MouseEvent under a pointer event's name carries everything read. */
const fire = (el: EventTarget, type: string, init: MouseEventInit = {}) => {
  const e = new MouseEvent(type, { bubbles: true, ...init });
  Object.defineProperty(e, "pointerType", { value: "mouse" });
  el.dispatchEvent(e);
};
const hover = (el: Element) => fire(el, "pointerover");
/** A title written or removed while held is reported by a MutationObserver, on a microtask. */
const observed = () => Promise.resolve();

describe("splitShortcut", () => {
  it("reads a trailing chord in brackets as the key, and leaves words in brackets alone", () => {
    expect(splitShortcut("Search (⌘K)")).toEqual({ label: "Search", shortcut: "⌘K" });
    expect(splitShortcut("Split down (⌘⇧\\)")).toEqual({ label: "Split down", shortcut: "⌘⇧\\" });
    expect(splitShortcut("Focus — fill the space (⌘⇧F)")).toEqual({ label: "Focus — fill the space", shortcut: "⌘⇧F" });
    expect(splitShortcut("Commit, push and open a pull request (⌘↵)")).toEqual({ label: "Commit, push and open a pull request", shortcut: "⌘↵" });
    expect(splitShortcut("Open the overview (⌘⇧Space)").shortcut).toBe("⌘⇧Space");
    expect(splitShortcut("Stop (interrupt)")).toEqual({ label: "Stop (interrupt)", shortcut: null });
    expect(splitShortcut("Saved (2 files)").shortcut).toBeNull();
  });
  it("reads the spelled-out chords Linux and Windows print", () => {
    expect(splitShortcut("Search (Ctrl+K)")).toEqual({ label: "Search", shortcut: "Ctrl+K" });
    expect(splitShortcut("Split down (Ctrl+Shift+\\)").shortcut).toBe("Ctrl+Shift+\\");
    expect(splitShortcut("Next space (Super+Tab)").shortcut).toBe("Super+Tab");
    expect(splitShortcut("Retry (Shift+click)").shortcut).toBe("Shift+click");
  });
});

describe("the tooltip layer", () => {
  it("adopts a control's title: shown a fifth of a second after the pointer, with the system's held off", () => {
    // THE mutant: leave the attribute in place, and the system's grey box arrives a second later on
    // top of this one.
    setup('<button id="b" aria-label="Search" title="Search (⌘K)"></button>');
    hover($("#b"));
    expect($("#b").getAttribute("title")).toBe("");
    vi.advanceTimersByTime(TIP_DELAY_MS - 1);
    expect(open()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(open()).toBe(true);
    expect($(".tooltip-label").textContent).toBe("Search");
    expect($(".tooltip-key").textContent).toBe("⌘K");
    expect($(".tooltip-key").hidden).toBe(false);
  });

  it("gives the title back the moment the pointer leaves, so the DOM is the one the component wrote", () => {
    setup('<button id="b" aria-label="Copy" title="Copy"></button><p id="p">text</p>');
    hover($("#b"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    hover($("#p"));
    expect(open()).toBe(false);
    expect($("#b").getAttribute("title")).toBe("Copy");
    expect($("#b").hasAttribute("aria-description")).toBe(false);
  });

  it("keeps what the title meant to a screen reader while it is held, and only that", () => {
    /* THE mutants: an icon button named only by its title goes nameless while hovered, and a button
       with words loses its description. */
    setup('<button id="icon" title="Close this pane"><svg></svg></button><button id="word" title="Runs the script">Run</button>' +
      '<button id="own" title="Pin" aria-describedby="x">Pin</button>');
    hover($("#icon"));
    expect($("#icon").getAttribute("aria-label")).toBe("Close this pane");
    hover($("#word"));
    expect($("#icon").hasAttribute("aria-label")).toBe(false); // taken off with the hold
    expect($("#word").getAttribute("aria-description")).toBe("Runs the script");
    expect($("#word").hasAttribute("aria-label")).toBe(false);
    hover($("#own"));
    expect($("#word").hasAttribute("aria-description")).toBe(false);
    expect($("#own").hasAttribute("aria-description")).toBe(false); // it has a description of its own
  });

  it("shows the next control's at once within the grace period, and waits again after it", () => {
    setup('<button id="a" title="Back"></button><button id="b" title="Forward"></button><p id="p">gap</p><button id="c" title="Reload"></button>');
    hover($("#a"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    hover($("#b"));
    // THE mutant: no warm state, and sweeping a toolbar waits a fifth of a second on every button.
    expect(open()).toBe(true);
    expect(tip().hasAttribute("data-instant")).toBe(true);
    expect($(".tooltip-label").textContent).toBe("Forward");
    hover($("#p"));
    vi.advanceTimersByTime(TIP_WARM_MS + 1);
    hover($("#c"));
    expect(open()).toBe(false);
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(open()).toBe(true);
    expect(tip().hasAttribute("data-instant")).toBe(false);
  });

  it("goes on a press and stays away until the pointer has left — the system's with it", () => {
    setup('<button id="b" aria-label="Send" title="Send"></button><p id="p">x</p>');
    hover($("#b"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    fire($("#b"), "pointerdown");
    expect(open()).toBe(false);
    hover($("#b").appendChild(document.createElement("span")));
    vi.advanceTimersByTime(TIP_DELAY_MS * 5);
    expect(open()).toBe(false);
    expect($("#b").getAttribute("title")).toBe(""); // still held, so no grey box either
    hover($("#p"));
    hover($("#b"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(open()).toBe(true);
  });

  it("goes on Escape, without taking the key from anyone", () => {
    setup('<button id="b" title="Close"></button>');
    const heard = vi.fn();
    window.addEventListener("keydown", heard);
    hover($("#b"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    $("#b").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(open()).toBe(false);
    expect(heard).toHaveBeenCalled();
    window.removeEventListener("keydown", heard);
  });

  it("goes when what it is pinned to scrolls, and not when something else does", () => {
    setup('<div id="list"><button id="b" title="Rename"></button></div><div id="transcript"></div>');
    hover($("#b"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    $("#transcript").dispatchEvent(new Event("scroll"));
    expect(open()).toBe(true);
    $("#list").dispatchEvent(new Event("scroll"));
    expect(open()).toBe(false);
  });

  it("is shown by keyboard focus too, when the focus is the visible kind", () => {
    setup('<button id="b" title="New session (⌘N)">+</button>');
    const b = $("#b");
    vi.spyOn(b, "matches").mockImplementation((sel: string) => sel === ":focus-visible");
    b.focus();
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(open()).toBe(true);
    expect($(".tooltip-label").textContent).toBe("New session");
    b.blur();
    expect(open()).toBe(false);
    expect(b.getAttribute("title")).toBe("New session (⌘N)");
  });

  it("shows the title React rewrites while it is held, and gives that one back", async () => {
    setup('<button id="b" aria-label="Copy" title="Copy"></button><p id="p">x</p>');
    hover($("#b"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    $("#b").setAttribute("title", "Copied");
    await observed();
    expect($(".tooltip-label").textContent).toBe("Copied");
    expect($("#b").getAttribute("title")).toBe("");
    hover($("#p"));
    expect($("#b").getAttribute("title")).toBe("Copied");
  });

  it("does not put back a title React took away while it was held", async () => {
    setup('<button id="b" aria-label="Copy" title="Copy"></button><p id="p">x</p>');
    hover($("#b"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    $("#b").removeAttribute("title");
    await observed();
    expect(open()).toBe(false);
    hover($("#p"));
    expect($("#b").hasAttribute("title")).toBe(false);
  });

  it("an empty title means none, for the element and everything inside it", () => {
    setup('<div title="Pane"><span id="s" title="">x</span></div>');
    hover($("#s"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(open()).toBe(false);
  });

  it("where no spot beside it is clear of a browser view, leaves it to the system's tooltip", () => {
    // THE mutant: draw it anyway, under the native view that composites over it — a tooltip nobody
    // can see, and the title held so the system cannot show one either.
    views = [{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }];
    setup('<button id="b" title="Reload"><span id="inner">↻</span></button>');
    hover($("#b"));
    expect($("#b").getAttribute("title")).toBe("Reload"); // never taken
    hover($("#inner"));
    vi.advanceTimersByTime(TIP_DELAY_MS * 5);
    expect(open()).toBe(false);
    expect($("#b").getAttribute("title")).toBe("Reload");
  });

  it("clears the whole row a title inside it describes, never the row or the one after it", () => {
    // A tool row: 32 tall at y 100, and the long command in it, its own line 8 down the row.
    setup('<button id="row"><span id="cmd" title="cd /Users/me/work/realm || exit 1; gh issue list">cd /Users/me…</span></button><button id="next">Next</button>');
    const rect = (x: number, y: number, width: number, height: number) => () => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;
    $("#row").getBoundingClientRect = rect(40, 100, 700, 32);
    $("#cmd").getBoundingClientRect = rect(100, 108, 500, 16);
    tip().getBoundingClientRect = rect(0, 0, 260, 40);
    fire($("#cmd"), "pointerover", { clientX: 300, clientY: 116 });
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(open()).toBe(true);
    expect(tip().dataset.side).toBe("below");
    expect(parseFloat(tip().style.top)).toBeGreaterThanOrEqual(132); // under the row, not under the pointer
    expect(parseFloat(tip().style.left)).toBe(300 - 130); // where the pointer is along it
  });

  it("puts a two-line settings row's tooltip beside the row: never on the chip, never on the next row", () => {
    // ST-05: Reminders' row, 72 tall, its "Granted" chip 30 down it. Read as a region, the tooltip
    // went under the pointer and covered the chip; set under the row, it covered the row below.
    // THE MUTANTS: the region cut back at 64; the row's sides back to below-first.
    setup('<ul><li id="row" title="macOS reports the grant."><span id="chip">Granted</span></li><li id="next">Calendar</li></ul>');
    const rect = (x: number, y: number, width: number, height: number) => () => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;
    $("#row").getBoundingClientRect = rect(40, 440, 640, 72);
    $("#chip").getBoundingClientRect = rect(100, 470, 70, 20);
    tip().getBoundingClientRect = rect(0, 0, 180, 24);
    fire($("#chip"), "pointerover", { clientX: 120, clientY: 478 });
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(open()).toBe(true);
    expect(tip().dataset.side).toBe("right");
    expect(parseFloat(tip().style.left)).toBe(40 + 640 + 6);
    expect(parseFloat(tip().style.top) + 24).toBeLessThanOrEqual(512); // the next row starts at 512
  });

  it("goes over a two-line row where there is no room beside it", () => {
    setup('<ul><li id="row" title="macOS reports the grant."><span id="chip">Granted</span></li></ul>');
    const rect = (x: number, y: number, width: number, height: number) => () => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;
    $("#row").getBoundingClientRect = rect(40, 440, window.innerWidth - 80, 72);
    tip().getBoundingClientRect = rect(0, 0, 180, 24);
    fire($("#chip"), "pointerover", { clientX: 120, clientY: 478 });
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(tip().dataset.side).toBe("above");
    expect(parseFloat(tip().style.top)).toBe(440 - 6 - 24);
  });

  it("keeps a one-line row's tooltip where the pointer is along it", () => {
    setup('<ul><li id="row" title="Opens on login"><span id="name">Launch at login</span></li></ul>');
    const rect = (x: number, y: number, width: number, height: number) => () => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;
    $("#row").getBoundingClientRect = rect(40, 440, 640, 48);
    tip().getBoundingClientRect = rect(0, 0, 180, 24);
    fire($("#name"), "pointerover", { clientX: 300, clientY: 460 });
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(tip().dataset.side).toBe("below");
    expect(parseFloat(tip().style.left)).toBe(300 - 90);
  });

  describe("a row that shows its own name", () => {
    const rect = (x: number, y: number, width: number, height: number) => () => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;
    /** A sidebar row at y 92, widened past the 320 at which other rows anchor to the pointer, whose
     *  name is `full` wide in a 181px slot. */
    const row = (full: number) => {
      setup('<button id="row" aria-label="TAC 368 TA — unread" data-tip="clipped"><span id="name" data-tip-text>TAC 368 TA</span><span>7h</span></button>');
      Object.defineProperty($("#name"), "scrollWidth", { configurable: true, get: () => full });
      Object.defineProperty($("#name"), "clientWidth", { configurable: true, get: () => 181 });
      $("#row").getBoundingClientRect = rect(68, 92, 360, 30);
      tip().getBoundingClientRect = rect(0, 0, 140, 24);
    };

    it("has no tooltip while the whole name is on screen", () => {
      // THE mutant: the row's sentence as a tooltip again, over the row under it.
      row(181);
      hover($("#name"));
      vi.advanceTimersByTime(TIP_DELAY_MS * 5);
      expect(open()).toBe(false);
      expect($("#row").hasAttribute("title")).toBe(false);
    });

    it("shows only the name the column cut short, beside the row, and leaves its accessible name alone", () => {
      /* THE mutants: the state words back in the tooltip; the tooltip under the row, where it covered the
         heading below; the accessible name traded for the tooltip's words. */
      row(250);
      hover($("#name"));
      vi.advanceTimersByTime(TIP_DELAY_MS);
      expect(open()).toBe(true);
      expect($(".tooltip-label").textContent).toBe("TAC 368 TA");
      expect(tip().dataset.side).toBe("right");
      expect(parseFloat(tip().style.left)).toBe(68 + 360 + 6); // beside the row, not beside the pointer
      expect(parseFloat(tip().style.top)).toBe(92 + (30 - 24) / 2);
      expect($("#row").getAttribute("aria-label")).toBe("TAC 368 TA — unread");
      expect($("#row").hasAttribute("aria-description")).toBe(false);
      expect($("#row").hasAttribute("title")).toBe(false);
      hover(document.body);
      expect(open()).toBe(false);
      expect($("#row").getAttribute("aria-label")).toBe("TAC 368 TA — unread");
    });
  });

  it("puts a clipped tab's name under the strip, not over the tab beside it", () => {
    // RP-12. THE MUTANT: a tab read as a sidebar row, its name laid over the next tab.
    setup('<div role="tablist"><button id="tab" role="tab" data-tip="clipped"><span id="name" data-tip-text>Documents · realm</span></button><button role="tab">Next</button></div>');
    const rect = (x: number, y: number, width: number, height: number) => () => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height, toJSON: () => ({}) }) as DOMRect;
    Object.defineProperty($("#name"), "scrollWidth", { configurable: true, get: () => 160 });
    Object.defineProperty($("#name"), "clientWidth", { configurable: true, get: () => 90 });
    $("#tab").getBoundingClientRect = rect(500, 8, 120, 28);
    tip().getBoundingClientRect = rect(0, 0, 140, 24);
    hover($("#name"));
    vi.advanceTimersByTime(TIP_DELAY_MS);
    expect(open()).toBe(true);
    expect($(".tooltip-label").textContent).toBe("Documents · realm");
    expect(tip().dataset.side).toBe("below");
    expect(parseFloat(tip().style.top)).toBe(8 + 28 + 6);
  });

  it("leaves the page as it found it when uninstalled", () => {
    setup('<button id="b" title="Reload"></button>');
    hover($("#b"));
    uninstall();
    uninstall = () => {};
    expect($("#b").getAttribute("title")).toBe("Reload");
    expect(document.querySelector(".tooltip")).toBeNull();
  });
});
