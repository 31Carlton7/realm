import { useEffect, useState } from "react";
import type { Item } from "@realm/contracts";
import { getTerminalHub } from "./terminal-hub";

/**
 * The word beside a terminal pane's title: `Replayed`, `Not running`, or nothing.
 *
 * A word, on the `MachineMeta` precedent — not a dot and not a colour, because "what is on screen is
 * not live" is a sentence and not a severity, and a replayed screen that reads as a live one is the
 * single way this whole feature can mislead somebody.
 *
 * Nothing at all while the pane is live, which is almost always: where the owner has said nothing,
 * show nothing.
 */
export function TerminalMeta({ item }: { item: Item }) {
  const hub = getTerminalHub();
  const [word, setWord] = useState(() => hub.stateWord(item.refId));
  useEffect(() => {
    setWord(hub.stateWord(item.refId));
    return hub.onStateChange((terminalId) => {
      if (terminalId === item.refId) setWord(hub.stateWord(item.refId));
    });
  }, [hub, item.refId]);
  if (!word) return null;
  return <span className="terminal-bar-meta">{word}</span>;
}
