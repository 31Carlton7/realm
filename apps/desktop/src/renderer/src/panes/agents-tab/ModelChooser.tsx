import { AGENT_META, type AgentKind, type DelegableModel } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "../../components/use-anchored-popover";
import { useDissolve } from "../../components/ScrollFades";

/** The session's own model, as the chooser lists it: the one choice that is made by leaving the
 *  model's name out of the instruction. */
export const OWN = "own";

/** One line of the chooser: a model on the route a delegation would take. */
type Row = { key: string; label: string; kind: AgentKind; ready: boolean; own: boolean };

/**
 * Every model a sub-agent can be put on, to pick one or several from.
 *
 * A panel rather than a menu, because it is a multiple choice: an OS menu closes on the first pick,
 * and choosing three models would be three trips to it. Grouped by the harness each model RUNS on —
 * the route `constraints.model` will take, which the server decided (`delegation.models`) — so
 * reading down it says what Claude can run and what Codex can, the way the prompter's picker does.
 * The session's own model leads, on its own line: it is the default a delegation takes when nobody
 * names one, so it is the one choice that needs no name.
 *
 * A harness that cannot run right now keeps its rows, marked and unpickable, rather than vanishing:
 * a model missing from the list reads as Realm not knowing it, when the fix is a sign-in.
 */
export function ModelChooser({ anchor, models, own, picked, onToggle, onClose, label = "Models for sub-agents", noAgent, align = "left" }: {
  anchor: RefObject<HTMLElement | null>;
  models: readonly DelegableModel[];
  own: { kind: AgentKind; label: string };
  picked: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onClose: () => void;
  /** The panel's accessible name. */
  label?: string;
  /** Set where the chooser answers for the user — a question's model field. It is portalled out of
   *  the card that carries `data-no-agent`, so it has to carry the claim itself. */
  noAgent?: string;
  /** Which edge of the anchor the panel lines up with: a chip at the right of a card opens the panel
   *  over the card rather than off its edge. */
  align?: "left" | "right";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useDissolve(list);
  const { pos, closing, close } = useAnchoredPopover({ ref, anchorRef: anchor, align, placement: "up", onClose, returnFocusRef: anchor, exit: true });
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (r: Row) => q === "" || r.label.toLowerCase().includes(q) || AGENT_META[r.kind].label.toLowerCase().includes(q);
    const ownRow: Row = { key: OWN, label: own.label, kind: own.kind, ready: true, own: true };
    // The own model's catalog row is the same model; listing it twice would be two ways to pick one.
    const rest = models.filter((m) => !(m.kind === own.kind && m.label === own.label))
      .map((m): Row => ({ key: m.key, label: m.label, kind: m.kind, ready: m.ready, own: false }));
    return [ownRow, ...rest].filter(matches);
  }, [models, own, query]);
  const groups = useMemo(() => {
    const out: { label: string; ready: boolean; rows: Row[] }[] = [];
    for (const r of rows) {
      const label = r.own ? "This session" : AGENT_META[r.kind].label;
      const g = out.find((x) => x.label === label);
      if (g) g.rows.push(r); else out.push({ label, ready: r.ready, rows: [r] });
    }
    return out;
  }, [rows]);
  const flat = groups.flatMap((g) => g.rows);
  const at = Math.min(active, Math.max(0, flat.length - 1));

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(at + 1, flat.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(at - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const r = flat[at]; if (r?.ready) onToggle(r.key); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
  };
  const style: CSSProperties = { position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
    visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "bottom left" };

  return createPortal(
    <div ref={ref} role="dialog" aria-label={label} className="menu subagents-chooser" data-no-agent={noAgent} style={style}
      data-closing={closing || undefined} inert={closing} onKeyDown={onKey}>
      <div className="subagents-chooser-search">
        <Icon name="search" size={14} />
        <input autoFocus value={query} placeholder="Search models" aria-label="Search models"
          aria-controls="subagents-chooser-list" aria-activedescendant={flat[at] ? `subagents-opt-${flat[at]!.key}` : undefined}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }} />
      </div>
      <div className="subagents-chooser-list" ref={list} id="subagents-chooser-list" role="listbox" aria-multiselectable="true" aria-label="Models">
        {groups.length === 0 && <p className="subagents-chooser-empty">No model matches “{query.trim()}”.</p>}
        {groups.map((g) => (
          <div key={g.label} role="group" aria-label={g.label}>
            <div className="subagents-chooser-head">{g.label}{!g.ready && <span className="subagents-chooser-note">Not signed in</span>}</div>
            {g.rows.map((r) => {
              const on = picked.has(r.key);
              const i = flat.indexOf(r);
              return (
                <div key={r.key} id={`subagents-opt-${r.key}`} role="option" aria-selected={on} aria-disabled={!r.ready || undefined}
                  className="subagents-chooser-row" data-active={i === at || undefined}
                  title={r.ready ? undefined : `${AGENT_META[r.kind].label} is not ready on this Mac`}
                  onPointerMove={() => setActive(i)} onClick={() => { if (r.ready) onToggle(r.key); }}>
                  <Icon name={AGENT_META[r.kind].icon} size={16} colored />
                  <span className="subagents-chooser-label">{r.label}</span>
                  {r.own && <span className="subagents-chooser-note">{AGENT_META[r.kind].label}</span>}
                  <Icon name="check" size={14} className="subagents-chooser-tick" />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>,
    document.body,
  );
}
