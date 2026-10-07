import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

/** How long the control holds its ✓ before swapping back — the transcript's beat, so every copy in
 *  the app settles at the same pace. */
const COPIED_MS = 1600;

/**
 * A command the user is meant to run somewhere else, with the one control that helps: copy.
 *
 * Realm shows these rather than running them. A login is a browser round-trip and an install is a
 * package manager writing to a machine the user owns, so the honest offer is the exact text and a
 * way to get it into a terminal — never a button that half-finishes either.
 *
 * `action` is the slot for the surface's own second control (the install card's "Open in terminal"),
 * kept as a slot rather than a prop pair because who can honour it differs by surface: a transcript
 * block has no terminal of its own to type into.
 */
export function CommandCopy({ command, action }: { command: string; action?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="install-cmd">
      <code>{command}</code>
      {/* §6 icon swap: both glyphs stay mounted and cross-fade, and the accessible name never
          changes — a tick is a change of state, not a change of control. */}
      <button className="tool-copy" aria-label="Copy command" title={copied ? "Copied" : "Copy"}
        data-copied={copied || undefined}
        onClick={() => { void navigator.clipboard?.writeText(command); setCopied(true); }}>
        <Icon name="copy" size={12} className="copy-icon" />
        <Icon name="check" size={12} className="copied-icon" />
      </button>
      {action}
    </div>
  );
}
