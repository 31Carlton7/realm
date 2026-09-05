import { Icon } from "@realm/ui";
import { useEffect, useRef, useState } from "react";
import type { AgentAvailability } from "../../state/agent-availability";
import type { CliJob } from "../../state/store";

/**
 * Replaces the prompter when the session's agent can't run (design-language §5 floating card: raised,
 * `--r-float`, edge + shadow; it interrupts, so it floats). Two shapes, never one:
 *
 * - *missing* — the CLI isn't there. Offers the INSTALL command.
 * - *logged_out* — the CLI is there but signed out. Offers the LOGIN command.
 *
 * "Install" is offered only when the server's `cli.status` says so — one click that runs the command
 * shown above it and streams what it says. Everything the server will not run stays as it always was:
 * "Open in terminal" types the command into the session's own terminal **without a newline**, and the
 * user presses Return. A signed-out agent is always the second case, because logging in is a browser
 * flow or an API key, not a command Realm can run to completion on someone's behalf.
 *
 * Re-probing happens on BOTH triggers, because the user's fix happens outside Realm: window focus
 * (they alt-tabbed to a terminal, installed, and came back) and an explicit "Check again". Both force
 * past the server's probe cache — a cached "not installed" is precisely what they just fixed.
 */
export function InstallCard({ availability, onRetry, onOpenInTerminal, offer, job, onInstall, onDismissJob }: {
  availability: Extract<AgentAvailability, { command: string | null }>;
  onRetry: () => void;
  onOpenInTerminal: (command: string) => void;
  /** The command the server is currently willing to run here, or null when there is none. Null is
   *  the whole story for a signed-out agent and for any CLI with no install route. */
  offer: string | null;
  /** The install this card started, while it runs and after it ends. */
  job: CliJob | null;
  onInstall: () => void;
  onDismissJob: () => void;
}) {
  const { title, reason, command, state } = availability;
  const [copied, setCopied] = useState(false);
  const tail = useRef<HTMLPreElement>(null);
  useEffect(() => { const el = tail.current; if (el) el.scrollTop = el.scrollHeight; }, [job?.output]);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  // Window focus re-probe: the whole point of this card is that the fix can happen in another app.
  // Still true now that Realm can install one itself — Homebrew, a downloaded binary and a login all
  // still happen elsewhere.
  useEffect(() => {
    window.addEventListener("focus", onRetry);
    return () => window.removeEventListener("focus", onRetry);
  }, [onRetry]);
  const running = job?.state === "running";
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
              data-copied={copied || undefined}
              onClick={() => { void navigator.clipboard?.writeText(command); setCopied(true); }}>
              <Icon name="copy" size={12} className="copy-icon" />
              <Icon name="check" size={12} className="copied-icon" />
            </button>
          </div>
        )}
        {job && (
          <div className="cli-job" data-state={job.state}>
            <div className="cli-job-head">
              <span className="cli-job-state">
                {running ? "Running…" : job.state === "ok" ? "Finished" : job.error ?? "Failed"}
              </span>
              {!running && <button type="button" className="btn" onClick={onDismissJob}>Dismiss</button>}
            </div>
            <pre className="cli-job-output" ref={tail}>{job.output || "Waiting for output…"}</pre>
          </div>
        )}
        <div className="install-actions">
          <button type="button" className="btn" onClick={onRetry} disabled={running}>Check again</button>
          {command && (
            <button type="button" className="btn" onClick={() => onOpenInTerminal(command)}>
              Open in terminal
            </button>
          )}
          {offer && (
            <button type="button" className="btn primary" onClick={onInstall} disabled={running}>
              {running ? "Installing…" : "Install"}
            </button>
          )}
        </div>
        <p className="install-note">
          {offer
            ? "Realm runs the command above and shows you what it says."
            : command
              ? "Realm types the command into this session’s terminal — you press Return."
              : "Realm can’t offer a single command for this one; the reason above says what it needs."}
        </p>
      </div>
    </div>
  );
}
