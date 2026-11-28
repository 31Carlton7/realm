import { useEffect, useRef, useState } from "react";
import type { EventPayload } from "@realm/contracts";
import { rpc } from "../../rpc/client";
import { AGENT_CURSOR, AGENT_CURSOR_FORMS, AGENT_MOTION, CursorSlots, cursorHue, cursorIdentity, pillOffset, type CursorIdentity } from "../../../../main/agent-cursor";

/**
 * Each session's cursor over a machine's screen: the browser pane's per-session cursor, drawn as DOM.
 *
 * On a page the cursor is injected over CDP; here the screen is a canvas in Realm's own window, so it
 * is an ordinary overlay, read from the same table (`agent-cursor.ts`): the arrow, its hotspot, the
 * slot a session holds and the colour that slot takes, the pill's words and mark, and the idle-out.
 * The colours themselves live in `styles.css`, keyed by the palette's word, and `styles.test.ts`
 * holds them equal to the table.
 *
 * Only the arrow is drawn. A page says which pointer it would show at a point; a framebuffer says
 * nothing, so any other form would be a guess.
 */

const FORM = AGENT_CURSOR_FORMS.default;
const PILL = pillOffset(FORM);

type Shown = { who: CursorIdentity; hue: string | null; x: number; y: number; presses: number; leaving: boolean };

export function MachineCursors({ machineId, framebuffer, size }: {
  machineId: string;
  /** The guest's framebuffer, which the server's points are in. */
  framebuffer: { width: number; height: number };
  /** The canvas's size in CSS pixels. */
  size: { width: number; height: number };
}) {
  const [shown, setShown] = useState<Record<string, Shown>>({});
  const slots = useRef(new CursorSlots());

  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const later = (key: string, ms: number, fn: () => void) => {
      clearTimeout(timers.get(key));
      timers.set(key, setTimeout(fn, ms));
    };
    /* Each session's cursor idles out on its own clock, reset by its own acts, so one agent stopping
       takes only its pointer away. Owned here rather than by a `driving: false`, which a dropped
       socket can lose. */
    const idle = (key: string) => later(key, AGENT_CURSOR.idleMs, () => {
      setShown((s) => (s[key] ? { ...s, [key]: { ...s[key]!, leaving: true } } : s));
      later(key, AGENT_MOTION.fastMs, () => {
        timers.delete(key);
        setShown(({ [key]: _gone, ...rest }) => rest);
      });
    });
    const off = rpc().on("machine.driving", (p: EventPayload<"machine.driving">) => {
      if (p.machineId !== machineId || !p.driving) return;
      const key = p.actor?.sessionId ?? "";
      const point = p.point;
      setShown((s) => {
        const was = s[key];
        // A key or typed text has no point: it keeps a cursor already up, and draws none of its own.
        if (!point && (!was || was.leaving)) return s;
        const slot = slots.current.take(key);
        const who = cursorIdentity(p.actor ?? null, slot, "");
        return {
          ...s,
          [key]: {
            who, hue: cursorHue(slot),
            x: point?.x ?? was!.x, y: point?.y ?? was!.y,
            presses: (was?.presses ?? 0) + (point?.kind === "click" ? 1 : 0),
            leaving: false,
          },
        };
      });
      idle(key);
    });
    return () => { off(); for (const t of timers.values()) clearTimeout(t); };
  }, [machineId]);

  const sx = framebuffer.width ? size.width / framebuffer.width : 0;
  const sy = framebuffer.height ? size.height / framebuffer.height : 0;
  return (
    <div className="machine-cursors" aria-hidden>
      {Object.entries(shown).map(([key, c]) => (
        <div key={key} className="machine-cursor" data-actor={key} data-hue={c.hue ?? undefined} data-leaving={c.leaving || undefined}
          style={{
            width: FORM.box[0], height: FORM.box[1], margin: `${-FORM.hot[1]}px 0 0 ${-FORM.hot[0]}px`,
            translate: `${c.x * sx}px ${c.y * sy}px`,
          }}>
          {/* Keyed on the press count, so a second click remounts the glyph and replays its press. */}
          <svg key={c.presses} className="machine-cursor-glyph" data-press={c.presses > 0 || undefined}
            viewBox={`0 0 ${FORM.box[0]} ${FORM.box[1]}`} width={FORM.box[0]} height={FORM.box[1]}
            strokeWidth={AGENT_CURSOR.stroke * 2} style={{ transformOrigin: `${FORM.hot[0]}px ${FORM.hot[1]}px` }}>
            {FORM.paths.map((p) => <path key={p.d} d={p.d} />)}
          </svg>
          {c.who.label && (
            <span className="machine-cursor-pill" style={{ left: PILL[0], top: PILL[1] }}>
              {c.who.mark && (
                <svg className="machine-cursor-mark" viewBox={c.who.mark.viewBox}>
                  {c.who.mark.paths.map((p) => <path key={p.d} d={p.d} fillRule={p.evenOdd ? "evenodd" : undefined} />)}
                </svg>
              )}
              <span className="machine-cursor-name">{c.who.label}</span>
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
