import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
import type { AgentAvailability } from "../../state/agent-availability";

/**
 * Replaces the prompter when the session's agent can't run (design-language §5 floating card: raised,
 * `--r-float`, edge + shadow; it interrupts, so it floats). Two shapes, never one:
 *
 * - *missing* — the CLI isn't there. Offers the INSTALL command.
 * - *logged_out* — the CLI is there but signed out. Offers the LOGIN command.
 *
 * "Open in terminal" opens the session's own terminal panel with the command **typed but not run**
 * (`prefillTerminal` sends no newline). Realm never executes an installer; the user presses Return.
 *
 * Re-probing happens on BOTH triggers, because the user's fix happens outside Realm: window focus
 * (they alt-tabbed to a terminal, installed, and came back) and an explicit "Check again". Both force
 * past the server's probe cache — a cached "not installed" is precisely what they just fixed.
 */
export function InstallCard({ availability, onRetry, onOpenInTerminal }: {
  availability: Extract<AgentAvailability, { command: string | null }>;
  onRetry: () => void;
  onOpenInTerminal: (command: string) => void;
}) {
  const { title, reason, command, state } = availability;
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  // Window focus re-probe: the whole point of this card is that the fix happens in another app.
  useEffect(() => {
    window.addEventListener("focus", onRetry);
    return () => window.removeEventListener("focus", onRetry);
  }, [onRetry]);
  return (
    <div className="composer-dock">
      <div className="install-card" role="group" aria-label={title} data-state={state}>
        <div className="install-head">
          <Icon name="alert" size={16} className="install-glyph" />
          <h3>{title}</h3>
        </div>
        <p className="install-reason">{reason}</p>
        {command && (
          <div className="install-cmd">
            <code>{command}</code>
            <button className="tool-copy" aria-label="Copy command" title={copied ? "Copied" : "Copy"}
              onClick={() => { void navigator.clipboard?.writeText(command); setCopied(true); }}>
              <Icon name={copied ? "check" : "copy"} size={12} />
            </button>
          </div>
        )}
        <div className="install-actions">
          <button type="button" className="btn" onClick={onRetry}>Check again</button>
          {command && (
            <button type="button" className="btn primary" onClick={() => onOpenInTerminal(command)}>
              Open in terminal
            </button>
          )}
        </div>
        <p className="install-note">
          {command
            ? "Realm types the command into this session’s terminal — you press Return."
            : "Realm can’t offer a single command for this one; the reason above says what it needs."}
        </p>
      </div>
    </div>
  );
}
