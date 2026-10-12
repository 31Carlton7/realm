import { useEffect, useRef, useState } from "react";
import { formatScore, RunnerView, VIEW_HEIGHT, type RunnerState } from "./runner-view";

const PLAY_LABEL: Record<RunnerState, string> = { idle: "Play", running: "Pause", paused: "Resume", over: "Play again" };
const NOTE: Partial<Record<RunnerState, string>> = {
  idle: "Space or click to run. Hold to jump higher.",
  paused: "Paused. Space to carry on.",
  over: "Space to run again.",
};

const JUMP_KEYS = new Set([" ", "ArrowUp", "w", "W"]);

/**
 * A runner to pass the time while a server comes up, under the error page's Reload. It is a guest on
 * the page: it takes keys only while it has focus, so typing in the address bar never jumps, and it
 * holds still until someone presses Play.
 */
export function RunnerGame({ seed }: { seed: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<RunnerView | null>(null);
  const [shown, setShown] = useState({ state: "idle" as RunnerState, score: 0, best: 0, sound: false });

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const v = new RunnerView(el, { seed, onChange: setShown });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
  }, [seed]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (JUMP_KEYS.has(e.key)) {
      e.preventDefault();
      if (!e.repeat) view.current?.press();
    } else if (e.key === "Escape" || e.key === "p" || e.key === "P") {
      if (shown.state === "running") { e.preventDefault(); view.current?.pause(); }
    }
  };
  const onKeyUp = (e: React.KeyboardEvent) => { if (JUMP_KEYS.has(e.key)) view.current?.release(); };

  const note = NOTE[shown.state];
  return (
    <section className="browser-runner" aria-label="Runner game">
      <div className="browser-runner-stage" data-state={shown.state}>
        <canvas
          ref={canvas}
          className="browser-runner-canvas"
          height={VIEW_HEIGHT}
          tabIndex={0}
          aria-label={`Runner game. Score ${shown.score}, best ${shown.best}. Space to jump.`}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onPointerDown={(e) => { e.currentTarget.focus(); view.current?.press(); }}
          onPointerUp={() => view.current?.release()}
          onPointerLeave={() => view.current?.release()}
        />
        {note && <p className="browser-runner-note" aria-live="polite">{note}</p>}
      </div>
      <div className="browser-runner-bar">
        <button
          type="button"
          className="btn browser-runner-play"
          // Keep focus on the game, so pressing Pause does not blur it (which already pauses).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { view.current?.toggle(); canvas.current?.focus(); }}
        >
          {PLAY_LABEL[shown.state]}
        </button>
        <p className="browser-runner-score">
          <span>{formatScore(shown.score)}</span>
          <span className="browser-runner-best">Best {formatScore(shown.best)}</span>
        </p>
        <button
          type="button"
          className="btn browser-runner-sound"
          aria-pressed={shown.sound}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => view.current?.setSound(!shown.sound)}
        >
          {shown.sound ? "Sound on" : "Sound off"}
        </button>
      </div>
    </section>
  );
}
