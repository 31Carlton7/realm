import { useEffect, useRef, useState } from "react";
import { getTerminalHub } from "./terminal-hub";
import type { PaneProps } from "./registry";

/** Thin view over the hub-owned xterm: mount = attach host element, unmount = detach. State lives in the hub.
 *  While the terminal has produced no output yet, a centered hint (cwd name + key shortcuts) floats over
 *  the empty pane and fades out on first data (V-F3). */
export function TerminalPane({ item, visible }: PaneProps) {
  const ref = useRef<HTMLDivElement>(null);
  const terminalId = item.refId;
  const [hasData, setHasData] = useState(() => getTerminalHub().hasData(terminalId));

  useEffect(() => {
    const container = ref.current!;
    const entry = getTerminalHub().acquire(terminalId);
    entry.attach(container);
    const ro = new ResizeObserver(() => { try { entry.fit.fit(); } catch { /* not visible */ } });
    ro.observe(container);
    return () => { ro.disconnect(); entry.detach(); };
  }, [terminalId]);

  useEffect(() => {
    const hub = getTerminalHub();
    if (hub.hasData(terminalId)) { setHasData(true); return; }
    setHasData(false);
    return hub.onFirstData(terminalId, () => setHasData(true));
  }, [terminalId]);

  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(() => {
      const hub = getTerminalHub();
      if (!hub.has(terminalId)) return;
      const entry = hub.acquire(terminalId);
      try { entry.fit.fit(); entry.term.focus(); } catch { /* ignore */ }
    });
    return () => cancelAnimationFrame(raf);
  }, [visible, terminalId]);

  return (
    <div className="terminal-pane" ref={ref}>
      {/* Kept mounted so the opacity transition can actually fade it; hidden = inert. */}
      <div className="terminal-hint" data-hidden={hasData || undefined} aria-hidden={hasData}>
        <div className="terminal-hint-path">{item.title}</div>
        <div className="terminal-hint-keys">⌘\ split · ⌘K commands</div>
      </div>
    </div>
  );
}
