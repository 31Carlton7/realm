import { useEffect, useRef } from "react";
import { getTerminalHub } from "./terminal-hub";
import type { PaneProps } from "./registry";

/** Thin view over the hub-owned xterm: mount = attach host element, unmount = detach. State lives in the hub. */
export function TerminalPane({ item, visible }: PaneProps) {
  const ref = useRef<HTMLDivElement>(null);
  const terminalId = item.refId;

  useEffect(() => {
    const container = ref.current!;
    const entry = getTerminalHub().acquire(terminalId);
    entry.attach(container);
    const ro = new ResizeObserver(() => { try { entry.fit.fit(); } catch { /* not visible */ } });
    ro.observe(container);
    return () => { ro.disconnect(); entry.detach(); };
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

  return <div className="terminal-pane" ref={ref} />;
}
