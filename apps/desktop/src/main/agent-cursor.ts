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
  /**
   * The default arrow's drawn height in CSS pixels. Every glyph below is authored in these same
   * units, so the paths are drawn at the size they are written at and nothing scales — a test holds
   * this equal to `AGENT_CURSOR_FORMS.default.box[1]` so the two cannot drift.
   *
   * 20px rather than the 14px a mark-shaped mark took, because a pointer is a SHAPE and a shape has
   * to be recognisable: the difference between an arrow and a hand is what the form is for, and at
   * 14px they are two smudges. macOS's own pointer is larger still.
   */
  size: 20,
  /**
   * The accent outline around every glyph, drawn OUTSIDE the fill (`paint-order: stroke fill`).
   *
   * This is the whole answer to the obvious objection — that a second arrow beside the user's real
   * one is ambiguous about which is which. The user's macOS pointer is white with a black outline;
   * this one is white with an outline in the user's own accent, plus a lift shadow. At a glance
   * they are the same familiar shape; at any look at all, only one of them is Realm's.
   */
  stroke: 1.5,
  /**
   * The press contraction, about the HOTSPOT rather than the glyph's centre — a pointer that
   * shrinks toward its middle walks its own tip off the pixel the input went to.
   *
   * 0.82, not the 0.96 design.md permits for controls: 0.96 of a 20px glyph is under half a pixel
   * of travel at the tip, which is the failure `styles.css` already writes down about "a 6px circle
   * changing brightness by a third". The ratio is chosen against the box, not copied from one.
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
 * One drawn pointer.
 *
 * Filled paths rather than a font glyph or an image: a path is a string, and a string is the only
 * thing that survives being interpolated into a script and evaluated inside a page whose fonts,
 * bundler and CSP are not ours.
 */
export type CursorForm = {
  /** The glyph's box in CSS pixels. The SVG's viewBox is the same two numbers. */
  box: readonly [number, number];
  /**
   * The point inside that box the input actually goes to — an arrow's tip, a hand's fingertip, an
   * I-beam's middle. The mark is placed BY this, never by its centre.
   *
   * This is the load-bearing number of the whole feature. A circle could be centred on the act's
   * point and be right by construction; a pointer that is merely near the point is a picture of one
   * rather than a report of one, and the live check measures the hotspot for exactly that reason.
   */
  hot: readonly [number, number];
  /** Drawn white with the accent outline around them, in order. */
  paths: readonly { readonly d: string; readonly evenOdd?: true }[];
  /**
   * An outline narrower than `AGENT_CURSOR.stroke`, where this glyph's ink is too thin to carry it.
   *
   * Only the barred circle needs one, and the reason is worth keeping: every other form is a solid
   * body with an edge, so 1.5px of accent outside it reads as an edge. The barred circle is a BAND
   * — a 4.5px-wide ring at this size — and an outline that wide on both of its edges leaves no white
   * between them at all. Measured, not guessed: at the shared stroke it rendered as a filled green
   * disc with a smudge in it, which is not a cursor.
   */
  stroke?: number;
};

/**
 * The four pointers Realm draws, and no more.
 *
 * Each one is a form the PAGE said it would show under a real pointer at that point — read back out
 * of `getComputedStyle(...).cursor` at act time, not guessed from the element's tag. That is what
 * keeps this honest rather than decorative: an agent clicking a disabled control gets the barred
 * circle because the page's own stylesheet says that control is barred, and a reader learns
 * something they could not otherwise see.
 *
 * Everything else a page can ask for — `grab`, `move`, `crosshair`, `wait`, the resize family, a
 * `url()` of the page's own — falls back to `default`. Drawing a form Realm has not authored would
 * mean inventing one, and an arrow is the shape every platform falls back to as well.
 */
export const AGENT_CURSOR_FORMS = {
  /** The classic arrow. Tip at the top-left, which is where the input lands. */
  default: {
    box: [14, 20],
    hot: [1, 1],
    paths: [{ d: "M1 1 L1 17.6 L5.4 13.6 L8.1 19.4 L10.6 18.2 L8 12.6 L13.4 12.6 Z" }],
  },
  /**
   * The pointing hand, for the `cursor: pointer` a page puts on things it means to be clicked.
   * Index finger up, hotspot at the fingertip — which is where the page will be clicked.
   */
  pointer: {
    box: [20, 24],
    hot: [8.25, 1],
    paths: [{
      d: "M6.8 2.45 A1.45 1.45 0 0 1 9.7 2.45 V8.2"
        + " C10 8.05 10.3 8 10.6 8 C11.5 8 12.3 8.6 12.6 9.4"
        + " C13 9.1 13.5 8.9 14 8.9 C15 8.9 15.8 9.6 16 10.6"
        + " C16.3 10.3 16.7 10.2 17.1 10.2 C18.2 10.2 19.1 11.1 19.1 12.2"
        + " V17.6 C19.1 20.2 17 22.3 14.4 22.3 H11"
        + " C9.4 22.3 7.9 21.6 6.9 20.4 L2.5 15.1"
        + " C1.7 14.3 1.7 13 2.5 12.2 C3.3 11.4 4.6 11.4 5.4 12.2 L6.8 13.6 Z",
    }],
  },
  /** The I-beam, for `cursor: text` — a field the page expects a caret in. Hotspot at its middle. */
  text: {
    box: [8, 20],
    hot: [4, 10],
    paths: [{ d: "M1 1 H7 V2.8 H4.9 V17.2 H7 V19 H1 V17.2 H3.1 V2.8 H1 Z" }],
  },
  /** The barred circle, for `cursor: not-allowed` — the page saying this cannot be clicked. */
  "not-allowed": {
    box: [20, 20],
    hot: [10, 10],
    stroke: 1,
    paths: [
      { d: "M0.5 10 A9.5 9.5 0 1 1 19.5 10 A9.5 9.5 0 1 1 0.5 10 Z M5 10 A5 5 0 1 0 15 10 A5 5 0 1 0 5 10 Z", evenOdd: true },
      { d: "M4.13 14.03 L14.03 4.13 L15.87 5.97 L5.97 15.87 Z" },
    ],
  },
} as const satisfies Record<string, CursorForm>;

export type CursorFormName = keyof typeof AGENT_CURSOR_FORMS;

/**
 * The page's computed `cursor` keyword → the form Realm draws for it.
 *
 * A table rather than a chain of conditions in the injected script, so the mapping is data that can
 * be asserted here and the page does a lookup it cannot get wrong. `auto` is absent on purpose: it
 * means "the browser decides", and only the page knows what it decided — see `markScript`, which
 * resolves it the way Chromium renders it.
 */
export const CURSOR_FORM_FOR_CSS: Readonly<Record<string, CursorFormName>> = {
  pointer: "pointer",
  text: "text",
  "vertical-text": "text",
  "not-allowed": "not-allowed",
  "no-drop": "not-allowed",
  default: "default",
};

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
