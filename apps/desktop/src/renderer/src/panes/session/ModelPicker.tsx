import { AGENT_META, DEFAULT_MODEL_LABEL, type AgentKind } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "../../components/use-anchored-popover";
import type { AgentProbe } from "../../state/store";
import { filterRows, modelRows, railKinds, sortFavoritesFirst, type ModelRow, type RailFilter } from "./model-rows";

/** How many favourites get a ⌘-digit shortcut. Nine because ⌘0 is not a tenth — it is a different
 *  key users read as "zero", and a tenth badge nobody can press is worse than no badge. */
const MAX_SHORTCUTS = 9;

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

export function ModelPicker({ kind, model, effort, canSwitchAgent, agentProbe, favorites, onToggleFavorite, onPick, effortItems, overflow }: {
  kind: AgentKind;
  model: string | null;
  /** The session's effort level — the chip's gray suffix. `null` (unset) shows nothing at all. */
  effort: string | null;
  /** False once the session has produced an event — cross-agent rows go unavailable, not invisible. */
  canSwitchAgent: boolean;
  agentProbe: AgentProbe[];
  /** Canonical keys the user has starred (`MODEL_FAVORITES_KEY`). */
  favorites: string[];
  onToggleFavorite: (key: string) => void;
  onPick: (kind: AgentKind, modelId: string | null) => void;
  /** The effort options, permanently housed in the popover (prompter rework: the standalone effort
   *  chip is retired, and this menu is where clicking the suffix leads). Same shape as an overflow
   *  group's items — labels formatted, handlers applying via setSessionOptions. */
  effortItems: OverflowGroup["items"];
  overflow?: OverflowGroup[];
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => modelRows({ kind, model, agentProbe, canSwitchAgent, favorites }), [kind, model, agentProbe, canSwitchAgent, favorites]);
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
      {open && <ModelPopover rows={rows} anchorRef={btn} onClose={() => setOpen(false)} onPick={onPick}
        onToggleFavorite={onToggleFavorite} effortItems={effortItems} overflow={overflow} />}
    </>
  );
}

function ModelPopover({ rows, anchorRef, onClose, onPick, onToggleFavorite, effortItems, overflow }: {
  rows: ModelRow[];
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void; onPick: (kind: AgentKind, modelId: string | null) => void;
  onToggleFavorite: (key: string) => void;
  effortItems: OverflowGroup["items"];
  overflow?: OverflowGroup[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => onClose(), [onClose]);
  const pos = useAnchoredPopover({ ref, anchorRef, placement: "up", onClose: close });
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<RailFilter>(null);
  const [active, setActive] = useState(0);

  // Favourites float to the top of whatever the search and the rail have left, so the ⌘-digit rows
  // are always the ones the eye lands on first.
  const shown = useMemo(() => sortFavoritesFirst(filterRows(rows, { query, provider })), [rows, query, provider]);
  const rail = useMemo(() => railKinds(rows), [rows]);
  // Numbered by POSITION IN THE LIST, not by when they were starred: a badge column that reads
  // 1,2,3 down the page is legible, and one that reads 3,1,2 because that was the starring order is
  // not. The cost is that starring a model renumbers the ones below it, which is a rare thing the
  // user just did on purpose and can watch happen.
  const shortcuts = useMemo(() => shown.filter((r) => r.favorite && !r.blockedReason).slice(0, MAX_SHORTCUTS), [shown]);
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
    // ⌥↩ stars the highlighted row. The star is a <button> that focus never enters (rows are
    // options, not stops), so without this a keyboard user could reach every model and favourite
    // none of them.
    else if (e.key === "Enter" && e.altKey) { e.preventDefault(); if (activeRow) onToggleFavorite(activeRow.key); }
    else if (e.key === "Enter") { e.preventDefault(); pick(activeRow); }
    // ⌘1…⌘9 jump to a favourite. Free to bind here without touching hotkeys.ts: the window-level
    // ⌘1…⌘9 "nth space" binding does not opt into `inInputs`, so it is already swallowed while this
    // search field holds focus — which, autofocused, is the whole time the picker is open.
    else if (e.metaKey && e.key >= "1" && e.key <= "9") { e.preventDefault(); pick(shortcuts[Number(e.key) - 1]); }
  };

  return createPortal(
    <div ref={ref} className="model-picker" aria-label="Model picker" role="dialog"
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "bottom left" }}>
      {/* The rail sits ABOVE the search, not beside the list: it scopes what the search then narrows,
          and reading it left-to-right before typing matches the order the user actually works in. */}
      <div className="mp-rail" role="group" aria-label="Filter models">
        <button type="button" className="mp-rail-btn" aria-label="Favourites" title="Favourites"
          aria-pressed={provider === "favorites"} onClick={() => { setProvider(provider === "favorites" ? null : "favorites"); setActive(0); }}>
          <Icon name="star" size={15} />
        </button>
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
      <div className="mp-search">
        <Icon name="search" size={14} />
        {/* Autofocused because the picker opens for typing — the same bargain the command palette makes. */}
        <input autoFocus type="text" value={query} placeholder="Search models…" aria-label="Search models"
          role="combobox" aria-expanded aria-controls="mp-list" aria-activedescendant={activeRow ? `mp-${activeRow.key}` : undefined}
          onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKeyDown} />
      </div>
      <div className="mp-body">
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
                {shortcuts.indexOf(r) >= 0 && <kbd className="mp-kbd">⌘{shortcuts.indexOf(r) + 1}</kbd>}
                {r.selected && <Icon name="check" size={13} className="mp-check" />}
                {r.blockedReason && <Icon name="alert" size={13} className="mp-blocked" />}
                {/* tabIndex -1 keeps the listbox's one-stop focus model intact (rows are options, not
                    tab stops); the keyboard path to this is ⌥↩ on the highlighted row. The click must
                    not also pick the row — starring a model is not choosing it. */}
                <button type="button" className="mp-star" tabIndex={-1} aria-pressed={r.favorite}
                  aria-label={r.favorite ? `Unfavourite ${r.label}` : `Favourite ${r.label}`}
                  title={r.favorite ? "Unfavourite (⌥↩)" : "Favourite (⌥↩)"}
                  onClick={(e) => { e.stopPropagation(); onToggleFavorite(r.key); }}>
                  <Icon name="star" size={13} />
                </button>
              </div>
          ))}
          {shown.length === 0 && (
            <div className="mp-empty">
              {provider === "favorites" && query.trim() === ""
                ? "No favourites yet — star a model to pin it here and give it a ⌘-number."
                : `No models match “${query.trim()}”.`}
            </div>
          )}
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
