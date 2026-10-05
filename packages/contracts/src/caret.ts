/**
 * The caret: what the text cursor looks like, and how it moves, wherever you type — the prompter,
 * every field in the app and the code editor — set once, in Settings ▸ Appearance ▸ Cursor.
 *
 * VS Code's set is the floor — `editor.cursorStyle` (line, line-thin, block, block-outline,
 * underline, underline-thin), `editor.cursorBlinking` (blink, smooth, phase, expand, solid) and
 * `editor.cursorSmoothCaretAnimation` — and three shapes and two animations are Realm's own: a pill
 * (a bar with round ends), a beam (a wider bar that thins to nothing at its ends, so it reads as light
 * rather than as a rule), a soft block (the character tinted rather than covered, which is what a
 * block wants to be in proportional text), a pulse (a slow breath that never goes out), and a blink
 * that comes to rest once you stop typing.
 *
 * A terminal's cursor is NOT one of these places, and on purpose: it marks where output will land in
 * a screen that is mostly not yours, a full-screen program draws itself against a block, and a
 * program may set the shape itself. So it keeps its own shape and its own blink
 * (`terminals.cursorStyle`, `terminals.cursorBlink`, shown beside these rows), and takes only the
 * colour and the animation from here — the same split VS Code makes between `editor.*` and
 * `terminal.integrated.*`.
 *
 * Chromium 138 lets a stylesheet colour the native caret and nothing more (`caret-shape` and
 * `caret-animation` came later), so the app draws the caret itself, over the field (`caret.ts` in the
 * renderer) — except a thin blinking line in an ordinary field, which IS the platform's caret and is
 * left to the platform.
 */
export const CARET_SHAPES = ["line", "line-thin", "pill", "beam", "block", "block-soft", "block-outline", "underline", "underline-thin"] as const;
export type CaretShape = (typeof CARET_SHAPES)[number];

/** In the order a person reads them down a menu: the blinks, the eases, then still. */
export const CARET_ANIMATIONS = ["blink", "smooth", "phase", "expand", "pulse", "rest", "solid"] as const;
export type CaretAnimation = (typeof CARET_ANIMATIONS)[number];

/**
 * The accent is the caret's own colour in a Mac app since Sonoma, and it is already the prompter's
 * (`--rl-accent` is what "carets all take" in the token bridge). The text's ink is offered beside it
 * for anyone who wants the caret to read as part of what they typed.
 */
export const CARET_COLOURS = ["accent", "text"] as const;
export type CaretColour = (typeof CARET_COLOURS)[number];

export type CaretPrefs = {
  shape: CaretShape;
  animation: CaretAnimation;
  /** The caret slides to each new place instead of jumping — VS Code's smooth caret animation. */
  glide: boolean;
  colour: CaretColour;
};

export const CARET_KEY = "ui.caret";

/**
 * A line two pixels wide, blinking, in the accent: VS Code's default shape, and the code editor's
 * caret before this setting existed. Not the platform's own one-pixel line, which is `line-thin`.
 */
export const CARET_DEFAULT: CaretPrefs = { shape: "line", animation: "blink", glide: false, colour: "accent" };

export const isCaretShape = (x: unknown): x is CaretShape => (CARET_SHAPES as readonly unknown[]).includes(x);
export const isCaretAnimation = (x: unknown): x is CaretAnimation => (CARET_ANIMATIONS as readonly unknown[]).includes(x);
export const isCaretColour = (x: unknown): x is CaretColour => (CARET_COLOURS as readonly unknown[]).includes(x);

/**
 * The stored preference, field by field: a word this build does not know — written by a newer one,
 * or by hand — is that field's default, and the fields it did know are kept.
 *
 * A home that has never stored one may still have said something about a caret: `editor.cursorBlink`
 * was the code editor's own switch before the code editor drew this caret, and someone who turned it
 * off asked for a caret that holds still. That answer is carried into the animation, once, by
 * reading it — the old key is never written again, so there is nothing to keep in step.
 */
export function parseCaretPrefs(raw: unknown, legacy: { editorBlink?: unknown } = {}): CaretPrefs {
  const stored = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const animation: CaretAnimation = stored === null && legacy.editorBlink === false ? "solid" : CARET_DEFAULT.animation;
  return {
    shape: isCaretShape(stored?.shape) ? stored.shape : CARET_DEFAULT.shape,
    animation: isCaretAnimation(stored?.animation) ? stored.animation : animation,
    glide: typeof stored?.glide === "boolean" ? stored.glide : CARET_DEFAULT.glide,
    colour: isCaretColour(stored?.colour) ? stored.colour : CARET_DEFAULT.colour,
  };
}

/**
 * A terminal's cursor shape, as `terminals.cursorStyle` stores it. That key held xterm's three words
 * before it held a caret shape, and two of them are shapes already; the third, `bar`, is xterm's
 * name for a line. Anything else is the block every terminal on this Mac starts with.
 */
export function terminalCaretShape(raw: unknown): CaretShape {
  if (raw === "bar") return "line";
  return isCaretShape(raw) ? raw : "block";
}

/** What Settings says. Names, not descriptions: the tiles draw the shapes, and the field above them
 *  shows the animation running, so the words only have to say which is which. */
export const CARET_COPY = {
  shape: {
    label: "Shape",
    options: {
      line: "Line", "line-thin": "Thin line", pill: "Pill", beam: "Beam",
      block: "Block", "block-soft": "Soft block", "block-outline": "Outline block",
      underline: "Underline", "underline-thin": "Thin underline",
    } satisfies Record<CaretShape, string>,
  },
  animation: {
    label: "Animation",
    options: {
      blink: "Blink", smooth: "Smooth fade", phase: "Phase", expand: "Expand",
      pulse: "Pulse", rest: "Blink, then rest", solid: "Solid",
    } satisfies Record<CaretAnimation, string>,
  },
  glide: { label: "Glide to each new position" },
  colour: { label: "Colour", options: { accent: "Accent", text: "Text" } satisfies Record<CaretColour, string> },
} as const;
