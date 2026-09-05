import { Icon } from "@realm/ui";
import { useEffect, useRef, useState } from "react";

/** How long a copy control holds its ✓ before swapping back — ToolCard's and Markdown's beat, so
 *  every copy in the transcript settles at the same pace. */
const COPIED_MS = 1400;

/**
 * The controls under a finished assistant message.
 *
 * Mounted only once the message is complete, which is the whole design constraint: a bar under a
 * paragraph that is still growing would be pushed down the pane by every delta, and a 20px button
 * the reader has to chase is worth less than the stability it costs. Nothing here has an entrance
 * animation for the same reason the transcript seeds its enter tracker as already-seen — on
 * relaunch every message is complete at once, and forty bars fading in together reads as a fault
 * rather than as forty arrivals.
 */
export function MessageActions({ text, onRetry, retryBusy = false }: {
  text: string;
  /** Present only on the message a retry would land after, and only when there is a user message to
   *  ask again — the bar does not offer a button it cannot honour. */
  onRetry?: () => void;
  /** A turn is in flight. The control stays in place and greys rather than leaving, because a
   *  button that disappears for the seconds a run takes reads as one that was never there. */
  retryBusy?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };
  return (
    <div className="msg-actions" role="group" aria-label="Message actions">
      {/* §6 icon swap: both glyphs stay mounted and cross-fade, and the accessible name never
          changes — a tick is a change of state, not a change of control. */}
      <button className="msg-action" aria-label="Copy message" title="Copy"
        data-copied={copied || undefined} onClick={copy}>
        <Icon name="copy" size={14} className="copy-icon" />
        <Icon name="check" size={14} className="copied-icon" />
      </button>
      {/* "Retry", not "Regenerate": this asks the question again as a new turn. The answer above it
          stays where it is, because the agent's own context still holds it and a transcript that
          disagreed with what the agent remembers would be the more expensive lie. */}
      {onRetry && (
        <button className="msg-action" aria-label="Retry" title="Ask the last message again"
          disabled={retryBusy} onClick={onRetry}>
          <Icon name="reload" size={14} />
        </button>
      )}
    </div>
  );
}
