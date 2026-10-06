import { useEffect, useRef, useSyncExternalStore } from "react";
import { CARET_ANIMATIONS, CARET_COLOURS, CARET_COPY, CARET_SHAPES, TERMINALS_CURSOR_BLINK_COPY, TERMINALS_CURSOR_STYLE_COPY,
  type CaretAnimation, type CaretShape } from "@realm/contracts";
import { useApp } from "../../state/store";

/**
 * Settings ▸ Appearance ▸ Cursor: the caret everywhere you type, drawn by `caret.ts`, and a terminal's
 * cursor beside it with a shape and a blink of its own.
 *
 * The field at the top is the preview, and a real one — click into it and type. While nothing else is
 * being typed in, the caret stands in it anyway (`data-caret-preview`), so a shape picked from the
 * tiles or an animation from the menu is seen at once, without having to put the keyboard back.
 */

/** The animations Low power swaps for the plain blink (styles.css), because each repaints every frame. */
const EASED_CARETS: ReadonlySet<string> = new Set(["smooth", "phase", "expand", "pulse"]);
export function CaretSettings() {
  const caret = useApp((s) => s.caret);
  const setCaret = useApp((s) => s.setCaret);
  const terminalShape = useApp((s) => s.terminalCursorStyle);
  const setTerminalShape = useApp((s) => s.setTerminalCursorStyle);
  const terminalBlink = useApp((s) => s.terminalCursorBlink);
  const setTerminalBlink = useApp((s) => s.setTerminalCursorBlink);
  const lowPower = useApp((s) => s.lowPower);
  const run = useApp((s) => s.run);
  const reduced = useReducedMotion();

  return (
    <>
      <h3 className="settings-head">Cursor</h3>
      <div className="settings-group">
        <div className="settings-row" data-stack data-setting="caret-preview">
          <CaretPreview />
        </div>
        <div className="settings-row" data-setting="caret-shape" title="The prompter's, every field's and the code editor's. A terminal's cursor has a shape of its own, below.">
          <div className="settings-row-main"><span className="settings-row-name">{CARET_COPY.shape.label}</span></div>
          <ShapeTiles name="settings-caret-shape" label="Cursor shape" value={caret.shape} onPick={(shape) => run(() => setCaret({ shape }))} />
        </div>
        <div className="settings-row" data-setting="caret-animation"
          title="How the cursor goes out and comes back while it waits. It starts again whenever the cursor moves, so it is always showing where you just typed. A blinking terminal cursor moves the same way.">
          <div className="settings-row-main">
            <span className="settings-row-name">{CARET_COPY.animation.label}</span>
            {/* Said only when it is true: the menu still shows what was chosen, and the window is
                showing something else. */}
            {reduced
              ? <span className="settings-row-detail">Reduce motion is on, so every cursor holds still.</span>
              : lowPower && EASED_CARETS.has(caret.animation) && <span className="settings-row-detail">Low power is on, so the cursor blinks instead.</span>}
          </div>
          <select aria-label="Cursor animation" value={caret.animation}
            onChange={(e) => run(() => setCaret({ animation: e.target.value as CaretAnimation }))}>
            {CARET_ANIMATIONS.map((a) => <option key={a} value={a}>{CARET_COPY.animation.options[a]}</option>)}
          </select>
        </div>
        <div className="settings-row" data-setting="caret-glide"
          title="The cursor slides to each new place instead of jumping there, in fields, the prompter and the code editor. A terminal's cursor always jumps: a program moves it a whole screen at a time.">
          <div className="settings-row-main"><span className="settings-row-name">{CARET_COPY.glide.label}</span></div>
          <input type="checkbox" role="switch" className="switch" aria-label={CARET_COPY.glide.label}
            checked={caret.glide} onChange={(e) => run(() => setCaret({ glide: e.target.checked }))} />
        </div>
        <div className="settings-row" data-setting="caret-colour" title="The accent, or the ink of the text being typed. A terminal's cursor takes the same colour.">
          <div className="settings-row-main"><span className="settings-row-name">{CARET_COPY.colour.label}</span></div>
          <fieldset className="settings-tabs" aria-label="Cursor colour">
            {CARET_COLOURS.map((c) => (
              <label key={c} className="settings-tab" data-selected={caret.colour === c || undefined}>
                <input type="radio" name="settings-caret-colour" value={c} checked={caret.colour === c}
                  onChange={() => run(() => setCaret({ colour: c }))} />
                {CARET_COPY.colour.options[c]}
              </label>
            ))}
          </fieldset>
        </div>
        <div className="settings-row" data-setting="terminal-cursor-style"
          title="A block is what a full-screen program is drawn against; a line is what an editor trains you to look for; an underline never covers the character it stands on. A program can still ask for its own shape while it runs.">
          <div className="settings-row-main"><span className="settings-row-name">{TERMINALS_CURSOR_STYLE_COPY.label}</span></div>
          <ShapeTiles name="settings-terminal-cursor" label={TERMINALS_CURSOR_STYLE_COPY.label} value={terminalShape} mono
            onPick={(shape) => run(() => setTerminalShape(shape))} />
        </div>
        <div className="settings-row" data-setting="terminal-cursor-blink">
          <div className="settings-row-main">
            <span className="settings-row-name">{TERMINALS_CURSOR_BLINK_COPY.label}</span>
            <span className="settings-row-desc">{TERMINALS_CURSOR_BLINK_COPY.detail}</span>
          </div>
          <input type="checkbox" role="switch" className="switch" aria-label={TERMINALS_CURSOR_BLINK_COPY.label}
            checked={terminalBlink} onChange={(e) => run(() => setTerminalBlink(e.target.checked))} />
        </div>
      </div>
    </>
  );
}

/** Long enough to wrap in a narrow column, so up and down show the cursor moving between lines. */
const PREVIEW_TEXT = "Type here to try the cursor. The arrow keys move it, and a click puts it anywhere.";

function CaretPreview() {
  const field = useRef<HTMLTextAreaElement>(null);
  // At the end of the sentence, where a click past it would put the caret.
  useEffect(() => { const el = field.current; el?.setSelectionRange(el.value.length, el.value.length); }, []);
  return (
    <textarea ref={field} className="caret-preview" data-caret-preview aria-label="Try the cursor" rows={2}
      spellCheck={false} defaultValue={PREVIEW_TEXT} />
  );
}

/**
 * A tile per shape, each drawing it: the caret standing before a letter, as it would before any
 * other. Native radios under the tiles, so the arrow keys walk them and a screen reader hears the
 * shape's name. A terminal's tiles are set in the code face, which is what the shape will stand in.
 */
function ShapeTiles({ name, label, value, mono, onPick }: {
  name: string; label: string; value: CaretShape; mono?: boolean; onPick: (shape: CaretShape) => void;
}) {
  return (
    <fieldset className="caret-shapes" aria-label={label} data-mono={mono || undefined}>
      {CARET_SHAPES.map((shape) => (
        <label key={shape} className="caret-shape" data-selected={value === shape || undefined} title={CARET_COPY.shape.options[shape]}>
          <input type="radio" name={name} value={shape} checked={value === shape} aria-label={CARET_COPY.shape.options[shape]}
            onChange={() => onPick(shape)} />
          <span className="caret-sample" aria-hidden="true">a<span className="caret-sample-at" data-shape={shape}>b</span></span>
        </label>
      ))}
    </fieldset>
  );
}

const REDUCED = "(prefers-reduced-motion: reduce)";

/** Whether the window says motion is reduced — the Mac's answer, or Realm's own Reduce motion, which
 *  main applies by changing what the window reports (`@realm/contracts` motion). */
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia?.(REDUCED);
      query?.addEventListener?.("change", changed);
      return () => query?.removeEventListener?.("change", changed);
    },
    () => window.matchMedia?.(REDUCED).matches ?? false,
  );
}
