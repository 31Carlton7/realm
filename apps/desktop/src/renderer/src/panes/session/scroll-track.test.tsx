import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { sessionEvent, type TurnChanges } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { SessionPane } from "./SessionPane";
import { Transcript } from "./Transcript";
import { TIP_DELAY_MS } from "../../tooltips";
import { stampLabel } from "./timestamps";
import { emptyTranscript, reduceAll, reduceTranscript, type Block, type Transcript as TranscriptModel } from "./transcript-model";

/**
 * jsdom lays nothing out, so the track is given a geometry to read: each prompt's row at a staged
 * offset in its column, the scroller's viewport and content, and the track's own room. The scroller's
 * top padding — where a jump brings a row to rest — is 44px, the stylesheet's. Every painted rect is
 * staged as well, 6px low, as a row is while it rises in: the track must read layout, not paint.
 */
function stage({ rows: laidOut, view = 600, height, room = 500 }: { rows: number[]; view?: number; height: number; room?: number }) {
  let rows = laidOut;
  let top = 0;
  const jumps: { top: number; behavior: ScrollBehavior | undefined }[] = [];
  const has = (el: unknown, cls: string) => el instanceof HTMLElement && el.classList.contains(cls);
  const clampTop = (v: number) => Math.max(0, Math.min(v, height - view));
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true,
    get() { return has(this, "transcript") ? view : has(this, "scroll-track") ? room : 0; } });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get() { return has(this, "transcript") ? height : 0; } });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", { configurable: true,
    get() { return has(this, "transcript") ? top : 0; },
    set(v: number) { if (has(this, "transcript")) top = clampTop(v); } });
  HTMLElement.prototype.scrollTo = function (this: HTMLElement, opts?: ScrollToOptions | number) {
    if (!has(this, "transcript") || typeof opts !== "object") return;
    jumps.push({ top: opts.top ?? 0, behavior: opts.behavior });
    top = clampTop(opts.top ?? 0);
    fireEvent.scroll(this);
  } as HTMLElement["scrollTo"];
  Object.defineProperty(HTMLElement.prototype, "offsetTop", { configurable: true,
    get() { const i = [...document.querySelectorAll("[data-prompt]")].indexOf(this); return i >= 0 ? rows[i]! : 0; } });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const i = [...document.querySelectorAll("[data-prompt]")].indexOf(this);
    return new DOMRect(0, (i >= 0 ? rows[i]! - top : this.classList.contains("transcript-col") ? -top : 0) + (i >= 0 ? 6 : 0), 100, 40);
  });
  return {
    /** The log reflowing: every row from here on laid out somewhere else. */
    reflow(next: number[]) { rows = next; },
    jumps,
    get top() { return top; },
    /** The reader scrolling the log themselves: the wheel first, then the scroll it causes. */
    readerScrollsTo(v: number) {
      const el = document.querySelector(".transcript")!;
      fireEvent.wheel(el);
      top = clampTop(v);
      fireEvent.scroll(el);
    },
  };
}

/** The real ResizeObserver never fires in jsdom; this one fires when told to. */
function stageObserver() {
  const callbacks: ResizeObserverCallback[] = [];
  vi.stubGlobal("ResizeObserver", class {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; callbacks.push(cb); }
    observe() {}
    unobserve() {}
    disconnect() { const i = callbacks.indexOf(this.cb); if (i >= 0) callbacks.splice(i, 1); }
  } as unknown as typeof ResizeObserver);
  return { resized() { act(() => { for (const cb of [...callbacks]) cb([], null as never); }); } };
}

/** One animation frame, which is when the track reads. */
const nextFrame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

const T0 = new Date(2026, 9, 5, 9, 30).getTime();
/** `n` turns: a prompt, its answer, its run line — blocks 3i, 3i+1, 3i+2. Each prompt is a stored event,
 *  seq 1000 + i, as a log read from the server has them. */
const turns = (n: number): Block[] => Array.from({ length: n }, (_, i): Block[] => [
  { kind: "user", text: `Prompt ${i + 1}\nwith a second line`, ts: T0 + i * 60_000, seq: 1000 + i },
  { kind: "assistant", messageId: `m${i}`, text: `Answer **${i + 1}**, in full.`, streaming: false, ts: T0 + i * 60_000 + 5_000 },
  { kind: "run", ms: 5_000, startedAt: T0 + i * 60_000, ts: T0 + i * 60_000 + 6_000 },
]).flat();
const model = (blocks: Block[], extra: Partial<TranscriptModel> = {}): TranscriptModel =>
  ({ blocks, run: null, pendingPermissions: [], usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0 }, init: null, feedback: {}, summary: null, promptHint: null, ...extra });

function mount(transcript: TranscriptModel, props: Pick<ComponentProps<typeof Transcript>, "saved" | "onSave" | "reveal" | "onRevealed"> = {}) {
  const r = render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={transcript} track {...props} />);
  // The stylesheet's padding, which jsdom does not load — read on the next measurement.
  document.querySelector<HTMLElement>(".transcript")!.style.paddingTop = "44px";
  return r;
}

const track = () => screen.getByRole("toolbar", { name: "Prompts" });
/** The ticks, in order — not the card's bookmark, which is a button in the same toolbar. */
const ticks = () => within(track()).getAllByRole("button").filter((b) => b.classList.contains("track-tick"));
const card = () => document.querySelector<HTMLElement>(".track-card")!;
/** Where a tick's line is drawn, in the track's coordinates: its cell's top plus the line's place in it. */
const lineAt = (tick: HTMLElement) => parseFloat(tick.style.top) + parseFloat(tick.querySelector<HTMLElement>(".track-line")!.style.top);

let ro: ReturnType<typeof stageObserver>;
beforeEach(() => { ro = stageObserver(); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of ["clientHeight", "scrollHeight", "scrollTop", "offsetTop"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[k];
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTo;
});

/** A log of five turns, 900px apart, in a 600px viewport — and the track measured. */
async function fiveTurns(extra: Partial<TranscriptModel> = {}) {
  const geo = stage({ rows: [0, 900, 1800, 2700, 3600], height: 4400 });
  mount(model(turns(5), extra));
  ro.resized();
  await nextFrame();
  return geo;
}

describe("the scroll track", () => {
  it("is drawn for a log with two prompts or more, one tick each, and not at all for one", async () => {
    stage({ rows: [0], height: 600 });
    const { unmount } = mount(model(turns(1)));
    expect(screen.queryByRole("toolbar", { name: "Prompts" })).toBeNull();
    unmount();
    await fiveTurns();
    expect(ticks().map((t) => t.getAttribute("aria-label"))).toEqual(["Prompt 1", "Prompt 2", "Prompt 3", "Prompt 4", "Prompt 5"]);
  });

  it("is only drawn where it is asked for — the quick chat, which does not ask, has no room for one", () => {
    stage({ rows: [0, 900], height: 2000 });
    render(<Transcript sessionStatus="idle" onDecide={() => {}} transcript={model(turns(2))} />);
    expect(screen.queryByRole("toolbar", { name: "Prompts" })).toBeNull();
  });

  it("places each tick by where its row was measured, the band centred in the track's room", async () => {
    await fiveTurns();
    // Turns 900px long, at 1/40, are 22.5px apart; the 90px band sits in the middle of 500px.
    expect(ticks().map(lineAt)).toEqual([205, 227.5, 250, 272.5, 295]);
  });

  it("measures again when the log reflows, and moves the ticks with it", async () => {
    const geo = stage({ rows: [0, 900, 1800, 2700, 3600], height: 4400 });
    mount(model(turns(5)));
    ro.resized();
    await nextFrame();
    // A picture lands in the second turn: everything after it is 400px further down.
    geo.reflow([0, 900, 2200, 3100, 4000]);
    ro.resized();
    await nextFrame();
    const at = ticks().map(lineAt);
    expect(at[2]! - at[1]!).toBeCloseTo(1300 / 40);
    expect(at[3]! - at[2]!).toBeCloseTo(900 / 40);
  });

  it("lights the prompt being read, and follows the reader's scrolling", async () => {
    const geo = await fiveTurns();
    const lit = () => ticks().findIndex((t) => t.hasAttribute("data-current"));
    // A log opens at its end, so the newest prompt is the one being read.
    expect(lit()).toBe(4);
    geo.readerScrollsTo(0);
    await nextFrame();
    expect(lit()).toBe(0);
    geo.readerScrollsTo(1000);
    await nextFrame();
    expect(lit()).toBe(1);
    expect(ticks()[1]).toHaveAttribute("aria-current", "true");
    geo.readerScrollsTo(3800);
    await nextFrame();
    expect(lit()).toBe(4);
    expect(ticks().filter((t) => t.hasAttribute("data-current"))).toHaveLength(1);
  });

  it("lights nothing until the log has settled where it opens, so the first tick never flashes on the way", async () => {
    // The track lays out before the transcript sticks the log to its end; a reading taken then would
    // light the first prompt for a frame and fade across to the last.
    stage({ rows: [0, 900, 1800, 2700, 3600], height: 4400 });
    mount(model(turns(5)));
    expect(ticks()).toHaveLength(5);
    expect(ticks().filter((t) => t.hasAttribute("data-current"))).toHaveLength(0);
    await nextFrame();
    expect(ticks().map((t) => t.hasAttribute("data-current"))).toEqual([false, false, false, false, true]);
  });

  it("goes to a prompt on a click, bringing its row to rest at the log's top, smoothly", async () => {
    const geo = await fiveTurns();
    fireEvent.click(ticks()[2]!);
    expect(geo.jumps).toEqual([{ top: 1800, behavior: "smooth" }]);
    await nextFrame();
    expect(ticks()[2]).toHaveAttribute("data-current");
  });

  it("goes there at once when motion is reduced", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduced-motion"), media: q, addEventListener() {}, removeEventListener() {} }));
    const geo = await fiveTurns();
    fireEvent.click(ticks()[3]!);
    expect(geo.jumps).toEqual([{ top: 2700, behavior: "instant" }]);
  });

  it("keeps the clicked tick lit where the log runs out before its row reaches the top", async () => {
    // A short last turn: the fourth prompt cannot be brought to the top, and at the end of the log the
    // last prompt on screen is the fifth. The tick that lights must be the one that was clicked.
    const geo = stage({ rows: [0, 900, 1800, 2700, 2800], height: 3200 });
    mount(model(turns(5)));
    ro.resized();
    await nextFrame();
    fireEvent.click(ticks()[3]!);
    await nextFrame();
    expect(geo.top).toBe(2600);
    expect(ticks()[3]).toHaveAttribute("data-current");
    // …until the reader takes the scroller back.
    geo.readerScrollsTo(2600);
    await nextFrame();
    expect(ticks()[4]).toHaveAttribute("data-current");
  });

  it("takes the click and leaves the keyboard where it was, as a scrollbar does", async () => {
    await fiveTurns();
    expect(fireEvent.mouseDown(ticks()[1]!)).toBe(false);
  });

  it("shows what a tick's prompt asked, how it was answered and when, a moment after the pointer arrives", async () => {
    await fiveTurns();
    fireEvent.pointerEnter(ticks()[2]!);
    // The lens arrives with the pointer; the card on the tooltip's delay.
    expect(ticks().map((t) => t.getAttribute("data-near"))).toEqual(["2", "1", "0", "1", "2"]);
    expect(card()).not.toHaveAttribute("data-open");
    await waitFor(() => expect(card()).toHaveAttribute("data-open"), { timeout: TIP_DELAY_MS + 500 });
    expect(card().querySelector(".track-card-title")!.textContent).toBe("Prompt 3");
    expect(card().querySelector(".track-card-reply")!.textContent).toBe("Answer 3, in full.");
    expect(card().querySelector("time")!.textContent).toBe(stampLabel(T0 + 2 * 60_000, Date.now()));
    // The keyboard hears what the card adds to the tick's own name: the answer, then when.
    const described = ticks()[2]!.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!);
    expect(described.map((el) => el.className)).toEqual(["track-card-reply", "track-card-foot"]);
    // Along the track it follows at once.
    fireEvent.pointerEnter(ticks()[4]!);
    expect(card().querySelector(".track-card-title")!.textContent).toBe("Prompt 5");
    // Off it, it goes — once the pointer has had the moment it takes to cross to the card, and has not.
    fireEvent.pointerLeave(ticks()[4]!);
    await waitFor(() => expect(card()).not.toHaveAttribute("data-open"), { timeout: 1000 });
    expect(ticks().every((t) => !t.hasAttribute("data-near"))).toBe(true);
  });

  it("marks the turns that changed files, and its card says how many", async () => {
    const changed: TurnChanges = { checkpointId: null, settledAt: T0 + 60_000 + 6_000, root: "/w", afterTree: null, totalFiles: 2,
      files: [{ path: "a.ts", oldPath: null, status: "modified", additions: 1, deletions: 0 }, { path: "b.ts", oldPath: null, status: "added", additions: 4, deletions: 0 }] };
    await fiveTurns({ changes: { [changed.settledAt]: changed } });
    expect(ticks().map((t) => t.hasAttribute("data-edited"))).toEqual([false, true, false, false, false]);
    act(() => ticks()[1]!.focus());
    expect(card().querySelector(".track-card-foot")!.textContent).toBe(`${stampLabel(T0 + 60_000, Date.now())} · Edited 2 files`);
  });

  it("moves between prompts on ↑ and ↓ once it has the keyboard, going to each, and to the ends on Home and End", async () => {
    const geo = await fiveTurns();
    // One tick takes Tab — the one being read, which in a log opened at its end is the last.
    expect(ticks().map((t) => t.tabIndex)).toEqual([-1, -1, -1, -1, 0]);
    const first = ticks()[0]!;
    act(() => first.focus());
    expect(card()).toHaveAttribute("data-open");
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(ticks()[1]);
    expect(geo.jumps.at(-1)).toEqual({ top: 900, behavior: "smooth" });
    expect(card().querySelector(".track-card-title")!.textContent).toBe("Prompt 2");
    fireEvent.keyDown(ticks()[1]!, { key: "End" });
    expect(document.activeElement).toBe(ticks()[4]);
    expect(geo.jumps.at(-1)!.top).toBe(3600);
    fireEvent.keyDown(ticks()[4]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(ticks()[4]);
    fireEvent.keyDown(ticks()[4]!, { key: "Home" });
    fireEvent.keyDown(ticks()[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(ticks()[0]);
    expect(geo.jumps.at(-1)!.top).toBe(0);
  });

  it("puts the card away on Escape and keeps the keyboard on the track", async () => {
    await fiveTurns();
    act(() => ticks()[0]!.focus());
    expect(card()).toHaveAttribute("data-open");
    fireEvent.keyDown(ticks()[0]!, { key: "Escape" });
    expect(card()).not.toHaveAttribute("data-open");
    expect(document.activeElement).toBe(ticks()[0]);
  });
});

describe("saving a turn", () => {
  /** The five turns, the track's save wired to a spy, and whichever prompts' seqs are already saved. */
  async function saving(saved: number[] = [], extra: Pick<ComponentProps<typeof Transcript>, "reveal" | "onRevealed"> = {}) {
    const geo = stage({ rows: [0, 900, 1800, 2700, 3600], height: 4400 });
    const onSave = vi.fn();
    mount(model(turns(5)), { saved, onSave, ...extra });
    ro.resized();
    await nextFrame();
    return { geo, onSave };
  }
  const bookmark = () => card().querySelector<HTMLButtonElement>(".track-card-save");
  const pointAt = async (i: number) => {
    fireEvent.pointerEnter(ticks()[i]!);
    await waitFor(() => expect(card()).toHaveAttribute("data-open"), { timeout: TIP_DELAY_MS + 500 });
  };

  it("saves a turn from its card's bookmark, and unsaves one that is saved", async () => {
    const { onSave } = await saving([1003]);
    await pointAt(1);
    expect(bookmark()).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(bookmark()!);
    expect(onSave).toHaveBeenLastCalledWith(1001, true);
    fireEvent.pointerEnter(ticks()[3]!);
    expect(bookmark()).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(bookmark()!);
    expect(onSave).toHaveBeenLastCalledWith(1003, false);
    // The press leaves the keyboard where it was, as a click on the tick does.
    expect(fireEvent.mouseDown(bookmark()!)).toBe(false);
  });

  it("saves the turn the keyboard is on with S — and leaves ⌘S to whatever else wants it", async () => {
    const { onSave } = await saving([1004]);
    act(() => ticks()[2]!.focus());
    fireEvent.keyDown(ticks()[2]!, { key: "s" });
    expect(onSave).toHaveBeenLastCalledWith(1002, true);
    fireEvent.keyDown(ticks()[2]!, { key: "s", metaKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(ticks()[2]!, { key: "End" });
    fireEvent.keyDown(ticks()[4]!, { key: "S" });
    expect(onSave).toHaveBeenLastCalledWith(1004, false);
  });

  it("marks the saved turns on the track, and says so to the keyboard", async () => {
    await saving([1001, 1003]);
    expect(ticks().map((t) => t.hasAttribute("data-saved"))).toEqual([false, true, false, true, false]);
    expect(ticks()[1]).toHaveAttribute("aria-description", "Saved");
    expect(ticks()[0]).not.toHaveAttribute("aria-description");
  });

  it("goes between saved turns on ⌥↓ and ⌥↑, past every turn that is not one", async () => {
    const { geo } = await saving([1001, 1003]);
    act(() => ticks()[0]!.focus());
    fireEvent.keyDown(ticks()[0]!, { key: "ArrowDown", altKey: true });
    expect(document.activeElement).toBe(ticks()[1]);
    expect(geo.jumps.at(-1)!.top).toBe(900);
    fireEvent.keyDown(ticks()[1]!, { key: "ArrowDown", altKey: true });
    expect(document.activeElement).toBe(ticks()[3]);
    expect(geo.jumps.at(-1)!.top).toBe(2700);
    // Nothing saved further down: nowhere to go, and nothing moves.
    const moves = geo.jumps.length;
    fireEvent.keyDown(ticks()[3]!, { key: "ArrowDown", altKey: true });
    expect(document.activeElement).toBe(ticks()[3]);
    expect(geo.jumps).toHaveLength(moves);
    fireEvent.keyDown(ticks()[3]!, { key: "ArrowUp", altKey: true });
    expect(document.activeElement).toBe(ticks()[1]);
  });

  it("draws no bookmark for a prompt with no stored event, and S leaves it be", async () => {
    stage({ rows: [0, 900, 1800], height: 2600 });
    const onSave = vi.fn();
    const bare = turns(3).map((b) => (b.kind === "user" ? { ...b, seq: undefined } : b));
    mount(model(bare), { saved: [], onSave });
    ro.resized();
    await nextFrame();
    await pointAt(1);
    expect(bookmark()).toBeNull();
    act(() => ticks()[1]!.focus());
    fireEvent.keyDown(ticks()[1]!, { key: "s" });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("draws no bookmark where nothing can be saved — the quick chat's log", async () => {
    await fiveTurns();
    await pointAt(1);
    expect(bookmark()).toBeNull();
  });

  it("keeps the card up while the pointer crosses to its bookmark, and lets it go once the pointer has gone", async () => {
    await saving();
    await pointAt(2);
    fireEvent.pointerLeave(ticks()[2]!);
    // On its way to the card: still up a moment later, and up for as long as the pointer is on it.
    expect(card()).toHaveAttribute("data-open");
    fireEvent.pointerEnter(card());
    await new Promise((r) => setTimeout(r, 300));
    expect(card()).toHaveAttribute("data-open");
    fireEvent.pointerLeave(card());
    await waitFor(() => expect(card()).not.toHaveAttribute("data-open"), { timeout: 1000 });
  });

  it("opens at a prompt it is sent to, at once rather than gliding, and says it got there", async () => {
    const onRevealed = vi.fn();
    const { geo } = await saving([1002], { reveal: { seq: 1002, n: 7 }, onRevealed });
    await waitFor(() => expect(onRevealed).toHaveBeenCalledWith(7));
    expect(geo.jumps.at(-1)).toEqual({ top: 1800, behavior: "instant" });
    await nextFrame();
    expect(ticks()[2]).toHaveAttribute("data-current");
  });
});

describe("in a session pane", () => {
  it("runs down the left edge of every session's log", async () => {
    stage({ rows: [0, 900], height: 2000 });
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle" })] });
    const store = createAppStore(api);
    await store.getState().boot();
    store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 4, t: reduceAll([
      sessionEvent("user_message", { text: "what does this repo do", attachments: [] }),
      sessionEvent("assistant_text", { messageId: "m1", text: "a lot" }),
      sessionEvent("user_message", { text: "and the server?", attachments: [] }),
      sessionEvent("assistant_text", { messageId: "m2", text: "a Fastify app" }),
    ]) } } });
    render(<StoreContext.Provider value={store}>
      <SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "Session" })} visible />
    </StoreContext.Provider>);
    await screen.findByRole("toolbar", { name: "Prompts" });
    expect(ticks().map((t) => t.getAttribute("aria-label"))).toEqual(["what does this repo do", "and the server?"]);
  });

  it("saves a turn through the store: S on the track, the server's answer, the tick marked in every window", async () => {
    stage({ rows: [0, 900], height: 2000 });
    const api = fakeApi({ sessions: [session("se1", "s1", { status: "idle" })], savedTurns: { se1: [] } });
    const store = createAppStore(api);
    await store.getState().boot();
    // A log read from the server: each prompt keeps the seq of its stored event.
    const stored = [
      [11, sessionEvent("user_message", { text: "what does this repo do", attachments: [] })],
      [12, sessionEvent("assistant_text", { messageId: "m1", text: "a lot" })],
      [13, sessionEvent("user_message", { text: "and the server?", attachments: [] })],
      [14, sessionEvent("assistant_text", { messageId: "m2", text: "a Fastify app" })],
    ] as const;
    const t = stored.reduce((acc: TranscriptModel, [seq, e]) => reduceTranscript(acc, e, false, seq), emptyTranscript());
    store.setState({ sessionStatus: { se1: "idle" }, transcripts: { se1: { lastSeq: 14, t } } });
    render(<StoreContext.Provider value={store}>
      <SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "Session" })} visible />
    </StoreContext.Provider>);
    await screen.findByRole("toolbar", { name: "Prompts" });
    await waitFor(() => expect(api.calls).toContain("savedTurns:se1"));
    act(() => ticks()[1]!.focus());
    fireEvent.keyDown(ticks()[1]!, { key: "s" });
    await waitFor(() => expect(api.calls).toContain("setTurnSaved:se1:13=true"));
    expect(ticks()[1]).toHaveAttribute("data-saved");
    expect(store.getState().savedTurns.se1).toEqual([13]);
    // A change made in another window arrives as `session.saved`, and is drawn here as well.
    act(() => store.getState().applySavedTurns("se1", [11]));
    expect(ticks().map((x) => x.hasAttribute("data-saved"))).toEqual([true, false]);
  });
});
