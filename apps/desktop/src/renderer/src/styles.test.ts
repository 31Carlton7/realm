import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveVars, oklchToHex, themeSwatches } from "@realm/ui";

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
      "--dur-drag": 80, "--dur-hover": 100, "--dur-press": 120, "--dur-pop": 140, "--dur-fast": 150,
      "--dur-swap": 160, "--dur-enter": 180, "--dur-base": 200, "--dur-rise": 220, "--dur-slow": 240,
      "--dur-move": 320,
    });
  });

  it("no component writes a duration of its own", () => {
    // The failure mode this closes is the one the ladder was built to end: four tokens existed, two
    // of them with no users at all, while 41 `transition:` declarations wrote their own literals —
    // so the ladder documented a system the stylesheet was not on.
    const bare = new Set([...css.replace(/\/\*[\s\S]*?\*\//g, "")
      .matchAll(/(?:transition|animation)[^;{}]*?(?<![\d.])([\d.]+m?s)\b/g)].map((m) => m[1]!));
    // Loop PERIODS are a tempo, not the duration of a change, and the stagger step is a delay
    // between siblings rather than a duration at all. Neither belongs on the ladder.
    for (const period of ["0.9s", "1.4s", "3.6s", "5s", "40ms"]) bare.delete(period);
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

  it("hover fills run 100ms on plain `ease` and touch background/colour only — never geometry", () => {
    const hover = bodiesFor(".item-row").join(" ");
    expect(hover).toContain(`transition: background-color ${dur("--dur-hover")} ease, color ${dur("--dur-hover")} ease`);
    expect(hover).not.toContain("transform");
  });

  it("pressables scale to .97 over 120ms", () => {
    const press = bodiesFor(".ghost-chip").join(" ");
    expect(press).toContain(`transform ${dur("--dur-press")} var(--ease-out-strong)`);
    for (const sel of [".btn:active:not(:disabled)", ".icon-btn:active:not(:disabled)", ".composer-send:active:not(:disabled)"])
      expect(bodiesFor(sel).join(" "), sel).toContain("transform: scale(.97)");
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

  it("the copy ✓ swap uses the same 160ms opacity/scale/blur cross-fade as send↔stop", () => {
    const swap = bodiesFor(".tool-copy .copy-icon").join(" ");
    for (const prop of ["opacity", "transform", "filter"]) expect(swap, prop).toContain(`${prop} ${dur("--dur-swap")}`);
    expect(bodiesFor(".tool-copy:not([data-copied]) .copied-icon").join(" ")).toContain("blur(4px)");
  });

  it("W2's prompter hero→docked move keeps its 320ms ease-in-out-strong (§6 assigns that easing to on-screen movement)", () => {
    expect(bodiesFor(".composer-dock").join(" ")).toContain(`transition: transform ${dur("--dur-move")} var(--ease-in-out-strong)`);
  });

  it("W2's suggestion-chip stagger keeps §6's 220ms / 40ms steps / 8px rise", () => {
    const stagger = bodiesFor(".suggestions[data-animate] .suggestion-chip").join(" ");
    expect(stagger).toContain(`rl-chip-in ${dur("--dur-rise")} var(--ease-out-strong)`);
    // The step stays a literal: it is a delay BETWEEN siblings, not the duration of one of them.
    expect(stagger).toContain("calc(var(--i) * 40ms)");
    expect(blockAfter("@keyframes rl-chip-in")).toContain("translateY(8px)");
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
  it("the user message is Ara's signature: raised card, window radius (BUI 14), 14px 16px padding, 85% wide, left-aligned text", () => {
    // Plan 9 W1 re-pin: the literal 14px became var(--r-float), which the bridge pins to BUI's
    // --radius-window (14px) — same geometry, now on the token scale.
    const body = bodiesFor(".msg-user").join(" ");
    for (const decl of ["text-align: left", "max-width: 85%", "border-radius: var(--r-float)", "padding: 14px 16px", "background: var(--rl-raised)"])
      expect(body, decl).toContain(decl);
  });

  it("transcript prose reads at 15px/1.6 — user card and assistant prose alike", () => {
    for (const sel of [".msg-user", ".msg-assistant"]) {
      const body = bodiesFor(sel).join(" ");
      expect(body, sel).toContain("font-size: 15px");
      expect(body, sel).toContain("line-height: 1.6");
    }
  });

  it("suggestions are a single-column list, not a grid", () => {
    const body = bodiesFor(".suggestions").join(" ");
    expect(body).toContain("flex-direction: column");
    expect(body).not.toContain("grid");
    expect(bodiesFor(".suggestion-chip").join(" ")).toContain("background: transparent"); // transparent at rest, --rl-hover on hover
    expect(bodiesFor(".suggestion-chip:hover").join(" ")).toContain("var(--rl-hover)");
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

  it("a hovered chip is the same chip lifted, never a new shape", () => {
    expect(bodiesFor(".ch-element[data-hot]").join(" ")).toContain("background: var(--rl-hover)");
    expect(bodiesFor(".ch-mention[data-hot]").join(" ")).toContain("var(--rl-accent) 26%");
    // At rest this run wears no pill, and growing one under the pointer would read as an element
    // chip — a token that resolves to nothing dressing up as one that resolves to something.
    expect(bodiesFor(".ch-mention-stale[data-hot]").join(" ")).not.toContain("box-shadow");
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

  it("the radius scale is tembo's: tick 2, chip 6, control 8, card 12 (rows + panels), window 16", () => {
    const root = css.match(/:root \{([^}]*)\}/)?.[1] ?? "";
    for (const decl of ["--r-sm: 2px", "--r-chip: 6px", "--r-ctl: 8px", "--r-row: 12px", "--r-panel: 12px", "--r-float: 16px"])
      expect(root, decl).toContain(decl);
    // No component may dodge the scale with a hardcoded control-ish radius (ticks/dots/pills excepted).
    expect(css).not.toMatch(/border-radius:\s*(?:4|6|8|10|12|14|16)px/);
  });

  it("the weight ladder is four named rungs on tembo's values — no bare weight survives in a component rule", () => {
    const root = css.match(/:root \{([^}]*)\}/)?.[1] ?? "";
    // 450/500/560/600. The old 500/550/600/650 spread had two rungs nobody could tell apart.
    expect(root).toContain("--fw-medium: 450");
    expect(root).toContain("--fw-label: 500");
    expect(root).toContain("--fw-title: 560");
    expect(root).toContain("--fw-strong: 600");
    // Everything but the @font-face ranges and the two deliberate 400s goes through the ladder.
    const bare = [...css.matchAll(/font-weight:\s*(\d+)\s*;/g)].map((m) => m[1]);
    expect(bare.filter((w) => w !== "400")).toEqual([]);
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
    expect(bodiesFor("html, body, #root".split(", ")[0]!).join(" ")).toContain("font: 14px/20px var(--font-ui)");
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
    expect(bodiesFor(".permission-footer").join(" ")).toContain("border-top: 1px solid var(--line)");
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
    expect(bodiesFor(".tool-group-steps").join(" ")).toContain("border-left: 1px solid var(--line)");
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

  it("fenced code is CodeBlock's editor panel: surface + hairline ring, a language header, 12.5/1.65 mono body", () => {
    const panel = bodiesFor(".md-code").join(" ");
    expect(panel).toContain("background: var(--surface)");
    expect(panel).toContain("box-shadow: var(--shadow-hairline)");
    expect(bodiesFor(".md-code-head").join(" ")).toContain("border-bottom: 1px solid var(--line)");
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

  it("the commit dock wears that same card, on nothing: no fill behind it, no rule above it", () => {
    const card = bodiesFor(".commit-card").join(" ");
    expect(card).toContain("background: var(--surface)");
    expect(card).toContain("box-shadow: var(--shadow-card)");
    expect(bodiesFor(".commit-card:focus-within").join(" ")).toContain("0 0 0 1px var(--line-strong)");
    // The removed form: the dock used to be a raised strip behind a hairline. Both must stay gone —
    // the list already dissolves into the card through .diff-fade, and either one draws that seam twice.
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

  it("the changes list clears the whole fade, and reads its height from the same --fade-h the ramp does", () => {
    // Scrolled to the end, the last row must not sit in the blur. A fraction of the band (it was
    // 20px against 44) left the filename you scrolled down for smeared under the ramp.
    expect(bodiesFor(".diff-list").join(" ")).toContain("padding-bottom: var(--fade-h)");
    expect(bodiesFor(".diff-list-wrap").join(" ")).toContain("--fade-h: 44px");
    // One declaration of the number: a second one on the fade itself is how the two drift apart.
    expect(RULES.filter((r) => r.selectors.includes(".diff-fade")).map((r) => r.body).join(" ")).not.toContain("--fade-h:");
  });

  it("the sidebar list clears its own fade the same way, and dissolves with blur alone", () => {
    // Same invariant as the changes list: a full band of padding, and ONE declaration of the number,
    // so the ramp and the clearance that keeps the last session out of it cannot drift apart.
    expect(bodiesFor(".space-body").join(" ")).toContain("padding-bottom: var(--fade-h)");
    expect(bodiesFor(".space-page").join(" ")).toContain("--fade-h: 44px");
    expect(RULES.filter((r) => r.selectors.includes(".space-fade")).map((r) => r.body).join(" ")).not.toContain("--fade-h:");
    expect(bodiesFor(".space-fade").join(" ")).toContain("height: var(--fade-h)");
    // No colour wash, unlike the transcript's: that one washes to --rl-panel because it docks a card
    // and needs solid pane above it. This column is macOS vibrancy, so a ramp to any fixed tone would
    // paint a stripe the material shows through. Verified on screen — sidebar-fade-live.mjs measures
    // the band over empty gutter and holds it to the surrounding column's luminance.
    // RULES flattens @media, so the two layers are identified by what they declare rather than by
    // where they sit: the blurring rule is the one carrying the blur, and it must carry no colour.
    const blurring = bodiesFor(".space-fade::after").filter((b) => b.includes("backdrop-filter: blur("));
    expect(blurring, "the heavy blur layer").toHaveLength(1);
    expect(blurring[0], "a colour wash on the blurring layer would stripe the material").not.toContain("background:");
    expect(bodiesFor(".space-fade::before").filter((b) => b.includes("backdrop-filter: blur("))).toHaveLength(1);
    // …and the wash exists exactly once in the whole sheet: the reduced-transparency fallback below.
    expect(bodiesFor(".space-fade::after").filter((b) => b.includes("background:"))).toHaveLength(1);
  });

  it("reduced transparency swaps the sidebar fade's medium rather than removing it", () => {
    // The transcript can drop its blur and keep its wash. This fade has no wash to fall back on, so
    // dropping the blur alone would hand back the hard cut it exists to prevent — it gains the ramp
    // in the same breath, in the one condition where a fixed tone composites cleanly here (macOS
    // renders the vibrancy material opaque under this preference).
    const reduced = blockAfter("@media (prefers-reduced-transparency: reduce)").replace(/\s+/g, " ");
    expect(reduced).toContain(".space-fade::before");
    expect(reduced).toContain("linear-gradient(to bottom, transparent 0, var(--page) 88%)");
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
    expect(soft).toContain("backdrop-filter: blur(5px)");
    expect(soft).toContain("mask-image: radial-gradient");
    // A masked ancestor becomes a backdrop root and its children blur an EMPTY backdrop, so the mask
    // has to sit on the blurring layer itself — the trap the transcript's fade band documents.
    expect(glow).not.toContain("mask-image");
  });

  it("the glow appears on the drag rung, and reduced motion is what takes the fade away", () => {
    // `--dur-drag` is the ladder's rung for exactly this: a drop target appearing mid-drag.
    expect(bodiesFor(".session-drop").join(" ")).toContain(`animation: rl-fade-in ${dur("--dur-drag")} linear`);
    // Reduced motion needs no rule of its own here: the blanket `*` kill covers a real element (it
    // would NOT cover a pseudo-element, which is why the glow is one).
    expect(blockAfter("@media (prefers-reduced-motion: reduce)")).toContain("animation: none !important");
  });

  it("reduced transparency drops the glow's blur and keeps the ring that carries the meaning", () => {
    const reduced = blockAfter("@media (prefers-reduced-transparency: reduce)").replace(/\s+/g, " ");
    expect(reduced).toContain(".session-drop::before { backdrop-filter: none");
    // Only the blur goes. The ring is on `.session-drop` itself and is never touched here — a
    // preference about translucency must not take the affordance away.
    expect(reduced).not.toContain(".session-drop {");
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
    // thing this replaced.
    expect(tile).toContain("width: 44px");
    expect(tile).toContain("height: 44px");
    const art = bodiesFor(".attach-art").join(" ");
    expect(art).toContain("background: var(--field)");
    expect(art).toContain("box-shadow: var(--shadow-hairline)");
    // The well clips the picture; the TILE must not, or it would clip its own hover tip off.
    expect(art).toContain("overflow: hidden");
    expect(tile).not.toContain("overflow: hidden");
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

  it("warning pills speak the orange tone pair (StatusPill), not the old color-mix formula", () => {
    const pill = bodiesFor(".bypass-confirm").join(" ");
    expect(pill).toContain("color: var(--orange)");
    expect(pill).toContain("background: var(--orange-tint)");
    expect(bodiesFor('.ghost-chip[data-warning]').join(" ")).toContain("var(--orange-tint)");
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

  it("the sidebar search is SidebarNav's field: field fill behind a hairline ring at 13/500; rows and labels take BUI's 8px/12.5px", () => {
    const search = bodiesFor(".search").join(" ");
    expect(search).toContain("background: var(--field)");
    expect(search).toContain("box-shadow: var(--shadow-hairline)");
    expect(search).toContain("font-size: 13px");
    expect(bodiesFor(".item").join(" ")).toContain("border-radius: var(--r-ctl)");
    expect(bodiesFor(".group-label").join(" ")).toContain("font-size: 12.5px");
  });

  it("buttons are BUI Button's tiers: secondary = surface on shadow-btn stepping to inset; primary = accent with the filled highlight and accent-ink hover", () => {
    const btn = bodiesFor(".btn").join(" ");
    expect(btn).toContain("background: var(--surface)");
    expect(btn).toContain("box-shadow: var(--shadow-btn)");
    expect(bodiesFor(".btn:hover:not(:disabled)").join(" ")).toContain("background: var(--inset)");
    const primary = bodiesFor(".btn.primary").join(" ");
    expect(primary).toContain("box-shadow: var(--fill-bevel)");
    expect(bodiesFor(".btn.primary:hover:not(:disabled)").join(" ")).toContain("background: var(--accent-ink)");
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

  it("the legacy ::-webkit-scrollbar rules are gone, not merely overridden", () => {
    // They had been inert since Chromium 121 — setting either standard property makes the browser
    // ignore the pseudo-elements outright, and every selector they targeted also set
    // `scrollbar-width: thin`. Re-adding one would read as styling that does nothing.
    expect(css).not.toContain("::-webkit-scrollbar");
  });

  it("every scroller in the stylesheet has had a deliberate decision made about its bar", () => {
    // The regression this closes is how the app got here: nine containers were styled by hand and
    // every scroller added afterwards shipped with the default bar and a visible track.
    const covered = new Set(SCROLLERS.map(leaf));
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
    expect(bodiesFor(".diff-file[data-open] + .diff-file").join(" ")).toContain("border-top: 1px solid");
  });

  it("the seams where content passes under a fixed edge are kept", () => {
    // These are the ones that stop being decoration the moment anything scrolls: a pane's own bar, a
    // sticky head over a list, a card's head over its body, a popover's search field over its rows.
    for (const sel of [".panel-bar", ".diff-head", ".fd-head", ".md-code-head", ".mp-search", ".palette-input", ".spaces-search"])
      expect(bodiesFor(sel).join(" "), sel).toMatch(/border-bottom: 1px solid/);
    // Footers hold their place while the body scrolls past them.
    for (const sel of [".permission-footer", ".question-footer", ".spaces-foot", ".mp-detail-foot"])
      expect(bodiesFor(sel).join(" "), sel).toMatch(/border-top: 1px solid/);
    // A table's rules ARE its structure, and the sidebar's edge is the app's one column boundary.
    expect(bodiesFor(".md th").join(" ")).toContain("border-bottom: 1px solid");
    expect(bodiesFor(".usage-table th").join(" ")).toContain("border-bottom: 1px solid");
    expect(bodiesFor(".sidebar").join(" ")).toContain("border-right: 1px solid");
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
  const SURFACES = [".composer", ".composer-drop-hint", ".composer-understrip", ".install-card", ".commit-card"];

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

  it("the ring moves to the painter and the lift stays on box-shadow", () => {
    // A box-shadow ring is drawn on the rounded rect whatever the fill does, so under the gate —
    // where the radius is 0 — a focus ring left on box-shadow would square the corner off. The lift
    // is the opposite case: blurred far wider than the two curves diverge, so it stays put, and
    // keeping it there is what a mask would have cost.
    for (const sel of [".composer", ".commit-card"]) {
      expect(bodiesFor(`:root[data-squircle] ${sel}`).join(" "), sel).toContain("box-shadow: var(--shadow-card-lift)");
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
    [".attach-remove", "on the attached picture"], [".attach-remove:hover", "on the attached picture"],
    // Matching the native WebContentsView's own opaque white, so the sliver it trails during a
    // resize cannot flash the panel tone through the gap.
    [".browser-view-host", "the browser view's own ground"],
    // White on a red fill, the same as white on the accent fill (--rl-accent-contrast), which is
    // deliberately one value for both modes.
    [".btn.destructive", "ink on a filled control"],
    // The base half of a pair: the rule immediately below it flips the outline for light mode.
    [".md img", "paired with a light override"],
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

  it("the one literal that is half a pair really does have its other half", () => {
    expect(bodiesFor(".md img").join(" ")).toContain("outline: 1px solid rgba(255, 255, 255, 0.1)");
    expect(bodiesFor(':root[data-mode="light"] .md img').join(" ")).toContain("outline-color: rgba(0, 0, 0, 0.1)");
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

  it("the command palette and its scrim are instant — ⌘K is a 100×/day action (Raycast rule)", () => {
    for (const sel of [".palette", ".palette-backdrop"]) {
      for (const body of bodiesFor(sel)) {
        expect(body.match(/animation:\s*([^;]*)/)?.[1]?.trim() ?? "none", `${sel} { ${body} }`).toBe("none");
        expect(body, `${sel} { ${body} }`).not.toContain("transition");
      }
    }
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

  it("resize handles carry no transition or animation — a drag must track the pointer exactly", () => {
    for (const r of RULES.filter((x) => x.selectors.some((s) => s.startsWith(".resize-handle")))) {
      expect(r.body, r.selectors.join(",")).not.toContain("transition");
      expect(r.body, r.selectors.join(",")).not.toContain("animation");
    }
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
    expect(busy).toContain("background: var(--rl-accent)");
    expect(bodiesFor('.btn:disabled[aria-busy="true"]').join(" ")).toContain("opacity: .7");
    // The distinction only exists if the plain disabled treatment is still the dimmer one.
    expect(bodiesFor(".btn.primary:disabled").join(" ")).toContain("background: var(--rl-raised)");
    expect(bodiesFor(".btn:disabled").join(" ")).toContain("opacity: .45");
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

  it("the notifications split waits for room for BOTH columns, not just the list", () => {
    // The list alone claims up to 480px, so the old 640 threshold left the detail a 140px gutter
    // that could not hold a title.
    expect(blockAfter("@container (max-width: 760px)")).toMatch(/\.notif-split \{[^}]*flex-direction: column/);
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
    // packages/ui/src/themes.ts derives every theme from twelve seeds using ramp constants its
    // comments claim were measured off THIS file. That claim is only worth anything if something
    // re-measures it, so: take the seeds out of tokens.css, run them through the same derivation
    // every theme goes through, and require that what comes back IS tokens.css.
    //
    // THE drifted-ramp mutant: nudge any offset in DARK or LIGHT — the ΔL of --hover, an ink
    // exponent, the tooltip's inversion. Every theme still clears every contrast floor, because the
    // floors are about legibility and this is about SHAPE; only this notices that the derived
    // palettes have stopped being the same system as the one they sit beside.
    const L = (name: string, block: string): number => {
      const m = new RegExp(`${name}: oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)`).exec(block);
      expect(m, `${name} is not a plain oklch value in tokens.css`).not.toBeNull();
      return Number(m![1]);
    };
    const hex = (name: string, block: string): string => {
      const m = new RegExp(`${name}: oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)`).exec(block)!;
      return oklchToHex({ l: Number(m[1]), c: Number(m[2]), h: Number(m[3]) });
    };
    const derivedL = (v: string): number => Number(/^oklch\(([\d.]+)/.exec(v)![1]);

    for (const mode of ["dark", "light"] as const) {
      const at = tokens.indexOf(mode === "dark" ? ":root {\n  color-scheme: dark" : ':root[data-mode="light"] {');
      expect(at, `no ${mode} token block in tokens.css`).toBeGreaterThan(-1);
      const block = tokens.slice(at, tokens.indexOf("\n}", at));
      // The seeds are read back out of the palette rather than written here, so this cannot drift
      // by someone updating tokens.css and the copy in the test to match each other.
      const derived = deriveVars({
        bg: hex("--page", block), ink: hex("--ink", block), accent: hex("--accent", block),
        green: hex("--green", block), orange: hex("--orange", block), red: hex("--red", block),
        // The same role mapping the base --syn-* block states, so the seeds are Realm's own.
        syntax: { comment: hex("--ink-3", block), keyword: hex("--accent", block), string: hex("--green", block),
          number: hex("--orange", block), title: hex("--ink", block), type: hex("--ink", block), attr: hex("--ink-2", block) },
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
    // themeSwatches cannot read the live values — under any other theme they are that theme's — so
    // it carries four literals. This is the pin that keeps the copy honest.
    for (const mode of ["dark", "light"] as const) {
      for (const value of themeSwatches("realm", mode)) expect(tokens, `${mode} ${value}`).toContain(value);
    }
  });
});
