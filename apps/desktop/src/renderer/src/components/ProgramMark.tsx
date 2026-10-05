import { brandMarks, Icon, isIconName } from "@realm/ui";
import { useCallback, useId, useRef, useSyncExternalStore, type CSSProperties } from "react";
import type { Item, TerminalProgram } from "@realm/contracts";
import { getTerminalHub } from "../panes/terminal-hub";

const noSubscribe = () => () => {};

/**
 * Every terminal's program, re-rendering the caller when any of them changes. A getter rather than
 * one terminal's value so a strip of tabs subscribes once rather than once per tab — programs change
 * when someone starts one, which is rare enough that re-rendering a strip for a neighbour is free.
 * `follow: false` reads without subscribing, for a caller that is not about a terminal at all.
 */
export function useTerminalPrograms(follow = true): (terminalId: string) => TerminalProgram | null {
  const hub = getTerminalHub();
  const subscribe = useCallback((cb: () => void) => hub.onProgramChange(cb), [hub]);
  useSyncExternalStore(follow ? subscribe : noSubscribe, () => hub.programsSeen);
  return (terminalId) => hub.program(terminalId);
}

/** What a tab says about a terminal: what is running, then its own title — "claude · realm". The
 *  title stays the item's, so a rename edits the name and never the program in front of it. */
export const terminalTitle = (title: string, program: TerminalProgram | null): string =>
  (program ? `${program.label} · ${title}` : title);

/** An item's title as a tab or a pane bar shows it. */
export function useItemTitle(item: Item): string {
  const programOf = useTerminalPrograms(item.kind === "terminal");
  return item.kind === "terminal" ? terminalTitle(item.title, programOf(item.refId)) : item.title;
}

/** Apple's icon shape, a superellipse (|x|⁵ + |y|⁵ = 1), in a 24-unit box. Drawn rather than written
 *  as a CSS radius because this is an icon's own geometry, the way the app icon's is — a 14px tile has
 *  no rung on the control ladder, and a circular corner at that size reads as a pill. */
const TILE = (() => {
  const pts: string[] = [];
  for (let i = 0; i < 64; i++) {
    const t = (i / 64) * 2 * Math.PI;
    const [c, s] = [Math.cos(t), Math.sin(t)];
    pts.push(`${(12 + 12 * Math.sign(c) * Math.abs(c) ** 0.4).toFixed(2)} ${(12 + 12 * Math.sign(s) * Math.abs(s) ** 0.4).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
})();

/** How much of its tile an agent's mark takes: the reference's Claude and fx tiles, measured. */
const TILE_GLYPH = 0.62;

/**
 * A terminal's program, where its kind's glyph goes.
 *
 * An agent's mark sits on a tile, as an app's does in the Dock and in Codex's tabs: its vendor's one
 * colour where the mark declares one (Claude's coral), near-black where it declares none (fx, Codex),
 * and the mark in white. A tool keeps a bare glyph from the app's own set, and the shell the terminal
 * glyph it always had — so a strip of tabs is calm until an agent is in one, and that tab says so.
 *
 * Every variant is `size` square, so a program starting or stopping never moves the title beside it.
 */
export function ProgramMark({ program, size, className }: { program: TerminalProgram | null; size: number; className?: string }) {
  const mark = program && isIconName(program.mark) ? program.mark : "terminal";
  if (!program?.agent) return <Icon name={mark} size={size} className={className} />;
  return <ProgramTile mark={mark} size={size} className={className} />;
}

function ProgramTile({ mark, size, className }: { mark: string; size: number; className?: string }) {
  const rim = useId();
  const brand = Object.prototype.hasOwnProperty.call(brandMarks, mark) ? brandMarks[mark as keyof typeof brandMarks] : null;
  const fill = brand && "color" in brand ? brand.color : undefined;
  return (
    <span className={className ? `program-tile ${className}` : "program-tile"} data-ink={fill ? undefined : ""}
      style={{ width: size, height: size, ...(fill ? { "--program-tile": fill } : {}) } as CSSProperties}>
      <svg className="program-tile-ground" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <clipPath id={rim}><path d={TILE} /></clipPath>
        <path className="program-tile-fill" d={TILE} />
        {/* A one-device-pixel rim INSIDE the shape — the outline every picture on a Realm surface
            gets — so a near-black tile still has an edge on the dark ground. */}
        <path className="program-tile-rim" d={TILE} clipPath={`url(#${rim})`} vectorEffect="non-scaling-stroke" />
      </svg>
      {/* off-ladder: the mark is sized by its tile, not by the row the tile sits in. */}
      <Icon name={mark} size={Math.round(size * TILE_GLYPH)} className="program-tile-glyph" />
    </span>
  );
}

/**
 * A terminal's mark, following what it runs. A change turns over on the app's one icon swap
 * (`.icon-swap`): both marks stay stacked in the glyph's square, the new one written into the hidden
 * slot and the slots flipped, so it arrives with the opacity, 4px blur and .25 scale every swapped
 * glyph uses. Never on first draw — a tab that opens onto a running agent shows it, it does not
 * announce it — and the first draw is the one the hub KNOWS: a tab drawn while its first read is in
 * flight shows the shell for a moment, and the agent arriving then is news to the hub, not a program
 * starting.
 */
export function TerminalMark({ terminalId, size, className }: { terminalId: string; size: number; className?: string }) {
  const program = useTerminalPrograms()(terminalId);
  const key = program ? `${program.id}:${program.mark}` : "shell";
  const slots = useRef({ off: program, on: program, showOn: false, key, settled: false });
  const s = slots.current;
  if (!s.settled) {
    s.off = program; s.on = program; s.key = key;
    s.settled = getTerminalHub().programsKnown;
  } else if (key !== s.key) {
    if (s.showOn) s.off = program; else s.on = program;
    s.showOn = !s.showOn;
    s.key = key;
  }
  return (
    <span className="program-mark icon-swap" data-on={s.showOn || undefined} style={{ width: size, height: size }}>
      <span className="swap-off"><ProgramMark program={s.off} size={size} className={className} /></span>
      <span className="swap-on"><ProgramMark program={s.on} size={size} className={className} /></span>
    </span>
  );
}
