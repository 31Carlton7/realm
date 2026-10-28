import { beforeAll, describe, expect, it } from "vitest";
import { GUIDE_STATE_MARK, type GuideState } from "@realm/contracts";

/**
 * The study-guide runtime, run as a guide runs it: in a frame of its own, the boot inline at the top of
 * the head, the guide's own scripts after it, the runtime last. It lives in the server (the preview
 * server injects it) but it is a page script, so it is exercised here, where there is a DOM.
 *
 * Each guide gets a fresh child window — a jsdom iframe — with what the sandbox does to a real one:
 * no storage (both getters throw), and a `parent` that is the pane, recording what is posted to it.
 * Two things jsdom cannot do are done by hand: it does not turn a frame's `name` attribute into the
 * window's name (the window's name is set directly, which is what the attribute does in Chromium —
 * the live check covers that half), and its `about:blank` frames reject `history.replaceState`.
 */

/* Imported by path rather than by name: the runtime belongs to the server package, and a literal
   specifier would pull a server file into the renderer's type-checked project. */
const RUNTIME = new URL("../../../../../../server/src/documents/guide-runtime.ts", import.meta.url).pathname;
let GUIDE_BOOT = "", GUIDE_JS = "";
beforeAll(async () => {
  ({ GUIDE_BOOT, GUIDE_JS } = (await import(/* @vite-ignore */ RUNTIME)) as { GUIDE_BOOT: string; GUIDE_JS: string });
});

type Posted = { type: string; [k: string]: unknown };
type Frame = { w: Window & typeof globalThis; doc: Document; posted: Posted[]; tops: number[]; routes: string[] };

/** An `about:blank` frame's path, which is what the runtime reads its document's name from. */
const DOC = "blank";
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function load(body: string, { name = "", head = "" } = {}): Frame {
  const el = document.createElement("iframe");
  document.body.append(el);
  const w = el.contentWindow as Window & typeof globalThis;
  for (const k of ["localStorage", "sessionStorage"]) {
    Object.defineProperty(w, k, { configurable: true, get() { throw new w.DOMException("The document is sandboxed.", "SecurityError"); } });
  }
  const posted: Posted[] = [];
  // Cloned, as postMessage clones: what the pane keeps must not change under it afterwards.
  Object.defineProperty(w, "parent", { configurable: true, value: { postMessage: (m: unknown) => posted.push(JSON.parse(JSON.stringify(m))) } });
  const tops: number[] = [];
  let y = 0;
  Object.defineProperty(w, "scrollY", { configurable: true, get: () => y });
  w.scrollTo = ((_x: number, top: number) => { y = top; tops.push(top); }) as typeof w.scrollTo;
  const routes: string[] = [];
  w.history.replaceState = ((_s: unknown, _t: string, url?: string | URL | null) => { routes.push(String(url)); }) as History["replaceState"];
  (w as unknown as { routes: string[] }).routes = routes;
  w.name = name;
  w.document.open();
  w.document.write(`<!doctype html><html><head><script>${GUIDE_BOOT}</script>${head}</head><body>${body}<script>${GUIDE_JS}</script></body></html>`);
  w.document.close();
  return { w, doc: w.document, posted, tops, routes };
}

/** What the pane would keep: the last state the frame posted. */
function lastState(f: Frame): GuideState {
  const s = [...f.posted].reverse().find((m) => m.type === "realm-guide:state");
  if (!s) throw new Error(`no state posted: ${JSON.stringify(f.posted.map((m) => m.type))}`);
  return s.state as GuideState;
}
/** The frame's name as the pane makes it (`guideEnvelope`). */
const envelope = (state: GuideState, doc = DOC) => JSON.stringify({ k: GUIDE_STATE_MARK, doc, state });
/** The runtime snapshots a moment after the event that changed something. */
const settle = () => tick(90);

const QUIZ_A = `<section class="rg-quiz" data-topic="sets">
  <div class="rg-question" data-answer="b"><p>Which?</p><ol class="rg-options"><li>a</li><li>b</li><li>c</li></ol></div>
  <div class="rg-question" data-answer="a,c"><p>Which all?</p><ol class="rg-options"><li>a</li><li>b</li><li>c</li></ol></div>
  <div class="rg-question" data-answer="MESI|mesi"><p>Protocol?</p><input class="rg-input"><div class="rg-explain">Because.</div></div>
  <button class="rg-check">Check answers</button>
</section>`;
const QUIZ_B = `<section class="rg-quiz" data-topic="bayes">
  <div class="rg-question" data-answer="a"><p>Prior?</p><ol class="rg-options"><li>yes</li><li>no</li></ol></div>
  <button class="rg-check">Check answers</button>
</section>`;
const REST = `<div class="rg-steps"><div class="rg-step">one</div><div class="rg-step">two</div><div class="rg-step">three</div></div>
<details class="rg-reveal"><summary>Show answer</summary>42</details>
<details open><summary>Notes</summary>open by default</details>
<div class="rg-flashcards"><div class="rg-card"><div class="rg-front">Q1</div><div class="rg-back">A1</div></div><div class="rg-card"><div class="rg-front">Q2</div><div class="rg-back">A2</div></div></div>`;
const GUIDE = QUIZ_A + QUIZ_B + REST;

/** Everything the reader can have done to GUIDE, read off the page. */
function readGuide(doc: Document) {
  const quizzes = [...doc.querySelectorAll(".rg-quiz")].map((q) => ({
    picked: [...q.querySelectorAll(".rg-question")].map((x) => [...x.querySelectorAll(".rg-options > li")].map((li) => li.getAttribute("aria-checked") === "true" ? 1 : 0).join("")),
    typed: [...q.querySelectorAll<HTMLInputElement>(".rg-input")].map((i) => i.value),
    checked: q.getAttribute("data-checked") === "true",
    score: q.querySelector(".rg-score")?.textContent ?? null,
    button: q.querySelector(".rg-check")?.textContent ?? null,
  }));
  return {
    quizzes,
    step: doc.querySelector(".rg-steps-counter")?.textContent ?? null,
    flipped: [...doc.querySelectorAll(".rg-card")].map((c) => c.getAttribute("data-flipped") === "true"),
    open: [...doc.querySelectorAll("details")].map((d) => d.open),
  };
}

/** The reader works through GUIDE: picks and a typed answer in the first quiz (left unchecked), the
 *  second quiz answered and checked, a step taken, a card flipped, the reveal opened, the open note shut. */
async function work(f: Frame) {
  const li = (q: number, n: number, o: number) => f.doc.querySelectorAll(".rg-quiz")[q]!.querySelectorAll(".rg-question")[n]!.querySelectorAll<HTMLElement>(".rg-options > li")[o]!;
  li(0, 0, 1).click();
  li(0, 1, 0).click(); li(0, 1, 2).click();
  const input = f.doc.querySelector<HTMLInputElement>(".rg-input")!;
  input.value = "mesi"; input.dispatchEvent(new f.w.Event("input", { bubbles: true }));
  li(1, 0, 0).click();
  f.doc.querySelectorAll<HTMLElement>(".rg-check")[1]!.click();
  [...f.doc.querySelectorAll<HTMLButtonElement>(".rg-steps-nav button")].find((b) => /Next/.test(b.textContent ?? ""))!.click();
  f.doc.querySelectorAll<HTMLElement>(".rg-card")[1]!.click();
  const [reveal, note] = f.doc.querySelectorAll("details");
  reveal!.open = true; note!.open = false;
  f.doc.dispatchEvent(new f.w.Event("toggle"));
  await settle();
}

const WORKED = {
  quizzes: [
    { picked: ["010", "101", ""], typed: ["mesi"], checked: false, score: null, button: "Check answers" },
    { picked: ["10"], typed: [], checked: true, score: "1 / 1 correct", button: "Retake" },
  ],
  step: "Step 2 of 3",
  flipped: [false, true],
  open: [true, false],
};

describe("the guide runtime keeps what the reader was in the middle of", () => {
  it("reports answers, a checked quiz, a step, a flipped card and open sections, and a new frame made with them puts every one back", async () => {
    const first = load(GUIDE);
    await tick();
    await work(first);
    expect(readGuide(first.doc)).toEqual(WORKED);
    const kept = lastState(first);

    const again = load(GUIDE, { name: envelope(kept) });
    await tick();
    /* THE MUTANT: drop `if (seed) apply(seed)` from init. The state is posted, kept and handed back,
       and the guide still comes back blank — which is the owner's report, exactly. */
    expect(readGuide(again.doc)).toEqual(WORKED);
    // Checked again quietly: the attempt was recorded when the reader checked it. A second one per
    // switch would fill the sidecar with attempts nobody made.
    expect(again.posted.filter((m) => m.type === "realm-guide:attempt")).toEqual([]);
    expect(first.posted.filter((m) => m.type === "realm-guide:attempt")).toHaveLength(1);
    expect(again.posted.find((m) => m.type === "realm-guide:ready")).toEqual({ type: "realm-guide:ready", doc: DOC, seeded: true });
  });

  it("keeps only what differs from the page as written, so an untouched guide hands back nothing", async () => {
    const f = load(GUIDE);
    await tick();
    f.doc.querySelector<HTMLElement>(".rg-card")!.click();
    f.doc.querySelector<HTMLElement>(".rg-card")!.click();
    await settle();
    expect(lastState(f).widgets).toEqual({});
  });

  it("does not lay a rewritten quiz's old answers onto it — the rest of the guide still comes back", async () => {
    const first = load(GUIDE);
    await tick();
    await work(first);
    const kept = lastState(first);

    // An agent reworded the first quiz's first question. Its answer key and option count are unchanged,
    // which is exactly when an index-only key would have put the old picks back onto a new question.
    const rewritten = GUIDE.replace("<p>Which?</p>", "<p>Which one, now?</p>");
    const again = load(rewritten, { name: envelope(kept) });
    await tick();
    const read = readGuide(again.doc);
    /* THE MUTANT: key widgets by kind and index alone (drop the signature). The old picks land on the
       reworded quiz and this reads ["010","101",""]. */
    expect(read.quizzes[0]).toEqual({ picked: ["000", "000", ""], typed: [""], checked: false, score: null, button: "Check answers" });
    expect(read.quizzes[1]).toEqual(WORKED.quizzes[1]);
    expect({ step: read.step, flipped: read.flipped, open: read.open }).toEqual({ step: WORKED.step, flipped: WORKED.flipped, open: WORKED.open });
    // And the stale answers are shed from the state the pane keeps, rather than carried forever.
    await tick();
    expect(Object.keys(lastState(again).widgets ?? {}).some((k) => k.startsWith("q0:"))).toBe(false);
  });

  it("ignores a hand-off made for another document — a link followed inside the frame keeps its name", async () => {
    const first = load(GUIDE);
    await tick();
    await work(first);
    const other = load(GUIDE, { name: envelope(lastState(first), "docs1/guides/other.html") });
    await tick();
    expect(readGuide(other.doc).quizzes[0]!.picked).toEqual(["000", "000", ""]);
    expect(other.posted.find((m) => m.type === "realm-guide:ready")).toMatchObject({ seeded: false });
  });

  it("keeps the frame's name current, so a page's own reload comes back as it was an instant before", async () => {
    const f = load(GUIDE);
    await tick();
    await work(f);
    /* THE MUTANT: drop `boot.write()` from snapshot. The name keeps whatever the pane made the frame
       with, and a Retake or a course's reset reloads into the state from minutes ago. */
    const env = JSON.parse(f.w.name) as { k: string; doc: string; state: GuideState };
    expect(env).toMatchObject({ k: GUIDE_STATE_MARK, doc: DOC });
    expect(env.state.widgets).toEqual(lastState(f).widgets);
  });

  it("Retake clears the quiz where it stands, and its answers do not come back", async () => {
    const f = load(GUIDE);
    await tick();
    await work(f);
    f.doc.querySelectorAll<HTMLElement>(".rg-check")[1]!.click(); // the checked one reads "Retake"
    await settle();
    expect(readGuide(f.doc).quizzes[1]).toEqual({ picked: ["00"], typed: [], checked: false, score: null, button: "Check answers" });
    expect(readGuide(f.doc).quizzes[0]!.picked).toEqual(["010", "101", ""]); // the other quiz is left alone
    expect(Object.keys(lastState(f).widgets ?? {}).some((k) => k.startsWith("q1:"))).toBe(false);
    // A cleared input question is writable again.
    f.doc.querySelectorAll<HTMLElement>(".rg-check")[0]!.click();
    f.doc.querySelectorAll<HTMLElement>(".rg-check")[0]!.click();
    const input = f.doc.querySelector<HTMLInputElement>(".rg-input")!;
    expect([input.value, input.hasAttribute("readonly"), f.doc.querySelectorAll(".rg-answer").length]).toEqual(["", false, 0]);
  });

  it("puts the reader back at their scroll offset from the hand-off", async () => {
    const f = load(GUIDE, { name: envelope({ v: 1, top: 1234 }) });
    await tick(30);
    expect(f.tops).toContain(1234);
  });
});

describe("a guide's own storage", () => {
  /** A guide in the course kit's manner: progress in localStorage, read once as it starts, written on
   *  every answer, with an in-memory fallback for when storage throws. */
  const KIT_HEAD = `<script>
    var KEY = "course-v1", mem = {};
    var S; try { S = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { S = mem; }
    S.done = S.done || 0;
    window.answer = function () { S.done++; try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { mem = S; } };
    window.started = S.done;
  </script>`;

  it("stands one in for the sandbox's, and the guide's next load finds its progress there before its script runs", async () => {
    const first = load("<p>course</p>", { head: KIT_HEAD });
    await tick();
    expect((first.w as unknown as { started: number }).started).toBe(0);
    (first.w as unknown as { answer: () => void }).answer();
    (first.w as unknown as { answer: () => void }).answer();
    /* THE MUTANT: skip the stand-in (`stand(...)` returns at once). The guide's write throws, its catch
       keeps S in a variable, and the next load starts at 0 — the course restarting from the top. */
    expect(lastState(first).local).toEqual({ "course-v1": JSON.stringify({ done: 2 }) });

    const again = load("<p>course</p>", { head: KIT_HEAD, name: envelope(lastState(first)) });
    await tick();
    expect((again.w as unknown as { started: number }).started).toBe(2);
  });

  it("answers as a Storage does: by key, as properties, by index, and refusing what would overflow it", async () => {
    const f = load("<p>x</p>", { head: `<script>
      localStorage.best = "3";
      localStorage.setItem("seen", "1");
      window.out = { best: localStorage.getItem("best"), prop: localStorage.seen, len: localStorage.length, keys: Object.keys(localStorage).sort(), key0: localStorage.key(0), has: "best" in localStorage, missing: localStorage.getItem("none") };
      delete localStorage.seen;
      try { localStorage.setItem("big", "x".repeat(1000001)); window.full = "no"; } catch (e) { window.full = e.name; }
      sessionStorage.setItem("tab", "a");
    </script>` });
    await tick();
    const w = f.w as unknown as { out: unknown; full: string };
    expect(w.out).toEqual({ best: "3", prop: "1", len: 2, keys: ["best", "seen"], key0: "best", has: true, missing: null });
    expect(w.full).toBe("QuotaExceededError");
    expect(lastState(f)).toMatchObject({ local: { best: "3" }, session: { tab: "a" } });
  });

  it("posts a storage write at once, before the runtime has even loaded", async () => {
    const f = load("<p>x</p>", { head: `<script>localStorage.setItem("k", "v");</script>` });
    // The guide wrote during the parse; the pane has it before `ready`.
    const types = f.posted.map((m) => m.type);
    await tick();
    expect(types[0]).toBe("realm-guide:state");
    expect(f.posted[0]).toMatchObject({ doc: DOC, state: { local: { k: "v" } } });
  });

  it("puts the guide's own route back before the guide's script reads it", async () => {
    // The stub records the boot's call (jsdom's about:blank frames refuse a real replaceState), and the
    // guide's own first script copies what had been recorded by the time it ran.
    const f = load("<p>x</p>", { name: envelope({ v: 1, hash: "#u-cache" }), head: `<script>window.seenFirst = window.routes.slice();</script>` });
    await tick();
    expect((f.w as unknown as { seenFirst: string[] }).seenFirst).toEqual(["#u-cache"]);
  });
});

describe("the pane's copy, when the frame came up without it", () => {
  it("is applied when it arrives, if the reader has not started", async () => {
    const first = load(GUIDE);
    await tick();
    await work(first);
    const kept = lastState(first);

    const bare = load(GUIDE);
    await tick();
    expect(bare.posted.find((m) => m.type === "realm-guide:ready")).toEqual({ type: "realm-guide:ready", doc: DOC, seeded: false });
    bare.w.dispatchEvent(new bare.w.MessageEvent("message", { data: { type: "realm-guide:restore", state: kept } }));
    await tick();
    expect(readGuide(bare.doc)).toEqual(WORKED);
    expect(bare.posted.filter((m) => m.type === "realm-guide:attempt")).toEqual([]);
  });

  it("is not laid over what the reader has already done in this frame", async () => {
    const first = load(GUIDE);
    await tick();
    await work(first);
    const bare = load(GUIDE);
    await tick();
    bare.w.dispatchEvent(new bare.w.Event("pointerdown"));
    bare.doc.querySelectorAll<HTMLElement>(".rg-card")[0]!.click();
    bare.w.dispatchEvent(new bare.w.MessageEvent("message", { data: { type: "realm-guide:restore", state: lastState(first) } }));
    await tick();
    expect(readGuide(bare.doc).flipped).toEqual([true, false]);
  });

  it("gives storage to a guide that has not read its own yet", async () => {
    const bare = load("<p>x</p>");
    await tick();
    bare.w.dispatchEvent(new bare.w.MessageEvent("message", { data: { type: "realm-guide:restore", state: { v: 1, local: { k: "v" } } } }));
    await tick();
    expect(bare.w.localStorage.getItem("k")).toBe("v");
  });
});
