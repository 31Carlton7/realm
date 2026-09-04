import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

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
    expect(bodiesFor(".tool-card[data-open] .tool-body-wrap").join(" ")).toContain("grid-template-rows: 1fr");
    expect(bodiesFor(".tool-body").join(" ")).toContain(`transition: opacity ${dur("--dur-press")} ease`);
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

  it("the sidebar keeps its vibrancy: BUI --page at 82%, one mode-agnostic rule", () => {
    expect(bodiesFor(".sidebar").join(" ")).toContain("color-mix(in srgb, var(--page) 82%, transparent)");
    // The old per-mode rgba override is gone — --page flips with data-mode on its own.
    expect(css).not.toContain("rgba(244,244,244,.82)");
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
    expect(bodiesFor(".tool-card[data-open] .tool-row").join(" "))
      .toContain("border-radius: var(--r-ctl) var(--r-ctl) 0 0");
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
    expect(bodiesFor(".commit-message").some((b) => b.includes("scrollbar-width: thin"))).toBe(true);
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
    expect(bodiesFor(".composer-send").join(" ")).toContain("inset 0 1px 0 rgba(255,255,255,0.14)");
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
    expect(primary).toContain("inset 0 1px 0 rgba(255,255,255,0.14)");
    expect(bodiesFor(".btn.primary:hover:not(:disabled)").join(" ")).toContain("background: var(--accent-ink)");
  });
});

/** The squircle surfaces. What the CORNER looks like is settled by scripts/squircle-live.mjs, which
 *  measures the composited pixels — jsdom has no layout and no CSS Painting API, so to it
 *  `background: paint(rl-squircle)` and `border-radius: 20px` are the same declaration. What is
 *  checkable here is everything around the shape: that the fallback survives, that the two halves of
 *  the card shadow cannot drift apart, and that the three files involved still agree on the names
 *  they pass between them. */
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

  it("syntax colour is the ink ramp plus four hues — a transcript is prose with code in it", () => {
    // `color:` only. A .hljs rule may also reach for the weight ladder (a title is 560, strong is
    // 600) and those are not hues — folding them in would make this assert the ladder twice and
    // fail the moment a rung is used where a bare weight used to be.
    const hues = new Set(RULES.filter((r) => r.selectors.some((s) => s.startsWith(".hljs")))
      .flatMap((r) => [...r.body.matchAll(/(?:^|[;{]|\s)color:\s*var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]!)));
    expect([...hues].sort()).toEqual(["--accent", "--green", "--ink", "--ink-2", "--ink-3", "--orange", "--red"]);
  });

  it("the todo bar is the one accent fill, and finished items are struck through rather than dropped", () => {
    expect(bodiesFor(".todo-fill").join(" ")).toContain("background: var(--rl-accent)");
    expect(bodiesFor('.todo-list li[data-status="completed"] .todo-text').join(" ")).toContain("line-through");
  });
});
