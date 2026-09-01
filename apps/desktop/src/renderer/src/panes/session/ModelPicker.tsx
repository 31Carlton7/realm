import { AGENT_META, DEFAULT_MODEL_LABEL, type AgentKind } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "../../components/use-anchored-popover";
import type { AgentProbe } from "../../state/store";
import { filterRows, modelRows, railKinds, type ModelRow } from "./model-rows";

/**
 * The prompter's model selector: one chip that owns both halves of "which model is answering".
 *
 * Realm used to split this across an agent chip and a model chip, which made picking Opus from a
 * Codex session a two-step move through an intermediate state that was nobody's intent. Here a row
 * IS an (agent, model) pair, and selecting one sets both in a single action.
 *
 * Layout follows the picker the user already lives in (T3 Code): a search field, a vertical provider
 * rail that narrows to one agent, and rows of model name over provider name + brand mark.
 */
/** Controls the control row could not fit (Ara refresh §3): when the prompter's left group overflows,
 *  the effort + permission chips collapse into this menu as labelled option groups instead of
 *  wrapping the row. Items mirror the chips' own menu items exactly — same labels, same handlers. */
export type OverflowGroup = { label: string; items: { label: string; checked?: boolean; onSelect: () => void }[] };

/** Display form of an effort level: capitalised, with `xhigh` as "XHigh" — the id's two morphemes
 *  each get their cap, and no hyphen is invented that the CLIs never print. One formatter for the
 *  chip's suffix and the picker's effort buttons, so the two can never disagree. */
export const formatEffort = (e: string): string => (e === "xhigh" ? "XHigh" : e.charAt(0).toUpperCase() + e.slice(1));

export function ModelPicker({ kind, model, effort, canSwitchAgent, agentProbe, onPick, effortItems, overflow }: {
  kind: AgentKind;
  model: string | null;
  /** The session's effort level — the chip's gray suffix. `null` (unset) shows nothing at all. */
  effort: string | null;
  /** False once the session has produced an event — cross-agent rows go unavailable, not invisible. */
  canSwitchAgent: boolean;
  agentProbe: AgentProbe[];
  onPick: (kind: AgentKind, modelId: string | null) => void;
  /** The effort options, permanently housed in the popover (prompter rework: the standalone effort
   *  chip is retired, and this menu is where clicking the suffix leads). Same shape as an overflow
   *  group's items — labels formatted, handlers applying via setSessionOptions. */
  effortItems: OverflowGroup["items"];
  overflow?: OverflowGroup[];
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => modelRows({ kind, model, agentProbe, canSwitchAgent }), [kind, model, agentProbe, canSwitchAgent]);
  // A model id the current agent does not list (a stale row, or a model retired since) still deserves
  // its name shown rather than being silently replaced by the default label.
  const label = rows.find((r) => r.selected)?.label ?? model ?? DEFAULT_MODEL_LABEL[kind];

  return (
    <>
      {/* Prompter rework: the vendor's mark rides the chip IN COLOUR (the one place the provider's
          identity is the point), and the session's effort trails the label as a dimmer suffix —
          "Claude Fable 5 Max". Clicking the chip opens the picker, where both are edited. */}
      <button ref={btn} type="button" className="ghost-chip model-chip" aria-label="Model"
        title={`Model: ${AGENT_META[kind].label} · ${label}${effort ? ` · ${formatEffort(effort)} effort` : ""}`}
        aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        <Icon name={AGENT_META[kind].icon} size={14} colored className="chip-brand" />
        <span className="chip-label">{label}</span>
        {effort && <span className="chip-effort">{formatEffort(effort)}</span>}
        <Icon name="chevronDown" size={12} className="chip-caret" />
      </button>
      {open && <ModelPopover rows={rows} anchorRef={btn} onClose={() => setOpen(false)} onPick={onPick} effortItems={effortItems} overflow={overflow} />}
    </>
  );
}

function ModelPopover({ rows, anchorRef, onClose, onPick, effortItems, overflow }: {
  rows: ModelRow[];
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void; onPick: (kind: AgentKind, modelId: string | null) => void;
  effortItems: OverflowGroup["items"];
  overflow?: OverflowGroup[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onClose(), [onClose]);
  const pos = useAnchoredPopover({ ref, anchorRef, placement: "up", onClose: close });
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<AgentKind | null>(null);
  const [active, setActive] = useState(0);

  const shown = useMemo(() => filterRows(rows, { query, provider }), [rows, query, provider]);
  const rail = useMemo(() => railKinds(rows), [rows]);
  // The highlight is clamped rather than stored as a row key: filtering can shrink the list under it,
  // and a highlight pointing past the end would make Enter do nothing with no visible reason why.
  const cur = Math.min(active, shown.length - 1);
  const activeRow = shown[cur];

  // With live catalogs the list runs to 40+ rows inside `.mp-list`'s max-height, so arrowing past the
  // fold must bring the highlight along. `nearest` keeps this a no-op for rows already visible, which
  // also makes the mouseEnter -> setActive path scroll-free.
  useEffect(() => {
    if (activeRow) document.getElementById(`mp-${activeRow.key}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeRow]);

  const pick = (row: ModelRow | undefined) => {
    if (!row || row.blockedReason) return; // blocked rows are readable, never actionable
    onPick(row.kind, row.modelId);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(Math.min(shown.length - 1, cur + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(Math.max(0, cur - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(activeRow); }
  };

  return createPortal(
    <div ref={ref} className="model-picker" aria-label="Model picker" role="dialog"
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "bottom left" }}>
      <div className="mp-search">
        <Icon name="search" size={14} />
        {/* Autofocused because the picker opens for typing — the same bargain the command palette makes. */}
        <input autoFocus type="text" value={query} placeholder="Search models…" aria-label="Search models"
          role="combobox" aria-expanded aria-controls="mp-list" aria-activedescendant={activeRow ? `mp-${activeRow.key}` : undefined}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKeyDown} />
      </div>
      <div className="mp-body">
        <div className="mp-rail" role="group" aria-label="Filter by provider">
          <button type="button" className="mp-rail-btn" aria-label="All providers" title="All providers"
            aria-pressed={provider === null} onClick={() => { setProvider(null); setActive(0); }}>
            <Icon name="layout" size={15} />
          </button>
          {rail.map((k) => (
            <button key={k} type="button" className="mp-rail-btn" aria-label={AGENT_META[k].label} title={AGENT_META[k].label}
              aria-pressed={provider === k} onClick={() => { setProvider(provider === k ? null : k); setActive(0); }}>
              <Icon name={AGENT_META[k].icon} size={15} />
            </button>
          ))}
        </div>
        <div className="mp-list" id="mp-list" role="listbox" aria-label="Models">
          {shown.map((r) => (
              <div key={r.key} id={`mp-${r.key}`} role="option" tabIndex={-1}
                className="mp-row" aria-selected={r.selected} aria-disabled={r.blockedReason ? true : undefined}
                data-active={r === activeRow || undefined} data-blocked={r.blockedReason ? "" : undefined}
                title={r.blockedReason ?? (r.note ? `${r.agentLabel} is ${r.note}; pick it to see how to fix that` : undefined)}
                onMouseEnter={() => setActive(shown.indexOf(r))}
                onClick={() => pick(r)}>
                <span className="mp-row-text">
                  <span className="mp-row-name">{r.label}</span>
                  <span className="mp-row-provider">
                    <Icon name={r.icon} size={11} colored />
                    {r.agentLabel}
                    {r.note && <span className="mp-note"> — {r.note}</span>}
                  </span>
                </span>
                {r.selected && <Icon name="check" size={13} className="mp-check" />}
                {r.blockedReason && <Icon name="alert" size={13} className="mp-blocked" />}
              </div>
          ))}
          {shown.length === 0 && <div className="mp-empty">No models match “{query.trim()}”.</div>}
        </div>
      </div>
      {/* Effort lives here PERMANENTLY (prompter rework): the chip's gray suffix names the level,
          this strip edits it. Collapsed control-row groups (§3) append below when the row overflows —
          rendered whole rather than filtered, because the search box above narrows MODELS, and hiding
          a permission mode behind a model query would be absurd. */}
      <div className="mp-overflow">
        {[{ label: "Effort", items: effortItems }, ...(overflow ?? [])].map((g) => (
          <div key={g.label} className="mp-overflow-group" role="group" aria-label={g.label}>
            <span className="mp-overflow-label">{g.label}</span>
            <div className="mp-overflow-opts">
              {g.items.map((it, i) => (
                <button key={i} type="button" className="mp-overflow-opt" aria-pressed={!!it.checked}
                  onClick={() => { it.onSelect(); onClose(); }}>{it.label}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
      {rows.some((r) => r.blockedReason) && (
        <div className="mp-foot">A session’s agent can only change before its first message.</div>
      )}
    </div>,
    document.body,
  );
}
