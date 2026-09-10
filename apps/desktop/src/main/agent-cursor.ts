/**
 * The numbers behind the agent's in-page cursor and the controlled-screen frame (Plan 25 W2).
 *
 * A module rather than literals at the injection site, for one reason: these marks are drawn in TWO
 * places that can never share code. On a browser or simulator pane the mark is injected INTO the page
 * over CDP, because a `WebContentsView` composites above all DOM and nothing the renderer draws can
 * reach it; on a machine pane (Plan 25 W3) the screen is a `<canvas>` and the mark is an ordinary DOM
 * overlay in `styles.css`. Two surfaces, two transports, one appearance — so the appearance is a
 * number table both read, and `styles.test.ts` asserts the parity. Anything more shared than this
 * table would be a false abstraction over surfaces with different physics.
 *
 * Deliberately free of Electron, CDP and CSS: importable from a renderer test as easily as from main.
 */

/** The mark's geometry and its press. */
export const AGENT_CURSOR = {
  /** 14px — the `control` rung of the size ladder documented in `Icon.tsx` ("a button's verb").
   *  It is drawn against arbitrary page content, so it has to read without being large enough to
   *  hide what it is pointing at. */
  size: 14,
  /** The accent ring around the mark. 2px rather than a hairline because one device pixel of accent
   *  over an unknown page is not reliably visible. */
  stroke: 2,
  /** The white core at the centre — the part that says WHERE, as opposed to the halo that says what. */
  core: 3,
  /**
   * The press contraction. 0.82, not the 0.96 design.md permits for controls: 0.96 of a 14px box is
   * half a pixel, which is the same failure `styles.css` writes down about "a 6px circle changing
   * brightness by a third". The ratio is chosen against the box, not copied from one.
   */
  pressScale: 0.82,
  /**
   * How long after the last act the mark (and the frame with it) fades itself out.
   *
   * Owned by the PAGE, not by main: a dead IPC, a crashed host or a lost `driving:false` must not be
   * able to leave a pointer stuck on someone's page. Reset on every placement, so a burst of acts is
   * one continuous showing rather than a flicker per click.
   *
   * The same 1500ms as `computer-driving.ts`'s `LINGER_MS`, and deliberately the same number: both
   * answer "how long after the last act does an agent stop counting as driving", and two answers to
   * one question is how they drift. `agent-cursor.test.ts` holds them equal.
   */
  idleMs: 1500,
} as const;

/**
 * The motion values, mirrored from `theme/tokens.css` because the page cannot read Realm's tokens —
 * an injected overlay lives in the site's stylesheet world, where `var(--dur-swap)` is nothing.
 * `styles.test.ts` asserts each of these still equals the token it is named after, so the mirror
 * cannot silently drift from the app it is imitating.
 */
export const AGENT_MOTION = {
  /** `--dur-press`: a control resolving inside the gesture that caused it. */
  pressMs: 120,
  /** `--dur-fast`: a fade with no gesture behind it — here, the dwell watchdog's exit. */
  fastMs: 150,
  /**
   * `--dur-swap`: one thing replacing another.
   *
   * Deliberately NOT `--dur-move` ("something travelling across the pane"), because the mark does not
   * travel. All three of `mouseMoved`/`mousePressed`/`mouseReleased` fire at the same point and the
   * page receives one instantaneous arrival, so a drawn traversal would depict a journey that never
   * happened — and a hover menu the drawn path crossed would not open, which is the drawing and the
   * page visibly disagreeing. Naming it travel would have put that lie in the tokens instead of the
   * pixels.
   */
  swapMs: 160,
  /** `--dur-enter`: an item arriving in a view that is already on screen — the mark's first fade-in. */
  enterMs: 180,
  /** `--ease-out-strong`. */
  easeOutStrong: "cubic-bezier(0.23, 1, 0.32, 1)",
  /**
   * The controlled-screen frame's pulse rate.
   *
   * The SLOW rung of the in-flight ping family (`--ring-rate: 1.8s`, what `.status-dot[data-status=
   * "running"]` uses), not the 0.9s the `driving` dot takes. The dot is 13px and the frame is the
   * whole viewport, and the stylesheet already writes down why that difference decides the rate.
   */
  framePulseMs: 1800,
} as const;
