import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { sessionEvent } from "@realm/contracts";
import { StoreContext, createAppStore } from "../../state/store";
import { fakeApi, item, session } from "../../state/store.test-fakes";
import { ARRIVAL_HORIZON_MS, NO_ARRIVALS, markArrivals, noteArrival } from "./arrival-fade";
import { Markdown } from "./Markdown";
import { SessionPane } from "./SessionPane";
import { reduceAll } from "./transcript-model";

afterEach(() => { vi.restoreAllMocks(); });

/** The clock `Markdown` stamps arrivals with. */
const at = (ms: number) => vi.spyOn(performance, "now").mockReturnValue(ms);
const arrivals = () => [...document.querySelectorAll<HTMLElement>(".md-arrival")].map((s) => [s.textContent, s.style.animationDelay]);

describe("the arrival record", () => {
  it("takes the first look as history — nothing arrives on it", () => {
    // A restored transcript, a session switched back to, a pane opened mid-message: none of that
    // text was just written. THE MUTANT: recording the first look as a run from 0, which fades every
    // message in every transcript on every launch.
    expect(noteArrival(NO_ARRIVALS, 120, 1000)).toEqual({ shown: 120, runs: [] });
  });

  it("records growth after that as a run starting where the text used to end", () => {
    const a = noteArrival(noteArrival(NO_ARRIVALS, 5, 0), 11, 50);
    expect(a).toEqual({ shown: 11, runs: [{ at: 5, t: 50 }] });
    expect(noteArrival(a, 20, 90).runs).toEqual([{ at: 5, t: 50 }, { at: 11, t: 90 }]);
    // No growth, no run: a re-render over the same text is not an arrival.
    expect(noteArrival(a, 11, 60).runs).toEqual([{ at: 5, t: 50 }]);
  });

  it("lets a run go once it is older than any fade it could still be carrying", () => {
    const a = noteArrival(noteArrival(NO_ARRIVALS, 5, 0), 11, 50);
    expect(noteArrival(a, 11, 50 + ARRIVAL_HORIZON_MS - 1).runs).toHaveLength(1);
    expect(noteArrival(a, 11, 50 + ARRIVAL_HORIZON_MS).runs).toEqual([]);
  });

  it("drops the runs a restructure took away, and does not call the shrink an arrival", () => {
    // `**bo` renders its asterisks; the closing `**` makes them markup, and the text gets shorter.
    const a = { shown: 20, runs: [{ at: 10, t: 0 }, { at: 16, t: 10 }] };
    expect(noteArrival(a, 14, 20)).toEqual({ shown: 14, runs: [{ at: 10, t: 0 }] });
  });
});

const host = (html: string) => { const el = document.createElement("div"); el.innerHTML = html; return el; };
const marked = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".md-arrival")].map((s) => s.textContent);

describe("marking the runs", () => {
  it("wraps exactly the young runs, each fade resumed at its age, and never changes the text", () => {
    const el = host("<p>Hello world, again</p>");
    const before = el.textContent;
    markArrivals(el, [{ at: 5, t: 900 }, { at: 11, t: 1000 }], 1000);
    expect([...el.querySelectorAll<HTMLElement>(".md-arrival")].map((s) => [s.textContent, s.style.animationDelay]))
      .toEqual([[" world", "-100ms"], [", again", "0ms"]]);
    // THE MUTANT: a positive delay. The span would sit fully opaque, then drop to nothing and fade —
    // a flicker on every word, instead of a fade that carries on from where the last write cut it.
    expect(el.textContent).toBe(before);
  });

  it("follows a run across element boundaries, into the elements it crosses", () => {
    // "One" 0–3 · "Two " 3–7 · "bold" 7–11 · " three" 11–17
    const el = host("<p>One</p><p>Two <strong>bold</strong> three</p>");
    markArrivals(el, [{ at: 5, t: 0 }], 0);
    expect(marked(el)).toEqual(["o ", "bold", " three"]);
    expect(el.querySelector("strong .md-arrival")).not.toBeNull();
  });

  it("leaves formula markup alone, and still counts it, so the runs after it land on the right text", () => {
    // "x " 0–2 · "y" (MathML) 2–3 · "y" (drawn) 3–4 · " z" 4–6
    const el = host('<p>x <span class="katex"><span class="katex-mathml"><math><mi>y</mi></math></span><span class="katex-html">y</span></span> z</p>');
    markArrivals(el, [{ at: 4, t: 0 }], 0);
    // THE MUTANT: skipping a node before counting it. The run would start one character late and
    // fade "z" alone, and every run after a formula would be off by the formula's length.
    expect(marked(el)).toEqual([" z"]);
    markArrivals(el, [{ at: 0, t: 0 }], 0);
    expect(el.querySelector("math .md-arrival")).toBeNull();
  });

});

describe("streamed prose", () => {
  it("fades what arrives after the first render, and resumes a fade the next write destroyed", () => {
    at(0);
    const r = render(<Markdown text="Hello" arrive />);
    expect(arrivals()).toEqual([]);
    at(40);
    r.rerender(<Markdown text="Hello world" arrive />);
    expect(arrivals()).toEqual([[" world", "0ms"]]);
    at(100);
    r.rerender(<Markdown text="Hello world, again" arrive />);
    // THE BUG the whole design answers: every delta rewrites the markup, so " world"'s span — 60ms
    // into its fade — was destroyed. It is back, 60ms along, rather than snapping to full.
    expect(arrivals()).toEqual([[" world", "-60ms"], [", again", "0ms"]]);
    // Split across spans, never altered: the same characters a plain render of the prose holds.
    const plain = render(<Markdown text="Hello world, again" />).container.querySelector(".md")!.textContent;
    expect(r.container.querySelector(".md")!.textContent).toBe(plain);
  });

  it("fades the first letter of a run too, not one character late", () => {
    // THE BUG this pins: `marked` closes every block with a newline outside it, which sits after the
    // growing text. Counted, it pushed each run one character late and its first letter popped in.
    at(0);
    const r = render(<Markdown text="Hello" arrive />);
    at(16);
    r.rerender(<Markdown text="Hellothere" arrive />);
    expect(arrivals()).toEqual([["there", "0ms"]]);
  });

  it("marks nothing for markdown that does not stream", () => {
    at(0);
    const r = render(<Markdown text="Hello" />);
    at(40);
    r.rerender(<Markdown text="Hello world" />);
    expect(arrivals()).toEqual([]);
  });

  it("keeps a path clickable when it arrived inside a fade", () => {
    const onPath = vi.fn();
    at(0);
    const r = render(<Markdown text="I wrote" arrive onPath={onPath} />);
    at(30);
    r.rerender(<Markdown text="I wrote `applications/ESSAY-BANK.md` for you." arrive onPath={onPath} />);
    const inside = document.querySelector(".md-path .md-arrival")!;
    expect(inside).not.toBeNull();
    fireEvent.click(inside);
    expect(onPath).toHaveBeenCalledWith("applications/ESSAY-BANK.md", expect.any(HTMLElement));
  });
});

describe("an agent's answer in a session pane", () => {
  const streamed = (text: string) => reduceAll([
    sessionEvent("user_message", { text: "go", attachments: [] }),
    sessionEvent("assistant_delta", { messageId: "m1", delta: text }),
  ]);

  it("fades in as it streams, and a transcript opened onto it does not", async () => {
    const store = createAppStore(fakeApi({ sessions: [session("se1", "s1", { status: "running" })] }));
    await store.getState().boot();
    at(0);
    store.setState({ sessionStatus: { se1: "running" }, transcripts: { se1: { lastSeq: 2, t: streamed("Already here.") } } });
    render(<StoreContext.Provider value={store}>
      <SessionPane item={item("i9", "s1", { kind: "session", refId: "se1", title: "Session" })} visible />
    </StoreContext.Provider>);
    expect(arrivals()).toEqual([]);
    at(25);
    // THE MUTANT: the transcript not asking its prose to arrive. Everything else here still passes.
    act(() => { store.setState({ transcripts: { se1: { lastSeq: 3, t: streamed("Already here. And more.") } } }); });
    expect(arrivals()).toEqual([[" And more.", "0ms"]]);
  });
});
