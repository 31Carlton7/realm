import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { actionsThatFit } from "./components/pane-bar-fit";
import { REALM_SEED, deriveVars } from "@realm/ui";
import { oklchToHex } from "@realm/contracts";
import { PICTURE_RADIUS, SCREEN_INSET, SCREEN_PAD, SCREEN_RADIUS } from "./panes/machine/fit";

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
const RULES = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!.split(",").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean),
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

/* The two system notices — the socket-down banner and the error bar — are the only surfaces in the
   app that a state change alone puts on screen. They used to cut in fully formed. */
it("brings the system notices in on the transcript's own entrance rung, from the edge each hangs off", () => {
  for (const sel of [".conn-banner", ".error-bar"]) {
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
  it("is the one place a duration is written, and these are its rungs", () => {
    expect(LADDER).toEqual({
      "--dur-drag": 80, "--dur-hover": 180, "--dur-press": 120, "--dur-pop": 140, "--dur-fast": 150,
      "--dur-swap": 160, "--dur-enter": 180, "--dur-base": 200, "--dur-rise": 220, "--dur-slow": 240,
      "--dur-move": 320,
    });
  });

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
    expect([...bare].sort()).toEqual([]);
  });
});

describe("§6 motion table", () => {
  it("sheets enter at 240ms ease-out-strong with a .96 scale — one rule for every sheet, no per-sheet carve-out", () => {
    expect(bodiesFor(".sheet").join(" ")).toContain(`animation: rl-sheet-in ${dur("--dur-slow")} var(--ease-out-strong)`);
    expect(blockAfter("@keyframes rl-sheet-in")).toContain("scale(.96)");
    // W4b scoped 240ms to onboarding alone; W5's whole job was to hoist it. If the override comes
    // back, the shared sheet has silently regressed to something else.
    expect(bodiesFor(".sheet.onboarding").join(" ")).not.toContain("animation");
  });

  it("the sheet scrim fades on its own at 160ms", () => {
    expect(bodiesFor(".sheet-backdrop").join(" ")).toContain(`animation: rl-fade-in ${dur("--dur-swap")}`);
  });

  it("menus enter at 140ms ease-out-strong, scale .97→1, from an origin the component supplies", () => {
    expect(bodiesFor(".menu").join(" ")).toContain(`animation: rl-menu-in ${dur("--dur-pop")} var(--ease-out-strong)`);
    expect(blockAfter("@keyframes rl-menu-in")).toContain("scale(.97)");
  });

  it("popovers leave the way they arrived: the exit reverses the enter on the press rung, and holds nothing behind", () => {
    for (const sel of [".menu[data-closing]", ".model-picker[data-closing]", ".icon-picker[data-closing]"]) {
      const body = bodiesFor(sel).join(" ");
      expect(body, sel).toContain(`animation: rl-menu-out ${dur("--dur-press")} var(--ease-out-strong) forwards`);
      // A surface that is on its way out must not still be catching clicks. `inert` is the real
      // guard (Menu.tsx sets it) — this is the half that holds for the frame before the attribute.
      expect(body, sel).toContain("pointer-events: none");
    }
    // The exit is the enter played backwards, not a second idea about what a popover does.
    expect(blockAfter("@keyframes rl-menu-out")).toContain("scale(.97)");
    // No half-pairs. A surface that only animates while you are trying to get rid of it is worse
    // than one that never animates, so an exit may only exist where the matching enter already does
    // — which rules the @-mention typeahead and the skill picker out, both of which appear instantly.
    const listOf = (decl: string) => RULES.filter((r) => r.body.includes(decl)).flatMap((r) => r.selectors);
    const enters = new Set(listOf("rl-menu-in"));
    for (const sel of listOf("rl-menu-out")) expect(enters, sel).toContain(sel.replace("[data-closing]", ""));
  });

  it("the DOM hold and the CSS exit are the same number", () => {
    // `use-anchored-popover.ts` keeps a dismissed popover mounted on a timer; the stylesheet fades it
    // on an animation. Nothing in either file can notice the two drifting apart — a short timer clips
    // the fade, a long one parks a finished surface on screen — so they are pinned to each other here.
    const hook = readFileSync(repoFile("apps/desktop/src/renderer/src/components/use-anchored-popover.ts"), "utf8");
    expect(Number(hook.match(/const EXIT_MS = (\d+);/)?.[1])).toBe(LADDER["--dur-press"]);
  });

  it("the model picker is a popover and enters on the same rule as menus, not one of its own", () => {
    // It shares `.menu`'s declaration rather than carrying a copy: §6 gives every popover one timing,
    // and a second animation here is how the prompter's picker drifts away from every other surface.
    expect(bodiesFor(".model-picker").join(" ")).toContain(`animation: rl-menu-in ${dur("--dur-pop")} var(--ease-out-strong)`);
    // Its interactive rows honour the hover rule — background/colour only, never geometry.
    const hover = `transition: background-color ${dur("--dur-hover")} ease, color ${dur("--dur-hover")} ease`;
    for (const sel of [".mp-row", ".mp-seg-opt"]) {
      expect(bodiesFor(sel).join(" "), sel).toContain(hover);
      expect(bodiesFor(sel).join(" "), sel).not.toContain("transform");
    }
    // The route pills animate their border too — they carry the selected state on the outline rather
    // than on a fill — but still nothing geometric.
    expect(bodiesFor(".mp-route").join(" ")).toContain(
      `transition: border-color ${dur("--dur-hover")} ease, background-color ${dur("--dur-hover")} ease, color ${dur("--dur-hover")} ease`);
    expect(bodiesFor(".mp-route").join(" ")).not.toContain("transform");
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

  it("hover fills run on the hover rung, on plain `ease`, and touch background/colour only — never geometry", () => {
    const hover = bodiesFor(".item-row").join(" ");
    expect(hover).toContain(`transition: background-color ${dur("--dur-hover")} ease, color ${dur("--dur-hover")} ease`);
    expect(hover).not.toContain("transform");
  });

  it("pressables scale to .96 over 120ms", () => {
    const press = bodiesFor(".ghost-chip").join(" ");
    expect(press).toContain(`transform ${dur("--dur-press")} var(--ease-out-strong)`);
    for (const sel of [".btn:active:not(:disabled)", ".icon-btn:active:not(:disabled)", ".composer-send:active:not(:disabled)"])
      expect(bodiesFor(sel).join(" "), sel).toContain("transform: scale(.96)");
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
    // The sidebar's archived shelf rides the tool row's declaration rather than carrying a copy.
    // max-height is the alternative, and it is the wrong one twice over: the number has to be
    // guessed, and the easing then runs against a height the content does not have, so a short list
    // snaps and a long one is clipped.
    for (const sel of [".archived-wrap", ".tool-body-wrap"])
      expect(bodiesFor(sel).join(" "), sel).toContain(`transition: grid-template-rows ${dur("--dur-base")} var(--ease-in-out-strong)`);
    expect(bodiesFor(".archived-wrap[data-open]").join(" ")).toContain("grid-template-rows: 1fr");
    // 0fr only clips against an overflow container; without it the folded rows spill up the sidebar.
    expect(bodiesFor(".archived-clip").join(" ")).toContain("overflow: hidden");
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
    /* `BAR_CHROME` includes the nav pair's 48px, because at the widths this rung operates in the nav
       is still drawn. Below `@container (max-width: 300px)` it is not — so the estimate would be
       48px too pessimistic there, and the bar would collapse an action it had room for. The ladder
       only stays honest if the budget has already reached zero by the time that rule fires.
       THE mutant: raise `BAR_CHROME` or `TITLE_MIN` far enough that actions survive past 300px. */
    const navGone = Number(/\(max-width: (\d+)px\) \{ \.panel-nav/.exec(css)?.[1]);
    expect(navGone).toBeGreaterThan(0);
    // The observer reports the CONTENT box, so the bar's own padding comes off the rule's number.
    const padding = 28;
    expect(actionsThatFit(navGone - padding)).toBe(0);
    // …and the rung above it, where the meta goes, must still be leaving room for something — a
    // ladder whose last two rungs fire together is one rung with two names.
    const metaGone = Number(/\(max-width: (\d+)px\) \{ \.panel-meta/.exec(css)?.[1]);
    expect(actionsThatFit(metaGone - padding)).toBeGreaterThan(0);
  });

  it("New session and Quick chat are ONE block of two equal rows, not a row with a sub-item", () => {
    /* Twice now the quick row has been drawn to say "smaller occasion" — once smaller (30px/12.5px),
       once a rung quieter in ink — and both times it read as a child of the row above it. THE
       mutant: put either back. The two are alternatives to pick between, so nothing paints a rank.
       The negative margin cancels `.sb-top`'s gap for this ONE seam; taking it off the container
       instead would close the seam under the search field too. */
    const quick = bodiesFor(".quick-row").join(" ");
    const primary = bodiesFor(".new-row").join(" ");
    for (const decl of ["color: var(--rl-text-dim)", "min-height: 32px", "border-radius: var(--r-ctl)"]) {
      expect(quick, decl).toContain(decl);
      expect(primary, decl).toContain(decl);
    }
    expect(bodiesFor(".quick-row:hover").join(" ")).toContain("color: var(--rl-text-bright)");
    expect(bodiesFor(".new-row:hover").join(" ")).toContain("color: var(--rl-text-bright)");
    // Flush: the row pulls back exactly the gap its container hands out.
    const gap = /gap: (\d+)px/.exec(bodiesFor(".sb-top").join(" "))?.[1];
    expect(quick).toContain(`margin: -${gap}px 0 `);
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
    expect(btn).toContain(`transform ${dur("--dur-press")} var(--ease-out-strong)`);
    expect(bodiesFor(".msg-action:active:not(:disabled)").join(" ")).toContain("transform: scale(.96)");
    // A thumb's glyph is the same pressed or not, so the fill is the only thing saying which — one
    // rung past hover, the same reading .icon-btn's toggles get.
    expect(bodiesFor('.msg-action[aria-pressed="true"]').join(" ")).toContain("background: var(--hover-2)");
    // The shared -6px overhang is deliberately NOT taken: these sit 2px apart, and it would have
    // each button stealing clicks from the next.
    // Exactly one rule reaches it: joining the shared list would give it a second, all-sides one.
    expect(bodiesFor(".msg-action::after")).toEqual(['content: ""; position: absolute; inset: -6px 0;']);
  });

  it("the sources chevron turns on the swap rung — a glyph changing state, not a box changing size", () => {
    expect(bodiesFor(".msg-sources-chevron").join(" ")).toContain(`transform ${dur("--dur-swap")} var(--ease-out-strong)`);
    expect(bodiesFor(".msg-sources[data-open] .msg-sources-chevron").join(" ")).toContain("rotate(0deg)");
  });

  it("W2's prompter hero→docked move keeps its 320ms ease-in-out-strong (§6 assigns that easing to on-screen movement)", () => {
    expect(bodiesFor(".composer-dock").join(" ")).toContain(`transition: transform ${dur("--dur-move")} var(--ease-in-out-strong)`);
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

  it("the space strip's badge stays still — presence, not a summons", () => {
    // Deliberately NOT the status dot's ping: this is a rollup for a space nobody is looking at, and
    // only "waiting on you" asks anyone to go there. A running agent elsewhere needs no attention.
    expect(bodiesFor('.strip-badge[data-status="running"]').join(" ")).not.toContain("animation");
    expect(bodiesFor('.strip-badge[data-status="waiting_permission"]').join(" ")).toContain("rl-pulse 0.9s ease-in-out infinite");
  });

  it("the greeting's nod is on the ladder like everything else, and the preference takes it away", () => {
    // An unadvertised flourish is still motion, and gets no exemption from either rule: it reaches
    // for a rung rather than inventing a tempo, and it is an ordinary element rule, so the global
    // `* { animation: none }` reaches it without the pseudo-element carve-out the ping needed.
    expect(bodiesFor(".hero-greeting[data-nod]").join(" ")).toContain(`animation: rl-nod ${dur("--dur-move")} var(--ease-in-out-strong)`);
    expect(blockAfter("@keyframes rl-nod")).toContain("transform: none");
    expect(RULES.some((r) => r.selectors.some((sel) => sel.includes("::") && sel.includes("hero-greeting")))).toBe(false);
  });

  it("`will-change` is reserved for the swiper track (§6 performance note)", () => {
    const owners = RULES.filter((r) => r.body.includes("will-change")).flatMap((r) => r.selectors);
    expect(owners).toEqual([".swiper-track"]);
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
      expect(body, sel).toContain("line-height: 1.6");
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

  it("the send button is a 32px circle; the hero textarea starts at ~56px", () => {
    const send = bodiesFor(".composer-send").join(" ");
    expect(send).toContain("width: 32px");
    expect(send).toContain("height: 32px");
    expect(bodiesFor('.session-pane[data-composer="hero"] .composer-input').join(" ")).toContain("min-height: 56px");
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
    for (const rule of chips) {
      for (const decl of rule.body.split(";").map((d) => d.trim()).filter(Boolean)) {
        const prop = decl.split(":")[0]!.trim();
        expect(["color", "background", "background-color", "border-radius", "box-shadow", "text-decoration", "text-underline-offset", "text-decoration-color"],
          `${rule.selectors.join(",")} { ${decl} }`).toContain(prop);
      }
    }
  });

  it("a chip run wears the app's chip corner, and both kinds wear the SAME one", () => {
    /* The runs are painted at 3px, which is the corner of an inline code mark — and one of them IS
       an inline code mark (`.ch-code`), which is why it keeps it. A picked element is not code, it
       is a control the user pointed at, and it read as a snippet.

       Stated concentrically, because a run may carry no padding (`draft-format.ts`): the 2px
       box-shadow is the chip's visible edge, so the fill's radius is the chip corner LESS that
       spread and the outline lands on `--r-chip`.

       THE mutant: give one of the two its own number. They are the same chip — the test below says
       so about their hover — and two chips that lift identically but round differently is worse than
       either treatment on its own. */
    /* Revised: a chip wears NO corner now, because it wears no fill and no ring — it is its icon
       and its accent ink, inline with the draft. The two kinds are still one treatment: the same
       single declaration. THE mutant: give one of them a fill back. */
    for (const sel of [".ch-element", ".ch-mention"]) {
      const body = bodiesFor(sel).join(" ");
      expect(body, sel).toContain("color: var(--rl-accent)");
      expect(body, sel).not.toContain("background");
      expect(body, sel).not.toContain("box-shadow");
    }
    // The code mark stays a code mark. §"Shape" gives 2px to ticks, rails and code marks.
    expect(bodiesFor(".ch-code").join(" ")).toContain("border-radius: 3px");
  });

  it("a chip is the same chip once the message is SENT — one treatment, no per-kind fill", () => {
    /* `.msg-chip[data-kind="element"]` used to take `--inset` under bright ink. The bubble it lands
       in is `--rl-raised`, one step away: 1.05:1, which is a chip that exists only as text with a
       smudge behind it — "hard to even contrast it or see it in general".
       The accent tint is what separates a named thing from the prose around it, and it holds on both
       faces (measured on the shipped palette: the fill stands 1.24:1 off the dark bubble and 1.19:1
       off the light one, against 1.05 and 1.06 before, and the accent ink on it measures 4.35:1 dark
       / 3.05:1 light — the same pairing the mention chip and the composer's own chips already ship,
       and above the 2.9 floor `--rl-accent` is derived against).
       THE mutant: re-add a `[data-kind]` rule with a fill in it. */
    /* Revised: the fill is gone on both faces. A chip in the log is an icon and a name in the
       accent, inline with the prose; the pill read as a control dropped into a sentence. What is
       held is the SAMENESS: one ink, no per-kind fill, on the composer and in the log alike. */
    const chip = bodiesFor(".msg-chip").join(" ");
    expect(chip).toContain("color: var(--rl-accent)");
    expect(chip).not.toContain("background");
    expect(bodiesFor(".ch-element").join(" ")).toContain("color: var(--rl-accent)");
    expect(bodiesFor(".ch-element").join(" ")).not.toContain("background");
    const variants = RULES.flatMap((r) => r.selectors.map((sel) => ({ sel, body: r.body })))
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

  it("no rule still styles a mode CHIP, because the row no longer has one", () => {
    // Left behind, these would tint whatever next took that aria-label — and they were written for a
    // control inside a group that no longer exists.
    expect(css).not.toContain('aria-label="Mode"');
  });

  /* The one thing the mode's move could break invisibly. With the chip gone, the card's tint is the
     only place a running session says it is in Plan or Ask — remove these and the mode becomes
     something you can only discover by opening a menu. */
  it("the prompter card still carries its own mode tint, which is now the mode's only ambient signal", () => {
    const ask = bodiesFor('.composer[data-mode="ask"]').join(" ");
    const plan = bodiesFor('.composer[data-mode="plan"]').join(" ");
    expect(ask).toContain("--rl-success");
    expect(plan).toContain("--rl-warning");
    // And the "+" menu's row names it in words, which is where BUILD — the untinted default — is read.
    const value = bodiesFor(".plus-submenu-value").join(" ");
    expect(value).toContain("margin-left: auto");
    expect(bodiesFor('.plus-submenu-value[data-mode="plan"]').join(" ")).toContain("var(--rl-warning)");
    expect(bodiesFor('.plus-submenu-value[data-mode="ask"]').join(" ")).toContain("var(--rl-success)");
  });

  it("a hovered chip is the same chip lifted, never a new shape", () => {
    // Both chips now lift the same way, because both now ARE the same chip. A picked element used
    // to be a grey inset box behind a hairline, which in a prompter that already renders inline
    // code that way read as code — and it is not code, it is something the user pointed at and is
    // about to send. They are told apart by what they say, not by two treatments to learn.
    // With no fill to lift, the hover is an underline — the one affordance a metric-free run may
    // wear — and it is the same underline for both.
    for (const sel of [".ch-element[data-hot]", ".ch-mention[data-hot]"]) {
      expect(bodiesFor(sel).join(" "), sel).toContain("text-decoration: underline");
    }
    // At rest this run wears no pill, and growing one under the pointer would read as an element
    // chip — a token that resolves to nothing dressing up as one that resolves to something.
    expect(bodiesFor(".ch-mention-stale[data-hot]").join(" ")).not.toContain("box-shadow");
  });

  it("a hovered LINK chip lifts without underlining — it is not a hyperlink", () => {
    /* The one chip that already looks like a link: an app's mark and accent ink. An underline on top
       is the web's "this is a hyperlink", and that is a promise the run does not keep — the pointer
       is over a mirror that takes no clicks, and the gesture the highlight announces takes the CHIP
       rather than opening the URL. THE mutant is the rule being dropped, which puts the underline
       straight back via `.ch-element[data-hot]`. */
    const body = bodiesFor(".ch-element[data-service][data-hot]").join(" ");
    expect(body).toContain("text-decoration: none");
    // …and it still says "target" some other way, or the affordance is simply gone.
    expect(body).toMatch(/background:/);
    // The override has to outrank the underline it is overriding: same layer, more specific.
    const generic = RULES.findIndex((r) => r.selectors.includes(".ch-element[data-hot]"));
    const link = RULES.findIndex((r) => r.selectors.includes(".ch-element[data-service][data-hot]"));
    expect(link, "the link rule must come after the one it overrides").toBeGreaterThan(generic);
  });

  it("the highlight mirror matches the textarea's text metrics exactly", () => {
    const mirror = bodiesFor(".composer-highlight").join(" ");
    const input = bodiesFor(".composer-input").join(" ");
    for (const decl of ["font: inherit", "font-size: 15px", "line-height: 1.55", "padding: 14px 16px 6px"]) {
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
    for (const decl of ["font: inherit", "font-size: 15px", "line-height: 1.55", "padding: 14px 16px 6px"]) {
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
    expect(tokens).toMatch(/--line: var\(--overlay-lighten-300\)/);
    expect(tokens).toMatch(/:root\[data-mode="light"\] \{[^}]*--line: var\(--overlay-darken-200\)/);
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
      // The decorative wash's geometry (theme/grain.ts): drawn once per launch per surface and set
      // inline, because a value that is randomised cannot be written in a stylesheet. Every one is
      // used with a fallback, so a surface that never receives them is still a finished surface.
      "--grain-hue", "--grain-x", "--grain-y", "--grain-spread",
      // The slider's filled fraction (SettingsPage's `Slider`): computed from the same min/max/value
      // the input is given and set inline, because a track cannot know its own value from CSS. Used
      // with a 0% fallback, so a slider that never receives it is an empty track rather than a
      // broken one.
      "--fill",
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
    ]);
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!));
    expect([...used].filter((n) => !defined.has(n) && !n.startsWith("--dsg-")).sort()).toEqual([]);
  });

  it("collapsing costs no height: no rail, and a corner overlay that clears the lights", () => {
    // The rail spent 38px of window HEIGHT, full width, to hold one button — a permanent strip across
    // every pane bought so the traffic lights would not land on pane chrome. Its return is the
    // regression this pins; sidebar-collapsed-live.mjs measures that the panes really start at y=0.
    expect(RULES.some((r) => r.selectors.some((s) => s.includes(".sb-rail")))).toBe(false);
    // …and the shell no longer changes axis: collapsed is the same row with the column taken out.
    expect(bodiesFor(".app[data-sidebar-collapsed]").join(" ")).not.toContain("flex-direction");
    const corner = bodiesFor(".sb-corner").join(" ");
    expect(corner).toContain("position: absolute");
    expect(corner).toContain("height: 40px");      // the band trafficLightPosition y:14 centres in
    expect(corner).toContain("padding-left: 76px"); // clears the lights before the toggle starts
    // The window must still be draggable by its own top-left, and the toggle still clickable inside it.
    expect(corner).toContain("-webkit-app-region: drag");
    expect(bodiesFor(".sb-corner button").join(" ")).toContain("-webkit-app-region: no-drag");
    // An absolutely positioned corner is only in the window's corner if the shell is its containing block.
    expect(bodiesFor(".app").join(" ")).toContain("position: relative");
  });

  it("exactly one strip reserves the lights — whichever is at the top of the main column", () => {
    // :first-child on each candidate is what keeps the three mutually exclusive: an error bar pushes
    // the others down, and only the strip actually under the lights may be indented.
    const owners = RULES.filter((r) => r.body.includes("padding-left: var(--corner-w)")).flatMap((r) => r.selectors);
    expect(owners).toEqual([
      ".app[data-sidebar-collapsed] .main > .error-bar:first-child",
      ".app[data-sidebar-collapsed] .main > .group-bar:first-child",
      ".app[data-sidebar-collapsed] .main > .panehost:first-child .panel[data-first-leaf] > .panel-bar",
    ]);
    // One declaration of the width, or the corner and the space reserved for it drift apart.
    expect(RULES.filter((r) => r.body.includes("--corner-w:")).flatMap((r) => r.selectors)).toEqual([".app[data-sidebar-collapsed]"]);
    // Every strip the lights can land in is 40px. main places them once at y:14 and never moves them,
    // which only works while that is true of all of them (see the comment on trafficLightPosition).
    expect(bodiesFor(".sb-head").join(" ")).toContain("height: 40px");
    expect(bodiesFor(".panel-bar").join(" ")).toContain("height: 40px");
    expect(bodiesFor(".app[data-sidebar-collapsed] .main > .group-bar:first-child").join(" ")).toContain("min-height: 40px");
  });

  it("the sidebar's right edge is a BORDER on .main, and only while the sidebar is there", () => {
    /* Measured live (`sidebar-edge-live.mjs`): as an inset box-shadow this line computed perfectly
       and painted nothing at all. An inset shadow sits below the element's children, and `.main`'s
       children — `.panehost` and every `.panel` — carry --rl-panel edge to edge, so the pane covered
       it. A border is box decoration on `.main` itself and cannot be covered by a child laid out in
       its padding box. This test is the cheap half; the pixels are the real one. */
    const edge = RULES.filter((r) => r.selectors.some((sel) => /(^|\s)\.main$/.test(sel.trim())) && r.body.includes("border-left"))
      .flatMap((r) => r.selectors);
    expect(edge).toEqual([".app:not([data-sidebar-collapsed]) .main"]);
    // THE mutant: drop the :not(). Collapsed, nothing takes the sidebar's column, so the same line
    // becomes a stray rule down the window's own left edge.
    expect(bodiesFor(".app:not([data-sidebar-collapsed]) .main").join(" ")).toContain("var(--rl-line)");
    // And no inset shadow creeps back onto .main to say the same thing twice, invisibly.
    expect(bodiesFor(".main").join(" ")).not.toContain("box-shadow: inset");
  });

  it("the sidebar keeps its vibrancy, and it is the app's ONE adjustable ground", () => {
    // The intent this pins moved: the sidebar used to be --page at a literal 82%, and is now the
    // composed --sidebar-ground, because the number is the user's. What has NOT moved is which
    // surface is translucent — exactly one, so text on a pane never renders over the desktop.
    expect(bodiesFor(".sidebar").join(" ")).toContain("background: var(--sidebar-ground)");
    // The old per-mode rgba override is gone — --page flips with data-mode on its own.
    expect(css).not.toContain("rgba(244,244,244,.82)");
    // THE second-ground mutant: give .main or a pane a color-mix over --page too. The window looks
    // better on a nice wallpaper and every pane's body text starts depending on it.
    const translucent = RULES.filter((r) => /background:[^;]*var\(--sidebar-ground\)/.test(r.body)).flatMap((r) => r.selectors);
    expect(translucent).toEqual([".sidebar"]);
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
  it("the permission card wears ApprovalCard's shell: a resting surface card on shadow-card with a hairline-topped footer", () => {
    // Re-pin from §5's floating raised+overlay-shadow treatment: BUI cards rest in the flow.
    const card = bodiesFor(".permission-card").join(" ");
    expect(card).toContain("background: var(--surface)");
    expect(card).toContain("box-shadow: var(--shadow-card)");
    expect(card).toContain("border-radius: var(--r-panel)");
    expect(bodiesFor(".permission-footer").join(" ")).toContain("border-top: var(--hairline-w) solid var(--line)");
    // The kbd number chips take BUI's inset fill + hairline ring.
    const num = bodiesFor(".permission-num").join(" ");
    expect(num).toContain("background: var(--inset)");
    expect(num).toContain("box-shadow: var(--shadow-hairline)");
  });

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

  it("fenced code is a ringless panel on the prompter's curve, with a 12.5/1.65 mono body", () => {
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
    expect(body).toContain("font-size: 12.5px");
    expect(body).toContain("line-height: 1.65");
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

    /* Frame / No frame. They carry `.btn`, which is painted — so the picked one has to mark itself
       with `--fill`. THE MUTANT is the obvious `background: var(--rl-accent)`: `background` is spent
       on `paint()` there, so the segment paints its resting fill in every state and the control ends
       up with no visible selection at all. */
    expect(bodiesFor('.sim-frame-opt[aria-checked="true"]').join(" ")).toContain("--fill: var(--rl-accent)");
    expect(bodiesFor('.sim-frame-opt[aria-checked="true"]').join(" ")).not.toContain("background:");
  });

  it("the prompter's strips are edged alike — every tab above the card wears the ring the under-strip does", () => {
    /* They are one object seen twice: same fill, same corner, same inset, mirrored. Only the lower
       one was edged, which read as a prompter with a bottom and no top — and edging the over-strip
       alone left the same hole whenever the goal, plan or agents strip was the one on top. The
       exception is a MIDDLE tab: a ring there would trace a hairline across the band where two
       strips meet, so a strip arriving under another gives up both its ring and its top corners. */
    const ring = "--sq-ring: var(--card-ring); --sq-ring-w: var(--hairline-w)";
    for (const sel of [".composer-agents", ".composer-goal", ".composer-todos", ".composer-overstrip", ".composer-understrip"])
      expect(bodiesFor(`:root[data-squircle] ${sel}`).join(" "), sel).toContain(ring);
    // Every pair the band can actually stack, in DOM order: agents, goal, plan, over-strip.
    const STACKED = [".composer-agents + .composer-goal", ".composer-agents + .composer-todos", ".composer-goal + .composer-todos",
                     ".composer-agents + .composer-overstrip", ".composer-goal + .composer-overstrip", ".composer-todos + .composer-overstrip"];
    for (const sel of STACKED) {
      const body = bodiesFor(`:root[data-squircle] ${sel}`).join(" ");
      expect(body, sel).toContain("--sq-ring-w: 0");
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

  it("the sidebar list clears its own fade the same way, and dissolves by masking itself", () => {
    // Same invariant as the changes list: a full band of padding, and ONE declaration of the number,
    // so the ramp and the clearance that keeps the last session out of it cannot drift apart.
    const body = bodiesFor(".space-body").join(" ");
    // The clearance is the band PLUS room to breathe under it — the fade is still the one declared
    // number, and the extra is written in terms of it rather than as a second magic figure.
    expect(body).toContain("padding-bottom: calc(var(--fade-h) + 24px)");
    // …and the same at the top, which needs it more: a row half-dissolved under the header is one
    // you can see and cannot confidently click.
    expect(body).toContain("padding-top: calc(var(--fade-top-h) + 4px)");

    expect(bodiesFor(".space-page").join(" ")).toContain("--fade-h: 44px");
    expect(body).not.toContain("--fade-h:");
    // The ramp is the scroller's own mask, reading the same --fade-h, and it runs to TRANSPARENT: the
    // rows' alpha goes to zero and whatever ground was behind them shows — the vibrancy material, or
    // the opaque page under reduced transparency. Nothing is painted over the rows. The two named
    // mutants are the old band: a backdrop blur over this translucent column blurs the window's own
    // transparency and composites toward black (a dark smudge above the strip, verified on screen);
    // a colour wash to any fixed tone stripes the material. So no `.space-fade` rule may exist, and
    // no rule on the scroller may blur or wash.
    // One gradient, two stops in and two out — the top edge dissolves the same way the bottom does,
    // and both read their own declared height rather than a literal.
    const RAMP = "linear-gradient(to bottom, transparent 0, #000 var(--fade-top-h), #000 calc(100% - var(--fade-h)), transparent)";
    expect(body).toContain(`mask-image: ${RAMP}`);
    expect(body).toContain(`-webkit-mask-image: ${RAMP}`);
    expect(body).not.toContain("backdrop-filter");
    expect(body).not.toContain("background:");
    expect(RULES.filter((r) => r.selectors.some((sel) => sel.includes(".space-fade")))).toEqual([]);
  });

  it("the sidebar's dissolve needs no reduced-transparency fallback, because it paints nothing", () => {
    // The transcript's band drops its blur under this preference and keeps its wash. The sidebar's
    // mask has neither to drop: it is the same declaration on an opaque ground as on the material.
    const reduced = blocksAfter("@media (prefers-reduced-transparency: reduce)").join("\n").replace(/\s+/g, " ");
    expect(reduced).not.toContain(".space-fade");
    expect(reduced).not.toContain(".space-body");
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

  it("the glow appears on the drag rung, and reduced motion is what takes the fade away", () => {
    // `--dur-drag` is the ladder's rung for exactly this: a drop target appearing mid-drag.
    expect(bodiesFor(".session-drop").join(" ")).toContain(`animation: rl-fade-in ${dur("--dur-drag")} linear`);
    // Reduced motion needs no rule of its own here: the blanket `*` kill covers a real element (it
    // would NOT cover a pseudo-element, which is why the glow is one).
    expect(blockAfter("@media (prefers-reduced-motion: reduce)")).toContain("animation: none !important");
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
    // confirmed is media gets zoom-in, and the mark only lands once that answer is back.
    expect(open).toContain("cursor: pointer");
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

  it("sent attachments stack ABOVE the bubble, in a column that keeps the transcript's right edge", () => {
    const row = bodiesFor(".msg-user-row").join(" ");
    expect(row).toContain("flex-direction: column");
    expect(row).toContain("align-items: flex-end");
    // Not inside the bubble: the tiles are a list of their own, and the bubble is a sibling.
    expect(bodiesFor(".msg-user-files").join(" ")).toContain("list-style: none");
  });

  it("the send circle carries BUI Button's accent treatment: inset top highlight, accent-ink hover, PromptBar's line-strong disabled fill", () => {
    expect(bodiesFor(".composer-send").join(" ")).toContain("box-shadow: var(--fill-bevel)");
    expect(bodiesFor(".composer-send:hover:not(:disabled)").join(" ")).toContain("background: var(--accent-ink)");
    const off = bodiesFor(".composer-send:disabled").join(" ");
    expect(off).toContain("background: var(--line-strong)");
    expect(off).toContain("color: var(--ink-2)");
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
    expect(bodiesFor('.ghost-chip[data-warning]').join(" ")).toContain("var(--red-tint)");
    for (const body of [pill, bodiesFor('.ghost-chip[data-warning]').join(" ")]) {
      expect(body).not.toMatch(/(?:color|background|--fill):\s*color-mix/);
    }
  });

  it("menus and the model picker are surface cards on shadow-raised with the opaque hover ladder (GlideMenu's surface, minus its JS glide layer)", () => {
    for (const sel of [".menu", ".model-picker"]) {
      const body = bodiesFor(sel).join(" ");
      expect(body, sel).toContain("background: var(--surface)");
      expect(body, sel).toContain("box-shadow: var(--shadow-raised)");
      expect(body, sel).not.toContain("--rl-shadow");
    }
    expect(bodiesFor('.menu [role="menuitem"]:focus, .menu [role="menuitemcheckbox"]:focus'.split(", ")[0]!).join(" ")).toContain("var(--hover)");
  });

  it("sheets and the palette are surface cards at window radius on shadow-overlay — and the palette stays instant (pinned above)", () => {
    for (const sel of [".sheet", ".palette"]) {
      const body = bodiesFor(sel).join(" ");
      expect(body, sel).toContain("background: var(--surface)");
      expect(body, sel).toContain("box-shadow: var(--shadow-overlay)");
    }
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
    const painted = [".btn", ".ghost-chip", ".mp-use", ".palette-opt"];
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

  it("the unread badge OVERHANGS the bell, and wears the count pill's own colours", () => {
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
    expect(bodiesFor(".sb-bell").join(" ")).toContain("position: relative");
    expect(bodiesFor(".sb-bell").join(" ")).toContain("overflow: visible");
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
    expect(bodiesFor(".group-label").join(" ")).toContain("font-size: 12.5px");
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
  it("the track is hidden by INHERITANCE, so a scroller written tomorrow is covered too", () => {
    // The whole point of putting it on :root: `scrollbar-color` inherits, and a list is a thing to
    // keep up with. The transparent second value is the track.
    expect(bodiesFor(":root").join(" ")).toContain("scrollbar-color: var(--rl-line) transparent");
    expect(bodiesFor(":hover").join(" ")).toContain("scrollbar-color: var(--rl-line-strong) transparent");
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

  it("the sidebar's thumb is held clear of the mask, by the mask's own two depths", () => {
    /* `.space-body` is masked at both ends, and a mask applies to the element's whole rendering —
       scrollbar included — so the thumb dissolved at exactly the two places a scrollbar is most
       used. The track's margin is what holds it clear, and it is written as the same two custom
       properties the mask reads rather than as numbers: tune one end of the fade and the thumb
       follows it instead of drifting back under it.
       Only the wiring is checkable here. That the thumb is actually crisp at both ends is a
       composited-pixel question, and jsdom has no scrollbars at all. */
    const track = bodiesFor(".space-body::-webkit-scrollbar-track").join(" ");
    expect(track).toContain("margin-block: var(--fade-top-h) var(--fade-h)");
    const masked = bodiesFor(".space-body").join(" ");
    expect(masked).toContain("var(--fade-top-h)");
    expect(masked).toContain("var(--fade-h)");
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
    // the terminal's column count, and its interior is dark in both app modes.
    const exempt = new Set([".xterm-viewport"]);
    const uncovered = RULES
      .filter((r) => /overflow(-[xy])?:\s*(auto|scroll)/.test(r.body) && !/scrollbar-width:\s*none/.test(r.body))
      .flatMap((r) => r.selectors)
      .filter((sel) => !covered.has(leaf(sel)) && !exempt.has(leaf(sel)));
    expect([...new Set(uncovered)].sort()).toEqual([]);
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
    for (const sel of [".panel-bar", ".group-bar", ".browser-chrome"])
      expect(bodiesFor(sel).join(" "), sel).not.toMatch(/border-bottom: *1px/);
    // The claim is falsifiable, so it is checked: none of the three is sticky, which is the only way
    // content could pass under one.
    for (const sel of [".panel-bar", ".group-bar", ".browser-chrome"])
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
       hold the thing's own name and the control that closes it — chrome FOR the surface below, not a
       section beside it. Each page also opens with its own heading, so the rule was a second edge
       under a title that already had one. */
    for (const sel of [".page-overlay-bar", ".terminal-dock-bar"])
      expect(bodiesFor(sel).join(" "), sel).not.toMatch(/border-bottom/);
    // Footers hold their place while the body scrolls past them.
    for (const sel of [".permission-footer", ".question-footer", ".spaces-foot", ".mp-detail-foot"])
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
    // Full height, unlike its content-height neighbours.
    expect(dock).toContain("height: calc(var(--dock-pane-h) - var(--sidebar-inset) * 2)");
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
    for (const sel of SURFACES) {
      const body = bodiesFor(`:root[data-squircle] ${sel}`).join(" ");
      expect(body, sel).toContain("background: paint(rl-squircle)");
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
    [".media-lightbox-bar", "on a video frame"],
    [".media-lightbox-bar .media-name", "on a video frame"], [".media-lightbox-bar .media-detail", "on a video frame"],
    [".media-lightbox-bar .media-action", "on a video frame"], [".media-lightbox-bar .media-action:hover", "on a video frame"],
    [".attach-tile[data-image] .attach-ext", "on the attached picture"],
    /* A switch knob is white in both modes, the way it is on every platform that has one. It used to
       take `--surface`, which flips — so in dark mode the OFF state was a dark dot on a light track,
       backwards from every switch a person has ever used, and the ON state was a dark dot on the
       accent. The knob answers to the track it rides, not to the page behind it. */
    [".switch::after", "a switch knob is white on both faces"],
    // The slider's handle is the switch's knob, for the same reason and with the same answer: two
    // round controls a few rows apart must not disagree about what a handle looks like.
    ['.slider-row input[type="range"]::-webkit-slider-thumb', "the same knob the switch wears"],
    [".attach-remove", "on the attached picture"], [".attach-remove:hover", "on the attached picture"],
    // An element's name, drawn over the DEVICE's own screen — whatever the simulator is showing is
    // the same in both modes, so the halo that keeps the name legible on it answers to the device.
    [".sim-ax-label", "on the device's own screen"],
    // Matching the native WebContentsView's own opaque white, so the sliver it trails during a
    // resize cannot flash the panel tone through the gap.
    [".browser-view-host", "the browser view's own ground"],
    // White on a red fill, the same as white on the accent fill (--rl-accent-contrast), which is
    // deliberately one value for both modes.
    [".btn.destructive", "ink on a filled control"],
    // The base half of a pair: the rule immediately below it flips the outline for light mode.
    [".md img", "paired with a light override"],
    // The base half of a pair, like `.md img` above it: a Quick Look render is a picture on the
    // pane's own ground, and the rule below flips its outline for light mode.
    [".ql-page", "paired with a light override"],
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
    for (const sel of [".md img", ".ql-page"]) {
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
    // Each of these is drawn ON something that is the same in both modes — the terminal's own dark
    // interior, or a picture the user attached — so a light override would be the bug. They are
    // tokens rather than literals precisely so that reading is available to the next sweep.
    for (const token of ["--rl-terminal-ink", "--rl-terminal-ink-dim", "--rl-on-media"])
      expect(lightBlocks, token).not.toContain(token);
    expect(bodiesFor(".terminal-hint-path").join(" ")).toContain("color: var(--rl-terminal-ink)");
    expect(bodiesFor(".attach-remove").join(" ")).toContain("color: var(--rl-on-media)");
    // Same case, one level up: a filled control's lit top edge. The fill under it is a saturated
    // accent in both modes and the light still comes from above.
    expect(lightBlocks).not.toContain("--fill-bevel");
    for (const sel of [".btn.primary", ".composer-send", ".btn.destructive"])
      expect(bodiesFor(sel).join(" "), sel).toContain("box-shadow: var(--fill-bevel)");
  });

  it("a token defined for one mode only is a token that would carry a dark value into light", () => {
    // --grid-line and --shadow-glass-inset were both declared in the dark block alone and referenced
    // nowhere. That is worse than unused: the first thing to reach for one would have got a dark
    // value in light mode with nothing reporting it.
    for (const gone of ["--grid-line", "--shadow-glass-inset"]) expect(tokens, gone).not.toContain(gone);
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
    const dark = tokens.slice(tokens.indexOf("--line: var(--overlay-lighten-300)"));
    const light = tokens.slice(tokens.indexOf("--line: var(--overlay-darken-200)"));

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

  it("resize handles carry no transition or animation — a drag must track the pointer exactly", () => {
    for (const r of RULES.filter((x) => x.selectors.some((s) => s.startsWith(".resize-handle")))) {
      expect(r.body, r.selectors.join(",")).not.toContain("transition");
      expect(r.body, r.selectors.join(",")).not.toContain("animation");
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

  it("a page pane can shrink to its slot — otherwise it is painted over by the pane beside it", () => {
    // A pane is a flex ITEM, and a flex item's default `min-width: auto` floors it at its content's
    // min-content width. Without this, a page whose content did not fit grew PAST its slot and the
    // neighbouring pane painted over the overflow — `elementFromPoint` in the covered strip returned
    // the neighbour, so the buttons there could not be clicked. Found by driving the real app with
    // three panes open (Sessions overflowed by 179px, the Tasks lens by 247px). jsdom has no layout,
    // so this line is the only thing in the suite that can notice it going away.
    expect(bodiesFor(".page").join(" ")).toContain("min-width: 0");
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

  it("the header's indent is built from the SAME two numbers the rail is", () => {
    /* The title now starts where the content column does, which on a railed page means clearing the
       rail. Written as a literal, that number silently stops matching the moment the rail moves —
       so the indent is `calc(gutter + rail + gap)` off the variables, and this is what says so. */
    const indent = decl(".page:has(.page-rail) .page-head", "padding-left");
    expect(indent).toContain("--page-rail-w");
    expect(indent).toContain("--page-rail-gap");
    expect(decl(".page-rail", "width")).toBe("var(--page-rail-w)");
    expect(decl(".page-body", "gap")).toBe("var(--page-rail-gap)");
  });

  it("head, rail and content are ONE centred block — the title stays over the column it introduces", () => {
    // The mutant: drop `.page-head` from this rule. The form centres itself in the pane and the title
    // that names it stays at the pane's left edge, introducing nothing.
    const band = RULES.filter((r) => r.selectors.includes(".page-head") && r.body.includes("margin-inline: auto"));
    expect(band).toHaveLength(1);
    for (const sel of [".page-body", ".profile-spaces"]) expect(band[0]!.selectors).toContain(sel);
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

  it("the notifications feed takes the shared reading column, opting out in NEITHER direction", () => {
    /* Two reversals, and the second is the subtle one. It used to opt out UPWARD, to a 968px
       two-column page whose detail half stood empty until something was selected. Capping the feed
       narrower and centring it looked like the fix, and was not: the page then centred the cards and
       the header independently, leaving the title 76px to the left of the list it names. */
    expect(decl(".notif-feed", "max-width")).toBe("none");
    expect(MEASURES.has(".notifications-page-pane")).toBe(false);
  });

  it("no cap can bind inside the narrow pass, so the two never fight", () => {
    // Every measure is wider than the widest pane the responsive rules claim (the notifications
    // split's 760). Below them a page is full-bleed and the cap is inert; above them nothing
    // re-flows. A measure that fell between would centre a page that was busy standing itself up.
    expect(MEASURES.size, "no --page-measure rules found — the sweep below would pass vacuously")
      .toBeGreaterThanOrEqual(3);
    for (const [sel, value] of MEASURES) expect(value, sel).toBeGreaterThan(760);
  });

  it("the profile page's chip strip is a band of the page, and can still shed its gutter when narrow", () => {
    // Its own rule sits BELOW the narrow block. Stated there, `padding-inline: 24px` would beat the
    // query's 16px — a container query carries no extra specificity — and the chips would hang past
    // the head at every narrow width.
    const base = css.indexOf(".profile-spaces { padding-inline: 24px");
    const narrow = css.indexOf(".profile-spaces { padding-inline: 16px");
    expect(base).toBeGreaterThan(-1);
    expect(narrow).toBeGreaterThan(base);
    // A `margin` shorthand anywhere would zero the auto that centres it.
    for (const body of bodiesFor(".profile-spaces")) expect(body, body).not.toMatch(/(^|;\s*)margin:/);
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
    // The notifications page declared its own container first; hoisting it to `.page` is what lets
    // every page share the breakpoints. A re-declaration would be a second, narrower container
    // shadowing the shared one.
    expect(RULES.filter((r) => r.selectors.includes(".notifications-page-pane"))).toHaveLength(0);
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

  it("the panel bar spends a narrow pane on identity: meta goes, then the trail, never the title", () => {
    expect(blockAfter("@container (max-width: 380px)")).toMatch(/\.panel-meta \{[^}]*display: none/);
    expect(blockAfter("@container (max-width: 300px)")).toMatch(/\.panel-nav \{[^}]*display: none/);
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

  it("the notifications feed needs no narrow pass at all", () => {
    /* There was a 760px threshold here that stacked a two-column split. The split is gone — one
       measured column of cards reflows on its own — and a container query for a layout that no
       longer exists is the kind of dead rule the next person spends an afternoon on. */
    expect(css).not.toContain(".notif-split");
    expect(css).not.toContain(".notif-detail {");
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
    const shared = RULES.filter((r) => r.selectors.some((s) => s.includes(".fd-") && s.includes(".diff-")));
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
    // Both columns must run the same mono line-height or the numbers drift off their lines.
    expect(gutter).toContain("11.5px/1.65 var(--font-mono)");
    expect(bodiesFor(".code-body").join(" ")).toContain("12px/1.65 var(--font-mono)");
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
      const derived = deriveVars({
        bg: hexIn("--page", block), ink: hexIn("--ink", block), accent: hexIn("--accent", block),
        green: hexIn("--green", block), orange: hexIn("--orange", block), red: hexIn("--red", block),
        // The same role mapping the base --syn-* block states, so the seeds are Realm's own.
        syntax: { comment: hexIn("--ink-3", block), keyword: hexIn("--accent", block), string: hexIn("--green", block),
          number: hexIn("--orange", block), title: hexIn("--ink", block), type: hexIn("--ink", block), attr: hexIn("--ink-2", block) },
      }, mode);

      // The surface ladder and the tooltip chip are pure geometry off the seed: they have to land on
      // the shipped lightness to finer than a display can resolve.
      for (const token of ["--canvas", "--surface", "--inset", "--hover", "--hover-2", "--field",
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
      for (const [role, token] of [["bg", "--page"], ["ink", "--ink"], ["accent", "--accent"],
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
 * The machine pane's surfaces (Plan 25 W3).
 *
 * Every rule here exists because the surface underneath is ARBITRARY — a stranger's desktop, which
 * may be any colour and is white far more often than not. That is a different problem from every
 * other pane in the app, and the answers are easy to undo by someone tidying up.
 */
describe("the machine pane's screen", () => {
  it("letterboxes on the terminal's ground, not the canvas token", () => {
    // A guest desktop must not fight a near-white surround in light mode — the ruling
    // `.terminal-pane` already writes down for its own interior. `--canvas` is the working plane's
    // colour and would put a pale border around a pale screen in exactly the mode it shows most.
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
it("carries the prompter's mode ring up through every strip stacked above it", () => {
  for (const [mode, token] of [["plan", "--rl-warning"], ["ask", "--rl-success"]] as const) {
    for (const strip of [".composer-agents", ".composer-goal", ".composer-todos", ".composer-overstrip"]) {
      const painted = bodiesFor(`:root[data-squircle] ${strip}:has(~ .composer[data-mode="${mode}"])`).join(" ");
      expect(painted, `${strip} under ${mode}`).toContain(token);
      // The painter is gated, so the fallback edge has to say the same thing.
      const fallback = bodiesFor(`${strip}:has(~ .composer[data-mode="${mode}"])`).join(" ");
      expect(fallback, `${strip} fallback under ${mode}`).toContain(token);
      expect(fallback, `${strip} fallback hairline`).toContain("var(--hairline-w)");
    }
  }
});
