import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_CURSOR, AGENT_CURSOR_FORMS, AGENT_MOTION, CURSOR_FORM_FOR_CSS, type CursorFormName } from "./agent-cursor";
import { LINGER_MS } from "./computer-driving";

/* Vite rewrites `import.meta.url` to a non-file scheme under jsdom, so walk up from the cwd — the
   same trick `styles.test.ts` uses, and for the same reason. */
function repoFile(rel: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) { const p = join(dir, rel); if (existsSync(p)) return p; dir = dirname(dir); }
  throw new Error(`cannot locate ${rel} from ${process.cwd()}`);
}
const tokensCss = readFileSync(repoFile("apps/desktop/src/renderer/src/theme/tokens.css"), "utf8");
const stylesCss = readFileSync(repoFile("apps/desktop/src/renderer/src/styles.css"), "utf8");

describe("the agent cursor's number table", () => {
  /* Realm now has two indicators that coalesce a burst of agent acts into one continuous showing:
     the menu-bar item computer use puts up, and the mark the browser agent leaves in the page. They
     answer the same question — how long after the last act does an agent stop counting as driving —
     and a user watching both at once would see one of them give up first for no reason they could
     name. Held equal here rather than merely commented, because a comment does not fail. */
  it("gives up on the same deadline the menu-bar driving indicator does", () => {
    expect(AGENT_CURSOR.idleMs).toBe(LINGER_MS);
  });

  /* 0.96 is what design.md permits a control's press, and it is the wrong number for a 20px glyph:
     0.96 of 20px is under a pixel of travel at the tip, which is the failure `styles.css` already
     writes down about "a 6px circle changing brightness by a third". The ratio is chosen against the
     box. The mutant is someone "restoring the token": at 0.96 the press is invisible and the mark
     stops saying anything happened. */
  it("contracts by enough to be seen at the size it is actually drawn", () => {
    const travelled = AGENT_CURSOR.size * (1 - AGENT_CURSOR.pressScale);
    expect(travelled).toBeGreaterThanOrEqual(2);
  });

  /* The mark SWAPS position, and the token that names that is `--dur-swap`. `--dur-move` is
     "something travelling across the pane", and nothing travels: all three mouse events fire at the
     same point. Reaching for the longer duration would put the lie in the tokens rather than in the
     pixels, which is exactly the mutant this catches. */
  it("swaps rather than travels, and enters slower than it swaps", () => {
    expect(AGENT_MOTION.swapMs).toBe(160);
    expect(AGENT_MOTION.swapMs).toBeLessThan(AGENT_MOTION.enterMs);
    expect(AGENT_MOTION.pressMs).toBeLessThan(AGENT_MOTION.swapMs);
  });
});

/**
 * The drawn pointers.
 *
 * There is no test here that a hand looks like a hand — that is what `agent-cursor-live.cjs`'s crops
 * are for, and a human looking at them. What IS mechanical is everything the shapes have to satisfy
 * to be placed correctly, and every one of these has a mutant that makes the pointer point at the
 * wrong pixel while still looking perfectly fine in a screenshot.
 */
describe("the cursor forms", () => {
  const names = Object.keys(AGENT_CURSOR_FORMS) as CursorFormName[];

  it("anchors the size knob to the arrow it is named after", () => {
    expect(AGENT_CURSOR.size).toBe(AGENT_CURSOR_FORMS.default.box[1]);
  });

  /* The hotspot IS the act's point. A hotspot outside its own glyph's box would place the mark so
     the visible pointer sits somewhere else entirely — and nothing about the drawing would look
     wrong, which is what makes this worth asserting rather than eyeballing. */
  it("keeps every hotspot inside the glyph it belongs to", () => {
    for (const name of names) {
      const { box, hot } = AGENT_CURSOR_FORMS[name];
      expect(hot[0], `${name} hotspot x`).toBeGreaterThanOrEqual(0);
      expect(hot[1], `${name} hotspot y`).toBeGreaterThanOrEqual(0);
      expect(hot[0], `${name} hotspot x`).toBeLessThanOrEqual(box[0]);
      expect(hot[1], `${name} hotspot y`).toBeLessThanOrEqual(box[1]);
    }
  });

  /* Each form's hotspot is the one its platform uses, and they genuinely differ: an arrow points
     from its tip, a hand from its fingertip, an I-beam from its middle. Collapsing them all to the
     centre — the shape the mark had when it was a circle — is the mutant, and it moves the arrow
     ten pixels down and to the right of the pixel that was actually clicked. */
  it("puts each hotspot where that pointer's own is, not at the centre", () => {
    expect(AGENT_CURSOR_FORMS.default.hot).toEqual([1, 1]);                 // the arrow's tip
    expect(AGENT_CURSOR_FORMS.pointer.hot[1]).toBe(1);                      // the fingertip, at the top
    expect(AGENT_CURSOR_FORMS.text.hot).toEqual([4, 10]);                   // the I-beam's middle
    expect(AGENT_CURSOR_FORMS["not-allowed"].hot).toEqual([10, 10]);        // the barred circle's centre
    for (const name of ["default", "pointer"] as const) {
      const { box, hot } = AGENT_CURSOR_FORMS[name];
      expect(hot[1], `${name} points from its top, not its middle`).toBeLessThan(box[1] / 2);
    }
  });

  it("draws every path inside its own box, so nothing is authored off the glyph", () => {
    for (const name of names) {
      const [w, h] = AGENT_CURSOR_FORMS[name].box;
      for (const { d } of AGENT_CURSOR_FORMS[name].paths) {
        // Every coordinate pair in the path data, arc radii and flags included — a crude read, but
        // a negative number or one past the box is exactly what it needs to catch.
        for (const n of d.match(/-?\d+(\.\d+)?/g) ?? []) {
          expect(Number(n), `${name}: ${n} in ${d.slice(0, 40)}…`).toBeGreaterThanOrEqual(0);
          expect(Number(n), `${name}: ${n} in ${d.slice(0, 40)}…`).toBeLessThanOrEqual(Math.max(w, h));
        }
      }
    }
  });

  /* The form comes from the page's own computed `cursor`, so the table is the whole mapping and the
     mutant is a keyword quietly pointing at the wrong glyph — `not-allowed` resolving to the arrow
     would turn "this control is disabled" into "this was an ordinary click". */
  it("maps each CSS keyword to the form that keyword means", () => {
    expect(CURSOR_FORM_FOR_CSS.pointer).toBe("pointer");
    expect(CURSOR_FORM_FOR_CSS.text).toBe("text");
    expect(CURSOR_FORM_FOR_CSS["vertical-text"]).toBe("text");
    expect(CURSOR_FORM_FOR_CSS["not-allowed"]).toBe("not-allowed");
    expect(CURSOR_FORM_FOR_CSS["no-drop"]).toBe("not-allowed");
    expect(CURSOR_FORM_FOR_CSS.default).toBe("default");
    // Every value in the table is a form that exists — an entry naming a glyph nobody drew falls
    // through to the arrow at runtime and says nothing about it.
    for (const form of Object.values(CURSOR_FORM_FOR_CSS)) expect(names).toContain(form);
    // `auto` is deliberately absent: it means "the browser decides", and only the page knows what it
    // decided. Adding it here would freeze one answer for every page.
    expect(CURSOR_FORM_FOR_CSS.auto).toBeUndefined();
    // And the forms Realm has NOT authored fall back rather than resolving to something else.
    for (const unauthored of ["grab", "grabbing", "move", "crosshair", "wait", "ew-resize"]) {
      expect(CURSOR_FORM_FOR_CSS[unauthored]).toBeUndefined();
    }
  });
});

/**
 * The mirror, kept honest.
 *
 * The marks are injected INTO a driven page, where `var(--dur-swap)` resolves to nothing at all — a
 * `WebContentsView` composites above every pixel Realm's own stylesheet paints, so there is no way
 * to reach them from `styles.css`. `agent-cursor.ts` therefore copies the handful of values they
 * need, and copies drift: change a duration in `tokens.css` and the page keeps the old one silently
 * unless something fails. This is that something.
 *
 * Read as text rather than imported, because `tokens.css` belongs to the renderer's tsconfig project
 * and this file belongs to main's. When the machine pane (Plan 25 W3) gives these numbers a second
 * READER in the renderer, the table moves to a shared package and this becomes an ordinary import.
 */
describe("the in-page marks mirror the app's motion ladder", () => {
  const token = (name: string): number => {
    const m = tokensCss.match(new RegExp(`--${name}:\\s*(\\d+)ms`));
    expect(m, `--${name} is not a ms value in tokens.css`).toBeTruthy();
    return Number(m![1]);
  };

  it("takes each duration from the token it is named after", () => {
    expect(AGENT_MOTION.pressMs).toBe(token("dur-press"));
    expect(AGENT_MOTION.fastMs).toBe(token("dur-fast"));
    expect(AGENT_MOTION.swapMs).toBe(token("dur-swap"));
    expect(AGENT_MOTION.enterMs).toBe(token("dur-enter"));
    // `--dur-swap`, and emphatically not `--dur-move` — see the swap/travel test above.
    expect(AGENT_MOTION.swapMs).not.toBe(token("dur-move"));
  });

  it("takes the app's own ease-out, character for character", () => {
    const m = tokensCss.match(/--ease-out-strong:\s*([^;]+);/);
    expect(m).toBeTruthy();
    expect(AGENT_MOTION.easeOutStrong).toBe(m![1]!.trim());
  });

  /* The frame pulses because something is in flight, which is the rule `.status-dot`'s ping already
     establishes — not a second animation with its own reasoning. It takes the SLOW rung of that
     family rather than the `driving` dot's 0.9s, because the dot is 13px and the frame is the whole
     viewport, and `styles.css` writes down why that difference decides the rate. */
  it("pulses at the in-flight ping's slow rate, not the 13px dot's", () => {
    expect(stylesCss).toContain(`--ring-rate: ${AGENT_MOTION.framePulseMs / 1000}s`);
    expect(stylesCss).toMatch(/\.status-dot\[data-status="driving"\]::after \{ --ring: var\(--rl-accent\); --ring-rate: 0\.9s; \}/);
  });
});
