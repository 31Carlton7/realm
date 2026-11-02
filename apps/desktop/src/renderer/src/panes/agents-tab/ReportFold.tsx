import { Icon } from "@realm/ui";
import { useId, type ReactNode } from "react";
import { useApp } from "../../state/store";
import { longReport } from "./subagent-state";

/**
 * What a sub-agent came back with, as a card whose head folds it: pinned under the head of its viewer
 * in the Agents tab, and in place of the last message of its own transcript, opened as a session.
 *
 * Its head is a disclosure, because a person reading the log under it, or the transcript above it,
 * may want the room back. A short report starts open — it has nothing to hide — and a long one starts
 * closed, its first line after its name, so the card still says what came back without standing a
 * screenful tall. Either way the reader's choice is the sub-agent's (`reportsOpen`): closed in the
 * viewer, it is closed in the session too. The body folds on the disclosure rule every other one in
 * the app uses (grid rows, the size rung), which Reduce motion stills with everything else.
 */
export function ReportFold({ id, text, failed, className, children }: {
  /** The sub-agent's id: a delegated child's session, or a harness agent's launching call. */
  id: string; text: string; failed: boolean; className?: string; children: ReactNode;
}) {
  const chosen = useApp((s) => s.reportsOpen[id]);
  const setReportOpen = useApp((s) => s.setReportOpen);
  const open = chosen ?? !longReport(text);
  const body = useId();
  const name = failed ? "How it ended" : "What it reported";
  return (
    <section className={`subagent-view-result${className ? ` ${className}` : ""}`} data-error={failed || undefined} data-open={open || undefined} aria-label={name}>
      <h3 className="subagent-view-result-head">
        <button type="button" className="subagent-view-result-toggle" aria-expanded={open} aria-controls={body}
          title={open ? "Hide the report" : "Show the report"} onClick={() => setReportOpen(id, !open)}>
          <Icon name={failed ? "errorCircle" : "checkCircle"} size={14} />
          <span className="subagent-view-result-name">{name}</span>
          {!open && <span className="subagent-view-result-gist" aria-hidden>{gistOf(text)}</span>}
          <Icon name="chevronRight" size={12} className="subagent-view-result-chevron" />
        </button>
      </h3>
      <div className="subagent-view-result-wrap" id={body} data-open={open || undefined}>
        <div className="subagent-view-result-clip" inert={!open || undefined}>{children}</div>
      </div>
    </section>
  );
}

/** A report's first line as plain words, for the head of a closed card. */
export function gistOf(text: string): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "" && !/^(```|~~~|---|\*\*\*)/.test(l)) ?? "";
  return line.replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "").replace(/(\*\*|__|`|~~)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
}
