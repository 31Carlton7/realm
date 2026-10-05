import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { BAR_CHROME, actionsThatFit } from "./components/pane-bar-fit";
import { TOOLBAR_BUTTON, TOOLBAR_CHROME } from "./panes/simulator/toolbar-fit";
import { REALM_SEED, deriveVars } from "@realm/ui";
import { AGENT_FRAME, oklchToHex } from "@realm/contracts";
import { PICTURE_RADIUS, SCREEN_INSET, SCREEN_PAD, SCREEN_RADIUS } from "./panes/machine/fit";
import { MAX_ROWS_PX } from "./panes/session/Composer";
import { PRESSABLE } from "./press-tracking";

/** §6's motion table and its "do NOT animate" list are enforceable only against the stylesheet
 *  itself — jsdom has no layout, no compositor and no CSSOM for a raw file, so nothing else in the
 *  suite can notice a stray `transition:` on a resize handle or a pop-in creeping back onto the
 *  command palette. These read the real `styles.css` and assert the values written by hand from the
 *  spec, so a one-line edit to a duration, an easing or a forbidden surface fails here. */
/* Vite rewrites `import.meta.url` to a non-file scheme under jsdom, so walk up from the cwd instead
   (vitest may be invoked from the repo root or from apps/desktop). */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
/* Comments are stripped first: they sit between rules and would otherwise be swallowed into the
   following selector, and prose about `transition: all` must not read as a use of it. */
const css = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
/** tokens.css, whole. Two describes below read their own copy for a mode BLOCK; this one is for the
 *  handful of scalars a stylesheet rule is written against. */
const tokensCss = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8");

/** Flat (non-nested) rules: `selector { body }`. Bodies containing braces — @media, @keyframes —
 *  never match as a whole, so their inner rules are picked up with their own bare selectors instead. */
/** A selector list split at its OWN commas — not the ones inside `:is(a, b)` or `:not(a, b)`, which
 *  are part of one selector. */
const splitSelectors = (list: string): string[] => {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
};
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: splitSelectors(m[1]!).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean),
  body: m[2]!.replace(/\s+/g, " ").trim(),
}));

/** Every declaration block of every rule that lists `selector` as one of its comma-separated parts. */
const bodiesFor = (selector: string): string[] => {
  const hits = RULES.filter((r) => r.selectors.includes(selector)).map((r) => r.body);
  expect(hits.length, `no rule in styles.css targets \`${selector}\``).toBeGreaterThan(0);
  return hits;
};

/** Selector parts with any leading comment stripped — a rule's `selectors` chunk starts at the end of
 *  the previous rule, so a comment above it rides along on the first part. */
const partsOf = (r: { selectors: string[] }): string[] =>
  r.selectors.map((s) => s.replace(/\/\*[\s\S]*?\*\//g, "").trim()).filter(Boolean);

/* Ligatures render only where tracking is zero (Chromium suppresses them on any spaced run, and
   `font-variant-ligatures` cannot override it — measured in the real window). So the reset is not
   decoration: a mono surface missing from it silently loses `=>` and `!==`. THE mutant this kills is
   the quiet one — someone adds a rule reading --font-mono and never touches this list. */
it("gives up the app's tracking on every surface that uses the mono face, so its ligatures render", () => {
  const monoSelectors = new Set(RULES.filter((r) => r.body.includes("var(--font-mono)")).flatMap(partsOf));
  const reset = RULES.filter((r) => /^letter-spacing:\s*normal;?$/.test(r.body)).flatMap(partsOf);
  expect(monoSelectors.size).toBeGreaterThan(20);
  expect([...monoSelectors].filter((s) => !reset.includes(s))).toEqual([]);
});

/* The socket-down banner is the one surface in the app that a state change alone puts at the top of
   the window. It used to cut in fully formed. (The error bar that stood beside it is a toast now.) */
it("brings the system notices in on the transcript's own entrance rung, from the edge each hangs off", () => {
  for (const sel of [".conn-banner"]) {
    const body = bodiesFor(sel).join(" ");
    expect(body, `${sel} enters with no animation`).toMatch(/animation:\s*rl-[a-z-]+ var\(--dur-enter\) var\(--ease-out-strong\)/);
  }
  // THE mutant: write the banner's entrance without its own centring transform. Every frame but the
  // last then lacks `translateX(-50%)`, so a notice about a dropped socket slides in from the middle
  // of the window and snaps into place — motion that says something false about where it came from.
  const notice = css.slice(css.indexOf("@keyframes rl-notice-in"));
  const frames = notice.slice(0, notice.indexOf("}", notice.indexOf("to {")));
  for (const t of frames.match(/transform:[^;]+/g) ?? []) expect(t).toContain("translateX(-50%)");
  expect((frames.match(/transform:/g) ?? []).length).toBe(2); // both ends carry one
});

it("keeps expanded images at full opacity when their expansion button is disabled", () => {
  expect(bodiesFor(".media-image:disabled").join(" ")).toMatch(/opacity:\s*1\s*;/);
});

/** Brace-balanced contents of every block introduced by `prelude` (an at-rule or keyframes header). */
function blocksAfter(prelude: string): string[] {
  const out: string[] = [];
  for (let at = css.indexOf(prelude); at >= 0; at = css.indexOf(prelude, at + 1)) {
    const open = css.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) { out.push(css.slice(open + 1, i)); break; }
    }
  }
  expect(out.length, `${prelude} is missing from styles.css`).toBeGreaterThan(0);
  return out;
}
const blockAfter = (prelude: string): string => blocksAfter(prelude).join("\n");

/** The motion ladder, read straight out of tokens.css: rung → milliseconds. §6's table is pinned
 *  through it rather than against literals, so each timing below is now two facts — the rule reaches
 *  for the right RUNG, and that rung is still the millisecond value §6 specified. Either one can
 *  break on its own, and they fail with different messages. */
const LADDER: Record<string, number> = Object.fromEntries(
  [...readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8")
    .matchAll(/(--dur-[a-z]+):\s*(\d+)ms/g)].map((m) => [m[1]!, Number(m[2])]),
);
/** `var(--dur-x)`, and a hard failure if the rung does not exist — a typo'd token in an assertion
 *  would otherwise quietly pin a string nothing in the stylesheet can ever match. */
const dur = (rung: string): string => {
  expect(LADDER[rung], `${rung} is not a rung of the ladder in tokens.css`).toBeGreaterThan(0);
  return `var(${rung})`;
};

describe("§6 motion ladder", () => {

  it("no component writes a duration of its own", () => {
    // The failure mode this closes is the one the ladder was built to end: four tokens existed, two
    // of them with no users at all, while 46 declarations wrote their own literals — so the ladder
    // documented a system the stylesheet was not on.
    const bare = new Set([...css.replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/(?:transition|animation)[^;{}]*?(?<![\d.])([\d.]+m?s)\b/g)].map((m) => m[1]!));
    // Loop PERIODS are a tempo, not the duration of a change, and the stagger step is a delay
    // between siblings rather than a duration at all. Neither belongs on the ladder. 24s is the
    // grain's drift: an ambient tempo an order of magnitude off the slowest rung, and putting it on
    // the ladder would invite a UI transition to reach for it.
    for (const period of ["0.9s", "1.4s", "3.6s", "24s", "40ms"]) bare.delete(period);
    // Nor is a threshold: 600ms is how long a browser pane's first page has to keep a person waiting
    // before its spinner comes up at all — a page that answers sooner never shows one.
    bare.delete("600ms");
    // Zero is not a rung either: it is the absence of a duration, written where a hover or a press
    // has to land on the frame the pointer did (the Press rule).
    bare.delete("0s");
    expect([...bare].sort()).toEqual([]);
  });
});

describe("§6 motion table", () => {

  /* A menu is NSMenu: there at once, gone on a short fade. THE mutants are an entrance creeping back
     onto `.menu` (a click waiting on a picture of the answer) and the exit growing travel again. */
  it("menus open instantly and leave on a fade with no travel, on the press rung", () => {
    for (const body of bodiesFor(".menu")) expect(body).not.toContain("animation");
    const exit = bodiesFor(".menu[data-closing]").join(" ");
    expect(exit).toContain(`animation: rl-fade-out ${dur("--dur-press")} var(--ease-fade) forwards`);
    // A surface that is on its way out must not still be catching clicks. `inert` is the real
    // guard (Menu.tsx sets it) — this is the half that holds for the frame before the attribute.
    expect(exit).toContain("pointer-events: none");
    expect(blockAfter("@keyframes rl-fade-out")).not.toContain("transform");
  });

  it("popovers grow out of their anchor on the spring and leave the way they arrived, holding nothing behind", () => {
    for (const sel of [".model-picker", ".icon-picker"]) {
      expect(bodiesFor(sel).join(" "), sel).toContain(`animation: rl-menu-in ${dur("--dur-pop")} var(--spring-smooth)`);
      const body = bodiesFor(`${sel}[data-closing]`).join(" ");
      expect(body, sel).toContain(`animation: rl-menu-out ${dur("--dur-press")} var(--ease-out-strong) forwards`);
      expect(body, sel).toContain("pointer-events: none");
    }
    expect(blockAfter("@keyframes rl-menu-in")).toContain("scale(.97)");
    // The exit is the enter played backwards, not a second idea about what a popover does.
    expect(blockAfter("@keyframes rl-menu-out")).toContain("scale(.97)");
    // No half-pairs. A surface that only animates while you are trying to get rid of it is worse
    // than one that never animates, so an exit may only exist where the matching enter already does
    // — which rules the @-mention typeahead and the skill picker out, both of which appear instantly.
    const listOf = (decl: string) => RULES.filter((r) => r.body.includes(decl)).flatMap((r) => r.selectors);
    const enters = new Set(listOf("rl-menu-in"));
    for (const sel of listOf("rl-menu-out")) expect(enters, sel).toContain(sel.replace("[data-closing]", ""));
  });

  /* The curve is a spring because of how it STARTS. THE mutant is a cubic ease-out pasted over it:
     that leaves at full speed, and the first sample here would be far past 0.01. */
  it("the spring starts from rest and settles without overshoot", () => {
    const curve = tokensCss.match(/--spring-smooth:\s*linear\(([^)]*)\)/)?.[1];
    expect(curve, "--spring-smooth is not a linear() curve in tokens.css").toBeTruthy();
    const values = curve!.split(",").map((stop) => Number(stop.trim().split(/\s+/)[0]));
    expect(values[0]).toBe(0);
    expect(values[1]).toBeLessThan(0.05);
    expect(values.at(-1)).toBe(1);
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    expect(Math.max(...values)).toBe(1);
  });

  it("the DOM hold and the CSS exit are the same number", () => {
    // `use-anchored-popover.ts` keeps a dismissed popover mounted on a timer; the stylesheet fades it
    // on an animation. Nothing in either file can notice the two drifting apart — a short timer clips
    // the fade, a long one parks a finished surface on screen — so they are pinned to each other here.
    const hook = readFileSync(repoFile("apps/desktop/src/renderer/src/components/use-anchored-popover.ts"), "utf8");
    expect(Number(hook.match(/const EXIT_MS = (\d+);/)?.[1])).toBe(LADDER["--dur-press"]);
  });

  /* A toast rises on the spring a surface arrives on and leaves on a shorter fade, and the component
     holds a leaving one in the DOM on a timer. THE mutants: the two numbers drifting apart (a clipped
     fade, or a finished toast parked on screen), a leaving toast still catching clicks, and the line
     across its foot running on while the clock it draws is stopped. */
  it("toasts arrive on the spring, leave on a shorter fade the DOM waits out, and their line stops with their clock", () => {
    expect(bodiesFor(".toast").join(" ")).toContain(`animation: rl-toast-rise ${dur("--dur-slow")} var(--spring-smooth)`);
    const leaving = bodiesFor(".toast[data-leaving]").join(" ");
    expect(leaving).toContain(`opacity ${dur("--dur-swap")} var(--ease-fade)`);
    expect(leaving).toContain("pointer-events: none");
    const toasts = readFileSync(repoFile("apps/desktop/src/renderer/src/components/Toasts.tsx"), "utf8");
    expect(Number(toasts.match(/export const TOAST_EXIT_MS = (\d+);/)?.[1])).toBe(LADDER["--dur-swap"]);
    expect(bodiesFor(".toast[data-paused] .toast-progress").join(" ")).toContain("animation-play-state: paused");
  });

  /* THE mutants: a tooltip that catches the pointer (it would steal the hover from the control it
     names, and flicker), one drawn under the menus and toasts it explains, and one that wears a colour
     of its own instead of the per-theme chip tokens. */
  it("the tooltip never takes the pointer, floats over menus and toasts, and arrives on the tip's own rung", () => {
    const tip = bodiesFor(".tooltip").join(" ");
    expect(tip).toContain("pointer-events: none");
    const z = (sel: string) => Number(bodiesFor(sel).join(" ").match(/z-index:\s*(\d+)/)?.[1]);
    expect(z(".tooltip")).toBeGreaterThan(z(".menu"));
    expect(z(".tooltip")).toBeGreaterThan(z(".toasts"));
    expect(tip).toContain("background: var(--tooltip-bg)");
    expect(tip).toContain("color: var(--tooltip-fg)");
    expect(bodiesFor(".tooltip[data-open]").join(" ")).toContain(`opacity ${dur("--dur-fast")}`);
    expect(bodiesFor(".tooltip[data-instant]").join(" ")).toContain("transition: none");
  });

  it("transcript items enter at 180ms with a 6px rise, gated on the data-enter mark Transcript.tsx sets", () => {
    expect(bodiesFor(".transcript-col > [data-enter]").join(" ")).toContain(`animation: rl-msg-in ${dur("--dur-enter")} var(--ease-out-strong)`);
    expect(blockAfter("@keyframes rl-msg-in")).toContain("translateY(6px)");
  });

  /* The lines Realm writes about the session — the run receipt, the seams, an error, the closing
     summary, the live label — arrived on the block rung above, and a strong ease-out under a quiet
     grey line reads as a stamp rather than an arrival. THE mutants: putting any of them back on
     rl-msg-in (the rise returns), and swapping --ease-fade for a strong curve (the fade front-loads
     into the same hard cut it was written to end). Both are caught by naming the pair exactly. */
  it("system lines in the transcript fade with no travel, on the slow rung and the even curve", () => {
    const entrance = `animation: rl-fade-in ${dur("--dur-slow")} var(--ease-fade)`;
    for (const sel of [".transcript-col > .msg-run[data-enter]", ".transcript-col > .msg-handoff[data-enter]",
                       ".transcript-col > .msg-error[data-enter]", ".msg-transcript-summary", ".msg-working"]) {
      const body = bodiesFor(sel).join(" ");
      expect(body, `${sel} does not fade in`).toContain(entrance);
      expect(body, `${sel} still rises`).not.toContain("rl-msg-in");
    }
    // A fade is opacity and nothing else; a keyframe that grew a transform would make the name lie.
    expect(blockAfter("@keyframes rl-fade-in")).not.toContain("transform");
    // And the curve has to be the even one — a strong ease-out here is the original complaint.
    expect(tokensCss).toContain("--ease-fade: cubic-bezier(0.4, 0, 0.2, 1)");
  });

  /* Streamed prose fades as it arrives (`arrival-fade.ts`), on the system lines' pair: text
     appearing, not an object landing. THE mutants: a rise (`rl-msg-in`), which would twitch every
     chunk upward as it lands, dozens of times a second; and a resting `opacity` on the span — reduced
     motion removes the animation, and whatever the span rests at is all the reader gets. (That it is
     never paused when the window goes quiet is the quiet list's own test: it ends.) */
  it("streamed prose fades in where it lands, and rests fully opaque", () => {
    const body = bodiesFor(".md-arrival").join(" ");
    expect(body).toContain(`animation: rl-fade-in ${dur("--dur-slow")} var(--ease-fade)`);
    expect(body).not.toContain("rl-msg-in");
    expect(body).not.toMatch(/(^|;|\s)opacity:/);
  });

  /* A Mac button does not shrink; it darkens, on the mouse-down frame. THE mutants: a scale coming
     back onto any press, and the zero leaving the hovered/pressed state (the highlight eases in). */
  it("a press is a fill one rung past hover, never a change of size", () => {
    for (const r of RULES.filter((r) => r.selectors.some((s) => s.includes(":active"))))
      expect(r.body, r.selectors.join(", ")).not.toMatch(/\bscale\b/);
    for (const sel of [".btn:is([data-pressed], :active:focus-visible):not(:disabled)", ".ghost-chip:is([data-pressed], :active:focus-visible):not([data-static])"])
      expect(bodiesFor(sel).join(" "), sel).toContain("--fill: var(--hover-2)");
    expect(bodiesFor(".icon-btn:is([data-pressed], :active:focus-visible):not(:disabled)").join(" ")).toContain("background: var(--hover-2)");
    expect(bodiesFor(".btn.primary:is([data-pressed], :active:focus-visible):not(:disabled)").join(" ")).toContain("--fill: var(--rl-accent-press)");
    expect(bodiesFor(".composer-send:is([data-pressed], :active:focus-visible):not(:disabled)").join(" ")).toContain("background: var(--rl-accent-press)");
    // The fill TRACKS the pointer (press-tracking.ts): drag off a held button and it lets go, drag
    // back and it lights again. THE mutant is a bare `:active` fill, which Chromium drops for good
    // the moment a held pointer leaves.
    for (const r of RULES.filter((r) => /--fill:|background/.test(r.body)))
      for (const sel of r.selectors.filter((sel) => sel.includes(":active") && !sel.includes("::-webkit-slider-thumb")))
        expect(sel, sel).toContain(":is([data-pressed], :active:focus-visible)");
    expect(bodiesFor(".ghost-chip").join(" ")).not.toContain("transform");
  });

  it("a hover or press arrives on the frame the pointer does, and only the release fades", () => {
    const instant = RULES.filter((r) => r.body === "transition-duration: 0s;" && r.selectors.some((s) => s.includes(":is(:hover, :active, [data-press-tracking])")));
    expect(instant).toHaveLength(1);
    const sel = instant[0]!.selectors.join(", ");
    // A tracked press is instant BOTH ways: dragged off a held button, the highlight goes at once.
    expect(sel).toContain(":is(:hover, :active, [data-press-tracking])");
    for (const control of ["button", '[role="button"]', '[role^="menuitem"]', ".item-row"]) expect(sel).toContain(control);
  });

  /* A choice is never half-made: the rows a person picks from change instantly in BOTH directions,
     so the zero sits on their base rule, not only on their hovered state. */
  it("rows chosen from a list highlight and unhighlight instantly", () => {
    const rows = RULES.find((r) => r.body === "transition-duration: 0s;" && r.selectors.includes(".palette-opt"));
    expect(rows, "no instant rule for list rows").toBeTruthy();
    for (const sel of [".palette-opt", '.menu [role^="menuitem"]', ".mp-row", ".mp-seg-opt", ".seg-opt", ".mention-row"])
      expect(rows!.selectors, sel).toContain(sel);
    // …and it comes after the shared hover rule it overrides, or the cascade would hand the fade back.
    const shared = RULES.findIndex((r) => r.selectors.includes(".palette-opt") && r.body.includes("transition: background-color"));
    expect(RULES.indexOf(rows!)).toBeGreaterThan(shared);
    // …and no LATER rule for one of them states a transition again: `.seg-opt`'s own rule did, after
    // this one, and every segmented control in the app faded its choice in and out.
    const after = RULES.slice(RULES.indexOf(rows!) + 1);
    for (const sel of rows!.selectors) {
      const later = after.filter((r) => r.selectors.includes(sel) && /(^|;)\s*transition(-duration)?:/.test(r.body));
      expect(later.map((r) => r.body), sel).toEqual([]);
    }
  });

  it("the send↔stop icon swap cross-fades over 160ms with opacity, scale and blur", () => {
    const swap = bodiesFor(".composer-send svg").join(" ");
    for (const prop of ["opacity", "transform", "filter"]) expect(swap, prop).toContain(`${prop} ${dur("--dur-swap")}`);
    expect(bodiesFor('.composer-send[data-state="send"] .stop-icon').join(" ")).toContain("blur(4px)");
  });

  it("the tool row expands by animating grid-template-rows over 200ms, with the content fading at 120ms", () => {
    expect(bodiesFor(".tool-body-wrap").join(" ")).toContain(`transition: grid-template-rows ${dur("--dur-base")} var(--ease-in-out-strong)`);
    expect(bodiesFor(".tool-body-wrap").join(" ")).toContain("grid-template-rows: 0fr");
    expect(bodiesFor(".tool-card[data-open] > .tool-body-wrap").join(" ")).toContain("grid-template-rows: 1fr");
    expect(bodiesFor(".tool-body").join(" ")).toContain(`transition: opacity ${dur("--dur-press")} ease`);
  });

  it("every disclosure in the app opens the same way — one rule, never a second guess at max-height", () => {
    // The sidebar's space sections ride the tool row's declaration rather than carrying a copy.
    // max-height is the alternative, and it is the wrong one twice over: the number has to be
    // guessed, and the easing then runs against a height the content does not have, so a short list
    // snaps and a long one is clipped.
    for (const sel of [".sb-section-wrap", ".tool-body-wrap"])
      expect(bodiesFor(sel).join(" "), sel).toContain(`transition: grid-template-rows ${dur("--dur-base")} var(--ease-in-out-strong)`);
    expect(bodiesFor(".sb-section-wrap[data-open]").join(" ")).toContain("grid-template-rows: 1fr");
    // 0fr only clips against an overflow container; without it the folded rows spill up the sidebar.
    expect(bodiesFor(".sb-section-clip").join(" ")).toContain("overflow: hidden");
    expect(css, "no disclosure may animate max-height").not.toMatch(/transition:[^;]*max-height/);
  });

  it("every glyph that carries a state turns over on ONE rule — no surface writes the swap again", () => {
    // The two that had their own copy of it are now comma-separated parts of the shared one, which
    // is what lets a third control (the media transport) reach for `.icon-swap` instead of writing
    // a fourth. Anything declaring the cross-fade outside this pair of rules is a copy coming back.
    const swapRules = RULES.filter((r) => r.body.includes("filter") && r.body.includes(dur("--dur-swap")) && r.body.includes("grid-area"));
    expect(swapRules).toHaveLength(1);
    expect(swapRules[0]!.selectors).toContain(".icon-swap > *");
    const down = RULES.filter((r) => r.body.includes("blur(4px)") && r.body.includes("scale(.25)"));
    expect(down).toHaveLength(1);
    // `.icon-swap` reads its state off the CONTAINER, so a control adopting it needs no new CSS —
    // just the two glyphs and a `data-on`.
    expect(down[0]!.selectors).toEqual(expect.arrayContaining([".icon-swap:not([data-on]) .swap-on", ".icon-swap[data-on] .swap-off"]));
  });

  it("an icon button can finally show that it is ON, one rung past hover", () => {
    // Bold, Italic, and the terminal drawer's ⌘J are `.icon-btn[aria-pressed]` and had no pressed
    // treatment of any kind — a toggle you could not tell the state of. The fill is the state (the
    // glyph does not change), so it has to sit ABOVE the hover fill or "on" and "under the pointer"
    // would be the same picture.
    const on = bodiesFor('.icon-btn[aria-pressed="true"]').join(" ");
    expect(on).toContain("background: var(--hover-2)");
    expect(bodiesFor(".icon-btn:hover").join(" ")).toContain("background: var(--rl-hover)");
    // …and it moves on the hover rung the button already carries — §6 gives it no rule of its own.
    expect(on).not.toContain("transition");
    expect(on).not.toContain("transform"); // hover and state are colour; geometry is the press alone
  });

  it("the bar's action budget never outlives the furniture it budgets for", () => {
    /* `BAR_CHROME` is what the bar always draws besides its title and actions. The pane's own back and
       forward were part of it (48px) until the window's one pair moved to the sidebar's head row
       (WindowNav): nothing may still style them, and the budget may not still be paying for them.
       THE mutant: leave the 48px in the sum, and every narrow bar folds an action it has room for. */
    expect(RULES.filter((r) => r.selectors.some((x) => x.includes(".panel-nav")))).toEqual([]);
    expect(BAR_CHROME).toBeLessThan(144 - 48 + 1);
    // The observer reports the CONTENT box, so the bar's own padding comes off the rule's number.
    const padding = 28;
    // The rung where the meta goes must still be leaving room for something — a ladder whose rungs
    // fire together is one rung with two names.
    const metaGone = Number(/\(max-width: (\d+)px\) \{ \.panel-meta/.exec(css)?.[1]);
    expect(actionsThatFit(metaGone - padding)).toBeGreaterThan(0);
  });

  it("New session is the head row's glyph and Quick chat a keystroke — neither is a row any more", () => {
    /* Plan 27: the column's first rows were "New session" and "Quick chat", two equal rows of one verb.
       New session is the ✎ in the head row now (and each space's + on hover), and Quick chat stays a
       keystroke. THE mutant is the half-removal: the rows deleted and their rules left behind. */
    for (const sel of [".new-row", ".quick-row", ".new-item", ".sb-head", ".sb-toggle", ".needs-you", ".sb-active", ".space-header"]) {
      expect(RULES.filter((r) => r.selectors.some((x) => x.split(/[\s:>[]/).includes(sel))), sel).toEqual([]);
    }
    // The head row is the 40px band the traffic lights centre in, beside the rail's.
    expect(bodiesFor(".sb-header").join(" ")).toContain("height: var(--frame-top)");
    expect(bodiesFor(":root").join(" ")).toContain("--frame-top: 40px");
    // The profile's name is the unbounded part of its row, so it is what gives way.
    expect(bodiesFor(".sb-profile").join(" ")).toContain("min-width: 0");
    expect(bodiesFor(".sb-profile-name").join(" ")).toContain("text-overflow: ellipsis");
    expect(bodiesFor(".sb-header-actions").join(" ")).toContain("flex: none");
  });

  it("a menu's shortcut reads as a KEY — a filled chip on the chip rung, not more of the sentence", () => {
    /* It was bare text held off the label by 18px of padding: the glyphs sat on the same plane as
       the words, and with no edge to hang on the column landed at a different x on every row. THE
       mutant: drop the fill and it is indistinguishable from the label it trails. The paint is the
       model picker's ⌘-digit badge verbatim — the same object, so not a second look for it. */
    const kbd = bodiesFor(".menu-kbd").join(" ");
    expect(kbd).toContain("background: var(--hover-2)");
    expect(kbd).toContain("border-radius: var(--r-chip)");
    expect(kbd).toContain("margin-left: auto"); // holds the right edge, so the chips form a column
    // The UI face, not `kbd`'s mono: ⌘⇧\ has to sit centred in a chip beside proportional words,
    // and a fixed advance width only makes the modifier glyphs drift inside it.
    expect(kbd).toContain("var(--font-ui)");
    /* The ink stays on `--rl-text-dim`, the rung the bare hint already wore. THE mutant: drop it to
       `--rl-text-faint` (the model picker's badge, which sits on the same fill) and the glyphs land
       at 2.5:1 dark / 2.2:1 light — measured in the built app, and under AA in both. A chip is a
       quieter shape, not quieter text. */
    expect(kbd).toContain("color: var(--rl-text-dim)");
    // A danger row tints its label; the shortcut is not part of the warning.
    expect(bodiesFor('.menu [role="menuitem"].danger .menu-kbd').join(" ")).toContain("color: var(--rl-text-dim)");
  });

  it("the copy ✓ swap uses the same 160ms opacity/scale/blur cross-fade as send↔stop", () => {
    const swap = bodiesFor(".tool-copy .copy-icon").join(" ");
    for (const prop of ["opacity", "transform", "filter"]) expect(swap, prop).toContain(`${prop} ${dur("--dur-swap")}`);
    expect(bodiesFor(".tool-copy:not([data-copied]) .copied-icon").join(" ")).toContain("blur(4px)");
  });

  it("the message action bar reaches for the rungs the copy button already pays for, not a set of its own", () => {
    const swap = bodiesFor(".msg-action .copy-icon").join(" ");
    for (const prop of ["opacity", "transform", "filter"]) expect(swap, prop).toContain(`${prop} ${dur("--dur-swap")}`);
    expect(bodiesFor(".msg-action:not([data-copied]) .copied-icon").join(" ")).toContain("blur(4px)");
    const btn = bodiesFor(".msg-action").join(" ");
    expect(btn).toContain(`background-color ${dur("--dur-hover")} ease`);
    expect(btn).not.toContain("transform");
    expect(bodiesFor(".msg-action:is([data-pressed], :active:focus-visible):not(:disabled)").join(" ")).toContain("background: var(--hover-2)");
    // A thumb's glyph is the same pressed or not, so the fill is the only thing saying which — one
    // rung past hover, the same reading .icon-btn's toggles get.
    expect(bodiesFor('.msg-action[aria-pressed="true"]').join(" ")).toContain("background: var(--hover-2)");
    // The shared -6px overhang is deliberately NOT taken: these sit 2px apart, and it would have
    // each button stealing clicks from the next.
    // Exactly one rule reaches it: joining the shared list would give it a second, all-sides one.
    expect(bodiesFor(".msg-action::after")).toEqual(['content: ""; position: absolute; inset: -6px 0;']);
  });

  it("the three in-flight states share one ping, and its ring survives prefers-reduced-motion", () => {
    // Only the ring moves; the core is untouched, so the row's dot column cannot jitter.
    const ring = bodiesFor('.status-dot[data-status="running"]::after').join(" ");
    expect(ring).toContain("animation: rl-ping var(--ring-rate)");
    // Authored at full strength with NO transform: the un-animated form has to be a steady halo, not
    // a half-scaled ghost. This one line is the whole reason the state is still legible when the
    // preference takes the motion away — a `transform: scale(...)` here silently breaks that.
    expect(ring).not.toContain("transform");
    expect(ring).toContain("inset: -3px");
    // …and the keyframe resolves to that same authored box, so the moving and still forms are one shape.
    expect(blockAfter("@keyframes rl-ping")).toContain("scale(1)");
    // Colour AND rate, never rate alone. waiting_permission is the one that needs a human, so it is
    // the loudest in BOTH modes: fastest ping with motion, warning tone against success without it.
    const waiting = bodiesFor('.status-dot[data-status="waiting_permission"]::after').join(" ");
    expect(ring).toContain("--ring-rate: 1.8s");
    expect(waiting).toContain("--ring-rate: 0.9s");
    expect(ring).toContain("--ring: var(--rl-success)"); // never accent — that is reserved for `driving`
    expect(waiting).toContain("--ring: var(--rl-warning)");
    // `*` does not match pseudo-elements, so without a rule naming these three the ping would be the
    // one animation on the page that ignores the preference.
    const reduced = blockAfter("@media (prefers-reduced-motion: reduce)").replace(/\s+/g, " ");
    for (const s of ["running", "waiting_permission", "driving"])
      expect(reduced, s).toContain(`.status-dot[data-status="${s}"]::after`);
    // The whole-dot opacity throb is gone from every state that now pings: two idioms for one thing
    // is how these drifted apart in the first place.
    for (const s of ["running", "waiting_permission", "driving"])
      expect(bodiesFor(`.status-dot[data-status="${s}"]`).join(" "), s).not.toContain("rl-pulse");
  });

  it("a space's state is the rows' own marks with a count, not a badge with a vocabulary of its own", () => {
    /* The strip's corner badge is gone with the strip (Plan 27). A section's head says what is going on
       in its space with the same `.status-dot` its rows wear, a count beside each — one fact, one mark,
       whether it is about a session or about the space it works in. THE mutant is a second badge style
       coming back for the head. */
    expect(RULES.filter((r) => r.selectors.some((sel) => sel.includes(".strip-badge")))).toEqual([]);
    expect(bodiesFor(".item-tally").join(" ")).toContain("display: flex");
    expect(bodiesFor(".item-count").join(" ")).toContain("font-variant-numeric: tabular-nums");
  });

  it("the greeting's nod is on the ladder like everything else, and the preference takes it away", () => {
    // An unadvertised flourish is still motion, and gets no exemption from either rule: it reaches
    // for a rung rather than inventing a tempo, and it is an ordinary element rule, so the global
    // `* { animation: none }` reaches it without the pseudo-element carve-out the ping needed.
    expect(bodiesFor(".hero-greeting[data-nod]").join(" ")).toContain(`animation: rl-nod ${dur("--dur-move")} var(--ease-in-out-strong)`);
    expect(blockAfter("@keyframes rl-nod")).toContain("transform: none");
    expect(RULES.some((r) => r.selectors.some((sel) => sel.includes("::") && sel.includes("hero-greeting")))).toBe(false);
  });

  it("nothing asks for `will-change` now the swiper is gone (§6 performance note)", () => {
    // The swiper's track was the one surface that earned a promoted layer — it moved under the fingers
    // every frame. With the spaces as sections nothing slides, and a hint with no motion behind it is a
    // layer held for nothing.
    const owners = RULES.filter((r) => r.body.includes("will-change")).flatMap((r) => r.selectors);
    expect(owners).toEqual([]);
  });
});

describe("the scroll track (ScrollTrack.tsx)", () => {
  it("lies over the log's own padding, and takes the pointer only where its ticks are", () => {
    const track = bodiesFor(".scroll-track").join(" ");
    expect(track).toContain("position: absolute");
    expect(track).toContain("pointer-events: none");
    expect(bodiesFor(".track-tick").join(" ")).toContain("pointer-events: auto");
  });

  /* THE mutant: a longer lit tick, a wider gap before the edit dot, or a track that starts further in.
     Any of them puts a resting mark over the first letters of every line in a narrow pane. */
  it("ends every resting mark inside the transcript's side padding, in the narrowest pane", () => {
    const px = (body: string, re: RegExp) => Number(body.match(re)?.[1]);
    const start = px(bodiesFor(".scroll-track").join(" "), /--track-x: clamp\((\d+)px/);
    const lit = px(bodiesFor(".track-tick[data-current] .track-line").join(" "), /width: (\d+)px/);
    const dot = bodiesFor(".track-tick[data-edited] .track-line::after").join(" ");
    const pad = px(bodiesFor(".transcript").join(" "), /padding: \d+px (\d+)px/);
    expect(start + lit + px(dot, /left: calc\(100% \+ (\d+)px\)/) + px(dot, /width: (\d+)px/)).toBeLessThan(pad);
  });

  it("rests as a mark a rung heavier on the light face, and comes up at once under the pointer", () => {
    expect(bodiesFor(".track-line").join(" ")).toContain("background: var(--tick)");
    expect(bodiesFor(':root[data-mode="light"] .scroll-track').join(" ")).toContain("--tick: var(--overlay-darken-500)");
    expect(bodiesFor(".scroll-track:is(:hover, :focus-within) .track-line").join(" ")).toContain("transition-duration: 0s");
  });

  it("puts up its card the way the tooltip comes and goes, and the card takes the pointer only while it is up", () => {
    const card = bodiesFor(".track-card").join(" ");
    expect(card).toContain("pointer-events: none");
    expect(card).toContain(`opacity ${dur("--dur-press")}`);
    const open = bodiesFor(".track-card[data-open]").join(" ");
    expect(open).toContain(`opacity ${dur("--dur-fast")}`);
    expect(open).toContain("pointer-events: auto");
  });

  it("gives a saved turn the accent — on the track, and on the card's filled ribbon", () => {
    expect(bodiesFor(".track-tick[data-saved] .track-line").join(" ")).toContain("var(--accent-ink)");
    expect(bodiesFor(".scroll-track:is(:hover, :focus-within) .track-tick[data-saved] .track-line").join(" ")).toContain("background: var(--accent-ink)");
    expect(bodiesFor('.track-card-save[aria-pressed="true"] svg *').join(" ")).toContain("fill: currentColor");
    // After the lens, so a saved tick under the pointer keeps its colour rather than turning to ink.
    const at = (sel: string) => RULES.findIndex((r) => r.selectors.includes(sel));
    expect(at(".scroll-track:is(:hover, :focus-within) .track-tick[data-saved] .track-line"))
      .toBeGreaterThan(at('.scroll-track:is(:hover, :focus-within) .track-tick[data-near="0"] .track-line'));
  });
});

describe("Ara refresh §3/§4 geometry", () => {
  it("the user message is Ara's signature: raised card, the prompter's curve, 14px 16px padding, 85% wide, left-aligned text", () => {
    // The radius moved off the circular ladder onto the squircle one: a sent message is the same
    // object the composer was holding a moment earlier, and the two now share a corner. Its own rung
    // (--r-squircle-msg) rather than the composer's, because a superellipse reads visually smaller
    // than the arc of the same radius and the ratio that suits a 720px card makes a bubble a lozenge.
    const body = bodiesFor(".msg-user").join(" ");
    for (const decl of ["text-align: left", "max-width: 85%", "border-radius: var(--r-squircle-msg)",
                        "corner-shape: squircle", "padding: 14px 16px", "background: var(--rl-raised)"])
      expect(body, decl).toContain(decl);
  });

  it("the bubble keeps the circular fallback AND the painted form, like every other squircle surface", () => {
    // `corner-shape` is a no-op until Chromium 139, and `paint()` with no registered painter renders
    // nothing at all — so dropping either half strands the bubble as a square card or an invisible one.
    const painted = bodiesFor(":root[data-squircle] .msg-user").join(" ");
    expect(painted).toContain("background: paint(rl-squircle)");
    expect(painted).toContain("border-radius: 0");
    expect(painted).toContain("--sq-fill: var(--rl-raised)");
    // The peer-attributed bubble's ring has to move onto the painted curve with it: a box-shadow ring
    // is drawn on the rounded rect whatever the fill does, so it would cross a corner the fill has
    // already bulged past.
    const from = bodiesFor(":root[data-squircle] .msg-user-row[data-from] .msg-user").join(" ");
    expect(from).toContain("--sq-ring:");
    expect(from).toContain("box-shadow: none");
  });

  it("transcript prose reads at 15px/1.6 — user card and assistant prose alike", () => {
    for (const sel of [".msg-user", ".msg-assistant"]) {
      const body = bodiesFor(sel).join(" ");
      expect(body, sel).toContain("font-size: 15px");
      expect(body, sel).toContain("line-height: calc(1.6 + var(--lh-shift))");
    }
  });

  /* Measured in a real Chromium at pane widths from 1100px down to 360px (jsdom has no layout, so
     the numbers below came from the browser, not from here). At a fixed 30px the longest greeting
     took three lines under roughly a 400px pane and a fixed-height box centred them, spilling a line
     into the top of the prompter card. THE mutants, both of which the browser showed and neither of
     which any other test can see: `min-height` back to `height` (the third line spills again), and
     dropping `min-width: 0` from the span (a flex item's automatic minimum is its longest
     unbreakable run, so a space named without spaces in it pushes the line out past both pane
     edges and `overflow-wrap` never gets to break it). */
  it("the hero greeting scales with its pane and keeps a third line inside the box", () => {
    const hero = bodiesFor(".hero-greeting").join(" ");
    // Fluid between two title rungs, against the SESSION PANE's inline size — the viewport would
    // give both halves of a split the same 30px the whole window earns.
    const size = hero.match(/font-size:\s*clamp\(([\d.]+)px,\s*([\d.]+)cqi,\s*([\d.]+)px\)/);
    expect(size, "the greeting is no longer fluid against its pane").not.toBeNull();
    expect(Number(size![1]), "floor below a title rung").toBeGreaterThanOrEqual(20);
    expect(Number(size![3]), "the wide case is not what it was drawn at").toBe(30);
    expect(bodiesFor(".session-pane").join(" "), "cqi above would resolve against some other box")
      .toContain("container-type: size");
    // A floor, not a fixed height: two lines still measure 2.3em, a third grows the box upward.
    expect(hero).toContain("min-height: 2.3em");
    expect(hero, "a fixed height centres the spare line over the card").not.toMatch(/[^-]height:\s*2\.3em/);
    const span = bodiesFor(".hero-greeting > span").join(" ");
    expect(span).toContain("min-width: 0");
    expect(span).toContain("overflow-wrap: break-word");
  });

  /* The rich-text mirror is only correct while it is metrically IDENTICAL to the textarea it sits
     under: same font, same size, same line-height, same padding box, same wrapping. Nothing in jsdom
     can notice a drift here — there is no layout — so the stylesheet is the only place to catch a
     stray padding tweak that would slide every painted glyph off the caret above it. */
  /**
   * The rule `draft-format.ts` states, enforced against the stylesheet rather than trusted to review.
   * Every `.ch-*` run is painted UNDER a textarea whose caret positions itself by the textarea's own
   * metrics, so a chip that grows padding, a border or a heavier face moves the mirror's glyphs and
   * nothing moves the caret to match. `box-shadow` and `border-radius` are the exceptions that make
   * a pill possible: both paint outside the run's box without the box growing.
   */
  it("no chip run changes a metric — the caret under the mirror belongs to the textarea", () => {
    // Any rule that reaches a `.ch-*` run at all, not just the bare class: a hover or a state
    // variant paints the same glyphs on the same layer and is under exactly the same rule.
    const chips = RULES.filter((r) => r.selectors.some((sel) => /\.ch-[a-z-]+/.test(sel)));
    expect(chips.length, "no .ch-* rules in styles.css").toBeGreaterThan(0);
    /* Paint, never layout. A custom property is not a metric (what reads it is checked here in its
       turn), and `box-decoration-break` only changes where padding and borders go at a line break —
       a run has neither. The mark is the one thing allowed to move: it is absolutely positioned over
       its sigil, out of the flow the caret is measured in, so it may fade while the × has its place. */
    const PAINT = ["color", "background", "background-color", "border-radius", "box-shadow", "text-decoration", "text-underline-offset",
      "text-decoration-color", "-webkit-box-decoration-break", "box-decoration-break"];
    const MARK = ["opacity", "transition-duration"];
    for (const rule of chips) {
      const onMark = rule.selectors.filter((sel) => /\.ch-[a-z-]+/.test(sel)).every((sel) => / \.chip-mark$/.test(sel));
      for (const decl of rule.body.split(";").map((d) => d.trim()).filter(Boolean)) {
        const prop = decl.split(":")[0]!.trim();
        if (prop.startsWith("--")) continue;
        expect(onMark ? [...PAINT, ...MARK] : PAINT, `${rule.selectors.join(",")} { ${decl} }`).toContain(prop);
      }
    }
  });

  it("every chip kind is ONE pill — one corner, one geometry, a tone of its own and nothing else", () => {
    /* The owner's ask, by screenshot: the picked element's square highlight and the `/goal` wash
       were two shapes for one idea. Every kind now reads its pill from ONE rule — the fill, the spread
       that stands in for padding, and the corner stated concentrically with it, so the visible edge
       lands on `--r-chip` — the rung the chips of the control row under it are cut to. THE mutant:
       give one kind a radius or a fill of its own. */
    const family = bodiesFor(".ch-element").join(" ");
    for (const decl of ["background: var(--chip-fill)", "border-radius: calc(var(--chip-r) - var(--chip-spread))",
                        "box-shadow: var(--chip-dx) 0 0 var(--chip-spread) var(--chip-fill)", "box-decoration-break: clone"])
      expect(family, decl).toContain(decl);
    const shared = RULES.find((r) => r.body.includes("background: var(--chip-fill)"))!;
    for (const kind of [".ch-mention", ".ch-mention-stale", ".ch-element", ".ch-slash"]) expect(shared.selectors, kind).toContain(kind);
    expect(bodiesFor(".composer-highlight").join(" ")).toContain("--chip-r: var(--r-chip)");
    // No other rule reaching a chip run draws a shape of its own; the states only move the fill.
    const shaped = RULES.filter((r) => r !== shared && r.selectors.some((sel) => /\.ch-(mention|element|slash)/.test(sel))
      && /(?:^|[;\s])(?:background|border-radius|box-shadow):/.test(r.body));
    expect(shaped.map((r) => r.selectors.join(", "))).toEqual([]);
    // Each kind's tone is a TOKEN pair — ink and tint — never a hand-rolled mix.
    for (const [kind, tint] of [[".ch-element", "--accent-tint"], [".ch-mention-stale", "--orange-tint"], [".ch-slash", "--green-tint"]] as const)
      expect(bodiesFor(kind).join(" "), kind).toContain(`--chip-tint: var(${tint})`);
    // The code mark stays a code mark. §"Shape" gives 2px to ticks, rails and code marks.
    expect(bodiesFor(".ch-code").join(" ")).toContain("border-radius: 3px");
  });

  it("a chip is the same chip once the message is SENT — one pill, one tone, no per-kind fill", () => {
    /* `.msg-chip[data-kind="element"]` once took `--inset` under bright ink: 1.05:1 on the bubble,
       a chip that existed only as text with a smudge behind it. Then the fill went altogether and the
       log's chip stopped matching the prompter's the moment the prompter's grew a shape. What is held
       is the SAMENESS: the prompter's accent chips and the log's wear one tint, one ink and one corner.
       THE mutant: re-add a `[data-kind]` rule with a fill in it, or let the two corners part. */
    const chip = bodiesFor(".msg-chip").join(" ");
    expect(chip).toContain("background: var(--accent-tint)");
    expect(chip).toContain("color: var(--accent-ink)");
    expect(bodiesFor(".ch-element").join(" ")).toContain("--chip-tint: var(--accent-tint)");
    expect(bodiesFor(".ch-element").join(" ")).toContain("--chip-ink: var(--accent-ink)");
    expect(chip).toContain("border-radius: var(--r-chip)");
    const variants = RULES.flatMap((rule) => rule.selectors.map((sel) => ({ sel, body: rule.body })))
      .filter(({ sel }) => /^\.msg-chip\[/.test(sel))
      .filter(({ body }) => /(?:^|[;\s])(?:background(?:-color)?|color):/.test(body))
      .map(({ sel }) => sel);
    expect(variants).toEqual([]);
  });

  /* The chip GROUP is gone. The session mode moved into the "+" menu, and a group of one segment was
     nine seam rules that could never fire plus a squared corner and a hairline ring no other chip in
     the row wore. These three pin what replaced it, including the two things whose removal would be
     silent: the card's own mode tint, and the mode having somewhere to be read at all. */
  it("the permission chip is an ordinary chip, not a segment — nothing groups it any more", () => {
    // The mutant is a re-introduced wrapper: any `.chip-group` rule at all means the squared seam,
    // the inside-out focus ring and the overlay hairline are back on a control that has no neighbour.
    expect(css).not.toContain("chip-group");
    // It keeps the radius and the corner every other chip in the row has, from `.ghost-chip` itself
    // rather than from a group that owned the shape on its behalf.
    const chip = bodiesFor(".ghost-chip").join(" ");
    expect(chip).toContain("border-radius: calc(var(--btn-h) * var(--sq-ratio-ctl))");
    expect(chip).toContain("corner-shape: squircle");
  });

  /* The one thing the mode's move could break invisibly. With the chip gone, the card's tint is the
     only place a running session says it is in Plan or Ask — remove these and the mode becomes
     something you can only discover by opening a menu. */
  it("the prompter card still carries its own mode tint, which is now the mode's only ambient signal", () => {
    const ask = bodiesFor('.composer[data-mode="ask"]').join(" ");
    const plan = bodiesFor('.composer[data-mode="plan"]').join(" ");
    expect(ask).toContain("--rl-success");
    expect(plan).toContain("--rl-warning");
    // And the "+" menu's Mode section names it in words, which is where BUILD — the untinted default
    // — is read, with each read-only mode's mark in the tone the card wears for it.
    expect(bodiesFor('.mode-mark[data-mode="plan"]').join(" ")).toContain("var(--rl-warning)");
    expect(bodiesFor('.mode-mark[data-mode="ask"]').join(" ")).toContain("var(--rl-success)");
  });

  it("a hovered chip is the same chip lifted, never a new shape — and never underlined", () => {
    /* One rule for every kind, and all it moves is the fill, toward the chip's own tone. An underline
       is the web's "this is a hyperlink", and the pointer is over a mirror that takes no clicks: the
       gesture a chip's hover announces takes the CHIP (a click selects it, its × removes it). THE
       mutant: an underline back on a hovered run, which was the old affordance. */
    const hot = RULES.filter((r) => r.selectors.some((sel) => sel.includes(".ch-") && sel.includes("[data-hot]")));
    expect(hot.length).toBeGreaterThan(0);
    for (const r of hot) expect(r.body, r.selectors.join(", ")).not.toContain("text-decoration");
    const lift = bodiesFor(":is(.ch-mention, .ch-mention-stale, .ch-element, .ch-slash)[data-hot]").join(" ");
    expect(lift).toContain("--chip-fill: color-mix(in oklab, var(--chip-tint), var(--chip-tone)");
    // …and the mark gives its slot to the × at once, the way a hover arrives, rather than both
    // drawing in one place — and comes back on the shared swap's rung, not a copy of it.
    const mark = bodiesFor(":is(.ch-mention, .ch-mention-stale, .ch-element)[data-hot] .chip-mark").join(" ");
    for (const decl of ["opacity: 0", "transition-duration: 0s"]) expect(mark).toContain(decl);
    expect(RULES.find((r) => r.selectors.includes(".icon-swap > *"))!.selectors).toContain(".chip-sigil > .chip-mark");
  });

  it("a chip's sigil is never an atomic inline — the mirror may not wrap where the textarea cannot", () => {
    /* An inline-block is an atomic inline, and the line breaker may break on either side of one. The
       textarea reads `@mac` as one word and moves it to the next line whole; a mirror whose `@` was an
       inline-block broke after it, and from there every painted glyph sat a line off the caret. The
       mark only needs a positioned box to hang from, and an inline one is that. */
    const body = bodiesFor(".chip-sigil").join(" ");
    expect(body).toContain("position: relative");
    expect(body).not.toMatch(/display:\s*inline-(block|flex|grid)/);
    /* …and the line may not break after the out-of-flow mark either, which Chromium allows. The
       sigil and the name's first glyph are held together by wrap mode alone — `white-space: nowrap`
       would also collapse the spaces a hand-typed label holds, and the mirror would come up short. */
    const lead = bodiesFor(".chip-lead").join(" ");
    expect(lead).toContain("text-wrap-mode: nowrap");
    expect(lead).not.toContain("white-space");
  });

  it("a chip selected whole lights in its own shape, and the textarea's square selection steps aside", () => {
    /* 14-prompter-element-chip-and-full-access.png: the "square thing" was the textarea's own
       selection rectangle, drawn over the chip a click had just selected. For exactly that range the
       textarea's selection goes transparent and the chip draws its selected state instead.
       THE mutant: drop the transparent selection, which puts the rectangle back over the pill. */
    expect(bodiesFor(".composer-input[data-chip-selected]::selection").join(" ")).toContain("background: transparent");
    const selected = bodiesFor(".composer-editor:focus-within :is(.ch-mention, .ch-mention-stale, .ch-element, .ch-slash)[data-selected]").join(" ");
    expect(selected).toContain("--chip-fill: color-mix(in oklab, var(--chip-tint), var(--chip-tone)");
    expect(selected).toContain("--chip-ink: var(--rl-text-bright)");
  });

  it("the prompter's column gives up MORE width than the zoom already takes", () => {
    /* ⌘− scales every px, so a px column keeps the same share of the window at every zoom — zooming
       out to fit more of the work on screen bought nothing back from the prompter. Multiplying by
       the factor is what makes it give ground: at 80% the column is 80% of 576px on screen rather
       than of 720. THE MUTANT is a bare `720px`, which is what this was and which looks correct in
       every screenshot taken at 100%.

       The floor is a reading measure (480px of 15px text ≈ 55 characters) and the ceiling is today's
       number, so zoom IN is unchanged. `--zoom` must be registered with an initial value: unset and
       unregistered, the calc is invalid at computed-value time and the column has no width at all in
       a renderer with no preload bridge. */
    const root = bodiesFor(":root").join(" ");
    expect(root).toContain("--prompter-w: clamp(480px, calc(720px * var(--zoom, 1)), 720px)");
    const registered = RULES.some((r) => r.selectors.some((sel) => /@property\s+--zoom/.test(sel)));
    expect(registered, "--zoom needs an @property with an initial value").toBe(true);
    expect(bodiesFor("@property --zoom").join(" ")).toContain("initial-value: 1");
  });

  it("the prompter's cap is one number, and both ends of the draft dissolve at it", () => {
    /* The textarea autogrows in JS and stops at a max-height in CSS. Two numbers for one cap is a
       prompter that grows a line past its own ceiling and snaps back, so the stylesheet is asserted
       against the constant the component measures with rather than against a literal.

       The mask is what makes the cap survivable: past it the draft scrolls, and a hard edge put half
       a line against the attachment chips above and the model row below. Its stops are the text
       box's own padding, so a draft that fits is never touched. */
    const input = bodiesFor(".composer-input").join(" ");
    expect(input).toContain(`max-height: ${MAX_ROWS_PX}px`);
    const editor = bodiesFor(".composer-editor").join(" ");
    expect(editor).toContain("mask-image: linear-gradient(to bottom, transparent 0, #000 14px");
    // The top stop equals the text box's top padding, or the fade eats the first line while it fits.
    expect(input).toContain("padding: 14px 16px 10px");
  });

  it("the prompter's text is set at the medium rung, on the box both layers inherit from", () => {
    /* Asked for by name: medium, not regular, inside the prompter. It goes on `.composer-editor` and
       on neither layer under it, because the mirror's glyphs have to sit exactly under the textarea's
       caret — THE mutant is the weight on the mirror alone (or the textarea alone), which paints
       every run a few pixels off the caret by the end of a line. Through the ladder, never a literal,
       so the font-weight preference still reaches it. */
    expect(bodiesFor(".composer-editor").join(" ")).toContain("font-weight: var(--fw-medium)");
    for (const layer of [".composer-highlight", ".composer-input", ".composer-hint"]) {
      const body = bodiesFor(layer).join(" ");
      expect(body, layer).toContain("font: inherit");
      expect(body, layer).not.toContain("font-weight");
    }
  });

  it("the prompter's popover lists dissolve at their ends, inside a surface that does not", () => {
    /* 15-skills-popover-cutoff.png: the skill list's last row was cut by its footer. Each list is the
       SCROLLER, so the mask fades rows into the field and the footer while the card keeps its fill
       and corner; its scroll-padding is the band's own depth, so a row brought into view by the
       keyboard lands clear of the band rather than half inside it. */
    for (const list of [".skill-picker-list", ".mention-list"]) {
      const body = bodiesFor(list).join(" ");
      expect(body, list).toMatch(/overflow-y: auto/);
      const depth = /--fade-h: (\d+)px/.exec(body)?.[1];
      expect(depth, list).toBeDefined();
      expect(body, list).toContain(`--fade-top-h: ${depth}px`);
      expect(body, list).toContain(`scroll-padding-block: ${depth}px`);
    }
    // THE mutant: the scroller back on the surface — the mask would take the card's own edge with it.
    const surface = bodiesFor(".mention-picker").join(" ");
    expect(surface).toContain("overflow: hidden");
    expect(surface).not.toMatch(/overflow-y: auto/);
  });

  it("an app-level page is the BOTTOM of the overlay stack, not the top", () => {
    /* THE BUG this pins, which was four bugs wearing one number: the page overlay sat at z-index 200,
       above every floating surface in the app. Quick chat opened behind Settings, ⌘K opened behind
       it, a sheet raised from a page landed under the page that raised it, and a menu portalled out
       of a page's own body was painted over by that page. A page is a screen — it covers the pane
       host and yields to everything that floats over a screen. */
    const rung = (sel: string) => Number(/z-index:\s*(\d+)/.exec(bodiesFor(sel).join(" "))?.[1]);
    const page = rung(".page-overlay");
    expect(page).toBeGreaterThan(rung(".session-usage-panel")); // …and over the tallest thing in a pane
    for (const above of [".sheet-backdrop", ".palette-backdrop", ".spaces-backdrop", ".media-viewer", ".quick-chat", ".menu"]) {
      expect(rung(above), `${above} must float over a page`).toBeGreaterThan(page);
    }
  });

  it("the highlight mirror matches the textarea's text metrics exactly", () => {
    const mirror = bodiesFor(".composer-highlight").join(" ");
    const input = bodiesFor(".composer-input").join(" ");
    for (const decl of ["font: inherit", "font-size: 15px", "line-height: calc(1.55 + var(--lh-shift))", "padding: 14px 16px 10px"]) {
      expect(mirror, decl).toContain(decl);
      expect(input, decl).toContain(decl);
    }
    // The UA's own textarea wrapping, restated — the mirror is a <div> and gets neither by default.
    expect(mirror).toContain("white-space: pre-wrap");
    expect(mirror).toContain("overflow-wrap: break-word");
    // Out of the flow, and never in the way of the pointer: the textarea owns both.
    expect(mirror).toContain("position: absolute");
    expect(mirror).toContain("pointer-events: none");
    // The glyphs belong to the mirror. `color` alone is not enough to hide the textarea's own.
    expect(input).toContain("-webkit-text-fill-color: transparent");
    // Selected text too, or the UA's selection foreground paints the hidden glyphs back over the mirror.
    expect(bodiesFor(".composer-input::selection").join(" ")).toContain("-webkit-text-fill-color: transparent");
    // ...but the placeholder shows in exactly the state the mirror is empty, so it opts back in.
    expect(bodiesFor(".composer-input::placeholder").join(" ")).toContain("-webkit-text-fill-color: var(--rl-text-faint)");
    // A classic scrollbar would take width from the textarea's text box and not from the mirror's.
    expect(input).toContain("scrollbar-width: none");
  });

  /* The suggested prompt stands in for the placeholder, so it inherits the placeholder's constraint:
     it occupies the same text box, in a box that is exactly one row tall while it shows. A wrap here
     would push the sentence past the empty prompter's height and be clipped mid-line. */
  it("the prompt hint sits in the input's own text box, on one line", () => {
    const body = bodiesFor(".composer-hint").join(" ");
    const input = bodiesFor(".composer-input").join(" ");
    for (const decl of ["font: inherit", "font-size: 15px", "line-height: calc(1.55 + var(--lh-shift))", "padding: 14px 16px 10px"]) {
      expect(body, decl).toContain(decl);
      expect(input, decl).toContain(decl);
    }
    // Out of the flow (it must not enter the textarea's autogrow measurement) and click-through: a
    // click on the hint has to place the caret in the textarea underneath, not land on a dead div.
    expect(body).toContain("position: absolute");
    expect(body).toContain("pointer-events: none");
    // One line, ellipsized — never a second row the empty box has no height for.
    expect(bodiesFor(".composer-hint-text").join(" ")).toContain("white-space: nowrap");
    expect(bodiesFor(".composer-hint-text").join(" ")).toContain("text-overflow: ellipsis");
  });

  it("the control row's left group clips instead of wrapping — the measured collapse depends on it", () => {
    const body = bodiesFor(".composer-opts").join(" ");
    expect(body).toContain("flex-wrap: nowrap");
    expect(body).toContain("overflow: hidden");
    expect(bodiesFor(".composer-opts > *").join(" ")).toContain("flex: none");
  });

  it("the branch name is capped by the pane it is in, never by a flat number", () => {
    // The named mutant: put `max-width: 160px` back. Every pane over ~600px then truncates a name it
    // had hundreds of pixels of room for, and every pane under ~565px has the whole chip amputated by
    // the clip above — a button sliced down the middle. Neither is visible from here (jsdom has no
    // layout); composer-bar-live.mjs sweeps the real row and fails on a chip the group has cut.
    const branch = bodiesFor(".composer-git .git-branch").join(" ");
    expect(branch).toContain("100cqw");
    expect(branch).toContain("var(--branch-reserved)");
    expect(bodiesFor(".composer-git").join(" ")).toContain("--branch-reserved:");
  });

  it("a narrow pane spends its width on the branch's NAME, dropping the counts that restate it", () => {
    const noDirty = blockAfter("@container (max-width: 520px)");
    expect(noDirty).toMatch(/\.git-dirty \{[^}]*display: none/);
    const noDiff = blockAfter("@container (max-width: 460px)");
    expect(noDiff).toMatch(/\.git-diff \{[^}]*display: none/);
    // The reserve has to be restated as each count leaves, or the name goes on being capped against
    // room the row has just handed back to it — the silent half of this, and the one worth pinning.
    expect(noDirty).toContain("--branch-reserved:");
    expect(noDiff).toContain("--branch-reserved:");
    // Last step: the chip becomes the mark it already carries. Hidden from the eye, not from a
    // screen reader — the button's whole remaining content would otherwise be an icon.
    expect(blockAfter("@container (max-width: 360px)")).toMatch(/\.chip-label \{[^}]*clip-path: inset\(50%\)/);
  });
});

describe("Plan 9 W1 — the BUI bridge", () => {
  const tokens = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8");

  it("the foundation imports Tailwind v4 and shadow-plugin, and keys dark on Realm's data-mode", () => {
    expect(tokens).toContain('@import "tailwindcss"');
    expect(tokens).toContain('@import "shadow-plugin/unprefixed"');
    // BUI ships `@custom-variant dark (.dark)`; Realm's theme mechanism stamps data-mode instead.
    expect(tokens).toMatch(/@custom-variant dark[^;]*data-mode="dark"/);
    // Dark is the primary palette: the base :root block carries the dark surface ramp…
    expect(tokens).toMatch(/:root \{[^}]*--surface: oklch\(0\.26 0\.006 271\.191\)/);
    // …and BUI's light-first values live under the light mode attribute.
    expect(tokens).toMatch(/:root\[data-mode="light"\] \{[^}]*--surface: oklch\(1 0 0\)/);
  });

  it("every legacy --rl-* colour token resolves to a BUI token — the app can never be half-themed", () => {
    const root = css.match(/:root \{([^}]*)\}/)?.[1] ?? "";
    for (const [token, source] of [
      ["--rl-accent", "var(--accent)"],
      ["--rl-frame", "var(--page)"],
      ["--rl-panel", "var(--canvas)"],
      ["--rl-raised", "var(--surface)"],
      ["--rl-line", "var(--line)"],
      ["--rl-line-strong", "var(--line-strong)"],
      ["--rl-divider", "var(--divider)"],
      ["--rl-divider-hover", "var(--divider-hover)"],
      ["--rl-hairline", "var(--line)"],
      ["--rl-text-bright", "var(--ink)"],
      ["--rl-text-dim", "var(--ink-2)"],
      ["--rl-text-faint", "var(--ink-3)"],
      ["--rl-danger", "var(--red)"],
      ["--rl-success", "var(--green)"],
      ["--rl-warning", "var(--orange)"],
      ["--rl-edge", "var(--shadow-hairline)"],
    ] as const) expect(root, token).toContain(`${token}: ${source}`);
  });

  it("the radius scale is tembo's, one rung up at the control tier: tick 2, chip 8, control 10, card 12 (rows + panels), window 16", () => {
    const root = css.match(/:root \{([^}]*)\}/)?.[1] ?? "";
    for (const decl of ["--r-sm: 2px", "--r-chip: 10px", "--r-ctl: 13px", "--r-row: 12px", "--r-panel: 12px", "--r-float: 16px"])
      expect(root, decl).toContain(decl);
    // No component may dodge the scale with a hardcoded control-ish radius (ticks/dots/pills excepted).
    expect(css).not.toMatch(/border-radius:\s*(?:4|6|8|10|12|14|16)px/);
  });

  it("no decorative border is a full pixel — structure is drawn at the hairline", () => {
    /* Sixty-nine rules drew their separators and outlines at 1px. Against a 0.5px hairline that is
       twice the weight, and the app read as ruled — a mesh of lines around every menu, row and
       field. They are all `var(--hairline-w)` now, in the same colours: still there, half as loud.

       Deliberately scoped to the LINE ramp. A border in an accent, a danger or a warning colour is
       carrying state rather than structure, and thinning one of those weakens a signal. */
    const heavy = RULES
      .filter((r) => /border(?:-top|-bottom|-left|-right)?:\s*1px solid var\(--(?:rl-)?(?:line|line-strong|hairline)\)/.test(r.body))
      .flatMap((r) => r.selectors);
    expect([...new Set(heavy)].sort(), "draw it at var(--hairline-w), or say why it is structural").toEqual([]);
  });

  it("every edge fade is the same strength, because they all read the same tokens", () => {
    /* They were three hand-tuned copies at blur(3px)/blur(11px)/88%, which is how "the blurs are too
       strong" became one note about the whole app rather than about a surface. Strength is in
       tokens now, so subtler is one edit and no two fades can disagree. */
    const fades = RULES.filter((r) => /backdrop-filter:\s*blur/.test(r.body) && !/blur\(0/.test(r.body));
    const literal = fades.filter((r) => /backdrop-filter:\s*blur\(\d/.test(r.body)).flatMap((r) => r.selectors);
    /* Two named exceptions, both scrims rather than edge fades: they obscure on purpose, where a
       fade's whole job is to go unnoticed. The drop target dims a pane under a dragged file, and the
       media button's disc sits over a video frame it has to stay legible against. */
    expect(literal.filter((sel) => !sel.includes(".session-drop") && !sel.includes(".media-play")).sort()).toEqual([]);
  });

  it("nothing is set below 11px, the type scale's own floor for a tiny label", () => {
    /* design.md puts the floor at 11/14 for tiny operational labels, and thirty-seven rules sat
       under it — 10.5px uppercase group labels, 10px badges, a 9.5px stat key. Individually each
       looked like a considered micro-label; together they were most of why the connections, library,
       tasks and settings pages read as unreadable.

       The exceptions are geometry or typography, not taste, and each is named rather than tolerated
       by a range: a superscript citation is sized against its own line, and the rest live inside
       boxes whose height is fixed by something other than the text (a 44px attachment tile, a 12px
       calendar row, an SVG axis). */
    const EXEMPT = new Set([".md-cite", ".attach-ext", ".cal-month", ".cal-weekday", ".chart-tick",
      ".summary-step-mark", ".tile-title"]);
    const tooSmall = RULES
      .filter((r) => {
        const m = r.body.match(/font(?:-size)?:\s*(?:[\w-]+\s+)*?([\d.]+)px/);
        return m !== null && Number(m[1]) < 11;
      })
      .flatMap((r) => r.selectors)
      .filter((sel) => ![...EXEMPT].some((e) => sel.includes(e)));
    expect([...new Set(tooSmall)].sort(), "below the 11px floor — raise it, or name the geometry that forbids it").toEqual([]);
  });

  it("every size is a rung of the type ladder — no half-pixel steps a reader cannot tell apart", () => {
    /* The floor stopped sizes going below 11; nothing stopped them multiplying above it. The app had
       grown 11, 11.5, 12, 12.5, 13 and 13.5 — six sizes in a 2.5px band, used interchangeably, so two
       labels doing the same job in two places were half a pixel apart and read as a mistake rather
       than as a distinction. The ladder is design.md's: 11 tiny, 12 caption, 13 small UI, 14 body,
       15 reading, then the four title rungs. Below 11 is the floor test's business, and its named
       exceptions stand here too. THE mutant: put any one rule back at 12.5. */
    const LADDER = new Set([11, 12, 13, 14, 15, 18, 20, 24, 28]);
    const EXEMPT = new Set([".md-cite", ".attach-ext", ".cal-month", ".cal-weekday", ".chart-tick",
      ".summary-step-mark", ".tile-title",
      // A display numeral: the one figure on the usage page that is the page's subject.
      ".stat-value-hero",
      // Plan 26's readable-type redesign of Settings, the Library, Memory, Usage and first run set
      // these by name (Settings in Codex's grammar: notes at 12.5, rail tabs at 13.5, a first-run step
      // head at 17). They are the owner's sizes, kept as stated — named here one by one, so a NEW
      // half step anywhere else still fails.
      ".agent-card-by",
      ".agent-card-note",
      ".agent-card-tail",
      ".budget-input",
      ".budget-line",
      ".budget-note",
      ".budget-threshold",
      ".budget-thresholds legend",
      ".failover-note",
      ".filter-chip",
      ".library-more",
      ".library-row-name",
      ".library-row-time",
      ".memory-doc-status",
      ".memory-fact-label",
      ".memory-fact-sub",
      ".memory-reader",
      ".memory-space-here",
      ".memory-space-size",
      ".onboarding-note",
      ".onboarding-step-head",
      ".onboarding-step-sub",
      ".page-empty p",
      ".page-rail .settings-tab",
      ".sb-page-nav .page-rail-head",
      ".scope-move",
      ".settings-hint",
      ".settings-result-place",
      ".settings-row-problem",
      ".stat-delta",
      ".stat-label",
      ".tcc-state",
      ".usage-card-head .usage-card-sub",
      ".usage-caveats p",
      ".usage-table thead th"]);
    const off = RULES
      .flatMap((r) => [...r.body.matchAll(/(?:font-size:|\bfont:)\s*(?:var\([^)]*\)\s+)?([\d.]+)px/g)]
        .filter((m) => !LADDER.has(Number(m[1])))
        .flatMap(() => r.selectors))
      .filter((sel) => ![...EXEMPT].some((e) => sel.includes(e)));
    expect([...new Set(off)].sort(), "off the type ladder — pick a rung").toEqual([]);
  });

  it("no label is set in tracked capitals — a section is named in sentence case", () => {
    /* design.md rejects all-caps tracked eyebrows, and nineteen rules wore them: the palette's
       sections, the model picker's groups, table heads, kind tags. A quiet sentence-case label at the
       caption rung names a section as clearly and does not shout over the rows it heads. Uppercase
       also hid raw source strings — an import row printed its "space-folder" enum for months because
       the transform made it look like a label. One exception, typography rather than taste: a file
       extension on an attachment tile ("PDF"), which is an acronym in any case. */
    const caps = RULES.filter((r) => /text-transform:\s*uppercase/.test(r.body)).flatMap((r) => r.selectors);
    expect(caps).toEqual([".attach-ext"]);
  });

  it("the weight ladder is four named rungs on tembo's values — no bare weight survives in a component rule", () => {
    const root = css.match(/:root \{([^}]*)\}/)?.[1] ?? "";
    // 450/500/560/600. The old 500/550/600/650 spread had two rungs nobody could tell apart.
    // Each rung carries --fw-shift, which is the whole of how the font-weight preference reaches the
    // app. THE absolute-weight mutant: have the preference write --fw-medium..--fw-strong directly.
    // Two rungs a user picked "Medium" for would land on the same number and the ladder would stop
    // being a ladder for exactly the people who asked for heavier text.
    for (const [rung, base] of [["medium", 450], ["label", 500], ["title", 560], ["strong", 600]] as const) {
      expect(root, rung).toContain(`--fw-${rung}: calc(${base} + var(--fw-shift))`);
    }
    expect(root).toContain("--fw-shift: 0");
    // Everything but the @font-face ranges and the two deliberate 400s goes through the ladder.
    const bare = [...css.matchAll(/font-weight:\s*(\d+)\s*;/g)].map((m) => m[1]);
    expect(bare.filter((w) => w !== "400")).toEqual([]);
    // ...and body copy is on it too, or the preference would move every label in the app and leave
    // the prose it sits beside behind. The `font:` shorthand resets weight, so it has to be IN it.
    expect(bodiesFor("html, body, #root".split(", ")[0]!).join(" ")).toContain("var(--fw-body) 14px/20px");
  });

  it("hairlines are half-pixel alpha overlays — one device pixel on retina, and no ground they are painted for", () => {
    expect(tokens).toContain("--hairline-w: 0.5px");
    expect(tokens).toMatch(/--shadow-hairline: 0 0 0 var\(--hairline-w\) var\(--line\)/);
    // The border ramp is derived from the overlay ladder, not from a solid grey.
    // One rung softer than tembo's in both faces (border-softness-live.mjs measured the old pair).
    expect(tokens).toMatch(/--line: var\(--overlay-lighten-200\)/);
    expect(tokens).toMatch(/:root\[data-mode="light"\] \{[^}]*--line: var\(--overlay-darken-100\)/);
  });

  it("type carries per-size tracking and explicit line heights, not one em-relative value for the whole document", () => {
    expect(tokens).toMatch(/body \{[^}]*letter-spacing: -0\.1px/);
    expect(tokens).not.toMatch(/letter-spacing: -0\.01em/);
    for (const decl of ["--text-xs--letter-spacing: -0.2px", "--text-sm--letter-spacing: -0.2px", "--text-base--line-height: 20px"])
      expect(tokens, decl).toContain(decl);
    // The body line box is the 20px the scale asks for, not 1.5×.
    expect(bodiesFor("html, body, #root".split(", ")[0]!).join(" ")).toContain("font: var(--fw-body) 14px/20px var(--font-ui)");
  });

  it("every custom property the stylesheet reads is one it (or tokens.css) actually defines", () => {
    // The failure this catches is silent and total. `color: var(--rl-text-2)` where `--rl-text-2` was
    // never defined is INVALID AT COMPUTED-VALUE TIME: the declaration does not fall back to the
    // previous rule, it resolves to `inherit` — and `border-radius: var(--rl-radius-sm)` resolves to
    // zero. That is exactly how the documents pane came to render flat text on square corners inside
    // a rounded, ramped app, with nothing anywhere reporting an error.
    const defined = new Set([
      ...[...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!),
      ...[...tokens.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!),
      /* A registered property with an `initial-value` is defined too, and defined more strongly than
         a declaration: it has a type, so it resolves before any rule runs and cannot be invalid at
         computed-value time. `--zoom` is the case — written from `theme/zoom.ts`, and its registration
         is what keeps `--prompter-w` a width in a renderer that never writes it. */
      ...[...css.matchAll(/@property\s+(--[a-z0-9-]+)\s*\{[^}]*initial-value\s*:/g)].map((m) => m[1]!),
      // Defined elsewhere, legitimately: Tailwind's own theme (`@import "tailwindcss"`), the
      // shadow-plugin scale, react-datasheet-grid's stylesheet, and the stagger index the
      // suggestion chips set inline in TSX.
      "--shadow-xs", "--shadow-sm", "--shadow-md", "--shadow-lg", "--shadow-xl", "--shadow-2xl", "--i",
      // The spinner's pose table (Spinner.tsx): nine poses × per-dot x/y/opacity plus the stage
      // scale, computed from the globe's geometry and set inline so one keyframe can walk them.
      "--orb-k", ...Array.from({ length: 9 }, (_, i) => [`--g${i}x`, `--g${i}y`, `--g${i}o`]).flat(),
      // The video scrubber's fill (MediaView.tsx): the played fraction, set inline per frame so the
      // track and the knob are one box and cannot drift out of register.
      "--media-progress",
      // The rubber-band's offset (rubber-band.ts): written on the scroller per wheel event and per
      // spring frame, and only while the content is past an end.
      "--rubber",
      // The decorative wash's geometry (theme/grain.ts): drawn once per launch per surface and set
      // inline, because a value that is randomised cannot be written in a stylesheet. Every one is
      // used with a fallback, so a surface that never receives them is still a finished surface.
      "--grain-hue", "--grain-x", "--grain-y", "--grain-spread",
      // The slider's filled fraction (SettingsPage's `Slider`): computed from the same min/max/value
      // the input is given and set inline, because a track cannot know its own value from CSS. Used
      // with a 0% fallback, so a slider that never receives it is an empty track rather than a
      // broken one.
      "--fill",
      // Where a point sits on the model picker's effort track (ModelPicker.tsx's `EffortTrack`): the
      // fill, the knob and each dot carry their own fraction of the run, set inline because the
      // number of levels is the model's, not the stylesheet's. Used with a 0 fallback, so a track
      // that never receives it is empty rather than broken.
      "--at",
      // The pane glyph's grid shape (sidebar/ItemList.tsx): how many columns and rows the layout
      // actually has, set inline because the mark is a picture of a tree that changes per item.
      // Both carry a fallback of 1, so a glyph that never receives them is still a single cell.
      "--glyph-cols", "--glyph-rows",
      // The session pane's measured height (SessionSummary.tsx): the cap the summary panel clamps
      // its content-driven height against. Set inline because only the DOM can measure a pane, and
      // used with a 100vh fallback, so a panel that never receives it is capped at the window rather
      // than uncapped.
      "--dock-pane-h",
      // The machine screen's letterboxed size (panes/machine/MachinePane.tsx): computed by `fit.ts`
      // from the guest's framebuffer, the pane's measured box and the display's scale factor, and
      // set inline because none of those three is a thing a stylesheet can know.
      "--machine-w", "--machine-h",
      // The picture's superellipse corner as a clip path (panes/machine/squircle-path.ts). Inline
      // for a reason no other squircle in the app has: a canvas takes neither the paint worklet —
      // its content is opaque, and `mask-image: paint()` does not mask in this Chromium — nor
      // `corner-shape`, which is inert here. A path needs real pixels, so it is built from the same
      // `fit` the canvas is sized by. Carries a `none` fallback, so a screen that never receives it
      // is unclipped rather than clipped away to nothing.
      "--machine-clip",
      // A stroke's place in the signature (panes/settings/Signature.tsx): its index in the order the
      // pen drew it, which is what staggers the reveal. Inline because the count is the asset's, not
      // the stylesheet's — one :nth-child rule per stroke would encode the ink in the CSS. Carries a
      // 0 fallback, so a stroke that never receives it starts immediately rather than never.
      "--stroke",
      // The simulator picture's box and its corner (panes/simulator/SimulatorPane.tsx), which are
      // `--machine-w`/`--machine-h`/`--machine-clip` for a device: the same `fit.ts` arithmetic, set
      // inline for the same reason — a stylesheet cannot know a framebuffer's size, and the clip has
      // to be built from the same numbers the box was sized by or the two disagree at the corner.
      "--sim-w", "--sim-h", "--sim-clip",
      // The chassis drawn around that picture (panes/simulator/device-frame.ts): the rail's thickness
      // and the outer corner. Inline for the same reason again — both are fractions of a framebuffer
      // the stylesheet cannot see, and the outer corner in particular is the inner one PLUS the
      // rail, which is arithmetic rather than a value.
      "--sim-bezel", "--sim-outer-r",
      // The attachment well's superellipse as a clip path (panes/session/AttachmentTile.tsx). Inline
      // for `--machine-clip`'s reason exactly: under the paint worklet the well's `border-radius` is
      // 0, so its thumbnail and badge would clip to a square over a painted curve — and a clip needs
      // real pixels, which only the laid-out tile has. Carries a `none` fallback, so a tile measured
      // before layout is unclipped rather than clipped away to nothing.
      "--attach-clip",
      // How far an update's download has got (Rail.tsx, RailUpdate): main's own percentage, set inline
      // as it arrives, with a 0% fallback for the moment before main has said.
      "--update-progress",
      // A terminal's ink and sixteen colours, and the share faint text keeps (terminal-hub.ts, from
      // terminal-palette.ts): set on each terminal's host, because they are computed from the live
      // theme's tokens and must reach the terminals already open when it changes. Each carries a
      // fallback — the span's own colour, and xterm's own half — so a host that never receives them
      // draws faint text exactly as xterm would.
      "--term-fg", "--term-dim", ...Array.from({ length: 16 }, (_, i) => `--term-ansi-${i}`),
    ]);
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
    expect([...used].filter((n) => !defined.has(n) && !n.startsWith("--dsg-")).sort()).toEqual([]);
  });

  it("a page's bar moves the window, as the pane bars it covers do, and anything put in it still clicks", () => {
    /* A page (Connections, Library, Settings…) covers the pane host, whose panes — and with them their
       draggable bars — are hidden while it is up. Its own bar is the window's top row then, and with
       no region of its own the band held still everywhere but the sidebar's head (reported 10-04). It
       holds only the page's name now (page-overlay.test.tsx), and stays a drag region all the way
       across. THE mutants: the bar's `drag` dropped, or a button put back in it left inside it. */
    expect(bodiesFor(".page-overlay-bar").join(" ")).toContain("-webkit-app-region: drag");
    expect(bodiesFor(".page-overlay-bar button").join(" ")).toContain("-webkit-app-region: no-drag");
  });

  it("a folded sidebar takes no part in the window's drag regions, so the rail's buttons stay clickable", () => {
    /* Electron lays drag regions down in DOCUMENT order, not stacking order. The folded column slides
       under the rail, and the rail comes first in the DOM, so a drag region left on the column covers
       the rail's buttons again and macOS takes a click on them for the start of a window drag: the
       toggle folded the sidebar and could not bring it back (reported 10-04). A live check cannot
       see this — CDP's clicks go straight into the page and never meet the OS's regions — so the
       rule is held here. THE mutant: the column's own `drag` left in force while it is folded. */
    expect(bodiesFor(".sidebar").join(" ")).toContain("-webkit-app-region: drag");
    // `initial`, which is no region at all. An explicit `none` computes as `no-drag` in this Chromium
    // (measured): clickable, but a hole in the rail's own drag region wherever the column sits.
    expect(bodiesFor(".sidebar[data-collapsed]").join(" ")).toContain("-webkit-app-region: initial");
    // And everything in it: a drag band inside would cover the rail just the same, and a no-drag
    // button would punch it.
    expect(bodiesFor(".sidebar[data-collapsed] *").join(" ")).toContain("-webkit-app-region: initial");
  });

  it("the rail is as narrow as its icons, an even margin round each, and the lights run on across the top row", () => {
    /* The owner, 10-04: the rail was wider than it should be, with more room either side of its icons
       than between them. It is Codex's now: 36px buttons with the same 8px beside them as between and
       above them, which makes it narrower than the traffic lights (main places them at x:12, y:14; they
       run to ~66px). So the lights cross into the top row, which is the WINDOW's — back and forward sit
       just past them (`.window-lead`), and whatever the row holds under them makes room (the next test).
       THE mutants: the old 76px rail, uneven margins, or a lead that starts under the lights. */
    const rail = bodiesFor(".app-rail").join(" ");
    expect(rail).toContain("width: var(--rail-w)");
    const root = RULES.filter((r) => r.selectors.includes(":root")).map((r) => r.body).join(" ");
    const px = (name: string) => Number(new RegExp(`${name}: (\\d+)px`).exec(root)?.[1]);
    const railW = px("--rail-w");
    expect(bodiesFor(".rail-btn").join(" ")).toContain("width: 36px; height: 36px");
    const gap = Number(/gap: (\d+)px/.exec(bodiesFor(".rail-group").join(" "))?.[1]);
    expect((railW - 36) / 2, "the margin beside an icon is the gap between two").toBe(gap);
    // The first destination sits the same step below the head row.
    expect(rail).toContain(`padding: calc(var(--frame-top) + ${gap}px) 0 ${gap}px`);
    expect(railW).toBeLessThan(px("--lights-end"));
    expect(root).toContain("--lead-x: calc(var(--lights-end) + 10px)");
    expect(bodiesFor(".window-lead").join(" ")).toContain("left: var(--lead-x)");
    // The window is still draggable by its own left edge, and the rail's buttons still clickable.
    expect(rail).toContain("-webkit-app-region: drag");
    expect(bodiesFor(".app-rail button").join(" ")).toContain("-webkit-app-region: no-drag");
    // The rail wears the window's rounded corners now; the sidebar beside it is square.
    expect(rail).toContain("border-radius: var(--r-float) 0 0 var(--r-float)");
    expect(bodiesFor(".sidebar").join(" ")).not.toContain("border-radius");
    // The rail stacks over the sidebar's column.
    expect(rail).toContain("position: relative");
    expect(rail).toMatch(/z-index: \d/);
    /* …and the shell still does not change axis: collapsed is the same row with the column taken out.
       Read off the rule set rather than through `bodiesFor`, which requires the selector to exist. */
    expect(RULES.filter((r) => partsOf(r).includes(".app[data-sidebar-collapsed]"))
      .every((r) => !r.body.includes("flex-direction"))).toBe(true);
  });

  it("the sidebar opens and closes as ONE box: its width, its slide and its head row's clip read one number", () => {
    /* THE BUG (reported 10-04, with a video): the column slid out UNDER the rail on a negative margin,
       so its rows and its head showed through the rail's translucent ground, passing beneath the
       destinations and the traffic lights; and its head faded on its own clock over the page's bar.
       Now the column is a box that clips what it holds, its width a fraction of the sidebar's, and the
       one wrapper inside it slides with that edge — the fraction registered, so it interpolates, and
       one transition on it moves all three together. THE mutants: the clip dropped (the slide is drawn
       over the rail), the old margin back, or a second clock on any part. */
    expect(css).toMatch(/@property --sidebar-open \{ syntax: "<number>"; inherits: true; initial-value: 1; \}/);
    const column = bodiesFor(".sidebar").join(" ");
    expect(column).toContain("width: calc(var(--sidebar-w) * var(--sidebar-open))");
    expect(column).toContain("overflow: hidden");
    expect(column).toContain("transition: --sidebar-open var(--dur-move) var(--ease-in-out-strong)");
    expect(column).not.toContain("margin-inline-start");
    expect(column).not.toMatch(/(^|;)\s*opacity/);
    expect(bodiesFor(".sidebar[data-collapsed]").join(" ")).toContain("--sidebar-open: 0");
    const slide = bodiesFor(".sidebar-slide").join(" ");
    expect(slide).toContain("width: var(--sidebar-w)");
    expect(slide).toContain("translate: calc(var(--sidebar-w) * (var(--sidebar-open) - 1)) 0");
    // Nothing inside keeps a clock of its own.
    for (const sel of [".sidebar-slide", ".sb-header", ".sb-list"]) {
      expect(RULES.filter((r) => r.selectors.includes(sel)).map((r) => r.body).join(" "), sel).not.toContain("transition");
    }
    // The frame changes hands once the column has gone, never at the click (App.tsx, useSidebarFolded).
    const handedAtClick = RULES.flatMap(partsOf).filter((sel) => sel.includes("[data-sidebar-collapsed]")
      && /(\.main|\.page-overlay)(::|\s|$)/.test(sel) && !sel.endsWith("-bar"));
    expect(handedAtClick).toEqual([]);
  });

  it("a page hides the panes' bars and their dividers, which would otherwise run up through its clear bar", () => {
    // Reported in the live check: a split's divider drawn as a stray rule across the page's top row.
    expect(bodiesFor(":root:has(.page-overlay) .main .panel-bar").join(" ")).toContain("visibility: hidden");
    expect(bodiesFor(":root:has(.page-overlay) .main .resize-handle").join(" ")).toContain("visibility: hidden");
  });

  it("the sidebar stands a hair above the panes: its edge casts a light shade onto them, below the head row", () => {
    /* The owner, 10-04: "put that shadow on the sidebar and remove the shadow from the left side of
       the session panes". The sidebar is the raised surface, so the shade falls on the panes' side of
       the seam — over a page as well, which is what stands beside the sidebar then — and on `.main`,
       whose edge is the column's edge on every frame of the motion. Below the 40px head row, which is
       chrome on both sides and casts nothing; none at all once the column has folded. Its own alpha
       per face: the same black reads far heavier on the light ground. THE mutants: the shade back on
       the sidebar's own ground, over the head row, under a page, or kept while folded. */
    expect(bodiesFor(".sidebar").join(" ")).not.toContain("seam-shade");
    const shade = bodiesFor(".app:not([data-sidebar-folded]) > .main::after").join(" ");
    expect(shade).toContain("background: linear-gradient(to right, var(--seam-shade), transparent)");
    expect(shade).toContain("top: var(--frame-top)");
    expect(shade).toContain("left: 0; width: var(--seam-w)");
    const rung = (sel: string) => Number(/z-index:\s*(\d+)/.exec(bodiesFor(sel).join(" "))?.[1]);
    expect(rung(".app:not([data-sidebar-folded]) > .main::after")).toBeGreaterThan(rung(".page-overlay"));
    const alpha = (block: string) => Number(/--seam-shade: oklch\(0 0 0 \/ ([\d.]+)\)/.exec(block)?.[1]);
    const dark = alpha(bodiesFor(":root").join(" "));
    const light = alpha(bodiesFor(':root[data-mode="light"]').join(" "));
    expect(dark).toBeGreaterThan(0);
    expect(light).toBeGreaterThan(0);
    expect(light).toBeLessThan(dark);
    // Very light means very light: the owner asked for it lighter again (10-04), to about 60% of the
    // first cut's measured depth (0.14 dark, 0.02 light). THE mutant: the first cut's depth back.
    expect(dark).toBeLessThanOrEqual(0.085);
    expect(light).toBeLessThanOrEqual(0.012);
  });

  it("an app-level page is laid out in the panes' column: it moves with them and never covers the rail", () => {
    /* THE BUG this pins (reported 10-04, with a video): the page was a window-fixed layer inset by
       numbers of its own, so at a sidebar toggle it jumped to its final edge on the first frame while
       the panes it covers were still moving — they flashed through beside it — and its bar's title
       jumped with it. Inside `.main` (App.tsx), at `inset: 0`, it is the panes' box on every frame.
       THE mutant: `position: fixed` and an inset again. */
    const page = bodiesFor(".page-overlay").join(" ");
    expect(page).toContain("position: absolute");
    expect(page).toContain("inset: 0;");
    expect(page).not.toContain("position: fixed");
    expect(RULES.filter((r) => r.selectors.some((sel) => sel.startsWith(".page-overlay[data-sidebar")))).toEqual([]);
    const rung = (sel: string) => Number(/z-index:\s*(\d+)/.exec(bodiesFor(sel).join(" "))?.[1]);
    // The rail is chrome, not a floating surface: every scrim still covers it.
    for (const modal of [".sheet-backdrop", ".palette-backdrop"]) {
      expect(rung(modal), `${modal} no longer covers the rail`).toBeGreaterThan(rung(".app-rail"));
    }
    // The window's lead (back, forward, the toggle) stays above a page and under every scrim.
    expect(rung(".window-lead")).toBeGreaterThan(rung(".page-overlay"));
    expect(rung(".window-lead")).toBeLessThan(rung(".sheet-backdrop"));
  });

  it("whatever the top row holds under the window's lead makes room for it, on the column's own timing", () => {
    /* The lights, back and forward are the window's (WindowLead), so each thing that can sit under
       them clears them: the sidebar's head row clips what it draws past the lead (and the clip rides
       the slide, so it stays put on the window while the row moves), and — while the sidebar is away —
       the first pane's bar or a page's bar starts its content past the lead and the toggle. Their
       padding moves on the column's own duration and curve, so a title travels with the edge instead
       of jumping to its final place at the click. THE mutants: no room made (a title under the lead),
       or room made on a different timeline (the title arrives before or after the edge). */
    expect(bodiesFor(".sb-header").join(" ")).toContain("clip-path: inset(0 0 0 calc(var(--lead-nav-end) - var(--rail-w) + var(--sidebar-w) * (1 - var(--sidebar-open))))");
    for (const bar of [".app[data-sidebar-collapsed] .panel[data-first-leaf] > .panel-bar", ".app[data-sidebar-collapsed] .page-overlay-bar"]) {
      expect(bodiesFor(bar).join(" "), bar).toContain("padding-left: calc(var(--lead-end) - var(--rail-w))");
    }
    const column = bodiesFor(".sidebar").join(" ");
    const timing = /transition: --sidebar-open (var\(--dur-move\) var\(--ease-in-out-strong\))/.exec(column)?.[1];
    expect(timing).toBeTruthy();
    for (const bar of [".panel[data-first-leaf] > .panel-bar", ".page-overlay-bar"]) {
      expect(bodiesFor(bar).join(" "), bar).toContain(`transition: padding-left ${timing}`);
    }
    // The old corner overlay is still gone: one way of making room, not two.
    expect(RULES.filter((r) => r.selectors.some((sel) => sel.includes(".sb-corner")))).toEqual([]);
    expect(css).not.toContain("--corner-w");
    // Every strip at the top of the window is still 40px: main places the lights once at y:14 and
    // never moves them, which centres them in a 40px band — the rail's, beside the sidebar's header
    // and the first pane's bar.
    expect(bodiesFor(".panel-bar").join(" ")).toContain("height: 40px");
  });

  it("the window never scrolls: the shell is clipped at its own edges, without becoming a scroller", () => {
    /* Measured live (10-05): a page rising in from 6px under its place overran the window's foot, the
       document became scrollable by those 6px, and a classic scrollbar took 15px off the whole app
       until the rise ended — a page's centred column jumped 7.5px. THE MUTANTS: no clip (the
       scrollbar back), or `hidden`, which makes the shell a scroll container for every sticky header
       inside it. */
    const shell = bodiesFor(".app").join(" ");
    expect(shell).toContain("overflow: clip");
    expect(shell).not.toMatch(/overflow: (hidden|auto|scroll)/);
    expect(bodiesFor(".page-overlay").join(" ")).toContain("animation: rl-page-in");
  });

  it("navigation lands the column at once: the cut takes the motion off everything on the column's clock", () => {
    /* The owner, 10-05, with a video: a page with no sidebar drew itself at once while the spaces
       folded shut beside it, and a page whose sections take the column unfolded them beside a page
       already drawn. A change navigation makes is a cut (App.tsx, `useSidebarCut`), and under it
       nothing that moves with the column moves — the column, the bars that make room for the lead and
       the toggle arriving in the lead — while the person's own toggle keeps all of it (above). Read
       off the rule set, so a part given the column's timing later is held to the cut as well.
       THE MUTANTS: any one of them left moving, or the page that takes the sidebar with it still
       rising in over the panes taking its room. */
    const onTheColumnsClock = RULES.filter((r) => /transition: (--sidebar-open|padding-left) var\(--dur-move\) var\(--ease-in-out-strong\)/.test(r.body))
      .flatMap(partsOf);
    expect(onTheColumnsClock).toEqual(expect.arrayContaining([".sidebar", ".panel[data-first-leaf] > .panel-bar", ".page-overlay-bar"]));
    for (const sel of onTheColumnsClock) {
      const cut = RULES.filter((r) => partsOf(r).some((p) => p === `.app[data-sidebar-cut] > ${sel}` || p === `.app[data-sidebar-cut] ${sel}`));
      expect(cut.map((r) => r.body).join(" "), sel).toContain("transition: none");
    }
    expect(bodiesFor(".window-lead > .icon-btn").join(" ")).toContain("animation: rl-lead-in");
    expect(bodiesFor(".app[data-sidebar-cut] > .window-lead > .icon-btn").join(" ")).toContain("animation: none");
    expect(bodiesFor(".page-overlay").join(" ")).toContain("animation: rl-page-in");
    expect(bodiesFor(".page-overlay[data-cut]").join(" ")).toContain("animation: none");
  });

  it("the left chrome's edge is a BORDER on .main, in both states", () => {
    /* Measured live (`sidebar-edge-live.mjs`): as an inset box-shadow this line computed perfectly
       and painted nothing at all. An inset shadow sits below the element's children, and `.main`'s
       children — `.panehost` and every `.panel` — carry --rl-panel edge to edge, so the pane covered
       it. A border is box decoration on `.main` itself and cannot be covered by a child laid out in
       its padding box. This test is the cheap half; the pixels are the real one. */
    const edge = RULES.filter((r) => r.selectors.some((sel) => /(^|\s)\.main$/.test(sel.trim())) && r.body.includes("border-left"))
      .flatMap((r) => r.selectors);
    // Unconditional now: collapsed, the rail is still beside the panes (Plan 27), so the line is still
    // between two surfaces rather than a stray rule down the window's own edge.
    // Collapsed, there is no sidebar for it to stand against: the frame's rim takes the sheet's left
    // edge from it, round the corner, and the border goes rather than doubling the rim.
    // First run has neither the rail nor the sidebar beside it (`.app[data-first-run]`), so there is
    // nothing for the line to stand between and it goes with them.
    // FOLDED, not collapsed: the line rides the column's edge all the way in, and goes only once the
    // column has gone (App.tsx, useSidebarFolded) — at the click it left the sidebar unbounded for
    // the length of the motion.
    expect(edge).toEqual([".app > .main", ".app[data-sidebar-folded] > .main", ".app[data-first-run] > .main"]);
    expect(bodiesFor(".app[data-first-run] > .main").join(" ")).toContain("border-left: 0");
    expect(bodiesFor(".app > .main").join(" ")).toContain("var(--rl-line)");
    expect(bodiesFor(".app[data-sidebar-folded] > .main").join(" ")).toContain("border-left: 0");
    expect(bodiesFor(".app[data-sidebar-folded] .main::before").join(" ")).toMatch(/border-left: var\(--hairline-w\) solid var\(--rl-line-strong\)/);
    // And no inset shadow creeps back onto .main to say the same thing twice, invisibly.
    expect(bodiesFor(".main").join(" ")).not.toContain("box-shadow: inset");
  });

  it("the sidebar keeps its vibrancy, and it is the app's ONE adjustable ground", () => {
    // The intent this pins moved: the sidebar used to be --page at a literal 82%, and is now the
    // composed --sidebar-ground, because the number is the user's. What has NOT moved is which
    // surface is translucent — exactly one, so text on a pane never renders over the desktop.
    // Its own ground under the head band's chrome and the panes' shade at the seam (both below).
    expect(bodiesFor(".sidebar").join(" ")).toMatch(/background:[^;]*var\(--sidebar-ground\);/);
    // The rail is the window's chrome: the sidebar's ground, a step off it (the window's frame).
    expect(bodiesFor(".app-rail").join(" ")).toContain("background: linear-gradient(var(--chrome-tint), var(--chrome-tint)), var(--sidebar-ground)");
    // The old per-mode rgba override is gone — --page flips with data-mode on its own.
    expect(css).not.toContain("rgba(244,244,244,.82)");
    // THE second-ground mutant: give .main or a pane a color-mix over --page too. The window looks
    // better on a nice wallpaper and every pane's body text starts depending on it.
    const translucent = RULES.filter((r) => /background:[^;]*var\(--sidebar-ground\)/.test(r.body)).flatMap((r) => r.selectors);
    // Chrome only: the rail, the sidebar, the head row across the window (the panes' top band, the
    // page's bar) and the frame's corner where the sheet meets the rail. Never a pane's BODY — the
    // panes' ground below the head row is --pane-ground, painted once by `.main`.
    expect(translucent.sort()).toEqual([".app-rail", ".app[data-sidebar-folded] .main::after", ".app[data-sidebar-folded] > .main",
      ".main", ".sidebar"].sort());
    expect(bodiesFor(".main").join(" ")).toMatch(/var\(--pane-ground\)\) 0 var\(--frame-top\)/);
  });

  it("the ground's alpha is driven, defaulted opaque in CSS, and overridden by reduced transparency", () => {
    // The default 82 lives in packages/ui/src/theme.ts and nowhere else; what the stylesheet states
    // is the no-JS fallback, which is deliberately the OPPOSITE — a renderer that never ran should
    // leave an opaque sidebar, not a see-through one.
    expect(tokens).toContain("--ground-alpha: 100%;");
    expect(tokens).toContain("--sidebar-ground: color-mix(in srgb, var(--page) var(--ground-alpha), transparent);");
    expect(tokens).not.toMatch(/--ground-alpha:\s*82%/);
    // THE inline-composition mutant: compose --sidebar-ground in applyTheme instead. An inline
    // custom property beats every stylesheet rule, so the media query below would stop working and
    // Reduce Transparency would silently do nothing for the one surface it exists for.
    const reduced = tokens.slice(tokens.indexOf("@media (prefers-reduced-transparency: reduce)"));
    expect(reduced).toContain("--sidebar-ground: var(--page)");
  });

  it("Inter and JetBrains Mono are self-hosted with Inter leading the UI stack", () => {
    expect(css).toContain('src: url("./assets/fonts/InterVariable.woff2") format("woff2")');
    expect(css).toMatch(/--font-ui:\s*"Inter"/);
    expect(css).toMatch(/--font-mono:\s*"JetBrains Mono"/);
  });

  it("markdown lists survive Tailwind preflight's list-style reset", () => {
    expect(bodiesFor(".md ul").join(" ")).toContain("list-style: disc");
    expect(bodiesFor(".md ol").join(" ")).toContain("list-style: decimal");
  });
});

describe("Plan 9 W2 — BUI transcript primitives", () => {

  it("the tool ledger wears ThinkingState: shimmer on the working header (data-working, never a clock), a solid 1px trace rail, muted settled checks", () => {
    const shimmer = bodiesFor('.tool-group[data-working] .tool-group-summary').join(" ");
    expect(shimmer).toContain("animation: shimmer-text 1.4s linear infinite");
    expect(shimmer).toContain("background-clip: text");
    // BUI's trace rail is a solid hairline; the old dashed connector is gone.
    expect(bodiesFor(".tool-group-steps").join(" ")).toContain("border-left: var(--hairline-w) solid var(--line)");
    // The settled check is muted ink, not green — colour stays for errors.
    expect(bodiesFor('.tool-card[data-state="ok"] .tool-status').join(" ")).toContain("color: var(--ink-3)");
    // The row's target is ToolChips' field-fill chip.
    const chip = bodiesFor(".tool-summary").join(" ");
    expect(chip).toContain("background: var(--field)");
    expect(chip).toContain("box-shadow: var(--shadow-hairline)");
    // Measured edit counts are the semantic green/red.
    expect(bodiesFor(".tool-stat-add").join(" ")).toContain("var(--green)");
    expect(bodiesFor(".tool-stat-del").join(" ")).toContain("var(--red)");
  });

  it("an open card's head squares off against the body divider — only the card's own corners round", () => {
    // Both radii are the control radius while collapsed: the row IS the card's whole surface, so
    // its hover fill has to trace the card's corners exactly.
    expect(bodiesFor(".tool-card").join(" ")).toContain("border-radius: var(--r-ctl)");
    expect(bodiesFor(".tool-row").join(" ")).toContain("border-radius: var(--r-ctl)");
    // Open, the bottom two stop rounding: a curve there pulls the hover fill away from the
    // hairline and leaves a notch at each end of the divider.
    expect(bodiesFor(".tool-card[data-open] > .tool-row").join(" "))
      .toContain("border-radius: var(--r-ctl) var(--r-ctl) 0 0");
  });

  it("an open card's rules reach its own row and body only — the cards inside it are a sub-agent's", () => {
    for (const sel of [".tool-card[data-open] > .tool-row", ".tool-card[data-open] > .tool-body-wrap",
      ".tool-card[data-open] > .tool-row > .tool-chevron", ".tool-group[data-open] > .tool-group-row > .tool-chevron"]) bodiesFor(sel);
    // A descendant selector here reaches the whole sub-tree: opening one Task card would rotate every
    // chevron beneath it and unfold every nested body along with its own.
    expect(RULES.flatMap((r) => r.selectors).filter((s) => /^\.tool-(card|group)\[data-open\] [^>]/.test(s))).toEqual([]);
  });

  it("every surface on the prompter's curve is also PAINTED on it", () => {
    /* `corner-shape: squircle` is inert in the Chromium this app ships on, so a surface that
       declares the curve without appearing in the paint-worklet rule renders a plain rounded rect
       next to a composer wearing a real squircle — which is worse than not having asked. design.md
       states the rule; this is what makes it hold.

       Scoped to `--r-squircle` deliberately. The chip and control rungs also carry `corner-shape`,
       and at 8-10px the difference between a squircle and a round rect is not visible — those are
       forward-compatibility, not a signature. */
    const painted = new Set(
      RULES.filter((r) => r.selectors.some((sel) => sel.startsWith(":root[data-squircle]")))
        .flatMap((r) => r.selectors)
        .map((sel) => sel.replace(":root[data-squircle] ", "").trim()),
    );
    /* Scoped to the signature radius. A control taking the curve by RATIO at 20-34px is not in
       scope: the worklet draws a surface's fill, a button has four of them (resting, hover, primary,
       danger) and they change under the pointer — routing that through a paint would make any state
       someone forgot an invisible button. At 8-11px a squircle and a rounded rect are the same
       picture, so those declare only and get the shape free when Chromium 139 lands. */
    const declared = RULES
      .filter((r) => /corner-shape:\s*squircle/.test(r.body) && /border-radius:[^;]*--r-squircle\b/.test(r.body))
      .flatMap((r) => r.selectors)
      /* A CHILD taking its parent's corner is not a surface of its own. The palette's head and foot
         round themselves so nothing square meets the painted curve behind them — painting each of
         them would give the card three stacked fills instead of one. */
      .filter((sel) => !/^\.palette > /.test(sel));
    expect(declared.filter((sel) => !painted.has(sel)).sort(),
      "these wear the signature curve but are never painted — they will render as round rects").toEqual([]);
  });

  it("fenced code is a ringless panel on the prompter's curve, with a 13/1.65 mono body", () => {
    /* Changed deliberately from the hairline-ringed 12px card this used to pin. A fenced block is
       the same KIND of surface the composer is — a machine-text panel the eye rests in — so it
       wears the same corner; and a ring around a large radius is the one thing that makes the
       radius look like a mistake rather than a decision. The surface fill is what separates code
       from prose, and it is doing that job alone now. */
    const panel = bodiesFor(".md-code").join(" ");
    expect(panel).toContain("background: var(--surface)");
    expect(panel).toContain("border-radius: var(--r-squircle)");
    expect(panel).toContain("corner-shape: squircle");
    expect(panel).not.toContain("box-shadow: var(--shadow-hairline)");
    // And the painted path, because `corner-shape` is inert in the Chromium this ships on: without
    // this the block would render a plain round rect beside a composer wearing a real squircle.
    expect(bodiesFor(":root[data-squircle] .md-code").join(" ")).toContain("--sq-fill: var(--surface)");
    const body = bodiesFor(".md-code pre").join(" ");
    expect(body).toContain("font-size: 13px");
    expect(body).toContain("line-height: calc(1.65 + var(--lh-shift))");
  });

  it("diff lines carry the CodeBlock diff treatment: token tints, a 3px bar (solid green add, red hatch delete), coloured gutters", () => {
    expect(bodiesFor('.diff-line[data-kind="add"]').join(" ")).toContain("background: var(--green-tint)");
    expect(bodiesFor('.diff-line[data-kind="add"]::before').join(" ")).toContain("background: var(--green)");
    expect(bodiesFor('.diff-line[data-kind="del"]').join(" ")).toContain("background: var(--red-tint)");
    expect(bodiesFor('.diff-line[data-kind="del"]::before').join(" ")).toContain("repeating-linear-gradient(45deg, var(--red)");
    expect(bodiesFor('.diff-line[data-kind="add"]::before, .diff-line[data-kind="del"]::before'.split(", ")[0]!).join(" ")).toContain("width: 3px");
  });
});

describe("Plan 9 W3 — composer + chrome in BUI language", () => {
  it("the composer wears PromptBar's field card: surface on shadow-card, focus = the line-strong border-brighten (the 30% accent glow is gone)", () => {
    const card = bodiesFor(".composer").join(" ");
    expect(card).toContain("background: var(--surface)");
    expect(card).toContain("box-shadow: var(--shadow-card)");
    const focus = bodiesFor(".composer:focus-within").join(" ");
    expect(focus).toContain("0 0 0 1px var(--line-strong)");
    expect(focus).not.toContain("--rl-accent");
  });

  it("the quick chat's prompter draws no edge at all — no ring, no seam, on either path, focused or not", () => {
    /* The card spans the window and has given up its corners there, so a ring drew a rectangle
       inside the window's own rounded one and a seam ruled one continuous window into two. The
       transcript's fade band is what separates them. Both paths have to say so and both have to say
       it again for focus: `.composer:focus-within` and `:root[data-squircle] .composer:focus-within`
       are written later in the file, so an equally weighted rule would lose to them and the box
       would come back the moment the caret landed. */
    for (const sel of [".quick-chat .composer", ".quick-chat .composer:focus-within",
                       ":root[data-squircle] .quick-chat .composer",
                       ":root[data-squircle] .quick-chat .composer:focus-within"]) {
      const body = bodiesFor(sel).join(" ");
      expect(body, sel).toContain("box-shadow: none");
      if (sel.startsWith(":root")) expect(body, sel).toContain("--sq-ring-w: 0");
    }
    // The dissolve washes to the window's ground, not the pane's — on the wrong one it reads as a
    // block of off-tone above the prompter that comes and goes with the scroll.
    /* The sent bubble steps off THIS ground. `.msg-user` fills with `--rl-raised`, and this window is
       `--rl-raised` — the bubble measured 1.000:1 against it, against 1.087 in a pane. THE mutant:
       delete either rule. The painted path takes its fill from the custom property, so a fix that
       only names `background` leaves every squircle build exactly as invisible as before. */
    for (const [sel, decl] of [[".quick-chat .msg-user", "background: var(--rl-hover)"],
                               [":root[data-squircle] .quick-chat .msg-user", "--sq-fill: var(--rl-hover)"]] as const) {
      expect(bodiesFor(sel).join(" "), sel).toContain(decl);
    }
    const wrap = bodiesFor(".quick-chat .transcript-wrap").join(" ");
    /* The window shortens both ends rather than taking the pane's: at 380×520 the pane's 40/68 would
       dissolve most of what is on screen. */
    expect(wrap).toContain("--fade-top-h: 24px");
    expect(wrap).toContain("--fade-h: 28px");
    /* And the transcript CLEARS the bands it is read under. At 4px of top padding the first message
       pinned to the top sat inside a 40px band: blurred, washed halfway to the surface, its bubble
       fill gone — the reader's own words looking like a fault. THE mutant: drop the padding back.
       Asserted as a relation rather than as numbers, because it is one: shorten a band and the
       clearance may follow it down, but it may never fall under it. */
    const px = (body: string, prop: string) => Number(new RegExp(`${prop}: (\\d+)px`).exec(body)?.[1]);
    const pad = /padding: (\d+)px \d+px (\d+)px/.exec(bodiesFor(".quick-chat .transcript").join(" "));
    expect(Number(pad?.[1])).toBeGreaterThan(px(wrap, "--fade-top-h"));
    expect(Number(pad?.[2])).toBeGreaterThan(px(wrap, "--fade-h"));
  });

  it("the quick chat sits under the anchored-popover rung, or its own model picker opens behind it", () => {
    /* Both are portalled to the body, so they are siblings and the higher z-index simply wins. The
       window has to clear the scrims (40–60) and nothing above them. */
    const win = Number(/z-index: (\d+)/.exec(bodiesFor(".quick-chat").join(" "))?.[1]);
    const popovers = [".menu", ".model-picker", ".mention-picker", ".skill-picker"]
      .map((sel) => Number(/z-index: (\d+)/.exec(bodiesFor(sel).join(" "))?.[1]));
    expect(win).toBeGreaterThan(60);
    for (const z of popovers) expect(z).toBeGreaterThan(win);
  });

  it("the media viewer covers the quick chat, and stays under the popovers its prompter raises", () => {
    /* Its prompter has a model picker, and the viewer is opened from INSIDE the quick chat as often
       as from a pane — so it must clear the chat window and nothing that floats from its own controls.
       Not a filter either: Chromium paints a video layer through one, and a blur over the window's
       material smudges (design.md). The workspace's own frames go while it is up instead. */
    const z = (sel: string) => Number(/z-index: (\d+)/.exec(bodiesFor(sel).join(" "))?.[1]);
    expect(z(".media-viewer")).toBeGreaterThan(z(".quick-chat"));
    for (const over of [".menu", ".model-picker", ".mention-picker", ".toasts", ".tooltip"]) expect(z(over), over).toBeGreaterThan(z(".media-viewer"));
    expect(bodiesFor(".media-viewer").join(" ")).not.toMatch(/backdrop-filter/);
    expect(css).toContain("body[data-media-viewer] .app .media-el { visibility: hidden; }");
  });

  it("everything decorative stops when nobody is looking at the window", () => {
    /* Measured before it was written (`scripts/power-audit.mjs`): with its animations stopped the
       window costs about 1% of a core, and with them running it costs half of one PER PANE — nearly
       all of it decoration that never stops while an agent is working. `animation-play-state` rather
       than `animation: none`, so the orb resumes from where it stood instead of restarting. */
    const paused = RULES.filter((r) => r.body.includes("animation-play-state: paused"));
    const quiet = paused.map((r) => r.body).join(" ");
    expect(quiet).toContain("animation-play-state: paused");
    expect(quiet).not.toContain("animation: none"); // that one restarts everything on the way back
    // Transitions are deliberately untouched: one frozen mid-flight would stick half-open.
    expect(quiet).not.toContain("transition");
    // The orb is the one that has to be in there: it is the most expensive thing on screen.
    expect(paused.flatMap(partsOf)).toContain(":root[data-quiet] .spinner-dot");

    /* THE mutant, and the bug this replaced: pausing `*`. An entrance animation — `rl-msg-in`,
       `rl-fade-in` — starts at `opacity: 0`, so freezing one at its first frame leaves the thing
       invisible for as long as the window stays unfocused; a transcript an agent was talking into
       went blank. So every selector the quiet rules pause must name an animation that never ends. */
    for (const part of paused.flatMap(partsOf)) {
      if (!part.startsWith(":root[data-quiet] ")) continue;
      const target = part.slice(":root[data-quiet] ".length);
      const decls = RULES.filter((r) => partsOf(r).includes(target)).map((r) => r.body);
      // `animation: none` under prefers-reduced-motion is the global kill, not a declaration.
      const declaring = decls.filter((b) => /(^|;|\s)animation: /.test(b) && !b.includes("animation: none"));
      expect(declaring.length, `${target} is paused when quiet but declares no animation`).toBeGreaterThan(0);
      for (const b of declaring) {
        expect(b, `${target} is paused when quiet but its animation ends`).toContain("infinite");
      }
    }

    /* Low power used to go further: the fade bands stopped filtering their backdrop, and so did the
       transcripts in unfocused panes — two backdrop layers per transcript, fourteen in a seven-pane
       window, re-filtering on every frame an agent wrote into them. There is nothing left to turn
       off. The dissolve is a mask on the scroller and filters nothing at any setting, which is the
       same saving taken once instead of per state. THE mutant: a backdrop-filter creeping back onto
       a fade, which would reintroduce the cost AND smudge the translucent pane under it. */
    expect(css, "a fade may not filter its backdrop again").not.toMatch(/backdrop-filter: blur[^;]*;\s*[^}]*mask-image: linear-gradient\(to (bottom|top)/);

    // One ping per session, in the pane you are in — not a second forever-animating dot per sidebar row.
    expect(bodiesFor(".item-status::after").join(" ")).toContain("content: none");
  });

  it("the simulator's frame takes every measurement from the pane, and focus follows its corner", () => {
    /* The border's thickness and both corners are functions of how much room the picture got, so
       they arrive as custom properties rather than as numbers here — what the stylesheet owns is
       that it USES them. The focus ring is the one with a trap behind it: the picture's corner is a
       `clip-path` and a box-shadow is drawn from the border box, so a ring on the picture is a
       rectangle around a rounded screen. Framed, it goes on the frame, which has a real radius. */
    const chassis = bodiesFor('.sim-chassis[data-frame="drawn"]').join(" ");
    expect(chassis).toContain("padding: var(--sim-bezel)");
    expect(chassis).toContain("border-radius: var(--sim-outer-r)");
    expect(bodiesFor('.sim-screen:focus-visible .sim-chassis[data-frame="drawn"]').join(" ")).toContain("0 0 0 2px var(--rl-accent)");
    expect(bodiesFor('.sim-screen:focus-visible .sim-chassis[data-frame] .sim-picture').join(" ")).not.toContain("var(--rl-accent)");

    /* The frame Realm draws for a device it ships no picture of is Realm's own surface: a
       translucent lift off the pane's ground, and nothing in it imitates hardware — no metal
       gradient, no nubs for the volume keys. THE MUTANT is `--rl-raised`, the obvious surface: this
       pane's ground is dark in BOTH faces, so a fill off the neutral ladder is a white slab around
       the device on the light one. */
    expect(chassis).toContain("background: var(--overlay-lighten-300)");
    expect(RULES.flatMap(partsOf).filter((sel) => /\.sim-(rail-key|mockup)/.test(sel))).toEqual([]);

    /* The device art, which lies OVER the stream. It must never take a press meant for the device,
       and focus traces the ART's own silhouette — a box-shadow there is a rectangle whose corners
       show through the frame's transparent ones, which is a blue L in each corner of a black
       iPhone. `drop-shadow` follows rendered alpha. */
    expect(bodiesFor(".sim-art").join(" ")).toContain("pointer-events: none");
    expect(bodiesFor(".sim-screen:focus-visible .sim-art").join(" ")).toContain("drop-shadow");

    /* Painted, the corner is a superellipse concentric with the one the picture is clipped to — and
       `border-radius` is 0 under the painter, so the focus ring has to move to the painter with it
       or it draws a blue rectangle around a rounded device. */
    const painted = bodiesFor(':root[data-squircle] .sim-chassis[data-frame="drawn"]').join(" ");
    expect(painted).toContain("background: paint(rl-squircle)");
    expect(painted).toContain("--sq-fill: var(--overlay-lighten-300)");
    expect(painted).toContain("--sq-radius-top: var(--sim-outer-r)");
    const paintedFocus = bodiesFor(':root[data-squircle] .sim-screen:focus-visible .sim-chassis[data-frame="drawn"]').join(" ");
    expect(paintedFocus).toContain("box-shadow: none");
    expect(paintedFocus).toContain("--sq-ring: var(--rl-accent)");

  });

  it("the device's controls over it and under it are one pill", () => {
    /* The toolbar over the device, and under it the Record control, the recording it becomes and a
       phone's offer to go live: one height, fill, corner and lift, so above and below read as one
       instrument around the device. THE MUTANT: a row under the device in a material of its own —
       the `.btn` the Record control was, whose painter trades the lift for a ring. */
    const pill = RULES.find((r) => partsOf(r).includes(".sim-toolbar") && partsOf(r).includes(".sim-record-start"));
    expect(pill && partsOf(pill).sort()).toEqual([".sim-live", ".sim-record-start", ".sim-recording", ".sim-toolbar"]);
    for (const decl of ["height: 32px", "border-radius: 999px", "background: var(--rl-raised)", "box-shadow: var(--shadow-card)"]) {
      expect(pill!.body).toContain(decl);
    }
    // What sits inside a pill is a pill, under the painter too — or Stop is a squircle in a capsule.
    const inner = bodiesFor(":root[data-squircle] :is(.sim-recording-stop, .sim-live-btn)").join(" ");
    expect(inner).toContain("--sq-radius-top: calc(var(--btn-h) / 2)");
    expect(inner).toContain("--sq-radius-bottom: calc(var(--btn-h) / 2)");
    expect(bodiesFor(".sim-toolbar .icon-btn").join(" ")).toContain("border-radius: 999px");
  });

  it("the device toolbar's budget is its own rule's arithmetic", () => {
    /* `toolbar-fit.ts` decides how many presses a narrow pane keeps from these numbers: the pill's
       padding, its gaps, the 28px buttons and the rule between the state and them (its hairline
       counted as a whole pixel). Change the toolbar's box and the budget stops describing it —
       buttons clip, or fold into the overflow with room to spare. */
    const bar = bodiesFor(".sim-toolbar").join(" ");
    const pad = Number(/padding: (\d+)px/.exec(bar)?.[1]);
    const gap = Number(/gap: (\d+)px/.exec(bar)?.[1]);
    const margin = Number(/margin: 0 (\d+)px/.exec(bodiesFor(".sim-toolbar-rule").join(" "))?.[1]);
    const button = Number(/width: (\d+)px/.exec(bodiesFor(".icon-btn").join(" "))?.[1]);
    expect(TOOLBAR_BUTTON).toBe(button + gap);
    expect(TOOLBAR_CHROME).toBe(2 * pad + 1 + 2 * margin + button + 2 * gap);
  });

  it("the prompter's strips are edged alike — every tab above the card wears the ring the under-strip does", () => {
    /* They are one object seen twice: same fill, same corner, same inset, mirrored. Only the lower
       one was edged, which read as a prompter with a bottom and no top — and edging the over-strip
       alone left the same hole whenever the goal, plan or agents strip was the one on top. A MIDDLE
       tab gives up its top corners and the top of its ring — a ring across it would trace a hairline
       through the band where two strips meet — but never its sides. It once gave up the whole ring,
       and the git footer under the plan strip read as an open-sided box down both edges, right where
       the card tucks over it: its fill is the pane's own ground, so the ring is the only edge it has.
       THE mutant: `--sq-ring-w: 0` back on a stacked tab. */
    const ring = "--sq-ring: var(--card-ring); --sq-ring-w: var(--hairline-w)";
    for (const sel of [".composer-goal", ".composer-todos", ".composer-overstrip", ".composer-understrip"])
      expect(bodiesFor(`:root[data-squircle] ${sel}`).join(" "), sel).toContain(ring);
    // Every pair the band can actually stack, in DOM order: goal, plan, over-strip.
    const STACKED = [".composer-goal + .composer-todos", ".composer-goal + .composer-overstrip", ".composer-todos + .composer-overstrip"];
    for (const sel of STACKED) {
      const body = bodiesFor(`:root[data-squircle] ${sel}`).join(" ");
      expect(body, sel).toContain("--sq-ring-open: top");
      expect(body, sel).not.toMatch(/--sq-ring-w:\s*0/);
      expect(body, sel).toContain("--sq-radius-top: 0px");
      // …and the same corner under the fallback, where the radius is the browser's rather than the
      // worklet's: a pair squared in one path and rounded in the other is one seam in two shapes.
      expect(bodiesFor(sel).join(" "), sel).toContain("border-radius: 0");
    }
  });

  it("the quick chat's window edge is the one line that answers the pointer, and the drag glow is the whole of the drop", () => {
    /* The border is the window's own, stated ahead of the overlay shadow's hairline so it paints
       over it, and it has its own token pair because it is the only edge in the app with a hover
       state to go to. Nothing is drawn on the PROMPTER for a drag: the glow is the affordance, and
       an accent line across the card was a second mark for one drag. */
    const rest = bodiesFor(".quick-chat").join(" "), hover = bodiesFor(".quick-chat:hover").join(" ");
    expect(rest).toContain("box-shadow: 0 0 0 var(--hairline-w) var(--window-ring), var(--shadow-overlay)");
    expect(hover).toContain("box-shadow: 0 0 0 var(--hairline-w) var(--window-ring-hover), var(--shadow-overlay)");
    expect(rest).toContain("transition: box-shadow var(--dur-hover)");
    /* The glow is ONE layer over the reading area, and the containment is what makes that possible.
       It used to span the window, which ringed the prompter too — and because a backdrop-filter may
       never wash across the card, the wash had to sit under the dock while a SECOND element carried
       the stroke above it just to close the rectangle's bottom edge. A box that stops at the
       prompter has no card over any of its four sides, so the split is gone with the reason for it.
       THE mutant: bring `.quick-chat-drop-ring` back. */
    expect(RULES.flatMap((r) => r.selectors).filter((sel) => sel.includes("drop-ring"))).toEqual([]);
    const glow = bodiesFor(".quick-chat .session-drop").join(" ");
    expect(glow).toContain("inset: 6px");
    // All four corners on the window's own curve less that inset — the bottom pair included, so the
    // ring reads as a rounded rectangle above the prompter and not a box the card has cut off.
    expect(glow).toContain("border-radius: calc(var(--r-float) - 6px)");
    // The stroke is the shared rule's, inherited rather than restated — one description of the ring.
    expect(bodiesFor(".session-drop").join(" ")).toContain("inset 0 0 0 1.5px var(--rl-accent)");
    expect(bodiesFor(".session-drop").join(" ")).toContain("pointer-events: none");
    // The positioning parent it hangs off is the body, and the body holds no dock.
    expect(bodiesFor(".quick-chat-body").join(" ")).toContain("position: relative");
    // The label is on the SURFACE, never accent-on-accent: the wash behind it is already tinted.
    expect(bodiesFor(".quick-chat-drop-label").join(" ")).toContain("background: var(--surface)");
    expect(RULES.flatMap((r) => r.selectors).filter((sel) => sel.includes(".quick-chat[data-dropping]"))).toEqual([]);
    // Both faces carry the pair: an edge that exists in one mode only is the bug this catches.
    const light = [...tokensCss.matchAll(/:root\[data-mode="light"\]\s*\{([^}]*)\}/g)].map((m) => m[1]!).join("\n");
    for (const token of ["--window-ring:", "--window-ring-hover:"]) {
      expect(tokensCss, token).toContain(token);
      expect(light, token).toContain(token);
    }
  });

  it("the commit dock wears that same card, on nothing: no fill behind it, no rule above it", () => {
    const card = bodiesFor(".commit-card").join(" ");
    expect(card).toContain("background: var(--surface)");
    expect(card).toContain("box-shadow: var(--shadow-card)");
    expect(bodiesFor(".commit-card:focus-within").join(" ")).toContain("0 0 0 1px var(--line-strong)");
    // The removed form: the dock used to be a raised strip behind a hairline. Both must stay gone —
    // the list already dissolves into the card, and either one draws that seam twice.
    const dock = bodiesFor(".diff-commit").join(" ");
    expect(dock).not.toContain("background:");
    expect(dock).not.toContain("border-top:");
  });

  it("the commit field keeps its scrollbar, because nothing auto-grows it the way .composer-input grows", () => {
    // Inheriting the composer's `scrollbar-width: none` hid the only sign a message runs on.
    expect(bodiesFor(".commit-message").join(" ")).not.toContain("scrollbar-width: none");
    expect(bodiesFor(".commit-message").join(" ")).not.toContain("max-height");
    // It takes its bar from the shared scroller list rather than a rule of its own now, so
    // membership of that list is what the guarantee rests on.
    expect(SCROLLERS).toContain(".commit-message");
  });

  it("the changes list clears the whole ramp, and reads its depth from the same --fade-h the ramp does", () => {
    // Scrolled to the end, the last row must not sit in the dissolve. A fraction of the depth (it
    // was 20px against 44) left the filename you scrolled down for half faded under the ramp.
    expect(bodiesFor(".diff-list").join(" ")).toContain("padding-bottom: var(--fade-h)");
    expect(bodiesFor(".diff-list-wrap").join(" ")).toContain("--fade-h: 44px");
    // One declaration of the number, on the wrapper, inherited by the scroller that masks itself.
    expect(bodiesFor(".diff-list").join(" ")).not.toContain("--fade-h:");
  });

  it("the sidebar list dissolves with the app's shared mask, only where rows run past an end, and starts close under the profile", () => {
    /* It wore a mask of its own that was always drawn, so its first row sat a whole band (12px, and 4
       more) under the profile to stay out of a fade with nothing under it — the gap the owner asked to
       close (10-04). It takes the shared dissolve now (`data-dissolve`, set by Sidebar.tsx through
       `useDissolve`): a mask that appears at an end only while rows run past it. THE mutants: the
       static ramp back on the scroller, or the band's depth back in its top padding. */
    const body = bodiesFor(".space-body").join(" ");
    expect(body).not.toContain("mask-image");
    expect(body).toContain("padding-top: 4px");
    // The depths the shared mask reads are still declared once, on the list, for the scroller to inherit.
    expect(bodiesFor(".sb-list").join(" ")).toContain("--fade-h: 44px");
    expect(bodiesFor(".sb-list").join(" ")).toContain("--fade-top-h: 12px");
    expect(body).not.toContain("--fade-h:");
    // Still a mask and nothing painted over the rows: a blur over this translucent column composites
    // toward black, and a wash to a fixed tone stripes the material.
    expect(body).not.toContain("backdrop-filter");
    expect(body).not.toContain("background:");
    expect(RULES.filter((r) => r.selectors.some((sel) => sel.includes(".space-fade")))).toEqual([]);
  });

  /* Dropping a file anywhere on the session pane. jsdom has no compositing, so the one thing these
     can hold is the LAYERING and the degradations — how it actually paints is what
     `session-drop-live.mjs` samples. */
  it("the pane's drop glow passes UNDER the prompter, the way the transcript does", () => {
    const glow = bodiesFor(".session-drop").join(" ");
    // The bug this refuses to repeat: a blurring band that outranked the prompter cut a stripe
    // straight across the hero card (prompter-fade-live.mjs). The dock is layer 2; this is 1.
    expect(glow).toContain("z-index: 1");
    expect(bodiesFor(".composer-dock").join(" ")).toContain("z-index: 2");
    // Inset from the panel edge: flush, a four-way split's rings would run into each other and the
    // two panes would read as one target.
    expect(glow).toContain("inset: 6px");
    // It advertises the drop; it must never eat it.
    expect(glow).toContain("pointer-events: none");
    // The pane is the positioned ancestor the glow hangs off, not whatever happens to be above it.
    expect(bodiesFor(".session-pane").join(" ")).toContain("position: relative");
  });

  it("the glow is an inner ring that dissolves inward, and the blur is masked on its own layer", () => {
    const glow = bodiesFor(".session-drop").join(" ");
    // Both insets: the sharp ring, then the soft fall-off behind it. A flat overlay is what this is
    // deliberately not.
    expect(glow).toContain("box-shadow: inset 0 0 0 1.5px var(--rl-accent), inset 0 0 36px -6px var(--rl-accent)");
    const soft = bodiesFor(".session-drop::before").join(" ");
    expect(soft).toContain("mask-image: radial-gradient");
    /* And it does NOT blur its backdrop, which it used to: the pane under it is the window ground at
       `--pane-alpha` over the macOS material, and a filter over a translucent surface filters the
       window's own transparency toward black — the glow came out as a dark square. THE mutant is
       putting the blur back, which looks like an improvement in a diff. */
    expect(soft).not.toContain("backdrop-filter");
    // The mask stays on the pseudo-element rather than the parent: a masked ancestor clips the ring.
    expect(glow).not.toContain("mask-image");
  });

  it("has nothing left for reduced transparency to take off the glow", () => {
    /* There used to be a carve-out here dropping the glow's backdrop blur under the preference. The
       blur is gone at every setting now, so a rule naming it would be dead code that reads as
       coverage. The ring is on `.session-drop` itself and is still never touched by a preference
       about translucency — an affordance may not be taken away by one. */
    const reduced = blockAfter("@media (prefers-reduced-transparency: reduce)").replace(/\s+/g, " ");
    expect(reduced).not.toContain(".session-drop");
    expect(bodiesFor(".session-drop").join(" ")).toContain("box-shadow: inset");
  });

  it("a disabled quiet button stays dark under the cursor — the hover fill is guarded like .btn's", () => {
    // Unguarded, "Commit only" with nothing staged still lit up on hover: a control that answers
    // the pointer while refusing the click.
    expect(RULES.some((r) => r.selectors.includes(".btn-quiet:hover"))).toBe(false);
    expect(bodiesFor(".btn-quiet:hover:not(:disabled)").join(" ")).toContain("background: var(--rl-hover)");
    // The base `button:disabled` already dims it; a .btn-quiet copy of that opacity says it twice.
    expect(RULES.some((r) => r.selectors.includes(".btn-quiet:disabled"))).toBe(false);
  });

  it("an attachment is a SQUARE on the field fill behind a hairline ring — no name, no label column", () => {
    const tile = bodiesFor(".attach-tile").join(" ");
    // Square, and the same square in both directions: a chip that grows with its filename is the
    // thing this replaced. Both sides now come off ONE property, which is also what the corner
    // radius is derived from — so a tile cannot be resized without its corner following.
    expect(tile).toContain("--attach-tile: 44px");
    expect(tile).toContain("width: var(--attach-tile)");
    expect(tile).toContain("height: var(--attach-tile)");
    expect(bodiesFor(".msg-user-files .attach-tile").join(" ")).toContain("--attach-tile: 56px");
    const art = bodiesFor(".attach-art").join(" ");
    expect(art).toContain("background: var(--field)");
    expect(art).toContain("box-shadow: var(--shadow-hairline)");
    /* The corner is a proportion of the tile, not a flat length, and it is the squircle ratio rather
       than the control one — `--sq-ratio-ctl` would spend the whole 44px box and render the circular
       fallback as a disc (see the token's own note). `corner-shape` makes it a true superellipse on
       Chromium 139 at the same moment as every other surface that declares it. */
    expect(art).toContain("border-radius: calc(var(--attach-tile) * var(--sq-ratio-media))");
    expect(art).toContain("corner-shape: squircle");
    // One corner for both sizes: a sent attachment used to take a flat `--r-row`, which is what made
    // a file visibly change shape the moment it was sent.
    expect(RULES.some((r) => r.selectors.includes(".msg-user-files .attach-art"))).toBe(false);
    // The well clips the picture; the TILE must not, or it would clip its own hover tip off.
    expect(art).toContain("overflow: hidden");
    expect(tile).not.toContain("overflow: hidden");
    /* The tile is a <span>, so without a display of its own it is an INLINE box and both lengths
       above are dead letters. The composer never noticed — its <li> is `display: contents`, which
       makes the tile a flex item and blockifies it — but the transcript's <li> is an ordinary flex
       item, and there the sent tile collapsed to 0×0 and painted nothing. */
    expect(tile).toContain("display: inline-block");
  });

  it("the open control fills the tile and draws nothing — the well underneath already has the ring", () => {
    const open = bodiesFor(".attach-open").join(" ");
    // `inset: 0` is what keeps `.attach-art`'s own `inset: 0` resolving against the 44px square: the
    // art is now the button's child, so a button that merely wrapped the tile would collapse it.
    expect(open).toContain("position: absolute");
    expect(open).toContain("inset: 0");
    expect(open).toContain("border: none");
    expect(open).toContain("background: none");
    expect(open).toContain("padding: 0");
    // A drop target's cursor must not promise a zoom the file cannot do: only a tile main has
    // confirmed is media gets zoom-in, and the mark only lands once that answer is back. Every other
    // tile is a button that opens its file, and points like one (the pointer rule, by tag).
    expect(open).not.toContain("cursor:");
    expect(bodiesFor(".attach-tile[data-media] .attach-open").join(" ")).toContain("cursor: zoom-in");
  });

  it("the type badge is a ramp over the well, never a bar across the picture", () => {
    /* A flat scrim has a top edge, and on a thumbnail that edge is a line drawn across the image at
       whatever height the badge is — the tile reads as two pictures stacked. Both grounds ramp, and
       the top padding is the room the ramp needs. The letters carry a halo of their own ink, which
       is what keeps 8px type on a photograph from reading as pasted on. */
    const ext = bodiesFor(".attach-ext").join(" "), overImage = bodiesFor(".attach-tile[data-image] .attach-ext").join(" ");
    expect(ext).toContain("background: linear-gradient(to top, color-mix(in srgb, var(--surface) 88%, transparent), transparent)");
    expect(overImage).toContain("background: linear-gradient(to top, rgb(0 0 0 / .72), rgb(0 0 0 / 0))");
    expect(ext).toContain("text-shadow: 0 0 4px color-mix(in srgb, currentColor 38%, transparent)");
    expect(ext).toContain("padding: 7px 2px 1px");
    // The mutant this kills: either ground going back to a single flat colour.
    for (const body of [ext, overImage]) expect(body).not.toMatch(/background:\s*(?:rgb|color-mix|var)[^;]*;/);
  });

  it("the file's name lives in a hover tip that fades in — not in an OS `title`, which cannot show the size or the folder", () => {
    const tip = bodiesFor(".attach-tip").join(" ");
    expect(tip).toContain("opacity: 0");
    expect(tip).toContain("pointer-events: none");
    expect(tip).toContain("transition: opacity var(--dur-fast) var(--ease-out-strong)");
    expect(bodiesFor(".attach-tile:hover .attach-tip, .attach-tile:focus-within .attach-tip".split(", ")[0]!).join(" ")).toContain("opacity: 1");
  });

  it("a sent attachment's tip opens leftward from the tile's right edge, so it never overhangs the transcript", () => {
    /* Centred, the tip hung past the right edge of a row that hugs it — unseen at rest but still the
       scroller's overflow, so every transcript with a screenshot in it scrolled sideways and showed a
       white corner. THE MUTANT: drop the override and the centred placement returns. (That nothing
       overhangs is measured in the real window, against a replayed transcript; this pins the rule.) */
    const sent = bodiesFor(".msg-user-files .attach-tip").join(" ");
    expect(sent).toContain("left: auto");
    expect(sent).toContain("right: 0");
    expect(sent).not.toContain("translateX");
    expect(bodiesFor(".msg-user-files .attach-tile:hover .attach-tip").join(" ")).toContain("transform: translateY(0)");
  });

  it("sent attachments stack ABOVE the bubble, in a column that keeps the transcript's right edge", () => {
    const row = bodiesFor(".msg-user-row").join(" ");
    expect(row).toContain("flex-direction: column");
    expect(row).toContain("align-items: flex-end");
    // Not inside the bubble: the tiles are a list of their own, and the bubble is a sibling.
    expect(bodiesFor(".msg-user-files").join(" ")).toContain("list-style: none");
  });

  it("the Thinking strip shimmers on the shared shimmer-text gradient — no opacity pulse", () => {
    expect(bodiesFor(".composer-thinking span").join(" ")).not.toContain("rl-pulse");
    // one shimmer rule serves all three surfaces; membership is the pin
    const shimmer = RULES.find((r) => r.selectors.includes(".shimmer-text"));
    expect(shimmer?.selectors).toContain(".composer-thinking span");
  });

  it("the bypass pills speak a tone PAIR (StatusPill), not a hand-rolled color-mix", () => {
    /* The invariant is the pair — an ink token and its matching tint — rather than which hue it is.
       Both moved orange → red when the permission chip joined the mode chip in one control (see the
       Full-access test above); what must not come back is the ad-hoc `color-mix` these replaced. */
    const pill = bodiesFor(".bypass-confirm").join(" ");
    expect(pill).toContain("color: var(--rl-danger)");
    expect(pill).toContain("background: var(--red-tint)");
    // The chip's half of the pair is its HOVER now — see the test below for why it rests unfilled.
    const lifted = bodiesFor(".ghost-chip[data-warning]:hover:not([data-static])").join(" ");
    expect(lifted).toContain("--fill: var(--red-tint)");
    for (const body of [pill, bodiesFor('.ghost-chip[data-warning]').join(" "), lifted]) {
      expect(body).not.toMatch(/(?:color|background|--fill):\s*color-mix/);
    }
  });

  it("the permission control rests as a glyph and a word — Full access keeps its tone on the ink alone", () => {
    /* Codex's control, which the owner holds up as the bar: no fill and no highlight, an icon and a
       label. The red wash Full access used to rest on was a second warning laid under the first, and
       the only resting fill on a row of unfilled chips. THE mutant: put `--fill: var(--red-tint)` back
       on the resting rule. */
    const rest = bodiesFor(".ghost-chip[data-warning]").join(" ");
    expect(rest).toContain("color: var(--rl-danger)");
    expect(rest).not.toMatch(/--fill|background/);
    // …and the hover keeps the tone, so pointing at the chip never reads as the warning going away.
    expect(bodiesFor(".ghost-chip[data-warning]:hover:not([data-static])").join(" ")).toContain("color: var(--rl-danger)");
  });

  it("sidebar actives are a fill alone — SidebarNav has no accent tick and no weight bump", () => {
    expect(RULES.some((r) => r.selectors.includes(".item[data-active]::before"))).toBe(false);
    const active = bodiesFor(".item[data-active] .item-row").join(" ");
    expect(active).toContain("color: var(--rl-text-bright)");
    expect(active).not.toContain("font-weight");
    // the fills stay TRANSLUCENT (--rl-active), the W1 vibrancy carve-out for the material column
    expect(bodiesFor(".item[data-active]").join(" ")).toContain("background: var(--rl-active)");
  });

  it("a painted control's state fills are DATA, so no state rule can out-specify the painter", () => {
    /* The bug this pins, found on a hover: `.btn.primary:hover:not(:disabled)` is (0,4,0) and
       `:root[data-squircle] .btn` is only (0,3,0), so hovering a primary button replaced
       `background: paint(rl-squircle)` with a flat colour — over a `border-radius: 0` box, which is
       a hard SQUARE. Every rounded button in the app went square under the pointer.

       Specificity was the wrong thing to fight. The fills are `--fill` now: a state rule sets a
       custom property, the base rule paints `var(--fill)`, the painted rule paints the same
       property through the worklet, and there is nothing left for a state to win. So the invariant
       is not "the painted rule is specific enough" — it is "no state rule declares `background` at
       all", which is checkable and stays true as states are added. */
    const painted = [".btn", ".ghost-chip", ".palette-opt"];
    const offenders = RULES.flatMap((r) => r.selectors.map((sel) => ({ sel, body: r.body })))
      .filter(({ sel }) => !sel.includes("[data-squircle]"))
      .filter(({ sel }) => painted.some((c) => new RegExp(`\\${c}(?![\\w-])`).test(sel)))
      // A state rule is one with a pseudo-class or an attribute past the bare class name.
      .filter(({ sel }) => /:(hover|focus|active|checked|disabled)|\[/.test(sel))
      .filter(({ body }) => /(?:^|[;\s])background(?:-color)?:/.test(body))
      .map(({ sel }) => sel);
    expect(offenders).toEqual([]);
    // …and the painter reads that one property rather than one rule per state. There used to be a
    // `--sq-fill` line per button variant down here; ten rules that had to be kept in step with ten
    // rules above them is the other half of the same mistake.
    expect(css).toContain("--sq-fill: var(--fill);");
    expect(css.match(/--sq-fill: var\(--fill\)/g)).toHaveLength(1);
  });

  it("a switch is a pill, and the text-field rule cannot reach it", () => {
    /* `.field input` is (0,1,1) and `.switch` is (0,1,0), so a switch inside a field was rendered
       by the TEXT FIELD rule: 30px tall, control radius, field fill. A rounded rectangle with a
       knob in it — which is what "this switch looks like a weird square" was describing. The fix is
       reach, not specificity: a switch is not a text field and must not match the rule at all. */
    const field = RULES.find((r) => r.selectors.some((sel) => sel.startsWith(".field input")) && r.body.includes("height: 30px"));
    const sel = field?.selectors.find((x) => x.startsWith(".field input")) ?? "";
    expect(sel).toContain(":not(.switch)");
    expect(sel).toContain(":not(.checkbox)");
    const sw = bodiesFor(".switch").join(" ");
    expect(sw).toContain("border-radius: 999px");
    expect(sw).toContain("height: 20px");
    // Not a squircle: a superellipse on a 34×20 box is a lozenge, which is neither a pill nor a
    // rounded rectangle and reads as a mistake.
    expect(sw).not.toContain("corner-shape");
  });

  it("a count OVERHANGS its glyph in the rail, and wears the count pill's own colours", () => {
    /* The feed's count used to be a pill in a destination row, where an opaque row sat under it and
       there was width for padding. It is a badge on a 26px button now, and two things have to hold
       or it stops being readable as the same fact:

       It escapes the button. A digit fitted inside 26px alongside a 14px glyph has to go under the
       type floor to clear it — THE mutant is `overflow: hidden` (or dropping `position: relative`,
       which sends it to the nearest positioned ancestor and out of the row entirely).

       It is painted over something OPAQUE. `--orange-tint` is a 14% wash; over a column the user can
       make see-through it is the desktop wearing an orange cast, not a chip. The row gave it an
       opaque ground for free and this has to state it. */
    const badge = bodiesFor(".sb-badge").join(" ");
    // In the rail (Plan 27) the count hangs off the GLYPH's shoulder — Home's and the bell's — and the
    // button around it does not clip it.
    expect(bodiesFor(".rail-glyph").join(" ")).toContain("position: relative");
    expect(bodiesFor(".rail-btn").join(" ")).toContain("overflow: visible");
    expect(badge).toContain("position: absolute");
    expect(badge).toMatch(/top: -\d/);
    expect(badge).toContain("color: var(--orange)");
    expect(badge).toContain("background-color: var(--rl-frame)");
    expect(badge).toContain("linear-gradient(var(--orange-tint), var(--orange-tint))");
    // The same pair the pill in the nav uses, so one fact has one appearance.
    expect(bodiesFor('.status-pill[data-tone="warning"]').join(" ")).toContain("color: var(--orange)");
    // Not under the floor: §type — nothing is set below 11px, badges included.
    expect(badge).toContain("font-size: 11px");
    expect(bodiesFor(".item").join(" ")).toContain("border-radius: var(--r-ctl)");
    expect(bodiesFor(".group-label").join(" ")).toContain("font-size: 13px");
  });

  it("the sidebar's search bar is GONE, rule and token both", () => {
    /* It was a full-width button reading "Search… ⌘K" under the space's name, and it is a glyph in
       the header's actions now. THE mutant this catches is the half-removal: the component deleted
       and its stylesheet left behind, which is how `.search` (a button) and `.search-field` (the
       thing you type in) end up as two rules with one name and nobody able to say which is live.
       `--search-ground` went with it — it existed for that one control's fill on a see-through
       column, and a token with no user is a number the next person has to disprove. */
    expect(RULES.filter((r) => r.selectors.includes(".search"))).toHaveLength(0);
    expect(css).not.toContain("--search-ground");
    expect(tokensCss).not.toContain("--search-ground");
    // The typed field is untouched — it is the Library's, and it never was this one.
    expect(bodiesFor(".search-field").join(" ")).toContain("--search-h: 34px");
  });

  it("a painted control rounds the EXPONENT down, because its radius has nowhere left to go", () => {
    /* The complaint this answers is "the buttons are still slightly too square", and the obvious
       lever is the wrong one. `--sq-ratio-ctl` is 0.48 — a radius may not pass half the short side,
       so a 30px button is already spending 96% of the room it has, and the 0.6px between there and
       0.5 is both invisible and a literal pill for every control that renders the circular
       FALLBACK (`.icon-btn`, `.filter-chip`, `.btn-quiet`, the settings fields…).

       What was left to win is the curve. A superellipse is a corner plus the flat run beside it; a
       surface's 36px corner is a third of its height and has a run, a control's corner is the whole
       of its short side and has none, so n = 4 there renders as squareness and nothing else.

       THE mutant: drop `--sq-n` from the painted-control block. The buttons go back to the surface
       exponent and nothing else in the suite notices, because jsdom cannot see a painted curve —
       squircle-live.mjs measures the corner itself. */
    expect(tokensCss).toMatch(/--sq-n-ctl: [\d.]+;/);
    const n = Number(/--sq-n-ctl: ([\d.]+);/.exec(tokensCss)![1]);
    // 2 is a circle, and a circle at this ratio is a pill — a shape --r-pill already means something
    // by. 4 is the surfaces' own, which is where this started.
    expect(n).toBeGreaterThan(2);
    expect(n).toBeLessThan(4);
    // The ratio stays clear of half the box for the fallback's sake, which is the reason the
    // exponent had to be the lever at all.
    expect(Number(/--sq-ratio-ctl: ([\d.]+);/.exec(tokensCss)![1])).toBeLessThan(0.5);
    // Every painted CONTROL takes it — the block of them and the search field, which is one.
    for (const sel of [":root[data-squircle] .btn", ":root[data-squircle] .search-field"])
      expect(bodiesFor(sel).join(" "), sel).toContain("--sq-n: var(--sq-n-ctl)");
    // …and no SURFACE does. The signature is the 36px corner, and it is the one place the shape has
    // the run it needs to read as smooth rather than as blunt.
    for (const sel of [".composer", ".palette", ".md-code", ".install-card", ".commit-card"])
      expect(bodiesFor(`:root[data-squircle] ${sel}`).join(" "), sel).not.toContain("--sq-n");
  });

  it("a painted control's hover FADES — `background-color` has nothing to animate when the background is a paint", () => {
    /* The bug: under the gate a painted control's `background` is `paint(rl-squircle)`, which does
       not interpolate, so the §6 hover declaration animated a property that never changed and every
       painted fill snapped while its unpainted neighbours faded.
       THE mutant: delete `--sq-fill` from either list below. Both rules carry it, because a control
       must have ONE fill timing however the fill is drawn.
       The second half is the registration: an unregistered custom property computes to a token
       stream, and token streams do not interpolate — so `--sq-fill` transitioning at all depends on
       theme/squircle.ts declaring it `<color>`. squircle-live.mjs measures the composited midpoint. */
    for (const sel of [".btn", ".ghost-chip", ".palette-opt"]) {
      expect(bodiesFor(sel).join(" "), sel).toContain(`--sq-fill ${dur("--dur-hover")} ease`);
    }
    const registrar = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/squircle.ts"), "utf8");
    expect(registrar).toContain('{ name: "--sq-fill", syntax: "<color>"');
  });

  it("the search field is drawn by the painter, at a corner stated as a proportion of its height", () => {
    /* There were two of these — the sidebar's button and the Library's field — at 34px and 32px, one
       painted and one not, so one read as a rounded rect and the other as a pill. The sidebar's is
       gone (it is a glyph now); what that episode settled stays, because the field is still a
       control whose corner is a PROPORTION: set the height alone and the curve moves with it, and a
       copy of this control that forgets the painter renders square beside a composer that does not.
       THE mutant: change `--search-h`, or drop the painted block. */
    for (const sel of [".search-field"]) {
      const body = bodiesFor(sel).join(" ");
      expect(body, sel).toContain("--search-h: 34px");
      expect(body, sel).toContain("border-radius: calc(var(--search-h) * var(--sq-ratio-ctl))");
      expect(body, sel).toContain("corner-shape: squircle");
      const painted = bodiesFor(`:root[data-squircle] ${sel}`).join(" ");
      expect(painted, sel).toContain("--sq-radius-top: calc(var(--search-h) * var(--sq-ratio-ctl))");
      expect(painted, sel).toContain("--sq-n: var(--sq-n-ctl)");
    }
    // The field's focus ring goes to the PAINTER. Under the gate its border box is a square, so a
    // box-shadow ring would trace one around a curve the worklet drew correctly underneath.
    const focus = bodiesFor(":root[data-squircle] .search-field:focus").join(" ");
    expect(focus).toContain("--sq-ring: color-mix(in srgb, var(--rl-accent) 35%, transparent)");
    expect(focus).toContain("box-shadow: none");
  });

  it("the Skills tab types into the Library's search field, not a bar of its own", () => {
    /* What it had was a `.skills-filter` box with a magnifier inside it and an `<input>` inside
       that — and `.field input` (0,3,1) out-specified the input's own class, so the form's plain
       text-field rule drew a second bordered box within the first. A search bar inside a search bar,
       which is what it looked like.
       THE mutant: drop `:not(.search-field)` from the `.field input` rule and the inner box returns
       wherever a search field sits in a form. */
    // The row and the toggle survive — they are the two controls standing apart. The box, its
    // magnifier and its inner input do not, and a rule with no user is how one comes back.
    expect(css).not.toMatch(/\.skills-filter(?!-row|-toggle)/);
    const panel = readFileSync(repoFile("apps/desktop/src/renderer/src/components/settings/SkillsPanel.tsx"), "utf8");
    expect(panel).toContain('className="search-field" type="search"');
    expect(panel).not.toContain("skills-filter-input");
    // The toggle beside it is still its own control, and still outside the field's box.
    expect(panel).toContain('className="skills-filter-toggle"');
    const field = RULES.find((r) => r.selectors.some((sel) => sel.startsWith(".field input")) && r.body.includes("height: 30px"));
    expect(field?.selectors.find((x) => x.startsWith(".field input"))).toContain(":not(.search-field)");
  });

  it("buttons are BUI Button's tiers: secondary = surface on shadow-btn LIFTING to hover; primary = accent with the filled highlight and accent-ink hover", () => {
    /* The tiers are unchanged; where they are WRITTEN moved. Each state sets `--fill` and the base
       rule paints it, so the painted regime can read one property instead of racing each state on
       specificity — see the painted-control test above for the square-on-hover bug that forced it. */
    const btn = bodiesFor(".btn").join(" ");
    expect(btn).toContain("--fill: var(--surface)");
    expect(btn).toContain("background: var(--fill)");
    /* The EDGE, not the lift. A drop under a secondary button says it is floating above the sheet,
       which it is not doing — at 30px it landed as a smudge along the bottom rather than as depth,
       and it fought the ring for the job of saying where the button ends. `--shadow-btn` keeps both
       layers for the controls that really are raised (the selected segment, the pressed
       documents-mode), which is why the ring is its own token rather than that one edited. */
    expect(btn).toContain("box-shadow: 0 0 0 var(--hairline-w) var(--btn-ring)");
    expect(btn).not.toContain("box-shadow: var(--shadow-btn)");
    /* Painted, the edge has to be the PAINTER's ring: a box-shadow would trace the square border box
       that `border-radius: 0` leaves behind, which is the bug that squared these corners twice. */
    const paintedBtn = bodiesFor(":root[data-squircle] .btn").join(" ");
    expect(paintedBtn).toContain("--sq-ring: var(--btn-ring)");
    expect(paintedBtn).toContain("--sq-ring-w: var(--hairline-w)");
    expect(paintedBtn).not.toContain("filter:");
    /* `--hover`, not `--inset`, and the direction is the point rather than the token name. `--inset`
       is a rung of the SURFACE ladder and sits below `--surface` on a dark face, so a hovered button
       sank while every row and menu item beside it lifted — which is what read as the button lurching
       to a darker colour. `--hover` is the interaction rung and is authored per mode to move the
       right way on both faces. The mutant: put `--inset` back and a hovered button darkens again. */
    expect(bodiesFor(".btn:hover:not(:disabled)").join(" ")).toContain("--fill: var(--hover)");
    expect(bodiesFor(".btn:hover:not(:disabled)").join(" ")).not.toContain("--fill: var(--inset)");
    const primary = bodiesFor(".btn.primary").join(" ");
    expect(primary).toContain("--fill: var(--rl-accent)");
    expect(primary).toContain("box-shadow: var(--fill-bevel)");
    expect(bodiesFor(".btn.primary:hover:not(:disabled)").join(" ")).toContain("--fill: var(--accent-ink)");
  });
});

/** The squircle surfaces. What the CORNER looks like is settled by scripts/squircle-live.mjs, which
 *  measures the composited pixels — jsdom has no layout and no CSS Painting API, so to it
 *  `background: paint(rl-squircle)` and `border-radius: 20px` are the same declaration. What is
 *  checkable here is everything around the shape: that the fallback survives, that the two halves of
 *  the card shadow cannot drift apart, and that the three files involved still agree on the names
 *  they pass between them. */
/** The shared scroller list, read out of the `:where(...)` block it is written in. */
const SCROLLERS = (css.match(/:where\(([^)]*)\)\s*\{\s*scrollbar-width: thin/)?.[1] ?? "")
  .split(",").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
/** The element that actually scrolls is the last compound of the selector: `.permission-preview
 *  .fd-file` is `.fd-file` doing the scrolling, in a place that gives it a height to overflow. */
const leaf = (sel: string): string => sel.split(" ").pop()!;

describe("scrollbars", () => {
  const GUARD = ":root:not([data-overlay-scrollbars])";
  it("the track is hidden by INHERITANCE, so a scroller written tomorrow is covered too", () => {
    // The whole point of putting it on :root: `scrollbar-color` inherits, and a list is a thing to
    // keep up with. The transparent second value is the track.
    // A thumb is a MARK, not an edge: it keeps its weight when the app's borders soften.
    expect(bodiesFor(GUARD).join(" ")).toContain("scrollbar-color: var(--mark) transparent");
    expect(bodiesFor(`${GUARD} :hover`).join(" ")).toContain("scrollbar-color: var(--mark-strong) transparent");
  });

  /* On a Mac whose system draws overlay bars, every rule that styles one stands down (App.tsx,
     ScrollbarStyleBridge): a colour repaints the system's thumb in the page's ink, and a
     `::-webkit-scrollbar` rule turns it into a classic bar holding a gutter (8px against 0, measured).
     THE mutant is a new scrollbar rule written without the guard. `none` is exempt: hiding a bar is
     not drawing one. */
  it("stands down wherever the system draws overlay scrollbars", () => {
    const styling = RULES.filter((r) =>
      r.selectors.some((sel) => sel.includes("::-webkit-scrollbar"))
      || /scrollbar-color:\s*(?!auto)/.test(r.body)
      || /scrollbar-width:\s*thin/.test(r.body));
    expect(styling.length).toBeGreaterThan(10);
    for (const r of styling) for (const sel of partsOf(r))
      expect(sel.startsWith(GUARD) || sel.startsWith(`:where(${GUARD})`), sel).toBe(true);
  });

  /** Base selectors that own a `::-webkit-scrollbar*` rule, deduped. */
  const webkitBarOwners = (): string[] => [...new Set(RULES
    .flatMap((r) => r.selectors)
    .filter((sel) => sel.includes("::-webkit-scrollbar"))
    .map((sel) => sel.slice(0, sel.indexOf("::-webkit-scrollbar")).replace(/:hover$/, "").trim()))];

  it("a ::-webkit-scrollbar rule only exists where the standard properties have been handed back", () => {
    /* The regression this closes is styling that does nothing. Setting either standard property
       makes Chromium ignore the pseudo-elements outright — and `scrollbar-color` is set on :root and
       INHERITS, so every scroller in the app starts out ignoring them. Nine such rules had been dead
       since Chromium 121 for exactly that reason.

       So the rule is not "never use the pseudo-elements". It is: if you use them, say so on the
       element by returning both standard properties to `auto` first, in a rule of its own. Anything
       else is a pseudo-element that will never paint. (`.space-body` is the one that needs them —
       see its carve-out: only `::-webkit-scrollbar-track`'s margin can hold a thumb clear of the
       mask fading that column's two ends.) */
    for (const owner of webkitBarOwners()) {
      const body = bodiesFor(owner).join(" ");
      expect(body, `${owner} styles a webkit scrollbar without reclaiming it`).toContain("scrollbar-color: auto");
      expect(body, `${owner} styles a webkit scrollbar without reclaiming it`).toContain("scrollbar-width: auto");
    }
  });

  it("every scroller that draws its own bar says what goes where two bars meet", () => {
    /* Owning the pseudo-elements owns the corner too, and a corner nobody states paints opaque white:
       the square at the foot of every transcript that scrolled both ways. THE MUTANT: style the bar,
       the track and the thumb and stop there, which is what all three owners did. An owner is
       covered by a corner rule on itself or on a selector it compounds (`.mp-list[data-dissolve]` is
       a `[data-dissolve]`). */
    const corners = RULES.filter((r) => r.body.includes("background: transparent"))
      .flatMap((r) => r.selectors).filter((sel) => sel.endsWith("::-webkit-scrollbar-corner"))
      .map((sel) => sel.slice(0, sel.indexOf("::-webkit-scrollbar-corner")));
    expect(corners.length).toBeGreaterThan(0);
    // Read past the scope every webkit bar rule now sits under (overlay scrollbars stand all of them
    // down), so a compound owner still finds the corner rule on the selector it compounds.
    const unscoped = (sel: string) => sel.replace(":root:not([data-overlay-scrollbars]) ", "");
    for (const owner of webkitBarOwners()) {
      expect(corners.some((base) => unscoped(owner).includes(unscoped(base))), `${owner} leaves its scrollbar corner to paint white`).toBe(true);
    }
  });

  it("the sidebar's thumb is held clear of the mask, by the mask's own two depths", () => {
    /* `.space-body` dissolves at both ends, and a mask applies to the element's whole rendering —
       scrollbar included — so the thumb dissolved at exactly the two places a scrollbar is most
       used. The track's margin is what holds it clear, and it is written as the same two custom
       properties the mask reads rather than as numbers: tune one end of the fade and the thumb
       follows it instead of drifting back under it.
       Only the wiring is checkable here. That the thumb is actually crisp at both ends is a
       composited-pixel question, and jsdom has no scrollbars at all. */
    const track = bodiesFor(`${GUARD} .space-body::-webkit-scrollbar-track`).join(" ");
    expect(track).toContain("margin-block: var(--fade-top-h) var(--fade-h)");
    // The mask is the shared dissolve, reading the same two depths at its two ends.
    expect(bodiesFor('[data-dissolve~="start"]').join(" ")).toContain("var(--fade-top-h");
    expect(bodiesFor('[data-dissolve~="end"]').join(" ")).toContain("var(--fade-h");
  });

  it("every scroller in the stylesheet has had a deliberate decision made about its bar", () => {
    // The regression this closes is how the app got here: nine containers were styled by hand and
    // every scroller added afterwards shipped with the default bar and a visible track.
    // Covered = named in the shared `:where(...)` list, OR carrying a webkit treatment of its own
    // (which the test above holds to its own standard).
    const covered = new Set([...SCROLLERS.map(leaf), ...webkitBarOwners().map(leaf)]);
    // Left out on purpose. The horizontal strips hide their bar entirely (they fade at the edges or
    // are short tab rows, and a bar under them would be the tallest thing in the row) and say so with
    // `scrollbar-width: none` in their own rule, which is why they are filtered rather than listed.
    // xterm is the one exception that keeps an explicit treatment: it measures this element to decide
    // the terminal's column count.
    const exempt = new Set([".xterm-viewport"]);
    const uncovered = RULES
      .filter((r) => /overflow(-[xy])?:\s*(auto|scroll)/.test(r.body) && !/scrollbar-width:\s*none/.test(r.body))
      .flatMap((r) => r.selectors)
      .filter((sel) => !covered.has(leaf(sel)) && !exempt.has(leaf(sel)));
    expect([...new Set(uncovered)].sort()).toEqual([]);
  });
});

/* The owner, 10-05: "every scrollable surface in the entire app to have our signature blur". The
   dissolve is a mask a component asks for on its scroller (`useDissolve`, ScrollFades.tsx), so the
   stylesheet alone cannot say a scroller has it: what is checked is the MARKUP — every element that
   wears a scroller's class hands its ref to the hook — or that the scroller is named below with the
   reason a dissolve would hurt it. */
describe("every scroller dissolves", () => {
  /** Scrollers that do not, each with why. */
  const EXCEPTIONS: Record<string, string> = {
    // Lines that scroll sideways. A line of code, a diff, a command or a formula is read to its last
    // character, which is exactly where a dissolve sits; the scrollbar already says there is more.
    ".md pre": "a fenced block's code lines, scrolling sideways",
    ".code-body": "a file's code lines, scrolling sideways (it dissolves downwards where a tool's body caps it)",
    ".fd-body": "a diff's lines, scrolling sideways",
    ".diff-hunks": "a file's patch in the diff pane, scrolling sideways on its own panel",
    ".cr-diffs": "a pull request's diffs, read line by line to the last character, under file heads that pin to its top",
    ".install-cmd code": "one command to copy, scrolling sideways",
    ".code-preview": "the code font's preview lines, scrolling sideways",
    ".documents-raw": "a document's raw source lines, scrolling sideways",
    ".math-display": "a typeset formula's line, scrolling sideways",
    // Surfaces that own something a mask would take.
    ".md-scroll": "a table whose column heads pin to its top, where a top band would dissolve the heads",
    ".settings-tabs": "a segmented control lying down in a narrow pane: a mask would fade the track it sits in",
    ".sched-card": "a scheduled task's card, whose own fill and rim a mask would dissolve with its rows",
    ".ql-view": "Quick Look's render on a ground of its own, which a mask would fade with the picture",
    ".media-viewer-canvas[data-pans]": "a zoomed picture being panned: its edges are the picture's pixels, which is what a zoom is for",
    // Editors keep their engines' scrolling, as they keep its rubber-banding (design.md).
    ".documents-rich-scroll": "the rich-text editor's page, where the caret can be on any line",
    ".documents-rich-surface pre": "a code block inside the rich-text editor",
    // A selector whose elements are all held to it under their own classes above.
    ".tool-body pre": "the wells a tool's body holds — .tool-well, .term-out, .code-body — each held here by its own class",
  };
  /** Scrollers whose element wears no class of its own, found by where they are drawn instead. */
  const BY_PLACE: Record<string, { file: string; tag: string }> = {
    ".permission-details pre": { file: "panes/session/PermissionCard.tsx", tag: "pre" },
    ".msg-error pre": { file: "panes/session/Transcript.tsx", tag: "pre" },
  };
  /** An element that wears a scroller's class without being the one that scrolls. */
  const NOT_THE_SCROLLER: Record<string, string> = {
    "panes/settings/SettingsPage.tsx .page-rail": "Settings' rail box never scrolls — narrow it is `overflow: visible`, and its lists are the strip",
  };

  const scrollers = [...new Set(RULES.filter((r) => /overflow(-[xy])?:\s*(auto|scroll)/.test(r.body)).flatMap(partsOf))];
  const root = dirname(repoFile("apps/desktop/src/renderer/src/styles.css"));
  const tsx = (function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx$/.test(f) && !/\.test\./.test(f) ? [p] : [];
    });
  })(root).map((p) => ({ file: p.slice(root.length + 1), src: readFileSync(p, "utf8") }));

  /** Every lower-case opening tag in a file, whole: to its first `>` outside braces and strings. */
  const tags = (src: string): { tag: string; text: string; at: number }[] => {
    const out: { tag: string; text: string; at: number }[] = [];
    for (const m of src.matchAll(/<([a-z][\w-]*)[\s>/]/g)) {
      if (/[\w"'`$.\]]/.test(src[m.index - 1] ?? "")) continue;
      let depth = 0, quote: string | null = null, j = m.index + m[1]!.length + 1;
      for (; j < src.length; j++) {
        const ch = src[j]!;
        if (quote) { if (ch === quote && src[j - 1] !== "\\") quote = null; continue; }
        if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
        if (ch === "{") depth++; else if (ch === "}") depth--; else if (ch === ">" && depth === 0) break;
      }
      out.push({ tag: m[1]!, text: src.slice(m.index, j + 1), at: m.index });
    }
    return out;
  };
  /** The names a file hands to the dissolve: to the hook, to the components that call it, or out of
   *  the two helpers that return a scroller already wired. */
  const dissolved = (src: string): Set<string> => new Set([
    ...[...src.matchAll(/useDissolve\((\w+)/g)].map((m) => m[1]!),
    ...[...src.matchAll(/<ScrollFades(?:X)? scroller=\{(\w+)\}/g)].map((m) => m[1]!),
    ...[...src.matchAll(/const \{ ref: (\w+)[^}]*\} = useFadedScroller\(/g)].map((m) => m[1]!),
    ...[...src.matchAll(/const \{ (\w+)[^}]*\} = usePickerScroller\(/g)].map((m) => m[1]!),
  ]);
  const wears = (text: string, cls: string): boolean =>
    [...text.matchAll(/className=(?:"([^"]*)"|\{([^]*?)\}(?=\s|\/?>))/g)].some((m) => (m[1] ?? m[2] ?? "").split(/[\s"'`?:]+/).includes(cls));

  it("is wired to the dissolve everywhere its element is drawn, or is named with its reason", () => {
    expect(scrollers.length, "no scrollers read out of the stylesheet").toBeGreaterThan(40);
    const bare: string[] = [];
    for (const sel of scrollers) {
      if (sel in EXCEPTIONS) continue;
      const place = BY_PLACE[sel];
      const cls = place ? null : /\.([\w-]+)(?:\[[^\]]*\]|:[\w-]+(?:\([^)]*\))?)*$/.exec(sel.split(" ").pop()!)?.[1];
      if (!place && !cls) { bare.push(`${sel}: no class to find it by — name it in BY_PLACE or EXCEPTIONS`); continue; }
      const sites = tsx.filter((f) => !place || f.file === place.file).flatMap((f) =>
        tags(f.src).filter((t) => (place ? t.tag === place.tag : wears(t.text, cls!))).map((t) => ({ ...t, file: f.file, src: f.src })));
      if (sites.length === 0) { bare.push(`${sel}: drawn nowhere in the renderer`); continue; }
      for (const s of sites) {
        if (`${s.file} ${sel}` in NOT_THE_SCROLLER) continue;
        const ref = /\bref=\{(\w+)\}/.exec(s.text)?.[1];
        if (!ref || !dissolved(s.src).has(ref)) bare.push(`${sel}: ${s.file}:${s.src.slice(0, s.at).split("\n").length} <${s.tag}${ref ? ` ref=${ref}` : ""}>`);
      }
    }
    expect(bare).toEqual([]);
  });

  it("names nothing that is not a scroller", () => {
    // An exception that outlived its scroller is a hole left open for the next one.
    for (const sel of [...Object.keys(EXCEPTIONS), ...Object.keys(BY_PLACE)]) expect(scrollers, sel).toContain(sel);
  });
});

describe("a side pane's tab strip", () => {
  it("keeps every tab's glyph whole, whatever the title beside it is doing", () => {
    /* The documents and device tabs drew smaller marks than a session's: the glyph was a flex item
       that SHRANK with its title — an SVG's automatic minimum width is zero — so every tab whose
       title ran to an ellipsis lost width off its mark, measured 5px across for "Documents · realm".
       THE MUTANT: the glyph left to the flex default. A page's own icon is held the same way. */
    expect(bodiesFor(".pane-tab-label > svg").join(" ")).toMatch(/flex: none/);
    expect(bodiesFor(".page-icon").join(" ")).toMatch(/flex: none/);
  });

  it("stays without a scrollbar where the dissolve hands every other scroller its bar back", () => {
    /* `[data-dissolve-x]` reclaims the bar on a Mac set to show classic scrollbars, so the strip's
       own `scrollbar-width: none` loses to it the moment the strip dissolves. THE MUTANT: no
       override, and a 10px bar appears under a 28px row of tabs on those Macs only. */
    expect(bodiesFor(":root:not([data-overlay-scrollbars]) [data-dissolve-x]").join(" ")).toContain("scrollbar-width: auto");
    expect(bodiesFor(":root:not([data-overlay-scrollbars]) .pane-tabs[data-dissolve-x]").join(" ")).toContain("scrollbar-width: none");
  });

  it("gives a tab's close a hit target that ends at the tab, so a strip that fits has nothing to scroll", () => {
    /* Every icon button reaches 6px past itself, and the close sits 3px in from its tab's end: the
       last tab's reached 3px past the strip, which the strip measured as slack and dissolved its far
       end over. The reach may be no more than the gap between the close and its tab's edges. */
    const close = bodiesFor(".pane-tab .pane-tab-close").join(" ");
    const tab = bodiesFor(".pane-tab").join(" ");
    const room = Math.min(Number(/margin-right: (\d+)px/.exec(close)?.[1]),
      (Number(/height: (\d+)px/.exec(tab)?.[1]) - Number(/--btn-h: (\d+)px/.exec(close)?.[1])) / 2);
    const reach = -Number(/inset: (-?\d+)px/.exec(bodiesFor(".pane-tab > .icon-btn::after").join(" "))?.[1]);
    expect(room).toBe(3);
    expect(reach).toBeLessThanOrEqual(room);
  });

  it("draws a focused tab's ring inside the tab, where the strip's clip cannot cut it", () => {
    /* The strip is exactly one tab tall and clips like any scroller, so the app's ring — 1px outside
       the label — lost its top and bottom and read as two accent bars. THE MUTANT: the global ring
       left to the label. The tab draws it instead, inset by its own width. */
    const ring = bodiesFor(".pane-tab:has(> .pane-tab-label:focus-visible)").join(" ");
    const width = Number(/outline: (\d+)px solid var\(--rl-accent\)/.exec(ring)?.[1]);
    expect(width).toBeGreaterThan(0);
    expect(ring).toContain(`outline-offset: -${width}px`);
    expect(bodiesFor(".pane-tab-label:focus-visible").join(" ")).toContain("outline: none");
  });
});

describe("dividers", () => {
  /** The table-list idiom: a rule drawn between every pair of adjacent rows. */
  const ADJACENT = /^(\.[a-z-]+) \+ \1$/;
  const drawsALine = (body: string): boolean =>
    /border(-top|-bottom)?:\s*1px/.test(body) || /box-shadow:\s*inset 0 1px 0 var\(--line/.test(body);

  it("no list draws an unconditional rule between its rows", () => {
    // Six of these carried the app's divider weight — the diff files, checkpoints, checkouts, the
    // activity log, the settings rows and the engines — and every one of them sat on rows that
    // already separated themselves with a hover fill, a rounded row or plain spacing. A hairline on
    // top of that says the same thing twice, which is most of what made the app read as ruled.
    const offenders = RULES
      .filter((r) => drawsALine(r.body))
      .flatMap((r) => r.selectors)
      .filter((sel) => ADJACENT.test(sel));
    expect(offenders.sort()).toEqual([]);
  });

  it("a card of settings rows draws ONE line between two rows — the inset divider — not the row's own border as well", () => {
    /* Measured in the New space sheet and on Settings: the row above kept its full-width bottom
       border and the row below drew the inset divider straight under it, so every boundary was two
       lines, one of them running edge to edge. THE mutant drops the upper row's hand-over. */
    expect(bodiesFor(".settings-row").join(" ")).toContain("border: var(--hairline-w) solid var(--rl-card-rim)");
    expect(bodiesFor(".settings-row + .settings-row").join(" ")).toContain("border-top: 0");
    expect(bodiesFor(".settings-row:has(+ .settings-row)").join(" ")).toContain("border-bottom: 0");
    expect(bodiesFor(".settings-row + .settings-row::before").join(" ")).toContain("inset: 0 16px auto 16px");
  });

  it("the diff list draws a seam only under an OPEN file", () => {
    // The exception that proves the rule, and the reason the check above says "unconditional": an
    // expanded file's patch panel really would run into the next filename, so a seam there is doing
    // work rather than decorating. Between two collapsed rows it is not.
    expect(bodiesFor(".diff-file[data-open] + .diff-file").join(" ")).toContain("border-top: var(--hairline-w) solid");
  });

  it("no bar that merely sits ABOVE a pane's body rules a line across it", () => {
    /* The three that came out, and why the justification they carried was wrong.
       Each was defended as a scroll seam — "content scrolls beneath it" — and not one of them is
       sticky or absolutely positioned. They are `flex: none` rows above their pane's body, so the
       scrollers inside that body clip at their own top edge and nothing has ever passed under any of
       them. What the lines actually drew was a horizontal stripe across the top of every pane in
       every split.
       What separates a pane from what is AROUND it is untouched, and is asserted below. */
    for (const sel of [".panel-bar", ".browser-chrome"])
      expect(bodiesFor(sel).join(" "), sel).not.toMatch(/border-bottom: *1px/);
    // The claim is falsifiable, so it is checked: none of the three is sticky, which is the only way
    // content could pass under one.
    for (const sel of [".panel-bar", ".browser-chrome"])
      expect(bodiesFor(sel).join(" "), sel).not.toContain("position: sticky");
  });

  it("the seams INSIDE one surface, between a head or a field and the rows below it, are kept", () => {
    // A card's head over its body, and a popover's search field over its list. These separate two
    // different KINDS of thing sharing one surface, which is what a hairline is for.
    for (const sel of [".diff-head", ".fd-head", ".mp-search", ".spaces-search"])
      expect(bodiesFor(sel).join(" "), sel).toMatch(/border-bottom: var\(--hairline-w\) solid/);
    /* `.palette-input` left that list. The rule is for a seam between two different KINDS of thing
       sharing a surface; a search field over its own results is a search and its results, and the
       line between them was the divider this app spent a pass removing everywhere else. */
    expect(bodiesFor(".palette-input").join(" ")).not.toMatch(/border-bottom/);
    // `.md-code-head` is deliberately NOT in that list any more. The rule above is for a seam
    // between two different KINDS of thing sharing a surface; a code block's head holds the
    // language label and the copy control, which are chrome FOR the code rather than a section
    // beside it. Ruling them apart drew a line across a panel with one thing in it.
    expect(bodiesFor(".md-code-head").join(" ")).not.toMatch(/border-bottom: var\(--hairline-w\) solid/);
    /* Same reading, two more bars that lost theirs: a page overlay's bar and the terminal dock's
       hold the thing's own name (the dock's, the control that closes it too) — chrome FOR the surface
       below, not a section beside it. Each page also opens with its own heading, so the rule was a
       second edge under a title that already had one. */
    for (const sel of [".page-overlay-bar", ".terminal-dock-bar"])
      expect(bodiesFor(sel).join(" "), sel).not.toMatch(/border-bottom/);
    // Footers hold their place while the body scrolls past them.
    for (const sel of [".permission-footer", ".question-footer", ".spaces-foot", ".mp-foot"])
      expect(bodiesFor(sel).join(" "), sel).toMatch(/border-top: var\(--hairline-w\) solid/);
    // A table's rules ARE its structure, and the sidebar's edge is the app's one column boundary.
    expect(bodiesFor(".md th").join(" ")).toContain("border-bottom: var(--hairline-w) solid");
    expect(bodiesFor(".usage-table th").join(" ")).toContain("border-bottom: var(--hairline-w) solid");
    /* The sidebar's rule is gone with the edge it divided. It was a full-height column flush to the
       window with a line down its right side — the shape of a panel bolted on. It floats now, inset
       and rounded all the way round, and a detached surface separates itself. */
    /* The rule stays gone — a change of surface is the boundary. The INSET came back off: a sidebar
       floating inside the frame leaves a strip of window down its left edge, which reads as a gap
       rather than as depth. It is the app's own edge, not a card on a page. That inset moved to the
       summary panel, which genuinely is a card over a page. */
    const sidebar = bodiesFor(".sidebar").join(" ");
    expect(sidebar).not.toContain("border-right");
    expect(sidebar).not.toContain("margin: var(--sidebar-inset)");
    // On `.pane-dock` now, which every docked panel wears — the inset belongs to the CARD, and
    // enumerating it per panel is how the terminal dock shipped flush to the pane's edges.
    expect(bodiesFor(".pane-dock").join(" ")).toContain("margin: var(--sidebar-inset)");
  });

  /* The bug this pins: the card look was enumerated by panel name, so the terminal dock — which
     carries `.pane-dock` like the other two — shipped with no surface, no inset, no corner and no
     shadow, and read as a bare rectangle floating over the transcript. Keyed on the shared class,
     a fourth panel gets the card for free instead of hitting the same wall. */
  it("every docked panel gets the card from the class they all share, not from its own name", () => {
    const card = bodiesFor(".pane-dock").join(" ");
    expect(card).toContain("background: var(--surface)");     // the thing you could see through
    expect(card).toContain("margin: var(--sidebar-inset)");   // flush to the pane edge without it
    expect(card).toContain("border-radius: var(--r-float)");  // square corners without it
    expect(card).toContain("corner-shape: squircle");
    expect(card).toContain("box-shadow: var(--shadow-overlay)");
    // And no panel may re-declare the card under its own name, which is how the three drift apart.
    for (const sel of [".session-summary", ".subagent-dock", ".terminal-dock"])
      expect(bodiesFor(sel).join(" "), sel).not.toContain("background: var(--surface)");
  });

  it("the terminal dock clips its shell to the card, and rules nothing off under its title", () => {
    const dock = bodiesFor(".terminal-dock").join(" ");
    // Without this the pty paints a square straight over the corners the card just rounded.
    expect(dock).toContain("overflow: hidden");
    // A shell's own height along the pane's foot, not its content's: a dock that grew as output
    // scrolled would move the window being typed into.
    expect(dock).toContain("height: var(--terminal-dock-h)");
    /* No seam between the title and the shell it names. The bar is chrome FOR the terminal, not a
       section beside it — the same reason `.md-code-head` left the divider list above. */
    expect(bodiesFor(".terminal-dock-bar").join(" ")).not.toMatch(/border-bottom/);
  });

  it("the summary panel is as tall as its content, capped at the pane — never the pane's height", () => {
    /* It used to take `height: rect.height` from the component, so a summary of three short rows drew
       a column of empty surface the height of the window. The cap is the pane height the component
       measures; the inset it has to leave at both ends is the panel's own margin, so the arithmetic
       stays with the margin rather than being written a second time in TSX. */
    const panel = bodiesFor(".session-summary").join(" ");
    expect(panel).toContain("max-height: calc(var(--dock-pane-h, 100vh) - var(--sidebar-inset) * 2)");
    expect(panel, "a height here is the full-height panel again").not.toMatch(/(^|[; ])height:/);
    /* `flex: 0 1 auto`, never `flex: 1`. A basis of zero makes the scroller claim whatever height the
       panel has, which fills the pane by another route and scrolls a list that fits. */
    const wrap = bodiesFor(".summary-scroll-wrap").join(" ");
    expect(wrap).toContain("flex: 0 1 auto");
    expect(wrap).toContain("min-height: 0");
    /* The depths hang off the WRAPPER and the dissolve belongs to the scroller inside it. The panel's
       head is not in the scroller, so nothing can dissolve a title — which is what a band pinned to
       the panel did. Both occupants of the dock are checked: the sub-agent panel shares this
       geometry, and a copy of it that reached for the panel would fail here. */
    expect(wrap).toContain("--fade-h");
    expect(wrap).toContain("--fade-top-h");
    expect(bodiesFor(".subagent-scroll-wrap").join(" ")).toContain("--fade-h");
    expect(RULES.filter((r) => r.selectors.some((sel) => sel.includes(".edge-fade"))), "the bands are gone").toEqual([]);
  });

  it("a docked panel arrives from the edge it docks to and never past it — its travel is the gap it rests at", () => {
    /* The summary came in from 12px out to rest 8px in, so its first frames hung 4px past the window's
       edge, and a window that could not run the animation left it there (new-surfaces-live measured
       the panel at 1404 in a 1400px window). THE mutant: any travel wider than the inset — the
       terminal dock rises from the foot by the same rule. */
    expect(bodiesFor(".pane-dock").join(" ")).toContain("margin: var(--sidebar-inset)");
    expect(blockAfter("@keyframes rl-summary-in")).toMatch(/from \{ translate: var\(--sidebar-inset\) 0;/);
    expect(blockAfter("@keyframes rl-dock-up")).toMatch(/from \{ translate: 0 var\(--sidebar-inset\);/);
  });

  it("\"this icon button is on\" has ONE appearance, whichever attribute carries it", () => {
    /* Two rules used to say it: `.icon-btn[aria-pressed=\"true\"]` for Bold and ⌘J, and a bespoke
       `.summary-btn[data-on]` on a different token for the summary toggle. Which attribute a toggle
       takes is a fact about its accessible NAME — `aria-pressed` where the name holds still, `data-on`
       where it flips to name the next action — and a difference in the name may not become a
       difference in the fill. `.browser-pick` stays the one deliberate exception, and says why. */
    const on = RULES.filter((r) => r.selectors.some((sel) => sel === '.icon-btn[aria-pressed="true"]' || sel === ".icon-btn[data-on]"));
    expect(on.flatMap((r) => r.selectors)).toEqual(['.icon-btn[aria-pressed="true"]', ".icon-btn[data-on]"]);
    expect(on[0]!.body).toContain("background: var(--hover-2)");
    // Nothing re-states it for one toggle. The old `.summary-btn` rule is gone with its class.
    expect(RULES.flatMap((r) => r.selectors).filter((sel) => sel.includes("summary-btn"))).toEqual([]);
  });

  it("the two option lists in the transcript separate their rows the same way", () => {
    // A permission and a question are the same card asking a different question; one of them used to
    // rule its rows and the other did not.
    for (const sel of [".permission-options", ".question-options"])
      expect(bodiesFor(sel).join(" "), sel).toContain("gap: 1px");
  });
});

describe("squircle surfaces", () => {
  const tokens = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8");
  const worklet = readFileSync(repoFile("apps/desktop/src/renderer/public/squircle-paint.js"), "utf8");
  const registrar = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/squircle.ts"), "utf8");
  const SURFACES = [".composer", ".composer-drop-hint", ".composer-todos", ".composer-overstrip", ".composer-understrip", ".install-card", ".commit-card"];
  /** The cards that cast a lift from a layer of their own. */
  const LIFTED = [".composer", ".install-card", ".commit-card"];

  it("every squircle surface keeps a circular-corner fallback AND the declarative form", () => {
    // `corner-shape` is a no-op on Chromium 138 (measured in squircle-live.mjs) and takes over at
    // 139. Dropping either half strands the app: without `border-radius` a failed worklet load
    // renders a square card, without `corner-shape` the upgrade brings nothing.
    for (const sel of SURFACES) {
      const body = bodiesFor(sel).join(" ");
      expect(body, sel).toContain("corner-shape: squircle");
      expect(body, sel).toMatch(/border-radius:/);
    }
  });

  it("the painted treatment is gated on the mark theme/squircle.ts only sets once the worklet loaded", () => {
    // `paint()` with no registered painter resolves to nothing, so a card that opted in before the
    // module arrived would render as an invisible box. The gate is what makes that unreachable.
    // A card that casts a lift paints its face on its ::after instead of on itself (see below).
    for (const sel of SURFACES) {
      const body = bodiesFor(`:root[data-squircle] ${sel}`).join(" ");
      const face = LIFTED.includes(sel) ? bodiesFor(`:root[data-squircle] ${sel}::after`).join(" ") : body;
      expect(face, sel).toContain("background: paint(rl-squircle)");
      // The background painting area is clipped by the radius, and a superellipse sits FURTHER into
      // the corner than the arc of the same radius — left in place it shaves the painted corner
      // straight back into the rounded rect this replaces.
      expect(body, sel).toContain("border-radius: 0");
    }
    expect(registrar).toContain('root.setAttribute("data-squircle", "")');
  });

  it("the ring AND the lift both come off box-shadow — neither can be drawn from the border box", () => {
    // Both are drawn from the rounded rect whatever the fill does, so under the gate — where the
    // radius is 0 — box-shadow squares them off. The ring squares the corner outright; the lift
    // landed as a detached square band beside the card, measured 6px wide at --r-squircle: 36px.
    // The lift's old home was defended as "blurred wider than the two curves diverge", which held
    // while the radius was 20 and stopped holding when it grew.
    //
    // The lift rides a ::before rather than the card because a filter on the card promotes it to its
    // own layer, and the worklet then stops repainting when --sq-ring changes — focus silently stops
    // brightening the edge. squircle-live.mjs is what catches that; this only pins where it lives.
    for (const sel of [".composer", ".commit-card"]) {
      expect(bodiesFor(`:root[data-squircle] ${sel}`).join(" "), sel).toContain("box-shadow: none");
      expect(bodiesFor(`:root[data-squircle] ${sel}::before`).join(" "), sel).toContain("filter: var(--shadow-card-lift-filter)");
      const focus = bodiesFor(`:root[data-squircle] ${sel}:focus-within`).join(" ");
      expect(focus, sel).toContain("--sq-ring: var(--line-strong)");
      expect(focus, sel).not.toContain("0 0 0 1px");
    }
    expect(bodiesFor(":root[data-squircle] .composer[data-dropping]").join(" ")).toContain("--sq-ring: var(--rl-accent)");
  });

  it("a lifted card's shadow is under its face — both are children, ordered, in the card's own stacking context", () => {
    /* A negative-z child of a stacking context paints ABOVE that element's own background, never
       below it. With the face on the card's background the lift layer sat on top of it: its fill
       covered all but the card's outer 2px, and its shadow darkened those 2px into a second edge
       inside the ring — measured 8 luminance levels darker than the fill beside it, and wider at the
       corners. THE MUTANTS: paint the face on the card again (its background), put the lift above the
       face, or leave a card without the stacking context its two layers are ordered in. */
    for (const sel of LIFTED) {
      const card = bodiesFor(`:root[data-squircle] ${sel}`).join(" ");
      expect(card, sel).toContain("background: none");
      const lift = bodiesFor(`:root[data-squircle] ${sel}::before`).join(" ");
      const face = bodiesFor(`:root[data-squircle] ${sel}::after`).join(" ");
      expect(lift, sel).toContain("z-index: -2");
      expect(face, sel).toContain("z-index: -1");
      // The face covers the whole card, ring included; the lift may sit inside it, since only its
      // shadow beyond the face is ever seen.
      expect(face, sel).toContain("inset: 0");
      // The face is driven by the card's own state rules, so it takes every input the painter reads.
      for (const input of ["--sq-fill", "--sq-ring", "--sq-ring-w", "--sq-ring-open", "--sq-radius-top", "--sq-radius-bottom", "--sq-n"]) {
        expect(face, `${sel} ${input}`).toContain(`${input}: inherit`);
      }
      const context = [...bodiesFor(sel), card].join(" ");
      expect(context, `${sel} orders its layers in a context of its own`).toMatch(/z-index: 1|isolation: isolate/);
      expect(context, `${sel} places its layers against itself`).toContain("position: relative");
    }
  });

  it("--shadow-card is composed from the ring and the lift, in both modes", () => {
    // The squircle surfaces need the two halves apart; every other card wants the whole stack. One
    // definition of each half, and the composite built from them, is what stops the two drifting.
    // Twice: once per mode. (A third `--shadow-card:` exists in `@theme inline`, which only re-exports
    // the token to Tailwind and states no value of its own.)
    const composed = /--shadow-card: 0 0 0 var\(--hairline-w\) var\(--card-ring\), var\(--shadow-card-lift\)/g;
    expect(tokens.match(composed) ?? []).toHaveLength(2);
    for (const half of ["--card-ring", "--shadow-card-lift"]) {
      expect(tokens.match(new RegExp(`${half}:`, "g")) ?? [], half).toHaveLength(2);
    }
  });

  it("the stylesheet, the painter and the registrar agree on every name they pass between them", () => {
    // All three failures here are silent. A renamed painter leaves `paint()` resolving to nothing; an
    // input the worklet does not declare is never read, so the corner quietly keeps its last value;
    // an unregistered property arrives as its raw token stream — `calc(16px + 4px)` — which canvas
    // cannot parse into a length.
    expect(worklet).toContain('registerPaint(\n  "rl-squircle"');
    const declared = new Set([...worklet.matchAll(/"(--sq-[a-z-]+)"/g)].map((m) => m[1]!));
    const registered = new Set([...registrar.matchAll(/name: "(--sq-[a-z-]+)"/g)].map((m) => m[1]!));
    const used = new Set([...css.matchAll(/(--sq-[a-z-]+)\s*:/g)].map((m) => m[1]!));
    expect([...used].filter((n) => !declared.has(n)).sort(), "set in styles.css, not read by the worklet").toEqual([]);
    expect([...used].filter((n) => !registered.has(n)).sort(), "set in styles.css, never registered").toEqual([]);
  });
});

/** Light mode is a real mode, not a filter over the dark one. These pin the colours that were being
 *  written as dark-tuned literals in `styles.css` — one layer below the token ramps, where a sweep of
 *  tokens.css cannot see them — and, just as importantly, the ones that deliberately do NOT flip. */
/* The owner's report: the band behind the address field and the arrows was a different colour from
   the rest of the browser pane, and both from the session pane. The pane's chrome paints nothing, so it
   is the session pane's ground; the view's host painted the opaque panel tone under a new tab and round
   a device box, which beside the translucent band read as a lighter strip. THE mutants: a `background`
   back on the host's own rule, or on the chrome. Only the page's white, and only while the page shows. */
describe("the browser pane is one ground", () => {
  it("paints nothing behind its chrome or in the view's rectangle, but the page's white while a page shows", () => {
    for (const sel of [".browser-pane", ".browser-chrome", ".browser-view-host", ".new-tab", ".browser-error", ".browser-connecting"]) {
      for (const body of RULES.filter((r) => partsOf(r).includes(sel)).map((r) => r.body)) expect(body, sel).not.toMatch(/(^|;|\s)background(-color)?:/);
    }
    const painted = RULES.filter((r) => /(^|;|\s)background(-color)?:/.test(r.body)).flatMap(partsOf).filter((s) => s.includes(".browser-view-host"));
    // Not while the window's toasts hold the view's foot either: the strip it gives up is the ground.
    expect(painted).toEqual([".browser-view-host[data-page]:not([data-device]):not([data-yielded])"]);
  });
});

describe("light mode", () => {
  const tokens = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8");
  const lightBlocks = [...tokens.matchAll(/:root\[data-mode="light"\]\s*\{([^}]*)\}/g)].map((m) => m[1]!).join("\n");

  /** Black or white written literally, in either the comma or the space syntax. */
  const RAW_INK = /rgba?\(\s*(?:0[\s,]+0[\s,]+0|255[\s,]+255[\s,]+255)[\s,/)]|(?<![\w-])#(?:fff|ffffff)(?![\w-])/i;
  /** Every rule allowed to write one, and the reason it is not the theme's to flip. */
  const NOT_THE_THEMES_TO_FLIP = new Map([
    // Drawn on a video frame or a photo the user supplied. The picture is the same picture in both
    // modes, so chrome over it answers to the picture.
    [".media-play", "on a video frame"], [".media-play:hover", "on a video frame"],
    [".media-controls", "on a video frame"], [".media-btn:hover", "on a video frame"],
    [".media-scrub", "on a video frame"], [".media-scrub::-webkit-slider-thumb", "on a video frame"],
    [".attach-tile[data-image] .attach-ext", "on the attached picture"],
    // The Library tile's caption, which comes up over the file's own picture.
    [".library-tile-caption", "on the file's own picture"],
    /* A switch knob is white in both modes, the way it is on every platform that has one. It used to
       take `--surface`, which flips — so in dark mode the OFF state was a dark dot on a light track,
       backwards from every switch a person has ever used, and the ON state was a dark dot on the
       accent. The knob answers to the track it rides, not to the page behind it. */
    [".switch::after", "a switch knob is white on both faces"],
    // The slider's handle is the switch's knob, for the same reason and with the same answer: two
    // round controls a few rows apart must not disagree about what a handle looks like.
    ['.slider-row input[type="range"]::-webkit-slider-thumb', "the same knob the switch wears"],
    // …and so is the knob on the model picker's effort track, which is a slider in all but element.
    [".mp-track-knob", "the same knob the switch wears"],
    [".attach-remove", "on the attached picture"], [".attach-remove:hover", "on the attached picture"],
    // An element's name, drawn over the DEVICE's own screen — whatever the simulator is showing is
    // the same in both modes, so the halo that keeps the name legible on it answers to the device.
    [".sim-ax-label", "on the device's own screen"],
    // Matching the native WebContentsView's own opaque white, so the sliver it trails during a
    // resize cannot flash the panel tone through the gap.
    [".browser-view-host[data-page]:not([data-device]):not([data-yielded])", "the browser view's own ground"],
    // White on a red fill, the same as white on the accent fill (--rl-accent-contrast), which is
    // deliberately one value for both modes.
    [".btn.destructive", "ink on a filled control"],
    // The stop square on the rail's recording light: white on the same red fill, for the same reason.
    [".rail-recording-stop", "ink on a filled control"],
    // The base half of a pair: the rule immediately below it flips the outline for light mode.
    [".md img", "paired with a light override"],
    // The base half of a pair, like `.md img` above it: a Quick Look render is a picture on the
    // pane's own ground, and the rule below flips its outline for light mode.
    [".ql-page", "paired with a light override"],
    // The picture on the page about you: a photo on the page's ground, paired the same way.
    ["img.avatar", "paired with a light override"],
    // The picture in the media viewer, on the viewer's own ground — paired the same way.
    [".media-viewer-img", "paired with a light override"],
  ]);

  it("no rule paints a raw black or white that the mode cannot reach", () => {
    // The failure is invisible from tokens.css: every ramp there flips correctly, and then a
    // component writes `rgba(0,0,0,.45)` one layer below it and never changes. Anything that
    // genuinely must not flip is either a named token now or listed above with its reason.
    const offenders = RULES
      .filter((r) => RAW_INK.test(r.body))
      .flatMap((r) => r.selectors)
      .filter((sel) => !sel.startsWith(':root[data-mode="light"]') && !NOT_THE_THEMES_TO_FLIP.has(sel));
    expect(offenders.sort()).toEqual([]);
  });

  it("every literal that is half a pair really does have its other half", () => {
    for (const sel of [".md img", ".ql-page", "img.avatar", ".media-viewer-img"]) {
      expect(bodiesFor(sel).join(" "), sel).toContain("outline: 1px solid rgba(255, 255, 255, 0.1)");
      expect(bodiesFor(`:root[data-mode="light"] ${sel}`).join(" "), sel).toContain("outline-color: rgba(0, 0, 0, 0.1)");
    }
  });

  it("the scrims are the one colour that has to differ per mode", () => {
    // A veil subtracts from what is behind it, so the same alpha over a near-white window is a much
    // heavier dim than over a dark one. Everything else here can be one value for both modes.
    for (const sel of [".sheet-backdrop", ".spaces-backdrop"]) expect(bodiesFor(sel).join(" "), sel).toContain("background: var(--scrim)");
    expect(bodiesFor(".palette-backdrop").join(" ")).toContain("background: var(--scrim-soft)");
    expect(lightBlocks).toContain("--scrim:");
    expect(lightBlocks).toContain("--scrim-soft:");
  });

  it("the colours that answer to something other than the theme are named, and stay put", () => {
    // Each of these is drawn ON something that is the same in both modes — a machine's dark letterbox,
    // or a picture the user attached — so a light override would be the bug. They are tokens rather
    // than literals precisely so that reading is available to the next sweep.
    for (const token of ["--rl-terminal-ink-dim", "--rl-on-media"])
      expect(lightBlocks, token).not.toContain(token);
    expect(bodiesFor(".machine-starting").join(" ")).toContain("color: var(--rl-terminal-ink-dim)");
    expect(bodiesFor(".attach-remove").join(" ")).toContain("color: var(--rl-on-media)");
    // Same case, one level up: a filled control's lit top edge. The fill under it is a saturated
    // accent in both modes and the light still comes from above.
    expect(lightBlocks).not.toContain("--fill-bevel");
    for (const sel of [".btn.primary", ".composer-send", ".btn.destructive"])
      expect(bodiesFor(sel).join(" "), sel).toContain("box-shadow: var(--fill-bevel)");
  });

  it("a file card set into the dock's raised surface takes the raised frame step, and light's is no weaker than dark's", () => {
    /* One card, two grounds. In the Library it is a tile raised off the canvas (--rl-tile), as Codex's
       are; in the Files dock it stands on --surface, where a lift off white is no step at all, so it
       takes the raised frame step instead — --rl-frame one rung off white measured 1.04:1 there, a
       card with no edge. THE MUTANTS: point the dock's card back at the Library's fill; drop the
       dock's hover (its fill then out-ranks the Library's `:hover`, and the card stops answering the
       pointer); or set the light value back up the ladder. */
    expect(bodiesFor(".library-tile").join(" ")).toContain("background: var(--rl-tile)");
    expect(bodiesFor(".session-files .library-tile").join(" ")).toContain("background: var(--rl-frame-raised)");
    expect(bodiesFor(".session-files .library-tile:hover").join(" ")).toContain("background: var(--rl-frame-raised-hover)");
    expect(bodiesFor(":root").join(" ")).toContain("--rl-frame-raised: var(--page)");

    /* The light value is a number chosen by measurement, so hold it to the measurement: against its
       own face's --surface, the light step is at least the dark one. For a neutral, OKLab's L is the
       cube root of relative luminance, which is all the WCAG ratio needs. */
    const lOf = (src: string, name: string): number => {
      const m = src.match(new RegExp(`(?<![\\w-])${name}:\\s*oklch\\(([\\d.]+)`));
      expect(m, `${name} as an oklch() value`).not.toBeNull();
      return Number(m![1]);
    };
    const ratio = (a: number, b: number) => (Math.max(a, b) ** 3 + 0.05) / (Math.min(a, b) ** 3 + 0.05);
    // Uncommented first: the file's own header names the light selector in prose.
    const plain = tokens.replace(/\/\*[\s\S]*?\*\//g, "");
    const darkTokens = plain.slice(0, plain.indexOf(':root[data-mode="light"]'));
    const lightResidue = bodiesFor(':root[data-mode="light"]').join(" ");
    const dark = ratio(lOf(darkTokens, "--surface"), lOf(darkTokens, "--page"));
    const light = ratio(lOf(lightBlocks, "--surface"), lOf(lightResidue, "--rl-frame-raised"));
    expect(dark).toBeGreaterThan(1.12);
    expect(light, `light ${light.toFixed(3)} against dark ${dark.toFixed(3)}`).toBeGreaterThanOrEqual(dark);
    // And the light hover is a step of its own, deeper still — THE MUTANT: a hover equal to rest,
    // which leaves a card that no longer answers the pointer and no rule anywhere that says so.
    const rest = lOf(lightResidue, "--rl-frame-raised");
    const hover = lOf(lightResidue, "--rl-frame-raised-hover");
    expect(hover).toBeLessThan(rest);
    expect(ratio(rest, hover)).toBeGreaterThanOrEqual(1.05);
  });

});

describe("§6 do-NOT-animate list", () => {
  it("never uses `transition: all` anywhere", () => {
    expect(css).not.toMatch(/transition:\s*all\b/);
    expect(css).not.toMatch(/transition-property:\s*all\b/);
  });

  it("the command palette opens and closes FAST — the ⌘K rule is about duration, not existence", () => {
    /* This used to pin the palette as un-animated, on the reasoning that ⌘K is a hundred-times-a-day
       action and nobody should wait on it. That reasoning was half right: the cost of an animation
       is its DURATION. At 100ms in and 80ms out nobody reads a delay, and the palette reads as
       arriving over the app rather than being teleported into it — which is what Raycast, the rule's
       own source, does.

       So the invariant becomes the one that actually protects the user: it may animate, but not for
       long, and the exit must be shorter than the enter (§6's rule for exits). */
    // Through LADDER, so the assertion is two facts: the rule reaches for a rung, and that rung is
    // still short. Pinning a literal here would make this the second place the number lives.
    const ms = (body: string): number => {
      const rung = body.match(/animation:\s*[a-z-]+\s+var\((--dur-[a-z]+)\)/)?.[1];
      return rung ? LADDER[rung] ?? 0 : 0;
    };
    const enter = ms(bodiesFor(".palette").join(" "));
    const exit = ms(bodiesFor(".palette-backdrop[data-closing]").join(" "));
    expect(enter, "the palette must animate at all now").toBeGreaterThan(0);
    expect(enter, "…but never long enough to be felt").toBeLessThanOrEqual(140);
    expect(exit, "exits are softer and shorter than enters").toBeLessThan(enter);
    // And the closing scrim stops taking clicks: it outlives its own state, and a click meant for
    // what is behind it must not land on a dialog the app already considers gone.
    expect(bodiesFor(".palette-backdrop[data-closing]").join(" ")).toContain("pointer-events: none");
  });

  it("the prompter's drop target is instant — §6 does not animate anything during an active drag", () => {
    for (const sel of [".composer[data-dropping]", ".composer-drop-hint"]) {
      for (const body of bodiesFor(sel)) {
        expect(body, `${sel} { ${body} }`).not.toContain("transition");
        expect(body, `${sel} { ${body} }`).not.toContain("animation");
      }
    }
    // …and the hint never eats the drop it is describing.
    expect(bodiesFor(".composer-drop-hint").join(" ")).toContain("pointer-events: none");
  });

  it("the pane divider rests on its own token, a step above the app's ordinary hairline", () => {
    /* Measured live (`pane-divider-live.mjs`): on --rl-line the whole separation between two panes
       came to 6.6% of full range in dark and 5.2% in light, and panes read as one wash. This is the
       one hairline with no change of surface beside it — `.main` and every `.panel` paint --rl-panel
       — so unlike every other line in the app it is doing the whole job alone.

       THE mutant: put `.resize-handle` back on --rl-line. It computes perfectly and the app looks
       like one continuous surface, which is exactly how this shipped. This test is the cheap half;
       the pixels are the real one. */
    const rest = bodiesFor(".resize-handle").join(" ");
    expect(rest).toContain("background: var(--rl-divider)");
    expect(rest).not.toContain("var(--rl-line)");
    // The divider is a control as well as a seam, so raising the resting line must not flatten the
    // drag feedback into it — the second mutant is dropping this rule once the first is loud enough.
    for (const sel of [".resize-handle:hover", ".resize-handle[data-resize-handle-active]"]) {
      expect(bodiesFor(sel).join(" "), sel).toContain("background: var(--rl-divider-hover)");
    }
  });

  it("the divider's two steps are ordered, and light is not a mirror of dark", () => {
    const tokens = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8");
    const stepOf = (block: string, name: string) =>
      Number(new RegExp(`--${name}: var\\(--overlay-(?:lighten|darken)-(\\d+)\\)`).exec(block)?.[1] ?? NaN);
    const dark = tokens.slice(tokens.indexOf("--line: var(--overlay-lighten-200)"));
    const light = tokens.slice(tokens.indexOf("--line: var(--overlay-darken-100)"));

    // Dragging is always a step above resting, in both faces.
    expect(stepOf(dark, "divider-hover")).toBeGreaterThan(stepOf(dark, "divider"));
    expect(stepOf(light, "divider-hover")).toBeGreaterThan(stepOf(light, "divider"));
    // And the divider is always above the ordinary hairline it used to be.
    expect(stepOf(dark, "divider")).toBeGreaterThan(stepOf(dark, "line"));
    expect(stepOf(light, "divider")).toBeGreaterThan(stepOf(light, "line"));

    /* Light takes a HEAVIER step than dark, which looks like an inconsistency and is not: black on a
       near-white ground loses more of itself than white on a near-black one. Mirroring dark's step
       measured 7.2% in light against dark's 10.7% — under the floor, which is how light shipped
       fainter than dark without anyone writing a different number. */
    expect(stepOf(light, "divider")).toBeGreaterThan(stepOf(light, "line-strong"));
  });

  /* A divider may FADE, but it may never ease into position.
     What this has always been protecting is the drag: a transition on anything that decides where
     the handle is puts the line behind the pointer that is dragging it, and the pane edge arrives
     after the mouse. That is a fact about geometry, not about the word "transition" — the hover
     highlight is an opacity on a pseudo-element, which paints and cannot move anything. So the rule
     is the same rule §6 states for every hover fill in the app (colour, never geometry), enforced
     here rather than restated: list what may be transitioned, and let the ban do the rest.
     `animation` stays out entirely; nothing on a control this direct should run on its own clock. */
  /* The kill that silently killed nothing.
     `*` is a type selector: it matches ELEMENTS, and a `::before` is not one. So `@media
     (prefers-reduced-motion: reduce) { * { transition: none } }` read like an app-wide guarantee and
     left every pseudo-element transition running — the switch knob's throw, the checkbox tick, both
     slider thumbs, the space strip's marker, the divider highlights. Caught in a real window under
     `Emulation.setEmulatedMedia`, where the media query matched and the computed duration on
     `.sb-resize::after` was still 180ms. This pins the selector list AND the reason it has to exist,
     so the day nothing transitions on a pseudo-element the test says so rather than passing. */
  it("stops motion on pseudo-elements too, where `*` alone never reached", () => {
    const pseudoTransitions = RULES.filter(
      (r) => /transition:\s*(?!none)/.test(r.body) && partsOf(r).some((s) => s.includes("::")),
    );
    expect(pseudoTransitions.length, "no pseudo-element transitions left — this guard is now moot")
      .toBeGreaterThan(0);

    for (const guard of [/@media \(prefers-reduced-motion: reduce\)/, /\[data-theme-switching\]/]) {
      const block = RULES.find((r) => r.body.includes("transition: none !important")
        && (guard.source.includes("reduced") ? partsOf(r).includes("*") : partsOf(r).some((s) => s.includes("data-theme-switching"))));
      expect(block, `no blanket transition kill for ${guard.source}`).toBeTruthy();
      const parts = partsOf(block!).join(" ");
      expect(parts, `${guard.source} kill skips ::before`).toContain("::before");
      expect(parts, `${guard.source} kill skips ::after`).toContain("::after");
    }
  });

  it("resize handles transition paint only — a drag must track the pointer exactly", () => {
    const PAINT = ["opacity", "background-color", "color"];
    for (const r of RULES.filter((x) => x.selectors.some((s) => s.startsWith(".resize-handle") || s.startsWith(".sb-resize")))) {
      const where = r.selectors.join(",");
      expect(r.body, where).not.toContain("animation");
      const transition = /transition:([^;}]*)/.exec(r.body);
      if (!transition) continue;
      const properties = transition[1]!.split(",").map((part) => part.trim().split(/\s+/)[0]!);
      for (const property of properties) expect(PAINT, `${where} transitions ${property}`).toContain(property);
    }
  });

  it("a disabled switch is visibly disabled, wherever it is nested", () => {
    // `.switch:checked` paints the accent at full strength, and `disabled` changes nothing else about
    // it — a dependent toggle would otherwise read as live and on. The only other disabled treatment
    // a switch can pick up is `.slider-row input:disabled`, which reaches the one switch that happens
    // to sit inside a slider row and no other.
    expect(bodiesFor(".switch:disabled").join(" ")).toContain("opacity: .45");
  });

  it("the focused-pane marks are instant — §6 does not animate pane focus switching", () => {
    // The underline, the inked header icon and the empty-leaf top rule all move when focus moves.
    const focusRules = RULES.filter((x) => x.selectors.some((s) => /^\.panel(\[data-focused\]|-title|-icon)/.test(s)));
    expect(focusRules.length).toBeGreaterThanOrEqual(3);
    for (const r of focusRules) expect(r.body, r.selectors.join(",")).not.toContain("transition");
  });

  it("a theme swap is fenced by a root mark that kills every transition (useTheme sets it)", () => {
    expect(bodiesFor(":root[data-theme-switching] *").join(" ")).toContain("transition: none !important");
  });

  it("prefers-reduced-motion strips every animation and transition, and hides the spinner", () => {
    const reduced = blockAfter("@media (prefers-reduced-motion: reduce)");
    expect(reduced).toContain("animation: none !important");
    expect(reduced).toContain("transition: none !important");
    expect(reduced).toContain(".spinner { display: none; }");
  });
});

/** The three layout regressions the space page and the icon picker shipped with. All of them are
 *  invisible to the rest of the suite for the same reason §6's motion table is — jsdom has no
 *  layout — so the guard has to be against the declarations themselves. */
describe("row and control layout", () => {
  it("a button lays its glyph and label out as a centered row that cannot wrap or shrink", () => {
    // `.btn` was `display: block`: an icon-plus-label button ("+ New session", "Generate") put its
    // glyph on the baseline with only a JSX whitespace node for spacing, and shrank under its own
    // label until the text wrapped out of the fixed 30px box.
    const btn = bodiesFor(".btn").join(" ");
    expect(btn).toContain("display: inline-flex");
    expect(btn).toContain("align-items: center");
    expect(btn).toContain("gap:");
    expect(btn).toContain("white-space: nowrap");
    expect(btn).toContain("flex-shrink: 0");
  });

  it("a space's folder path takes the room it is given and asks for none, so it cannot widen the page around it", () => {
    /* One unbroken line of unbounded length: measured into first run's `1fr` tracks, the default
       location's path widened the whole page past a 520px window and un-stacked the agent cards
       (onboarding-live.mjs). THE mutant drops the containment — `min-width: 0` alone only lets a flex
       item shrink; it still reports the whole path as its intrinsic width. */
    for (const sel of [".space-folder-path", ".space-folder-made"]) {
      const body = bodiesFor(sel).join(" ");
      expect(body, sel).toContain("contain: inline-size");
      expect(body, sel).toContain("text-overflow: ellipsis");
      expect(body, sel).toMatch(/flex: 1/);
    }
  });

  it("a page row has exactly one elastic column, so its trailing metadata forms a straight edge", () => {
    // The bug: `.page-row-dim` and `.item-status` both carried `margin-left: auto`, which splits the
    // leftover space between them — every row parked its timestamp at a different x. The title grows
    // instead, and nothing after it may claim free space.
    const title = bodiesFor(".page-row-title").join(" ");
    expect(title).toMatch(/flex: 1|flex-grow: 1/);
    expect(title).toContain("min-width: 0");
    for (const sel of [".page-row-dim", ".page-row-dim + .page-row-dim"]) {
      for (const body of bodiesFor(sel)) expect(body, `${sel} { ${body} }`).not.toContain("margin-left: auto");
    }
    // …and the leading glyph is not a shrinkable column either: it went sub-pixel on narrow panes.
    expect(bodiesFor(".page-row > svg").join(" ")).toContain("flex: none");
  });

  it("a sidebar row's state and its actions share one slot at the far end", () => {
    /* The actions sat after the row at opacity 0 — hidden, but still taking ~50px of every row's
       title and parking the state in the middle of the line. THE MUTANTS: put the actions back in the
       flow, leave the state on screen under the buttons, or reveal on `:focus-within`, which a click
       satisfies — the row just opened would show its buttons instead of its state. */
    const actions = bodiesFor(".item-actions").join(" ");
    expect(actions).toContain("position: absolute");
    expect(actions).toContain("opacity: 0");
    expect(actions).toContain("pointer-events: none");
    for (const when of [":hover", ":has(:focus-visible)", ":has([data-confirming])"]) {
      expect(bodiesFor(`.item${when} .item-actions`).join(" "), when).toContain("opacity: 1");
      expect(bodiesFor(`.item${when} .item-trail`).join(" "), when).toContain("display: none");
      expect(bodiesFor(`.item${when} .item-row`).join(" "), when).toContain("padding-right:");
    }
    expect(css).not.toMatch(/\.item:focus-within \.item-actions/);
    // The title gives way by the actions' width, so a row with two takes more than a row with one.
    const one = parseFloat(/padding-right: ([\d.]+)px/.exec(bodiesFor(".item:hover .item-row").join(" "))![1]!);
    const two = parseFloat(/padding-right: ([\d.]+)px/.exec(bodiesFor('.item[data-actions="2"]:hover .item-row').join(" "))![1]!);
    expect(two - one).toBe(24);
    // No button reserves its own width any more: the slot is the overlay's.
    expect(bodiesFor(".item-close, .item-shelf, .item-delete".split(", ")[0]!).join(" ")).not.toContain("opacity: 0");
  });

  it("a row with no actions keeps its state under the pointer, and gives its title nothing", () => {
    /* The cross-room rows — a session drawn outside its room, a room with nothing to unfold — have no
       action to show, and W1's rule would still hide their state and pad their title for one. THE
       MUTANT is dropping this pair: the dot vanishes under the pointer for a slot with nothing in it. */
    for (const when of [":hover", ":has(:focus-visible)"]) {
      expect(bodiesFor(`.item[data-actions="0"]${when} .item-trail:not(:empty)`).join(" "), when).toContain("display: flex");
      expect(bodiesFor(`.item[data-actions="0"]${when} .item-row`).join(" "), when).toContain("padding-right: 8px");
    }
    // The resting inset is the same 8px, so a row with nothing to offer does not move at all.
    expect(bodiesFor(".item-row").join(" ")).toContain("padding: 5px 8px");
    // The disclosure is one of the row's own controls: the same box, the same hit area, the same hover.
    expect(bodiesFor(".item-disclose").join(" ")).toContain("width: 22px");
    expect(bodiesFor(".item-disclose::after").join(" ")).toContain("inset: -6px");
    expect(bodiesFor('.item-disclose[aria-expanded="true"] svg').join(" ")).toContain("rotate(90deg)");
  });

  it("the sidebar's list is headed by a caption and a switch, not a segmented control across the column", () => {
    /* The owner, 10-04: "The tabs between spaces and recent should be removed. It should just have a
       smaller subsection title that says spaces, then all the way to the right a button with an
       activity icon". The caption is in the column's section-label voice — the size, weight and ink
       "Pinned" wears. THE mutants: the old `.seg` track back, or a caption louder than the labels
       around it. */
    expect(RULES.filter((r) => r.selectors.some((sel) => sel.startsWith(".sb-lens") && /seg/.test(sel)))).toEqual([]);
    const title = bodiesFor(".sb-lens-title").join(" ");
    const label = bodiesFor(".group-label").join(" ");
    for (const part of ["font-size: 13px", "font-weight: var(--fw-medium)", "color: var(--rl-text-faint)"]) {
      expect(label, part).toContain(part);
      expect(title, part).toContain(part);
    }
  });

  it("a cross-space row's space name keeps its width, and the title is what gives way", () => {
    /* design.md's yielding order: the title is unbounded and takes the slack; the space's name is
       reserved up to a cap. THE MUTANT is letting the name shrink as well — two shrinking items share
       the shortfall, and a four-letter space comes out as "L." beside a title with room to spare. */
    const where = bodiesFor(".item-where").join(" ");
    expect(where).toContain("flex: none");
    expect(where).toMatch(/max-width: \d+px/);
    expect(where).toContain("text-overflow: ellipsis");
    expect(bodiesFor(".item-title").join(" ")).toContain("flex: 1");
  });

  it("the Tasks lens wraps rather than clipping: both columns shrink, neither is fixed-width", () => {
    // The same failure one level down. A fixed-width detail panel beside a flexing list overflowed
    // `.page-content` in any split layout; `flex: 1 1 <basis>` on both lets the panel drop under the
    // list instead. A `flex: none` or bare `width` on the panel is the regression.
    const detail = bodiesFor(".task-detail").join(" ");
    expect(detail).toContain("flex: 1 1");
    expect(detail).toContain("min-width: 0");
    expect(detail).not.toContain("flex: none");
    expect(bodiesFor(".task-lens").join(" ")).toContain("flex-wrap: wrap");
    expect(bodiesFor(".task-lens-list").join(" ")).toContain("flex: 1 1");
  });

  it("a busy control keeps its fill — only a nothing-to-do control is greyed out", () => {
    // `.btn.primary:disabled` is written for "there is nothing to commit"; applied to "Generating…"
    // it erased the button under the press that started the work.
    const busy = bodiesFor('.btn.primary:disabled[aria-busy="true"]').join(" ");
    expect(busy).toContain("--fill: var(--rl-accent)");
    expect(bodiesFor('.btn:disabled[aria-busy="true"]').join(" ")).toContain("opacity: .7");
    // The distinction only exists if the plain disabled treatment is still the dimmer one.
    expect(bodiesFor(".btn.primary:disabled").join(" ")).toContain("--fill: var(--rl-raised)");
    expect(bodiesFor(".btn:disabled").join(" ")).toContain("opacity: .45");
  });
});

/** The page measure. Where a column actually LANDS is settled by scripts/page-measure-live.mjs, which
 *  measures the real rects at seven pane widths — jsdom has no layout, so to it `margin-inline: auto`
 *  is a declaration that parses and nothing more. What is checkable here is the arithmetic: that each
 *  page shape is capped at what that shape's own parts add up to, read from the rules that state
 *  those parts, so a drift in either place fails. */
describe("no header is pinned", () => {
  it("nothing is sticky but a long table's column heads and a code block's line numbers", () => {
    /* The owner, 10-05: "the header shouldn't be sticky at all". A page's head is in its column and
       scrolls with it (page-heads.test.tsx mounts every page to hold that). Two pins stay, each a
       thing read ACROSS while it scrolls rather than a header over a page: a markdown table's heads,
       which name the columns of the rows passing under them, and a code block's numbers, which stay
       beside the lines they count while the code scrolls sideways. THE mutant: `position: sticky` on
       anything else. */
    const pinned = RULES.filter((r) => /position:\s*sticky/.test(r.body)).flatMap(partsOf).sort();
    expect(pinned).toEqual([".code-gutter", ".md thead th"]);
  });
});

describe("the page measure", () => {
  /** A declaration from the first rule that states it for `sel` — the base rule, which the narrow
   *  container block further down the file overrides rather than replaces. */
  function decl(sel: string, prop: string): string {
    for (const body of bodiesFor(sel)) {
      const m = body.match(new RegExp(`(?:^|;\\s*)${prop}:\\s*([^;]+)`));
      if (m) return m[1]!.trim();
    }
    throw new Error(`no ${prop} on ${sel}`);
  }
  const px = (v: string): number => Number(v.match(/(\d+(?:\.\d+)?)px/)?.[1] ?? NaN);

  const GUTTER = px(decl(".page-body", "padding").split(" ")[1]!);
  /* The rail's width and the gap beside it are variables now, because the header's indent is
     computed from both and a literal in either place would let the two drift. Read from the
     declaration rather than the use, so this still measures what the layout actually uses. */
  const pageVar = (name: string): number => px(decl(".page", name));
  const GAP = pageVar("--page-rail-gap");
  const RAIL = pageVar("--page-rail-w");
  const COLUMN = px(decl(".page-content", "max-width"));
  const LENS = px(decl(".task-lens", "max-width"));

  /** Every `--page-measure` in the stylesheet, by the selector that sets it. */
  const MEASURES = new Map(RULES
    .filter((r) => /--page-measure:/.test(r.body))
    .map((r) => [r.selectors.join(", "), px(r.body.match(/--page-measure:\s*([^;]+)/)![1]!)]));
  const measure = (sel: string): number => {
    expect(MEASURES.get(sel), `no --page-measure on \`${sel}\``).toBeGreaterThan(0);
    return MEASURES.get(sel)!;
  };

  it("the head stands in the column it names, so it takes no indent — and the rail starts level with its band", () => {
    /* The head is the column's first child now (PageScroll), so it starts where the content does by
       construction, and an indent written for the head ABOVE the column would push it past the
       content it names. THE mutants: an indent back on the head, or the rail left at the body's top
       edge, a whole title band above the head beside it. The band is one variable, so the two cannot
       drift. */
    expect(decl(".page-head", "padding")).toBe("var(--page-head-top) 0 18px");
    const indented = RULES.filter((r) => r.selectors.some((s) => /\.page-head$/.test(s)) && /padding-(left|inline)/.test(r.body));
    expect(indented).toEqual([]);
    expect(decl(".page-body > .page-rail", "margin-top")).toBe("var(--page-head-top)");
    expect(decl(".page-rail", "width")).toBe("var(--page-rail-w)");
    expect(decl(".page-body", "gap")).toBe("var(--page-rail-gap)");
  });

  it("rail and column are ONE centred block, and the head rides in the column — the title stays over what it introduces", () => {
    // The mutant: centre the column alone. The rail would stand at the pane's left edge beside a
    // column in the middle of it, belonging to neither.
    const band = RULES.filter((r) => r.selectors.includes(".page-body") && r.body.includes("margin-inline: auto"));
    expect(band).toHaveLength(1);
    expect(band[0]!.selectors).not.toContain(".page-head");
    // The load-bearing one: an auto cross-axis margin switches a flex item's stretch OFF, so without
    // an explicit width each band shrinks to fit its own longest line instead of filling the cap.
    expect(band[0]!.body).toContain("width: 100%");
    expect(band[0]!.body).toContain("max-width: var(--page-measure)");
  });

  it("each shape is capped at what ITS parts add up to, never at a number typed in twice", () => {
    // Bare column, column beside the rail, and the Tasks lens beside the rail. Change `.page-rail`'s
    // width or `.page-content`'s measure and the cap that no longer matches fails here.
    expect(measure(".page")).toBe(GUTTER * 2 + COLUMN);
    expect(measure(".page:has(.page-rail)")).toBe(GUTTER * 2 + RAIL + GAP + COLUMN);
    expect(measure(".page:has(.page-content[data-wide])")).toBe(GUTTER * 2 + RAIL + GAP + LENS);
  });

  it("the Tasks tab, which matches two of them, takes the wider", () => {
    // The space page has a rail AND a wide content, so both selectors hit it; `[data-wide]` is what
    // makes the wider one win. Losing that is a lens squeezed into the reading measure.
    expect(measure(".page:has(.page-content[data-wide])"))
      .toBeGreaterThan(measure(".page:has(.page-rail)"));
  });

  it("no cap can bind inside the narrow pass, so the two never fight", () => {
    // Every measure is wider than the widest pane the responsive rules claim (the notifications
    // split's 760). Below them a page is full-bleed and the cap is inert; above them nothing
    // re-flows. A measure that fell between would centre a page that was busy standing itself up.
    expect(MEASURES.size, "no --page-measure rules found — the sweep below would pass vacuously")
      .toBeGreaterThanOrEqual(3);
    for (const [sel, value] of MEASURES) expect(value, sel).toBeGreaterThan(760);
  });

  it("the rail's two lists lie down with the rail, and the gap between them outranks the gap inside", () => {
    /* The rail turns into a horizontal strip under 640px. THE MUTANT: leave `.page-rail-list` a
       column there and the strip becomes two short stacks side by side, which reads as a layout
       accident rather than as one row of destinations. */
    const narrow = css.indexOf(".page-rail-list { flex-direction: row");
    const base = css.indexOf(".page-rail-list { display: flex; flex-direction: column");
    expect(base).toBeGreaterThan(-1);
    expect(narrow).toBeGreaterThan(base); // and inside the container query, which follows it
    // Rows inside a list sit on the rail's own 2px; the lists themselves are further apart, or the
    // two questions read as one list with a heading dropped into the middle of it.
    expect(decl(".page-rail-list", "gap")).toBe("2px");
    expect(decl(".page-rail:has(.page-rail-list)", "gap")).toBe("16px");
    // The old chip strip is gone from the page's band rule, and from the stylesheet entirely.
    expect(css).not.toContain(".profile-chip");
  });
});

/** A pane is not a window: `minSize={10}` in PaneHost means a leaf can be a tenth of the host, and a
 *  three-way split routinely leaves one under 300px. These assert the two halves of the fix — the
 *  flex minimums that stop a pane sizing itself to its WIDEST child (and being clipped by
 *  `.panel { overflow: hidden }` with nothing to scroll), and the container queries that re-flow the
 *  parts once the pane is genuinely too narrow for them. Measured against the real panes at
 *  240/340/480/560/620/640/700/900px: no element escapes its panel at any of them. */
describe("narrow panes", () => {
  it("the pane roots refuse to be sized by their content", () => {
    // The named mutant: drop `min-width: 0` and `.page` grows to the width of the 180px rail plus a
    // full row of action buttons, taking its head, rail and actions outside the panel's clip.
    for (const sel of [".page", ".diff-pane", ".session-pane", ".browser-pane", ".panel"]) {
      expect(bodiesFor(sel).join(" "), sel).toContain("min-width: 0");
    }
  });

  it("panes measure THEMSELVES, not the window — every narrow rule is a container query", () => {
    // A media query here would answer to the window, and a 1400px window says nothing about a leaf
    // that is a tenth of it.
    for (const sel of [".page", ".diff-pane", ".panel"]) {
      expect(bodiesFor(sel).join(" "), sel).toContain("container-type: inline-size");
    }
    // Hoisting the container to `.page` is what lets every page share the breakpoints. A page that
    // re-declared its own would be a second, narrower container shadowing the shared one.
    expect(RULES.filter((r) => r.selectors.some((sel) => /^\.[\w-]+-page(?:-pane)?$/.test(sel)) && /container-type/.test(r.body))).toHaveLength(0);
  });

  it("the edge bands are positioned against the SCROLLER, never against the body the rail shares", () => {
    /* The dissolve used to be two bands hung off `.page-body`, which is the rail as well as the
       column — so the top one was drawn over the first rail tab wide, and over the whole tab strip
       narrow, where the body stands its parts up and the rail becomes a row above the content. A
       smeared navigation row reads as a rendering fault. Masking the scroller cannot reach the rail
       at all, which is the structural version of the same guarantee.
       THE mutant: a mask on `.page-body`, which would take the rail with it. */
    for (const body of bodiesFor(".page-body")) expect(body).not.toMatch(/mask-image/);
    expect(bodiesFor(".page-scroll").join(" ")).toContain("position: relative");
    for (const body of bodiesFor(".page-body")) expect(body).not.toMatch(/position:\s*(relative|absolute|sticky)/);
    // The depths live with the bands' own positioning context, because a custom property inherits
    // and the bands are the column's SIBLINGS: set on `.page-content` they reached neither.
    const scroll = bodiesFor(".page-scroll").join(" ");
    expect(scroll).toContain("--fade-h");
    expect(scroll).toContain("--fade-top-h");
  });

  it("nothing inside a dissolving scroller can be lifted out of it, so nothing claims to be", () => {
    /* The Library's search field and filter chips sit INSIDE the column, and they used to carry a
       z-index that lifted them out of the top band's backdrop — a band is painted, so being above it
       was enough to stay sharp. The dissolve is a mask on the scroller now, and a mask applies to
       everything the element paints regardless of stacking, so that rule could only have been a
       claim the browser ignores. It went with the band.

       What replaces it is a property rather than a rule: a mask takes ALPHA, not detail, so the bar
       scrolling into the dissolve keeps every edge it had and reads as a control leaving rather than
       as a broken render. `filter-bar-fade-live.mjs` measures exactly that on pixels, against a
       backdrop blur put back as the mutant.

       THE mutant here: a z-index creeping back onto a bar inside a scroller, which would look like
       protection in a diff and do nothing at all. */
    for (const sel of [".page-filters", ".skills-filter-row"]) {
      const body = bodiesFor(sel).join(" ");
      expect(body, `${sel} claims a stacking order it cannot escape the mask with`).not.toMatch(/z-index/);
    }
    // And the dissolve is on the scroller, not on the box beside the rail: a mask on `.page-scroll`
    // would take the tab strip with it, which is the navigation this page is read through.
    expect(bodiesFor(".page-scroll").join(" ")).not.toMatch(/mask-image/);
  });

  it("a stacked settings row opts out of the narrow pass's wrap, which means the opposite in a column", () => {
    /* The narrow block wraps every `.settings-row` and gives its label `flex-basis: 100%` — both of
       which mean "the label takes its own line" in a ROW and something else entirely in a column: a
       wrapping column flex container lays overflow out in new COLUMNS, and a 100% basis is a height.
       Measured live: the theme grid grew 432px of empty rows under its last card at every pane
       below 640. THE mutant: drop either declaration from the stacked-row rule. */
    const stacked = bodiesFor(".settings-row[data-stack]").join(" ");
    expect(stacked).toContain("flex-direction: column");
    expect(stacked).toContain("flex-wrap: nowrap");
    expect(bodiesFor(".settings-row[data-stack] > .settings-row-main").join(" ")).toContain("flex: none");
    // …and the narrow rules it is answering are still there to be answered.
    const narrow = blockAfter("@container (max-width: 640px)");
    expect(narrow).toMatch(/\.settings-row[^{]*\{[^}]*flex-wrap: wrap/);
    expect(narrow).toMatch(/\.settings-row > \.settings-row-main \{[^}]*flex-basis: 100%/);
  });

  it("under 640px of pane the rail stands up as a scrolling strip instead of halving the content", () => {
    const narrow = blockAfter("@container (max-width: 640px)");
    expect(narrow).toContain("flex-direction: row");
    // A fieldset's UA `min-inline-size: min-content` outranks `width: auto`: without this the rail
    // refuses to shrink under the width of all its tabs and scrolls nothing.
    expect(narrow).toContain("min-width: 0");
    expect(narrow).toContain("overflow-x: auto");
    expect(narrow).toMatch(/\.page-body \{[^}]*flex-direction: column/);
    // Only the head's trailing action is meant to wrap; an `auto` basis put the title on its own
    // line and stranded the 36px glyph above it.
    expect(narrow).toMatch(/\.page-title \{[^}]*flex: 1 1 140px/);
  });

  it("action clusters take their own line rather than pinching the text they act on", () => {
    const narrow = blockAfter("@container (max-width: 640px)");
    // `1fr auto` with an unshrinkable auto column crushed `.env-path` to 13px — one character per
    // line — at every pane width up to 640.
    expect(narrow).toMatch(/\.env-row \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(narrow).toMatch(/\.env-actions \{[^}]*grid-column: 1/);
    expect(narrow).toMatch(/\.settings-row > \.settings-row-main \{[^}]*flex-basis: 100%/);
  });

  it("the panel bar spends a narrow pane on identity: the meta goes, never the title", () => {
    expect(blockAfter("@container (max-width: 380px)")).toMatch(/\.panel-meta \{[^}]*display: none/);
    // The pane's own back and forward are gone from the bar (WindowNav has the window's one pair), and
    // with them the rung that hid them.
    expect(css).not.toMatch(/\.panel-nav/);
  });

  it("the diff head breaks onto its own row under 560px, and the commit bar holds out to 380", () => {
    const narrow = blockAfter("@container (max-width: 560px)");
    expect(narrow).toMatch(/\.diff-head \{[^}]*flex-wrap: wrap/);
    expect(narrow).toMatch(/\.diff-head-spacer \{[^}]*flex-basis: 100%/);
    expect(narrow).not.toMatch(/\.diff-commit-bar \{[^}]*flex-wrap: wrap/);
    const tight = blockAfter("@container (max-width: 380px)");
    expect(tight).toMatch(/\.diff-commit-bar \{[^}]*flex-wrap: wrap/);
    expect(tight).toMatch(/\.diff-staged-count \{[^}]*flex-basis: 100%/);
  });

  it("every override sits AFTER the shorthand it overrides — a container query adds no specificity", () => {
    // The mutant this catches is silent: move either block above its `flex: 1` and the query still
    // matches, the rule still parses, and nothing re-flows. Both were written wrong the first time.
    expect(css.indexOf("@container (max-width: 560px)"))
      .toBeGreaterThan(css.indexOf(".diff-staged-count { flex: 1;"));
    expect(css.lastIndexOf("@container (max-width: 640px)"))
      .toBeGreaterThan(css.indexOf(".engines-head .page-lede { flex: 1;"));
  });
});

/** Plan 24 W1 — the transcript's drawn payloads. These live here for the same reason the §6 motion
 *  table does: jsdom has no layout, so nothing else in the suite can notice that a diff's columns
 *  stopped lining up, that a code rail stopped being sticky, or that the one rule keeping the
 *  transcript's diff independent of the diff PANE's has quietly been merged into it. */
describe("Plan 24 W1: inline UI in the transcript", () => {
  it("the transcript's diff keeps its own selectors — a change to the diff pane cannot restyle it", () => {
    // The pane owns staging and history across a full-height list; this is a read-only card in a
    // 680px column. Sharing `.diff-line` would couple a message from three weeks ago to the pane.
    // The scrollbar list names every scroller in the app in one `:where(...)`; that is a roll call,
    // not a style the two diffs share.
    const shared = RULES.filter((r) => r.body !== "scrollbar-width: thin;"
      && r.selectors.some((s) => s.includes(".fd-") && s.includes(".diff-")));
    expect(shared).toEqual([]);
  });

  it("diff lines are a grid, so every hunk's code edge sits on one ruler", () => {
    // Flex would let each line size its own gutter and the code edge would wander hunk to hunk.
    expect(bodiesFor(".fd-line").join(" ")).toContain("display: grid");
    expect(bodiesFor(".fd-line").join(" ")).toContain("grid-template-columns: 0 0 14px 1fr");
    expect(bodiesFor(".fd-body[data-numbered] .fd-line").join(" ")).toContain("grid-template-columns: 38px 38px 14px 1fr");
  });

  it("intra-line emphasis is a wash of the ROW's own tint, never a third colour", () => {
    expect(bodiesFor(".fd-mark").join(" ")).toContain("var(--green)");
    expect(bodiesFor('.fd-line[data-kind="del"] .fd-mark').join(" ")).toContain("var(--red)");
  });

  it("the code preview's number rail stays put while the code scrolls under it", () => {
    const gutter = bodiesFor(".code-gutter").join(" ");
    expect(gutter).toContain("position: sticky");
    expect(gutter).toContain("left: 0");
    // Both columns must run the same mono SIZE and line-height or the numbers drift off their lines.
    // They did: the rail was 11.5px/1.65 beside a 12px/1.65 body, which lands 0.8px lower per line —
    // a number a full line off by the twenty-fourth. The same font string, not two that agree today.
    const font = (b: string) => b.match(/font: ([^;]+);/)?.[1];
    expect(font(gutter)).toBe("12px/1.65 var(--font-mono)");
    expect(font(bodiesFor(".code-body").join(" "))).toBe(font(gutter));
    expect(bodiesFor(".code-body").join(" ")).toContain("white-space: pre");
  });

  it("every drawn surface bounds its own height, so one tool call cannot own the scroller", () => {
    for (const sel of [".code-block", ".term-out", ".md-scroll"])
      expect(bodiesFor(sel).join(" "), `${sel} must cap its height`).toMatch(/max-height: \d+px/);
  });

  it("syntax colour is ten named roles and nothing else — a code theme has to be repaintable", () => {
    // `color:` only. A .hljs rule may also reach for the weight ladder (a title is 560, strong is
    // 600) and those are not hues — folding them in would make this assert the ladder twice and
    // fail the moment a rung is used where a bare weight used to be.
    //
    // THE re-inlined mutant: put `var(--accent)` back on `.hljs-keyword`. Every default-theme
    // screenshot is identical, and Monokai's keywords come out Realm blue — because `--accent` is a
    // theme's chrome hue and a code palette's keyword colour is a different decision that only
    // happens to coincide in the palette this mapping was written for.
    const hues = new Set(RULES.filter((r) => r.selectors.some((s) => s.startsWith(".hljs")))
      .flatMap((r) => [...r.body.matchAll(/(?:^|[;{]|\s)color:\s*var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]!)));
    expect([...hues].sort()).toEqual(SYNTAX_ROLES);
  });

  it("the todo bar is the one accent fill, and finished items are struck through rather than dropped", () => {
    expect(bodiesFor(".todo-fill").join(" ")).toContain("background: var(--rl-accent)");
    expect(bodiesFor('.todo-list li[data-status="completed"] .todo-text').join(" ")).toContain("line-through");
  });

  it("the to-do strip is the under-strip mirrored: same inset, same overlap, radii swapped end for end", () => {
    // The prompter is one card with a narrower tab at each end. A strip at the card's own width, or
    // at the under-strip's width but nudged off its centre, is a different object.
    const strip = bodiesFor(".composer-todos").join(" ");
    const under = bodiesFor(".composer-understrip").join(" ");
    // Three values, not four: the shorthand itself is what makes the two insets equal, so a strip
    // that is the right width can never also be off-centre.
    const margin = (body: string) => /margin:\s*(-?\d+(?:px)?) (-?\d+(?:px)?) (-?\d+(?:px)?)\s*[;}]/.exec(body);
    const s = margin(strip), u = margin(under);
    expect(s, ".composer-todos needs a three-value margin").not.toBeNull();
    expect(u, ".composer-understrip needs a three-value margin").not.toBeNull();
    expect(s![2], "the strip's side inset is the under-strip's").toBe(u![2]);
    // Mirrored overlap: the under-strip slides up behind the card, this one slides down behind it.
    expect(s![3]).toBe(u![1]);
    expect(s![1], "the strip adds no gap above itself").toBe("0");
    expect(strip).toContain("border-radius: var(--r-squircle) var(--r-squircle) 0 0");
    // Under the gate the corner is the painter's, and the swap has to go with it — the under-strip
    // zeroes its TOP, so this one zeroes its bottom.
    expect(bodiesFor(":root[data-squircle] .composer-todos").join(" ")).toContain("--sq-radius-bottom: 0px");
    expect(bodiesFor(":root[data-squircle] .composer-understrip").join(" ")).toContain("--sq-radius-top: 0px");
  });

  it("the over-strip is the to-do strip's geometry, and centres where the under-strip is a row", () => {
    // Same tab, same inset, same overlap — the prompter has ONE tab height at each end, not three.
    const over = bodiesFor(".composer-overstrip").join(" ");
    const todos = bodiesFor(".composer-todos").join(" ");
    const under = bodiesFor(".composer-understrip").join(" ");
    const margin = (body: string) => /margin:\s*(-?\d+(?:px)?) (-?\d+(?:px)?) (-?\d+(?:px)?)\s*[;}]/.exec(body);
    const o = margin(over), t = margin(todos), u = margin(under);
    expect(o, ".composer-overstrip needs a three-value margin").not.toBeNull();
    // Three values, so the two side insets cannot differ: a strip of the right width that is off the
    // card's centre is the failure a four-value shorthand allows and this one does not.
    expect(o![2], "the over-strip's side inset is the other two strips'").toBe(u![2]);
    expect(o![1], "the over-strip adds no gap above itself").toBe(t![1]);
    expect(o![3], "the over-strip slides down behind the card, like the plan above it").toBe(t![3]);
    expect(over).toContain("border-radius: var(--r-squircle) var(--r-squircle) 0 0");
    expect(bodiesFor(":root[data-squircle] .composer-overstrip").join(" ")).toContain("--sq-radius-bottom: 0px");
    // The centring IS the design difference from the row below, so it is pinned rather than left to
    // a default: one object on a strip sits on the card's centre line.
    expect(over).toContain("justify-content: center");
    expect(under).not.toContain("justify-content: center");
  });

  it("stacked above the plan, the over-strip gives up its top corners rather than reaching up for them", () => {
    // Two tabs on one fill read as one band, and the corners belong to whichever is on top. The join
    // is drawn from the strip that arrives underneath — a rule reaching back into `.composer-todos`
    // would be the newcomer redesigning the planner to fit itself, which is what the `.composer-todos
    // + .composer` check below forbids for the card.
    expect(bodiesFor(".composer-todos + .composer-overstrip").join(" ")).toContain("border-radius: 0");
    // Under the gate the corner is the painter's, so the squaring has to be too.
    expect(bodiesFor(":root[data-squircle] .composer-todos + .composer-overstrip").join(" ")).toContain("--sq-radius-top: 0px");
    const reaching = RULES.flatMap((r) => r.selectors).filter((sel) => /\.composer-overstrip\s*[+~]\s*\.composer-todos\b/.test(sel));
    expect(reaching).toEqual([]);
  });

  it("the prompter's own corners are untouched — the strip attaching above it changes nothing", () => {
    // The strip is the only thing that squares an edge here. A rule reaching for `.composer` to make
    // the join work would be the strip redesigning the card to fit itself.
    // `(?![-\w])` is the class name ENDING, not `\b`: a word boundary sits happily before the hyphen
    // in `.composer-overstrip`, which is a different element and a join this rule does not govern.
    const reaching = RULES.flatMap((r) => r.selectors).filter((sel) => /\.composer-todos\s*[+~]\s*\.composer(?![-\w])/.test(sel));
    expect(reaching).toEqual([]);
    expect(bodiesFor(".composer").join(" ")).toContain("border-radius: var(--r-squircle)");
  });

  it("the strip collapses on the house grid-row idiom, at the rung for a box changing size", () => {
    expect(bodiesFor(".composer-todos-wrap").join(" "))
      .toContain(`transition: grid-template-rows ${dur("--dur-base")} var(--ease-in-out-strong)`);
    expect(bodiesFor(".composer-todos[data-open] .composer-todos-wrap").join(" ")).toContain("grid-template-rows: 1fr");
    // Without the clip the collapsed rows still take their natural height and 0fr animates nothing.
    expect(bodiesFor(".composer-todos-clip").join(" ")).toContain("overflow: hidden");
  });

  it("the strip's list is bounded and does not hand its scroll to the transcript behind it", () => {
    const list = bodiesFor(".composer-todos .todo-list").join(" ");
    expect(list).toMatch(/max-height:\s*\d+px/);
    expect(list).toContain("overscroll-behavior: contain");
  });
});

/** Custom themes. The palette a theme writes is inline custom properties (packages/ui/src/themes.ts,
 *  pinned by its own suite there); what has to hold HERE is that the stylesheet reads those
 *  properties at all — a token nothing reaches for is a theme that repaints nothing. */
const SYNTAX_ROLES = [
  "--syn-attr", "--syn-comment", "--syn-deleted", "--syn-fg", "--syn-keyword",
  "--syn-meta", "--syn-number", "--syn-string", "--syn-title", "--syn-type",
];

describe("custom themes", () => {
  const tokens = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8");

  /** One mode's declaration block, so a token is read from the ramp that actually states it. */
  const modeBlock = (mode: "dark" | "light"): string => {
    const at = tokens.indexOf(mode === "dark" ? ":root {\n  color-scheme: dark" : ':root[data-mode="light"] {');
    expect(at, `no ${mode} token block in tokens.css`).toBeGreaterThan(-1);
    return tokens.slice(at, tokens.indexOf("\n}", at));
  };
  const oklchIn = (name: string, block: string): { l: number; c: number; h: number } => {
    const m = new RegExp(`${name}: oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)`).exec(block);
    expect(m, `${name} is not a plain oklch value in tokens.css`).not.toBeNull();
    return { l: Number(m![1]), c: Number(m![2]), h: Number(m![3]) };
  };
  const hexIn = (name: string, block: string): string => oklchToHex(oklchIn(name, block));

  it("the default palette defines every syntax role in terms of the ramps the old block wrote inline", () => {
    // Byte-for-byte the mapping styles.css used to carry, so introducing the roles cannot have
    // changed how the shipped theme highlights code. A drift here is a silent restyle of every
    // transcript for every user who never chose a theme.
    for (const [role, source] of [
      ["--syn-fg", "var(--ink-2)"], ["--syn-comment", "var(--ink-3)"], ["--syn-keyword", "var(--accent)"],
      ["--syn-string", "var(--green)"], ["--syn-number", "var(--orange)"], ["--syn-title", "var(--ink)"],
      ["--syn-type", "var(--ink)"], ["--syn-attr", "var(--ink-2)"], ["--syn-meta", "var(--ink-3)"],
      ["--syn-deleted", "var(--red)"],
    ] as const) {
      expect(tokens, role).toContain(`${role}: ${source};`);
    }
    // One block, not one per mode: every source above already flips on data-mode, so a second copy
    // under `[data-mode="light"]` would be a mapping that has to be kept in sync with itself.
    for (const role of SYNTAX_ROLES) {
      expect(tokens.split(`${role}:`).length - 1, `${role} is declared more than once in tokens.css`).toBe(1);
    }
  });

  it("the chart ground is its own token, and the Usage cards are what paints it", () => {
    // THE chart-drift mutant: point .usage-card back at --rl-raised. The card follows the theme's
    // surface, which for every dark theme in the set is lighter than the one the eight series were
    // validated against, and slot 6 quietly stops being distinguishable from its neighbours.
    expect(tokens).toContain("--chart-surface: var(--surface);");
    expect(tokens).toContain("--chart-gap: var(--chart-surface);");
    for (const sel of [".usage-card", ".stat-tile"]) {
      expect(bodiesFor(sel).join(" "), sel).toContain("background: var(--chart-surface)");
    }
  });

  it("the ramp reproduces the palette it was measured from", () => {
    // packages/ui/src/themes.ts derives every theme from thirteen seed colours — six plus seven
    // syntax roles — using ramp constants its comments claim were measured off THIS file. That
    // claim is only worth anything if something re-measures it, so: take the seeds out of
    // tokens.css, run them through the same derivation every theme goes through, and require
    // that what comes back IS tokens.css.
    //
    // THE drifted-ramp mutant: nudge any offset in DARK or LIGHT — the ΔL of --hover, an ink
    // exponent, the tooltip's inversion. Every theme still clears every contrast floor, because the
    // floors are about legibility and this is about SHAPE; only this notices that the derived
    // palettes have stopped being the same system as the one they sit beside.
    const L = (name: string, block: string): number => oklchIn(name, block).l;
    const derivedL = (v: string): number => Number(/^oklch\(([\d.]+)/.exec(v)![1]);

    for (const mode of ["dark", "light"] as const) {
      const block = modeBlock(mode);
      // The seeds are read back out of the palette rather than written here, so this cannot drift
      // by someone updating tokens.css and the copy in the test to match each other.
      // A light theme's seed background is its paper (themes.ts, `Ramp.page`), a dark one's its ground.
      const anchor = mode === "dark" ? "--page" : "--canvas";
      const derived = deriveVars({
        bg: hexIn(anchor, block), ink: hexIn("--ink", block), accent: hexIn("--accent", block),
        green: hexIn("--green", block), orange: hexIn("--orange", block), red: hexIn("--red", block),
        // The same role mapping the base --syn-* block states, so the seeds are Realm's own.
        syntax: { comment: hexIn("--ink-3", block), keyword: hexIn("--accent", block), string: hexIn("--green", block),
          number: hexIn("--orange", block), title: hexIn("--ink", block), type: hexIn("--ink", block), attr: hexIn("--ink-2", block) },
      }, mode);

      // The surface ladder and the tooltip chip are pure geometry off the seed: they have to land on
      // the shipped lightness to finer than a display can resolve.
      for (const token of ["--page", "--canvas", "--surface", "--inset", "--hover", "--hover-2", "--field",
        "--stripe-bg", "--tooltip-bg", "--tooltip-border", "--tooltip-fg"]) {
        expect(derivedL(derived[token]!), `${mode} ${token}`).toBeCloseTo(L(token, block), 3);
      }
      // The ink ramp is placed by CONTRAST rather than by lightness, so it lands within one step of
      // the walk that places it (0.002) rather than exactly on the shipped value.
      for (const token of ["--ink-2", "--ink-3", "--tooltip-muted"]) {
        expect(Math.abs(derivedL(derived[token]!) - L(token, block)), `${mode} ${token}`).toBeLessThan(0.004);
      }
    }
  });

  it("the picker's copy of Realm's own colours has not drifted from tokens.css", () => {
    // themeSwatches cannot read the live values — under any other theme they are that theme's — and
    // an override needs a seed to move, so REALM_SEED carries Realm's thirteen as hex. This is the pin
    // that keeps the copy honest: the same read-back the ramp test does above, compared value for
    // value. THE drifted-seed mutant: repaint --accent in tokens.css and leave REALM_SEED alone —
    // the picker's Realm card, and every override derived off Realm, keep the old blue.
    for (const mode of ["dark", "light"] as const) {
      const block = modeBlock(mode);
      const want = REALM_SEED[mode];
      for (const [role, token] of [["bg", mode === "dark" ? "--page" : "--canvas"], ["ink", "--ink"], ["accent", "--accent"],
        ["green", "--green"], ["orange", "--orange"], ["red", "--red"]] as const) {
        expect(want[role], `${mode} ${role}`).toBe(hexIn(token, block));
      }
      // The syntax seeds are the role mapping the base --syn-* block states, resolved through it.
      for (const [role, token] of [["comment", "--ink-3"], ["keyword", "--accent"], ["string", "--green"],
        ["number", "--orange"], ["title", "--ink"], ["type", "--ink"], ["attr", "--ink-2"]] as const) {
        expect(want.syntax[role], `${mode} syntax.${role}`).toBe(hexIn(token, block));
      }
    }
  });
});

describe("the decorative wash", () => {
  const tokensCss = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8");
  const wash = bodiesFor(".wash").join(" ");
  const grain = bodiesFor(".wash[data-grain]").join(" ");
  /* Every selector that paints any part of the decoration. If a rule is ever added that puts it on a
     pseudo-element or a child, these lists are what notice. */
  const painters = RULES.filter((r) => /--grain-tex|--grain-lift|--grain-wash-l/.test(r.body)).flatMap((r) => r.selectors);

  it("is painted as the surface's own background, never as a layer over it", () => {
    // state/no-overlay.ts exists because a WebContentsView composites ABOVE everything React draws,
    // so any floating surface has to be kept off its rect. A background cannot leave its own element
    // and so can never join that problem; an absolutely-positioned child could.
    expect(wash).toContain("background-image:");
    for (const body of [wash, grain]) {
      expect(body).not.toMatch(/position:\s*(absolute|fixed)/);
      expect(body).not.toContain("inset:");
      expect(body).not.toContain("z-index:");
    }
    expect(painters.filter((s) => /::(before|after)/.test(s))).toEqual([]);
  });

  it("keeps texture off a --canvas ground, where the contrast budget is zero", () => {
    // theme/grain.test.ts measures it: the derivation puts --ink-3 at exactly its 2.4 floor on
    // --canvas for six light faces, so a luminance excursion there has nothing to spend. `.page` is
    // --canvas, and takes the luminance-neutral colour field alone.
    const textured = RULES.filter((r) => r.body.includes("var(--grain-tex)")).flatMap((r) => r.selectors);
    expect(textured).toEqual([".wash[data-grain]"]);
    expect(wash).not.toContain("var(--grain-tex)");
    expect(wash).not.toContain("var(--grain-lift)");
  });

  it("drifts by exactly one tile, so the loop closes on a seam that is not there", () => {
    // feTurbulence stitchTiles makes the 160px tile repeat without a join; translating by any other
    // distance would park the texture mid-tile and show one.
    expect(grain).toContain("background-size: 160px 160px");
    expect(blockAfter("@keyframes rl-grain-drift")).toContain("background-position: 160px 160px");
  });

  it("is genuinely still under reduced motion, and gone under reduced transparency", () => {
    // The animation is on the ELEMENT, so the global `* { animation: none }` reaches it — which is
    // only true while nothing here moves to a pseudo-element, hence the check above.
    expect(grain).toContain("animation: rl-grain-drift");
    const transparency = blocksAfter("@media (prefers-reduced-transparency: reduce)").join("\n").replace(/\s+/g, " ");
    expect(transparency).toContain(".wash, .wash[data-grain] { background-image: none; }");
  });

  it("randomises hue and place, never the lightness the contrast proof rests on", () => {
    // --grain-wash-l/-c are pinned per mode in tokens.css because they are what keeps the field off
    // the luminance axis. If either became an inline value, grain.test.ts would still pass and the
    // guarantee would be gone.
    for (const name of ["--grain-wash-l", "--grain-wash-c", "--grain-wash-a", "--grain-lift", "--grain-tex"]) {
      expect(tokensCss, name).toContain(`${name}:`);
      expect(css, name).not.toMatch(new RegExp(`${name}\\s*:`));
    }
    // The light face flips the pin: .97 sits inside the light grounds' own band the way .10 sits
    // below every dark one.
    expect(tokensCss).toContain("--grain-wash-l: 0.17");
    expect(tokensCss).toContain("--grain-wash-l: 0.98");
    expect(wash).toContain("var(--grain-hue, 0)");
    expect(wash).toContain("var(--grain-x, 50%)");
  });
});

/**
 * A terminal sits on the pane's ground, as the transcript does. The pane area is ONE translucent sheet
 * (`.main`), and a terminal that filled itself with the same token painted that colour a second time
 * at full strength — the darker slab beside the chat it was meant to match.
 */
describe("a terminal's surface", () => {
  it("paints no ground of its own and keeps no colour scheme of its own", () => {
    // THE MUTANTS: any background on the pane, and the slab is back; `color-scheme: dark`, and on the
    // light face xterm's scrollbar stays a dark gutter on a light ground.
    const pane = bodiesFor(".terminal-pane").join(" ");
    expect(pane).not.toMatch(/background/);
    expect(pane).not.toMatch(/color-scheme/);
  });

  it("writes its hint in the pane's own inks, which are the ones that read on the pane's ground", () => {
    // THE MUTANT: the white-on-dark terminal inks it used to wear, invisible on the light face.
    expect(bodiesFor(".terminal-hint-path").join(" ")).toContain("color: var(--rl-text-dim)");
    expect(bodiesFor(".terminal-hint-keys").join(" ")).toContain("color: var(--rl-text-faint)");
  });
});

/**
 * The machine pane's surfaces (Plan 25 W3).
 *
 * Every rule here exists because the surface underneath is ARBITRARY — a stranger's desktop, which
 * may be any colour and is white far more often than not. That is a different problem from every
 * other pane in the app, and the answers are easy to undo by someone tidying up.
 */
describe("the machine pane's screen", () => {
  it("letterboxes on the terminal's ground, not the canvas token", () => {
    // A guest desktop must not fight a near-white surround in light mode. `--canvas` is the working
    // plane's colour and would put a pale border around a pale screen in exactly the mode it shows
    // most.
    const body = bodiesFor(".machine-screen").join(" ");
    expect(body).toContain("background: var(--rl-terminal-bg)");
    expect(body).not.toContain("var(--canvas)");
  });

  it("gives the canvas the one-device-pixel outline every screenshot in the app wears", () => {
    // Without it a pale guest desktop bleeds into the letterbox with no edge at all, and the pane
    // reads as one washed-out surface rather than as a screen inside a frame.
    expect(bodiesFor(".machine-host canvas").join(" ")).toContain("box-shadow: var(--shadow-hairline)");
  });

  it("claims sharpness only where one framebuffer pixel really is one device pixel", () => {
    // `image-rendering: pixelated` over a resampled image is a statement about the picture that is
    // not true — and it looks WORSE than the resampling it is trying to disown.
    const pixelated = RULES.filter((r) => /image-rendering:\s*pixelated/.test(r.body)).flatMap(partsOf);
    expect(pixelated).toEqual(['.machine-screen[data-scale="actual"] .machine-host canvas']);
  });

  it("draws no seam between the pane bar and the screen", () => {
    // `.browser-chrome`'s argument, and the same one: below the bar sits an arbitrary desktop, and a
    // hairline along an edge that is already the strongest tonal step in the window is decoration.
    const body = bodiesFor(".machine-screen").join(" ");
    expect(body).not.toMatch(/border-top:(?!\s*none)/);
    expect(bodiesFor(".machine-pane").join(" ")).not.toMatch(/border|box-shadow/);
  });

  it("puts the curve on the GROUND the screen sits in, never on the picture itself", () => {
    /* Reversed from the original rule, deliberately, and the distinction it replaces it with is the
       part worth keeping. The old rule was "no curve anywhere in this pane", on the argument that a
       remote desktop is content rather than a surface and a rounded corner eats pixels the guest
       drew. The second half of that is still true — so the canvas is still square, and what rounds
       is the letterbox it is centred in, which is Realm's surface and not the guest's.

       That split is also the only one this Chromium can actually draw. A canvas cannot be painted
       behind, and `mask-image: paint(rl-squircle)` parses here and does not mask — measured against
       the real renderer, where the masked box came out square. A curve on the picture would have to
       be a circular `border-radius` pretending to be the signature, next to a prompter wearing the
       real one. */
    const screen = bodiesFor(".machine-screen").join(" ");
    expect(screen).toContain("corner-shape: squircle");
    expect(screen).toContain("border-radius: var(--r-squircle-screen)");
    // Painted, or it is a circular arc wearing the signature's name — see the invariant above.
    expect(bodiesFor(":root[data-squircle] .machine-screen").join(" ")).toContain("--sq-fill: var(--rl-terminal-bg)");

    // The picture keeps its square edge, on both paths a frame can arrive by.
    for (const sel of [".machine-host canvas", ".machine-poll"]) {
      expect(bodiesFor(sel).join(" "), sel).not.toContain("corner-shape");
      expect(bodiesFor(sel).join(" "), sel).not.toMatch(/border-radius:(?!\s*0)/);
    }
  });

  it("states the screen's inset, padding and corner as the same numbers fit.ts computes the clip from", () => {
    /* The clip has to be built in JS — a canvas takes neither the painter nor `corner-shape` — so
       these four numbers exist in a stylesheet AND in a module, and nothing but this test stops them
       drifting. A drift is not a crash: it is a picture whose corner is a degree off the ground's,
       which nobody notices and everybody feels. */
    expect(css).toContain(`--r-squircle-screen: ${SCREEN_RADIUS}px;`);
    const screen = bodiesFor(".machine-screen").join(" ");
    expect(screen).toContain(`padding: ${SCREEN_PAD}px`);
    expect(tokensCss).toContain(`--sidebar-inset: ${SCREEN_INSET}px;`);
    expect(screen).toContain("margin: var(--sidebar-inset)");
    // Concentric, which is design.md's rule for a radius inside a radius and not a preference.
    expect(PICTURE_RADIUS).toBe(SCREEN_RADIUS - SCREEN_PAD);
  });

  it("clips the picture with a path, never a border-radius", () => {
    // `border-radius` here would be the circular arc — the exact form design.md rules out, a few
    // inches from a prompter wearing the real superellipse.
    const host = bodiesFor(".machine-host").join(" ");
    expect(host).toContain("clip-path: var(--machine-clip, none)");
    expect(host).not.toMatch(/border-radius/);
  });

  it("insets the screen and keeps the canvas clear of the corner it just gained", () => {
    /* The padding is not spacing — it is what makes the radius legible. The canvas is centred in the
       CONTENT box, so without it a guest whose aspect ratio matched the pane's would push square
       corners into round ones. A 28px superellipse reaches ~8px in from the corner; the mutant is
       dropping this below that, which no other test would notice.

       `fit.ts` needs to know nothing about either: `ResizeObserver` reports `contentRect`, which
       excludes padding, so the letterbox is computed against the padded box already. */
    const screen = bodiesFor(".machine-screen").join(" ");
    expect(screen).toContain("margin: var(--sidebar-inset)");
    const pad = /padding:\s*(\d+)px/.exec(screen);
    expect(pad, "the screen must be padded, or its corner cuts the picture").not.toBe(null);
    expect(Number(pad![1])).toBeGreaterThanOrEqual(12);
  });

  it("gives the route cards and Connect the curve too, both painted", () => {
    // The user-facing ask these serve: a picker of cards and the button under it, on the same corner
    // family as the screen above them rather than three different roundings on one form.
    const card = bodiesFor(".machine-route").join(" ");
    expect(card).toContain("border-radius: var(--r-squircle-card)");
    expect(card).toContain("corner-shape: squircle");
    // Its border has to become the painter's RING, or it traces a rectangle around a curved card.
    const paintedCard = bodiesFor(":root[data-squircle] .machine-route").join(" ");
    expect(paintedCard).toContain("border-color: transparent");
    expect(paintedCard).toContain("--sq-ring: var(--rl-line)");
    // Every state that moved `background` above must move `--sq-fill` here, or the card paints its
    // resting fill in all of them.
    expect(bodiesFor(":root[data-squircle] .machine-route:hover").join(" ")).toContain("--sq-fill: var(--rl-hover)");
    expect(bodiesFor(":root[data-squircle] .machine-route[data-on]").join(" ")).toContain("--sq-fill:");

    // The button takes its corner as a proportion of its own height, which is the house formula for
    // a control — a fixed radius copied down from a surface reads as square at this size.
    const btn = bodiesFor(".machine-primary").join(" ");
    expect(btn).toContain("border-radius: calc(34px * var(--sq-ratio-ctl))");
    expect(btn).toContain("corner-shape: squircle");
    expect(bodiesFor(":root[data-squircle] .machine-primary").join(" ")).toContain("--sq-n: var(--sq-n-ctl)");
  });

  it("gives `suspended` a shape rather than a fifth hue", () => {
    // off and suspended are the only pair in the whole dot vocabulary with no hue available to
    // separate them, so the difference has to be a form. design.md: readable without colour alone.
    const suspended = bodiesFor('.status-dot[data-status="machine-suspended"]').join(" ");
    expect(suspended).toContain("background: transparent");
    expect(suspended).toMatch(/box-shadow:\s*inset/);
    expect(bodiesFor('.status-dot[data-status="machine-off"]').join(" ")).toContain("background: var(--rl-text-faint)");
  });

  it("puts a recording for Laya in the in-flight ping family, in red, and in both lists", () => {
    // Red is what a recording light is everywhere; the ring has to survive reduced motion and leave
    // when the window goes quiet, which only a name in every list gets it.
    expect(bodiesFor('.status-dot[data-status="recording"]').join(" ")).toContain("background: var(--rl-danger)");
    expect(bodiesFor('.status-dot[data-status="recording"]::after').join(" ")).toContain("--ring: var(--rl-danger)");
    const ping = RULES.filter((r) => /animation:\s*rl-ping/.test(r.body)).flatMap(partsOf);
    expect(ping).toContain('.status-dot[data-status="recording"]::after');
    const reduced = RULES.filter((r) => /animation:\s*none/.test(r.body)).flatMap(partsOf);
    expect(reduced).toContain('.status-dot[data-status="recording"]::after');
    const quiet = RULES.filter((r) => /display:\s*none/.test(r.body)).flatMap(partsOf);
    expect(quiet).toContain(':root[data-quiet] .status-dot[data-status="recording"]::after');
  });

  it("puts `booting` in the in-flight ping family rather than giving it a second animation", () => {
    // The halo has to survive reduced motion, which the global `*` rule cannot reach on a
    // pseudo-element — so a value added to the family without being added to BOTH lists is the one
    // animation on the page that ignores the preference.
    const ping = RULES.filter((r) => /animation:\s*rl-ping/.test(r.body)).flatMap(partsOf);
    expect(ping).toContain('.status-dot[data-status="machine-booting"]::after');
    const reduced = RULES.filter((r) => /animation:\s*none/.test(r.body)).flatMap(partsOf);
    expect(reduced).toContain('.status-dot[data-status="machine-booting"]::after');
  });
});

/* The band above the prompter is one object. `.composer[data-mode]` re-colours the card's ring, and a
   strip left on the neutral `--card-ring` draws a different-coloured line up each side of the same
   band — which shows as a notch at either edge, where the card's own top corners sit inside the strip.
   THE MUTANT: colour the card alone, which is what it did. */
it("carries the prompter's mode ring up through every strip stacked above it, and down through the one below", () => {
  for (const [mode, token] of [["plan", "--rl-warning"], ["ask", "--rl-success"]] as const) {
    const strips: [string, string][] = [
      ...[".composer-goal", ".composer-todos", ".composer-overstrip"].map((strip): [string, string] => [strip, `${strip}:has(~ .composer[data-mode="${mode}"])`]),
      // The under-strip is the card's LATER sibling, so it reads the mode with no `:has`.
      [".composer-understrip", `.composer[data-mode="${mode}"] ~ .composer-understrip`],
    ];
    for (const [strip, sel] of strips) {
      const painted = bodiesFor(`:root[data-squircle] ${sel}`).join(" ");
      expect(painted, `${strip} under ${mode}`).toContain(token);
      /* …and under the gate the edge is the painter's ALONE. The fallback's box-shadow is drawn on the
         border box, which the painter squares to radius 0, so left on it drew a second ring: square
         past the painted corners, and across the band where two strips meet. THE mutant: drop this. */
      expect(painted, `${strip} under ${mode} keeps the fallback's box-shadow`).toContain("box-shadow: none");
      // The painter is gated, so the fallback edge has to say the same thing.
      const fallback = bodiesFor(sel).join(" ");
      expect(fallback, `${strip} fallback under ${mode}`).toContain(token);
      expect(fallback, `${strip} fallback hairline`).toContain("var(--hairline-w)");
    }
  }
});

/**
 * The self-drive frame, held to the same numbers the injected one is drawn from.
 *
 * `main/agent-cursor.ts` says the arrangement out loud: the mark exists on two surfaces with two
 * transports and must have one appearance, "so the appearance is a number table both read, and
 * `styles.test.ts` asserts the parity". This is that assertion. Without it the two drift silently —
 * nothing in the app ever renders them side by side, so a 2px ring here against a 3px ring in a page
 * is a difference only a user switching panes would ever see, and could not name.
 *
 * Geometry is deliberately absent: see `AGENT_FRAME`'s own comment for why insetting a pane-scoped
 * frame is parity rather than a departure from it.
 */
describe("the model picker's light and its fast-mode moment", () => {
  const LIGHT = [".mp-track-facets", ".mp-track-flow", ".mp-track-core", ".mp-track-shine"];

  it("loops only in the light's own layers, and pauses them with every other ambient loop", () => {
    // THE MUTANT: a layer of the light left off the quiet list keeps a core busy in a window nobody is
    // looking at — and under Low power, which is supposed to still it.
    for (const sel of LIGHT) {
      expect(bodiesFor(sel).join(" "), sel).toMatch(/animation: rl-[a-z]+ var\(--mp-[a-z]+\) [a-z-]+ infinite/);
      expect(bodiesFor(`:root[data-quiet] ${sel}`).join(" "), sel).toContain("animation-play-state: paused");
    }
  });

  it("answers a chosen heavy level, scaled by --heat, and draws in the live accent alone", () => {
    expect(bodiesFor('.mp-track[data-effort="xhigh"]').join(" ")).toContain("--heat: .55");
    expect(bodiesFor('.mp-track[data-effort="max"]').join(" ")).toContain("--heat: 1");
    // Hue is not free (theme/grain.ts): every colour in the light is the accent moved, never a hue
    // somebody picked — so it is the theme's own light at every palette.
    for (const sel of [...LIGHT, ".mp-track-glint"]) {
      const body = bodiesFor(sel).join(" ");
      expect(body.match(/oklch\((?!from var\(--rl-accent\))/g), sel).toBeNull();
    }
  });

  it("plays the fast-mode moment once, on the ladder, and never as a loop", () => {
    // A moment that looped would be the decorative pulsing §6 forbids; one off the ladder would be a
    // duration of its own (the motion ladder above).
    for (const sel of [".mp-bolt[data-charge]", ".mp-track-glint", '.model-chip[data-sweep] :is(.chip-label, .chip-effort)']) {
      const body = bodiesFor(sel).join(" ");
      expect(body, sel).toMatch(/animation: rl-[a-z-]+ var\(--(mp-moment|dur-move)\)/);
      expect(body, sel).not.toContain("infinite");
    }
    for (const sel of [".model-chip", ".mp-run"]) expect(bodiesFor(sel).join(" "), sel).toContain("--mp-moment: calc(var(--dur-move) * 1.5)");
  });
});

describe("the agent-controlled frame", () => {
  const glow = bodiesFor(".drive-frame-glow").join(" ");

  it("draws the ring at the shared weight", () => {
    // THE MUTANT: any other number. The ring is the whole statement on a pane whose content is
    // already dense, and one that does not match the browser's reads as a different kind of event.
    for (const body of bodiesFor(".drive-frame"))
      expect(body).toContain(`inset 0 0 0 ${AGENT_FRAME.ringPx}px var(--rl-accent)`);
  });

  it("draws the glow at the shared blur and spread", () => {
    // The negative spread is the load-bearing half: drop it and the wash fills the pane instead of
    // hugging its edges, and a terminal under it stops being readable.
    expect(glow).toContain(`inset 0 0 ${AGENT_FRAME.glowBlurPx}px ${AGENT_FRAME.glowSpreadPx}px var(--rl-accent)`);
  });

  it("pulses at the shared rate", () => {
    expect(glow).toContain(`${AGENT_FRAME.pulseMs}ms`);
  });

  it("gives the glow its own element rather than a pseudo-element", () => {
    // THE MUTANT: move the animation onto `.drive-frame::before`. The app-wide reduced-motion kill
    // is `* { animation: none }` and `*` does not match a pseudo-element, so the frame would keep
    // pulsing for a reader who turned motion off — the failure the eggs wash already documents.
    expect(RULES.some((r) => r.selectors.some((sel) => sel.startsWith(".drive-frame") && sel.includes("::")))).toBe(false);
  });

  it("is paused by the quiet attribute like every other ambient loop", () => {
    // The quiet list is an enumeration, not a wildcard: a new looping surface that nobody adds to it
    // keeps burning a core in an unfocused window, which is the audit this list came out of.
    expect(bodiesFor(":root[data-quiet] .drive-frame-glow").join(" ")).toContain("animation-play-state: paused");
  });
});

/** Settings' rail (Plan 26 W9a): a search above headed lists of pages, and a mark on the row a search
 *  lands on. jsdom lays nothing out, so `settings-groups-live.mjs` measures both in the real window;
 *  these pin the rules those measurements depend on. */
describe("Settings' search and grouped rail", () => {
  it("narrow, the search keeps a line of its own and only the pages lie down into the strip", () => {
    /* The generic narrow rail is one horizontal scroller. THE mutant: let the search ride in it, and
       the field scrolls out of sight exactly when the strip is too long to scan — which is when
       someone reaches for it. */
    const narrow = blockAfter("@container (max-width: 640px)");
    expect(narrow).toMatch(/\.page-rail\.settings-rail \{[^}]*flex-direction: column/);
    expect(narrow).toMatch(/\.page-rail\.settings-rail \{[^}]*overflow: visible/);
    expect(narrow).toMatch(/\.settings-rail-lists \{[^}]*flex-direction: row[^}]*overflow-x: auto/);
  });

  it("narrow, each headed list keeps its own width in the strip", () => {
    /* `.page-rail-list` is `min-width: 0`, so in a row it shrinks to share the strip. THE mutant:
       drop this, and the five lists squeeze to the strip's width with their tabs drawn over each
       other — measured live as "AppearanceEnginesKeysSign-ins" in one smear. */
    expect(blockAfter("@container (max-width: 640px)")).toMatch(/\.settings-rail-lists > \.page-rail-list \{[^}]*flex: none/);
  });

  it("wide, the lists scroll under the search when the page is shorter than the rail", () => {
    /* 530px of rail against 479px of page at the 600px minimum window. THE mutant: let the rail
       size to its content, and Import sits below the page with nothing to scroll it into view. In the
       page the rail starts a head's band down, so its cap gives that band back; in the sidebar's
       column there is no band, and the cap is the column. */
    expect(bodiesFor(".page-rail.settings-rail").join(" ")).toMatch(/max-height: calc\(100% - var\(--page-head-top, 0px\)\)/);
    const lists = bodiesFor(".settings-rail-lists").join(" ");
    expect(lists).toContain("min-height: 0");
    expect(lists).toContain("overflow-y: auto");
  });

  it("on the light face a search field on this page takes the raised fill, through the painter when there is one", () => {
    /* `--field` and `--canvas` are the same lightness on the light face, so a field laid on the
       page's ground has no edge. THE painter mutant: write `background` where the worklet paints —
       it replaces `paint(rl-squircle)` and, at `border-radius: 0`, squares the field off. */
    expect(bodiesFor(':root[data-mode="light"] .settings-page-pane .search-field').join(" ")).toBe("--sq-fill: var(--surface);");
    expect(bodiesFor(':root[data-mode="light"]:not([data-squircle]) .settings-page-pane .search-field').join(" ")).toContain("background: var(--surface)");
  });

  it("marks a landed row with an edge down its inside, never a ring", () => {
    /* A ring on a meshed row redraws the box the mesh removed and crosses the dividers either side
       of it — the reason the engine cards' warning is an inside edge. THE mutant: `inset 0 0 0 1.5px`. */
    for (const sel of [".settings-page-pane .settings-row[data-found]", ".settings-page-pane .engine-card[data-found]"]) {
      expect(bodiesFor(sel).join(" "), sel).toMatch(/box-shadow: inset 3px 0 0 var\(--rl-accent\)/);
    }
    // It fades because the RESTING row carries the transition; reduced motion's global kill is what
    // turns that into a plain on and off.
    expect(bodiesFor(".settings-page-pane .settings-row").join(" ")).toMatch(/transition: box-shadow var\(--dur-slow\)/);
  });
});

/** The content face (Plan 26 W9b). jsdom computes no cascade, so `settings-groups-live.mjs` reads the
 *  computed family off probes in the real window; this pins the declarations that reading depends on. */
describe("prose reads in the content face", () => {
  it("every surface prose is read on names --font-content, and the root starts it as the UI face", () => {
    /* THE missed-surface mutant: leave one off, and choosing a serif changes the transcript but not
       the documents editor — two faces for the same kind of reading in one window. */
    for (const sel of [".msg-assistant", ".msg-user", ".md", ".documents-rich-surface"]) {
      expect(bodiesFor(sel).join(" "), sel).toContain("font-family: var(--font-content)");
    }
    expect(bodiesFor(":root").join(" ")).toContain("--font-content: var(--font-ui)");
  });
});

describe("the pointer", () => {
  /** The one rule that asks for the hand, and what it lists. */
  const hands = RULES.filter((r) => /cursor:\s*pointer/.test(r.body));
  const list = (hands[0]?.selectors ?? []).join(", ");

  it("points with the hand at everything a click acts on, from ONE rule by tag and role, at no specificity", () => {
    /* The owner's call (10-05): the hand over buttons and wherever it makes sense. THE mutants: a kind
       of control left out of the list (every one of them keeps the arrow), a class rule asking for the
       hand on its own (the next control like it does not), or the rule given specificity (every drag
       handle, resize edge and zoomable picture loses its own cursor to it). */
    expect(hands.flatMap(partsOf)).toHaveLength(1);
    expect(list.startsWith(":where(")).toBe(true);
    for (const part of ["button", "a[href]", "summary", "select", '[role="button"]', '[role="link"]', '[role="tab"]',
      '[role="menuitem"]', '[role="menuitemradio"]', '[role="menuitemcheckbox"]', '[role="option"]', '[role="switch"]',
      '[role="checkbox"]', '[role="radio"]', '[role="slider"]', 'input:is([type="checkbox"], [type="radio"], [type="range"]',
      'label:has(input:is([type="checkbox"], [type="radio"]))']) expect(list).toContain(part);
    // Everything that tracks a press (press-tracking.ts) is something that points.
    for (const sel of PRESSABLE.split(", ")) expect(list, sel).toContain(sel === '[role^="menuitem"]' ? '[role="menuitem"]' : sel.replace(/^input\[type="checkbox"\]$/, '[type="checkbox"]'));
    // tokens.css loads first; a link is the one tag that asks there.
    const tokenHands = [...tokensCss.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^{}]*cursor:\s*pointer/g)].map((m) => m[1]!.trim());
    expect(tokenHands).toEqual(["a"]);
    expect(bodiesFor("button").join(" ")).not.toContain("cursor");
  });

  it("no control turns the hand back off — the arrow is for what a click does nothing on", () => {
    /* Sixty rules once wrote `cursor: default` to keep the Mac's arrow over their control, and each of
       them would out-rank a rule of no specificity. THE mutant is one of them coming back. What may ask
       for the arrow: a control that is off, and the handful of things that look like rows and are not
       pressed, each named for why. */
    const records: Record<string, string> = {
      ".summary-fact": "a context fact in the summary, read and not pressed",
      ".skill-file-name[data-inert]": "a skill's file the Library cannot open",
      ".ghost-chip[data-static]": "a chip that only reports a value",
      ".ship-row": "a record of a ship, whose PR link is the only thing in it that opens",
      ".media-video .media-el": "a video's picture, which its own play control sits over",
    };
    const arrows = RULES.filter((r) => /cursor:\s*default/.test(r.body)).flatMap(partsOf);
    const unexplained = arrows.filter((sel) => !(sel in records) && !/:disabled|\.disabled|aria-disabled/.test(sel));
    expect(unexplained).toEqual([]);
    expect(Object.keys(records).filter((sel) => !arrows.includes(sel)), "a record that no longer asks").toEqual([]);
  });

  it("gives the arrow back to a control that is off, and the I-beam to a field inside a row that points", () => {
    // Both are rules of no specificity AFTER the hand, so they win by order and lose to any class.
    const at = (re: RegExp) => RULES.findIndex((r) => re.test(r.body) && r.selectors.join(", ").startsWith(":where("));
    const hand = at(/cursor:\s*pointer/), off = at(/cursor:\s*default/), field = at(/cursor:\s*text/);
    expect(hand).toBeGreaterThanOrEqual(0);
    expect(off).toBeGreaterThan(hand);
    expect(field).toBeGreaterThan(hand);
    expect(RULES[off]!.selectors.join(", ")).toContain(':disabled, [aria-disabled="true"]');
    // `cursor` inherits, so a rename field inside a sidebar row would point without this.
    for (const part of ["input:not(", "textarea", '[contenteditable="true"]']) expect(RULES[field]!.selectors.join(", ")).toContain(part);
  });

  it("keeps a drag handle's grab and a divider's resize, which the hand would otherwise take", () => {
    expect(bodiesFor(".quick-chat-bar").join(" ")).toContain("cursor: grab");
    expect(bodiesFor(".quick-chat-bar[data-dragging]").join(" ")).toContain("cursor: grabbing");
    expect(bodiesFor(".sb-resize").join(" ")).toContain("cursor: col-resize");
    expect(bodiesFor(".attach-tile[data-media] .attach-open").join(" ")).toContain("cursor: zoom-in");
  });
});

describe("the Mac idiom", () => {

  it("does not let a drag or a double-click select the chrome, and leaves fields selectable inside it", () => {
    const chrome = RULES.find((r) => r.body.includes("user-select: none") && r.selectors.some((s) => s.includes(".sidebar")));
    expect(chrome, "no rule takes selection off the chrome").toBeTruthy();
    for (const part of ["button", '[role="button"]', ".panel-bar", ".menu"]) expect(chrome!.selectors.join(", ")).toContain(part);
    const fields = RULES.find((r) => r.selectors.some((s) => s.startsWith(":is(input")));
    expect(fields?.body).toContain("user-select: text");
  });

  /* The ring closes onto the control. Only `from` is written so each control keeps its own offset;
     a `to` would flatten every one of them to the same number. */
  it("draws the focus ring in from a wider halo, on controls only", () => {
    const ring = blockAfter("@keyframes rl-focus-ring");
    expect(ring).toContain("from");
    expect(ring).not.toMatch(/\bto\b/);
    const rule = RULES.find((r) => r.body.includes("animation: rl-focus-ring"));
    expect(rule?.body).toContain(`${dur("--dur-slow")} var(--spring-smooth)`);
    expect(rule!.selectors.join(", ")).toMatch(/^:is\(button/);
  });

  /* THE mutants: a grey that does not keep the accent's LUMINANCE — contrast is a function of it, and
     OKLCH's L is not, for a saturated accent a theme may choose — or reaching for `--accent-ink`,
     which would grey the links in a background window's prose. The contrast itself is measured live
     (native-feel-live.mjs); this pins the construction. */
  it("greys the accent in a window that is not key, keeping its luminance and leaving link ink alone", () => {
    const drained = bodiesFor(":root[data-window-inactive]").join(" ");
    // Luminance, not OKLCH lightness: the D65 white's x and z scaled by the colour's own Y.
    expect(drained).toContain("--accent-drained: color(from var(--accent) xyz-d65 calc(y * 0.9505) y calc(y * 1.089))");
    expect(drained).toContain("--accent-tint-drained: color(from var(--accent-tint) xyz-d65 calc(y * 0.9505) y calc(y * 1.089) / alpha)");
    const body = bodiesFor(":root[data-window-inactive] body").join(" ");
    for (const name of ["--accent", "--rl-accent", "--accent-tint", "--rl-accent-press"]) expect(body).toContain(`${name}:`);
    expect(body).not.toContain("--accent-ink");
  });
});

describe("the Mac idiom, continued", () => {
  it("does not light a sidebar row the pointer passes over, and still shows the row's own controls", () => {
    // Nothing under the pointer paints the row. The row's actions DO come up on hover — in the slot
    // its state gives up (Plan 26 W1), which moves the title's padding but lights nothing.
    const lights = (sel: string) => RULES.filter((r) => r.selectors.includes(sel) && /\b(background|color|box-shadow)\s*:/.test(r.body));
    expect(lights(".item:hover")).toEqual([]);
    expect(lights(".item:hover .item-row")).toEqual([]);
    expect(bodiesFor(".item:hover .item-actions").join(" ")).toContain("opacity: 1");
    // The selection still reads: clicking is what lights a row.
    expect(bodiesFor(".item[data-active]").join(" ")).toContain("background: var(--rl-active)");
  });

  it("keeps code copyable in the chrome, but not inside a control, where a drag is a press", () => {
    const rule = RULES.find((r) => r.selectors.some((s) => s.startsWith(":is(code")));
    expect(rule?.body).toContain("user-select: text");
    expect(rule!.selectors.join(", ")).toContain(":not(:is(button");
  });

  /* The children move, never the scroller: THE mutant is the offset landing on the scroller, which
     would drag its mask and scrollbar along and read as the pane itself sliding. */
  it("rubber-bands a scroller's content, not the scroller", () => {
    expect(bodiesFor("[data-rubber] > *").join(" ")).toContain("translate: 0 var(--rubber, 0px)");
    expect(RULES.filter((r) => r.selectors.includes("[data-rubber]"))).toEqual([]);
  });
});

describe("softer edges", () => {
  const tokens = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8");
  const stepOf = (block: string, name: string) =>
    Number(new RegExp(`--${name}: var\\(--overlay-(?:lighten|darken)-(\\d+)\\)`).exec(block)?.[1] ?? NaN);
  const dark = tokens.slice(tokens.indexOf("--line: var(--overlay-lighten-200)"));
  const light = tokens.slice(tokens.indexOf(':root[data-mode="light"]'));

  /* The edges went one rung softer; the FILLS that used to borrow their tokens did not. THE mutant is
     a switch's track left on `--rl-line`: softened with the borders, an off switch on the panel ground
     reads as a white knob floating on nothing. */
  it("keeps every mark a rung above the edge it used to share a token with, in both faces", () => {
    for (const [face, block] of [["dark", dark], ["light", light]] as const) {
      expect(stepOf(block, "mark"), face).toBeGreaterThan(stepOf(block, "line"));
      expect(stepOf(block, "mark-strong"), face).toBeGreaterThan(stepOf(block, "line-strong"));
      // …and a pane divider is still the heaviest line in the app: it is the whole boundary.
      expect(stepOf(block, "divider"), face).toBeGreaterThan(stepOf(block, "line-strong"));
    }
    for (const [sel, decl] of [
      [".switch", "background: var(--mark)"], [".switch:hover:not(:disabled)", "background: var(--mark-strong)"],
      [".todo-track", "background: var(--mark)"], ['.status-dot[data-status="idle"]', "background: var(--mark-strong)"],
      [".item-glyph rect", "fill: var(--mark-strong)"],
    ] as const) expect(bodiesFor(sel).join(" "), sel).toContain(decl);
  });
});

describe("the focus ring on a painted control", () => {
  /* THE mutant: the outline left on a control the worklet paints. Its border-radius is 0, so the
     outline is a square around a squircle — measured live (visual-review-live.mjs), a blue rectangle
     around the composer's model chip. */
  it("is drawn by the painter on the control's own curve, not as a square outline", () => {
    const rule = bodiesFor(":root[data-squircle] :is(.btn, .ghost-chip, .palette-opt):focus-visible").join(" ");
    expect(rule).toContain("outline: none");
    expect(rule).toContain("--sq-ring: var(--rl-accent)");
    expect(rule).toContain(`animation: rl-focus-ring-painted ${"var(--dur-slow)"} var(--spring-smooth)`);
    expect(blockAfter("@keyframes rl-focus-ring-painted")).toContain("--sq-ring: transparent");
    // Every control the worklet paints is covered — the list must not drift from the paint rule's.
    const painted = RULES.find((r) => r.body.includes("background: paint(rl-squircle)") && r.selectors.includes(":root[data-squircle] .ghost-chip"))!;
    for (const sel of painted.selectors) expect(sel.replace(":root[data-squircle] ", ""), sel).toMatch(/^\.(btn|ghost-chip|palette-opt)$/);
    expect(bodiesFor(":root[data-squircle] .btn.primary:focus-visible").join(" ")).toContain("--rl-accent-contrast");
  });
});

describe("the drawn caret (caret.ts)", () => {
  it("turns a field's own caret off only on the field the layer marks, and paints the platform's in the caret's colour", () => {
    /* THE always-off mutant: `caret-color: transparent` on every field, and a field the layer cannot
       stand in for — an email or number input, a composition — has no caret at all. The live check
       cannot see this one: a thin drawn line and the platform's land on the same pixel. */
    const off = RULES.filter((r) => /caret-color:\s*transparent/.test(r.body));
    expect(off.flatMap((r) => r.selectors)).toEqual([":is(input, textarea, [contenteditable])[data-rl-caret]"]);
    expect(bodiesFor("input").join(" ")).toContain("caret-color: var(--caret)");
  });

  it("sits over every other layer in the window, since a field drawn over the caret hides it", () => {
    /* Measured live: at 80 the caret went under a field at 100 — a popover's search — and was drawn
       where nobody could see it. What floats over a field hides the caret by the hit test instead. */
    const zOf = (body: string) => Number(body.match(/z-index:\s*(\d+)/)?.[1] ?? NaN);
    const caret = zOf(bodiesFor(".caret-layer").join(" "));
    const others = RULES.filter((r) => !r.selectors.includes(".caret-layer")).map((r) => zOf(r.body)).filter((z) => Number.isFinite(z));
    expect(caret).toBeGreaterThan(Math.max(...others));
  });

  it("holds every caret still while motion is off, its blink and its glide alike", () => {
    expect(bodiesFor(":root[data-caret-still] .caret-layer .caret").join(" ")).toMatch(/animation: none;.*transition: none/);
    expect(bodiesFor(":root[data-caret-still] .terminal-host .xterm-cursor").join(" ")).toContain("animation: none !important");
  });
});
