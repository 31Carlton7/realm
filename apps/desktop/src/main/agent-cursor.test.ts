import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_CURSOR, AGENT_MOTION } from "./agent-cursor";
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

  /* 0.96 is what design.md permits a control's press, and it is the wrong number for a 14px box:
     0.96 of 14px is a little over half a pixel, which is the failure `styles.css` already writes
     down about "a 6px circle changing brightness by a third". The ratio is chosen against the box.
     The mutant is someone "restoring the token": at 0.96 the press is invisible and the mark stops
     saying anything happened. */
  it("contracts by enough to be seen at the size it is actually drawn", () => {
    const travelled = AGENT_CURSOR.size * (1 - AGENT_CURSOR.pressScale);
    expect(travelled).toBeGreaterThanOrEqual(2);
  });

  /* The core is what says WHERE — it is the pixel the input went to. It has to survive inside the
     stroke, or the mark is a ring with nothing in it. */
  it("leaves room inside the stroke for the core", () => {
    expect(AGENT_CURSOR.core + 2 * AGENT_CURSOR.stroke).toBeLessThan(AGENT_CURSOR.size);
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
