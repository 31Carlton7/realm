import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { useScrollMemory } from "./scroll-memory";

/**
 * A scroller whose content arrives LATE — the rich editor's case, and the one no pane test can
 * reach: `EditorContent`'s wrapper is in the DOM (and its ref has already fired) while ProseMirror
 * is still appending into it, so the box a restore writes to is momentarily zero-height and the
 * write is clamped to 0. jsdom lays nothing out, so both the clamp and the growth are staged.
 */
function stage() {
  let height = 0;
  const view = 600;
  const tops = new WeakMap<HTMLElement, number>();
  const mine = (el: unknown) => el instanceof HTMLElement && el.classList.contains("scroller");
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return mine(this) ? height : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get() { return mine(this) ? view : 0; } });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() { return mine(this) ? tops.get(this as HTMLElement) ?? 0 : 0; },
    // The clamp is the whole point: a browser refuses an offset the content cannot reach, and does
    // so silently. Without it a restore into an empty box would look like it worked.
    set(v: number) { if (mine(this)) tops.set(this as HTMLElement, Math.max(0, Math.min(v, height - view))); },
  });
  return {
    grow(to: number) { height = to; },
    topOf(el: HTMLElement) { return tops.get(el) ?? 0; },
    readerScrollsTo(el: HTMLElement, v: number) { tops.set(el, v); fireEvent.scroll(el); },
  };
}

/** A ResizeObserver the test drives: the real one never fires in jsdom, and "the content grew" is
 *  exactly the signal under test. */
function stageObserver() {
  const callbacks: ResizeObserverCallback[] = [];
  vi.stubGlobal("ResizeObserver", class {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; callbacks.push(cb); }
    observe() {}
    unobserve() {}
    // Honest about disconnection, so "it stopped observing" is a thing this fake can actually show.
    disconnect() { const i = callbacks.indexOf(this.cb); if (i >= 0) callbacks.splice(i, 1); }
  } as unknown as typeof ResizeObserver);
  return { contentGrew() { act(() => { for (const cb of [...callbacks]) cb([], null as never); }); } };
}

function Scroller({ scrollKey }: { scrollKey: string | null }) {
  const ref = useScrollMemory(scrollKey);
  return <div className="scroller" data-testid="s" ref={ref} />;
}

const el = (r: { getByTestId(id: string): HTMLElement }) => r.getByTestId("s");

beforeEach(() => { vi.useRealTimers(); });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const k of ["scrollHeight", "clientHeight", "scrollTop"]) {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  }
});

describe("useScrollMemory", () => {
  it("keeps trying until the content is tall enough to hold the position", () => {
    const staged = stage();
    const ro = stageObserver();
    staged.grow(4000);
    const first = render(<Scroller scrollKey="k" />);
    staged.readerScrollsTo(el(first), 1200);
    first.unmount();

    // The scroller comes back before its content does — the write is clamped to 0.
    staged.grow(0);
    const again = render(<Scroller scrollKey="k" />);
    expect(staged.topOf(el(again))).toBe(0);

    staged.grow(4000);
    ro.contentGrew();
    expect(staged.topOf(el(again))).toBe(1200);
  });

  it("stops the moment the reader reaches for the scroller themselves", () => {
    const staged = stage();
    const ro = stageObserver();
    staged.grow(4000);
    const first = render(<Scroller scrollKey="k" />);
    staged.readerScrollsTo(el(first), 1200);
    first.unmount();

    staged.grow(0);
    const again = render(<Scroller scrollKey="k" />);
    fireEvent.wheel(el(again)); // they have taken over; the restore is no longer wanted

    staged.grow(4000);
    ro.contentGrew();
    expect(staged.topOf(el(again))).toBe(0);
  });

  it("gives up rather than waiting forever for content that never comes back", () => {
    vi.useFakeTimers();
    const staged = stage();
    const ro = stageObserver();
    staged.grow(4000);
    const first = render(<Scroller scrollKey="k" />);
    staged.readerScrollsTo(el(first), 1200);
    first.unmount();

    staged.grow(0);
    const again = render(<Scroller scrollKey="k" />);
    // Comfortably past the settle deadline — a file that shrank, or a pane that is wider now, must
    // not leave an observer waiting for a frame that is not coming.
    act(() => { vi.advanceTimersByTime(5000); });

    staged.grow(4000);
    ro.contentGrew();
    expect(staged.topOf(el(again))).toBe(0);
  });

  it("a null key attaches nothing: there is no reader to put back", () => {
    const staged = stage();
    stageObserver();
    staged.grow(4000);
    const first = render(<Scroller scrollKey={null} />);
    staged.readerScrollsTo(el(first), 1200);
    first.unmount();

    const again = render(<Scroller scrollKey={null} />);
    expect(staged.topOf(el(again))).toBe(0);
  });
});
