import { AGENT_META, AGENT_NOTES, DEFAULT_MODEL_LABEL, formatContext, formatPrice, type AgentKind, type ModelInfo } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "../../components/use-anchored-popover";
import { filterRows, filterVendor, flatten, groupRows, modelDetail, modelIdOn, modelVendor, vendorsOf, type ModelRow } from "./model-rows";

/** How many favourites get a ⌘-digit shortcut. Nine because ⌘0 is not a tenth — it is a different
 *  key users read as "zero", and a tenth badge nobody can press is worse than no badge. */
const MAX_SHORTCUTS = 9;

/**
 * The prompter's model selector: ONE chip that owns every part of "who is answering this".
 *
 * There used to be two chips and two mechanisms — a harness menu beside a model popover — which asked
 * the user to hold a distinction the product had never explained: a *harness* is the CLI Realm drives,
 * a *model* is what that CLI talks to, and most models are reachable through several harnesses. Split
 * across two controls, picking Opus from a Codex session was a two-step move through a state nobody
 * intended, and neither control ever said what either choice would cost or be good at.
 *
 * So the two collapse into one popover with three jobs, in this order:
 *
 * 1. **Find a model** — one search over every model and every harness that can run it. Grouped by
 *    harness when idle, flat when searching.
 * 2. **Understand it** — the detail pane says what the model is FOR, what it costs per million
 *    tokens, how much context it has, and which effort levels it accepts. The numbers come from a
 *    public catalog (`models.catalog`); the sentence is Realm's own where we have written one.
 * 3. **Choose the route** — "Run it through" names every harness that offers this model, so the
 *    harness decision lives WITH the model it applies to instead of in a chip beside it.
 *
 * The chip itself keeps the harness's brand mark (the CLI actually running the session), the model's
 * name and the effort level, so nothing the two-chip layout said is lost.
 */
/** Controls the control row could not fit (Ara refresh §3): when the prompter's left group overflows,
 *  the permission chip collapses into this menu as labelled option groups instead of wrapping the
 *  row. Items mirror the chips' own menu items exactly — same labels, same handlers. */
export type OverflowGroup = { label: string; items: { label: string; checked?: boolean; onSelect: () => void }[] };

/** Display form of an effort level: capitalised, with `xhigh` as "XHigh" — the id's two morphemes
 *  each get their cap, and no hyphen is invented that the CLIs never print. One formatter for the
 *  chip's suffix and the picker's effort buttons, so the two can never disagree. */
export const formatEffort = (e: string): string => (e === "xhigh" ? "XHigh" : e.charAt(0).toUpperCase() + e.slice(1));

export function ModelPicker({ kind, model, effort, rows, info, onToggleFavorite, onPick, effortItems, overflow }: {
  kind: AgentKind;
  model: string | null;
  /** The session's effort level — the chip's gray suffix. `null` (unset) shows nothing at all. */
  effort: string | null;
  /** Built by the Composer rather than here, so anything else that resolves a route resolves it
   *  against the very rows the list is showing — two `modelRows` calls could drift apart. */
  rows: ModelRow[];
  /** The model catalog by canonical key (`store.modelInfo`). Empty is a supported state, not a
   *  loading one: rows render without prices rather than waiting for a network round trip. */
  info: Record<string, ModelInfo>;
  onToggleFavorite: (key: string) => void;
  onPick: (kind: AgentKind, modelId: string | null) => void;
  /** The effort options, permanently housed in the popover. Same shape as an overflow group's items. */
  effortItems: OverflowGroup["items"];
  overflow?: OverflowGroup[];
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // A model id the current agent does not list (a stale row, or a model retired since) still deserves
  // its name shown rather than being silently replaced by the default label.
  const label = rows.find((r) => r.selected)?.label ?? model ?? DEFAULT_MODEL_LABEL[kind];

  return (
    <>
      {/* The mark is the HARNESS's, in colour: it is the one fact the model's own name cannot carry,
          and after the harness chip's retirement this chip is the only place a session says which CLI
          is running it. The title spells the whole triple out for anyone who needs it in words. */}
      <button ref={btn} type="button" className="ghost-chip model-chip" aria-label="Model"
        title={`${label} through ${AGENT_META[kind].label}${effort ? ` · ${formatEffort(effort)} effort` : ""}`}
        aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        <Icon name={AGENT_META[kind].icon} size={14} colored className="chip-brand" />
        <span className="chip-label">{label}</span>
        {effort && <span className="chip-effort">{formatEffort(effort)}</span>}
        <Icon name="chevronDown" size={12} className="chip-caret" />
      </button>
      {open && <ModelPopover rows={rows} info={info} anchorRef={btn} onClose={() => setOpen(false)} onPick={onPick}
        onToggleFavorite={onToggleFavorite} effortItems={effortItems} overflow={overflow} />}
    </>
  );
}

function ModelPopover({ rows, info, anchorRef, onClose, onPick, onToggleFavorite, effortItems, overflow }: {
  rows: ModelRow[];
  info: Record<string, ModelInfo>;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void; onPick: (kind: AgentKind, modelId: string | null) => void;
  onToggleFavorite: (key: string) => void;
  effortItems: OverflowGroup["items"];
  overflow?: OverflowGroup[];
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { pos, closing, close } = useAnchoredPopover({ ref, anchorRef, placement: "up", onClose, exit: true });
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  /** The harness the user has chosen for a given row, when they have overridden the resolved one.
   *  Keyed by row so switching route on one model does not silently re-route the next one you look
   *  at — a route is a property of the choice being made, not a mode the picker is in. */
  const [routes, setRoutes] = useState<Record<string, AgentKind>>({});

  /** The provider narrowing, or null for all of them. See `modelVendor` for why a provider here is
   *  the model's VENDOR and not the harness that runs it. */
  const [vendor, setVendor] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  // The chips come from the UNFILTERED rows, so the strip is a fixed set that neither the query nor
  // a previous pick can reflow out from under the pointer.
  const vendors = useMemo(() => vendorsOf(rows, info), [rows, info]);
  const queried = useMemo(() => filterRows(rows, query), [rows, query]);
  const groups = useMemo(() => groupRows(filterVendor(queried, vendor, info), { query }), [queried, vendor, info, query]);
  const shown = useMemo(() => flatten(groups), [groups]);
  // What each chip would leave, counted against the TEXT query alone — a chip has to be able to say
  // "nothing of mine survives what you typed" without that answer depending on which chip is lit.
  const vendorCounts = useMemo(() => {
    const n = new Map<string, number>();
    for (const r of queried) { const v = modelVendor(r, info); if (v) n.set(v, (n.get(v) ?? 0) + 1); }
    return n;
  }, [queried, info]);
  /** `null` is "All", and it leads the strip — the way back is always the first thing in it. */
  const chips = useMemo((): (string | null)[] => [null, ...vendors], [vendors]);
  const chooseVendor = (v: string | null) => { setVendor(v); setActiveKey(null); };
  // Roving focus, the radio-group way: the strip is ONE tab stop, so the arrows have to carry focus
  // to whichever chip they just lit or the next press would come from a button nobody is on.
  useLayoutEffect(() => {
    const el = strip.current;
    // Only when the strip already had focus: a mouse pick must not pull it out of the search field.
    if (!el || !el.contains(document.activeElement)) return;
    el.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
  }, [vendor]);
  // Bound on the strip and not on the popover, which is what lets these share a keystroke with the
  // ←/→ that walks the highlighted model's routes: that handler is the search field's, and these keys
  // mean "next provider" only while focus is in here.
  const onVendorKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const at = chips.indexOf(vendor);
    chooseVendor(chips[(at + (e.key === "ArrowRight" ? 1 : chips.length - 1)) % chips.length] ?? null);
  };
  // Numbered by POSITION IN THE LIST, not by when they were starred: a badge column that reads
  // 1,2,3 down the page is legible, and one that reads 3,1,2 because that was the starring order is
  // not. The cost is that starring a model renumbers the ones below it, which is a rare thing the
  // user just did on purpose and can watch happen.
  const shortcuts = useMemo(() => shown.filter((r) => r.favorite && !r.blockedReason).slice(0, MAX_SHORTCUTS), [shown]);
  // Anchored to the ROW, not to its index. ⌥↩ re-sorts the starred row into Favourites from under the
  // highlight, and an index would leave the highlight on whatever slid into that slot — the user
  // stars one model and finds another one selected. A key the list no longer holds (search narrowed
  // it away, or nothing is highlighted yet) resolves to the first row, so Enter never dead-ends.
  const cur = Math.max(0, shown.findIndex((r) => r.key === activeKey));
  const activeRow = shown[cur];
  // The route a pick would take: the user's override where they made one, the row's own resolution
  // otherwise. Never a harness the row cannot reach — an override left behind by a probe that has
  // since changed the row's routes falls back rather than transmitting an id that harness rejects.
  const route = activeRow && routes[activeRow.key] && activeRow.harnesses.includes(routes[activeRow.key]!)
    ? routes[activeRow.key]! : activeRow?.kind;

  // With live catalogs the list runs to 40+ rows inside `.mp-list`'s max-height, so arrowing past the
  // fold must bring the highlight along. `nearest` keeps this a no-op for rows already visible, which
  // also makes the mouseEnter -> setActiveKey path scroll-free.
  useEffect(() => {
    if (activeRow) document.getElementById(`mp-${activeRow.key}`)?.scrollIntoView?.({ block: "nearest" });
  }, [activeRow]);

  const pick = (row: ModelRow | undefined, harness?: AgentKind) => {
    if (!row || row.blockedReason) return; // blocked rows are readable, never actionable
    const target = harness && row.harnesses.includes(harness) ? harness : row.kind;
    // `modelIdOn` re-reads the id for THAT harness rather than re-sending the resolved one: the same
    // model is `claude-fable-5-1` to the Claude CLI and `claude-fable-5-1` through Cursor's ACP only
    // by luck, and a foreign id is rejected on the wire.
    onPick(target, modelIdOn(row, target) ?? null);
    close();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveKey(shown[Math.min(shown.length - 1, cur + 1)]?.key ?? null); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveKey(shown[Math.max(0, cur - 1)]?.key ?? null); }
    // ←/→ walk the highlighted model's routes, so a keyboard user can reach "the same model, through
    // Cursor" without leaving the search field. A row with one route ignores them.
    else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && activeRow && activeRow.harnesses.length > 1) {
      e.preventDefault();
      const at = activeRow.harnesses.indexOf(route ?? activeRow.kind);
      const next = activeRow.harnesses[(at + (e.key === "ArrowRight" ? 1 : activeRow.harnesses.length - 1)) % activeRow.harnesses.length]!;
      setRoutes({ ...routes, [activeRow.key]: next });
    }
    // ⌥↩ stars the highlighted row. The star is a <button> that focus never enters (rows are
    // options, not stops), so without this a keyboard user could reach every model and favourite
    // none of them.
    else if (e.key === "Enter" && e.altKey) { e.preventDefault(); if (activeRow) onToggleFavorite(activeRow.key); }
    else if (e.key === "Enter") { e.preventDefault(); pick(activeRow, route); }
    // ⌘1…⌘9 jump to a favourite. Free to bind here without touching hotkeys.ts: the window-level
    // ⌘1…⌘9 "nth space" binding does not opt into `inInputs`, so it is already swallowed while this
    // search field holds focus — which, autofocused, is the whole time the picker is open.
    else if (e.metaKey && e.key >= "1" && e.key <= "9") { e.preventDefault(); pick(shortcuts[Number(e.key) - 1]); }
  };

  return createPortal(
    <div ref={ref} className="model-picker" aria-label="Model picker" role="dialog"
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
        visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "bottom left" }}
      data-closing={closing || undefined} inert={closing}>
      <div className="mp-search">
        <Icon name="search" size={14} />
        {/* Autofocused because the picker opens for typing — the same bargain the command palette
            makes. The placeholder names the harness axis too, because searching "cursor" is how you
            answer "what could I run through Cursor" now that the icon rail is gone. */}
        <input autoFocus type="text" value={query} placeholder="Search models and harnesses…" aria-label="Search models"
          role="combobox" aria-expanded aria-controls="mp-list" aria-activedescendant={activeRow ? `mp-${activeRow.key}` : undefined}
          onChange={(e) => { setQuery(e.target.value); setActiveKey(null); }} onKeyDown={onKeyDown} />
      </div>
      {/* Under the search rather than beside the list, because it narrows what the search searches:
          the two compose, and reading them top to bottom is the order the question is asked in. */}
      {vendors.length > 0 && (
        <div ref={strip} className="mp-vendors" role="radiogroup" aria-label="Provider" onKeyDown={onVendorKey}>
          {chips.map((v) => (
            <button key={v ?? "all"} type="button" role="radio" aria-checked={v === vendor} className="mp-vendor"
              // Dimmed, never disabled: a provider the query has emptied is still worth being able to
              // land on, and the list says so in words when you do.
              data-empty={v !== null && (vendorCounts.get(v) ?? 0) === 0 ? "" : undefined}
              tabIndex={v === vendor ? 0 : -1} onClick={() => chooseVendor(v)}>
              {v ?? "All"}
            </button>
          ))}
        </div>
      )}
      <div className="mp-body">
        <div className="mp-list" id="mp-list" role="listbox" aria-label="Models">
          {groups.map((g) => (
            <div key={g.label} className="mp-group" role="group" aria-label={g.label || "Results"}>
              {g.label && <div className="mp-group-label">{g.label}</div>}
              {g.rows.map((r) => {
                const price = info[r.key];
                return (
                  <div key={r.key} id={`mp-${r.key}`} role="option" tabIndex={-1}
                    className="mp-row" aria-selected={r.selected} aria-disabled={r.blockedReason ? true : undefined}
                    data-active={r === activeRow || undefined} data-blocked={r.blockedReason ? "" : undefined}
                    onMouseEnter={() => setActiveKey(r.key)}
                    onClick={() => pick(r, routes[r.key])}>
                    <Icon name={r.icon} size={15} colored className="mp-row-mark" />
                    <span className="mp-row-text">
                      <span className="mp-row-name">
                        {r.label}
                        {r.selected && <Icon name="check" size={12} className="mp-check" />}
                      </span>
                      <span className="mp-row-sub">
                        {r.agentLabel}
                        {r.note && <span className="mp-note"> — {r.note}</span>}
                        {r.blockedReason && <span className="mp-note"> — unavailable here</span>}
                      </span>
                    </span>
                    {shortcuts.indexOf(r) >= 0 && <kbd className="mp-kbd">⌘{shortcuts.indexOf(r) + 1}</kbd>}
                    {/* Output price alone on the row: it is the number that dominates an agent's
                        bill, and two numbers per row would turn the list into a table. The pair is
                        in the detail pane, labelled. */}
                    {price?.priceOut != null && <span className="mp-row-price">{formatPrice(price.priceOut)}</span>}
                    {/* tabIndex -1 keeps the listbox's one-stop focus model intact (rows are options,
                        not tab stops); the keyboard path to this is ⌥↩ on the highlighted row. The
                        click must not also pick the row — starring a model is not choosing it. */}
                    <button type="button" className="mp-star" tabIndex={-1} aria-pressed={r.favorite}
                      aria-label={r.favorite ? `Unfavourite ${r.label}` : `Favourite ${r.label}`}
                      title={r.favorite ? "Unfavourite (⌥↩)" : "Favourite (⌥↩)"}
                      onClick={(e) => { e.stopPropagation(); onToggleFavorite(r.key); }}>
                      <Icon name="star" size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
          {shown.length === 0 && (
            <div className="mp-empty">
              {/* Both constraints get named. With a provider lit, an empty list is as likely to be the
                  chip's doing as the query's, and "no models match" over a full catalog reads as a bug. */}
              {query.trim() && vendor ? `No ${vendor} models match “${query.trim()}”.`
                : vendor ? `Nothing from ${vendor} can run this session.`
                : `No models match “${query.trim()}”.`}
              {vendor && <button type="button" className="mp-empty-all" onClick={() => chooseVendor(null)}>Show every provider</button>}
            </div>
          )}
        </div>
        {activeRow && route && (
          <ModelDetail row={activeRow} route={route} info={info}
            onRoute={(h) => setRoutes({ ...routes, [activeRow.key]: h })}
            onUse={() => pick(activeRow, route)} effortItems={effortItems} overflow={overflow} onClose={close} />
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Everything Realm knows about the highlighted model, and the two choices that ride with it.
 *
 * The order is the order the question is asked in: what IS this (name, sentence), what does it cost
 * (the stats), how would it run (route pills, and what that harness is like), and then the two
 * controls that belong to the answer rather than to the model — effort, and whatever the prompter's
 * control row could not fit.
 *
 * Every number is allowed to be missing. Cursor's Composer, and every harness's "Default" row, have
 * no catalog entry at all, and a picker that hid them or invented a price would be worse than one
 * that shows the sentence and stops.
 */
function ModelDetail({ row, route, info, onRoute, onUse, effortItems, overflow, onClose }: {
  row: ModelRow; route: AgentKind; info: Record<string, ModelInfo>;
  onRoute: (h: AgentKind) => void; onUse: () => void;
  effortItems: OverflowGroup["items"]; overflow?: OverflowGroup[]; onClose: () => void;
}) {
  const { note, catalog } = modelDetail(row, info);
  const harness = AGENT_NOTES[route];
  return (
    <div className="mp-detail" aria-live="polite">
      {/* Everything the model has to SAY scrolls; the two controls below it never do. A long blurb
          on a small window used to push "Use model" past the popover's edge — the one control the
          whole pane exists to lead to. */}
      <div className="mp-detail-body">
      <div className="mp-detail-head">
        <Icon name={AGENT_META[route].icon} size={18} colored />
        <h3>{row.label}</h3>
      </div>
      {note && <p className="mp-detail-note">{note}</p>}
      {catalog && (catalog.priceIn != null || catalog.context != null) && (
        <div className="mp-stats">
          {catalog.priceIn != null && <Stat k="Input" v={`${formatPrice(catalog.priceIn)} / Mtok`} />}
          {catalog.priceOut != null && <Stat k="Output" v={`${formatPrice(catalog.priceOut)} / Mtok`} />}
          {catalog.context != null && <Stat k="Context" v={formatContext(catalog.context)} />}
          {catalog.efforts.length > 0 && <Stat k="Effort" v={`${formatEffort(catalog.efforts[catalog.efforts.length - 1]!)} → ${formatEffort(catalog.efforts[0]!)}`} />}
        </div>
      )}
      <div className="mp-routes">
        <div className="mp-group-label">Run it through</div>
        <div className="mp-route-pills">
          {/* Each pill is labelled with the whole sentence, not just the harness's name: out of
              context "Cursor" is a button that could do anything, and these are the one control here
              whose meaning depends entirely on which row is highlighted. */}
          {row.harnesses.map((h) => (
            <button key={h} type="button" className="mp-route" aria-pressed={h === route}
              disabled={!!row.blockedReason}
              aria-label={`Run ${row.label} through ${AGENT_META[h].label}`}
              onClick={() => onRoute(h)}>
              <Icon name={AGENT_META[h].icon} size={13} colored />
              {AGENT_META[h].label}
            </button>
          ))}
        </div>
        <p className="mp-harness-note">{harness.good}</p>
        {/* Billing sits directly under the price, and always: a per-token number is a lie about the
            bill for a harness that runs on a subscription, and this is the line that says so. */}
        <p className="mp-harness-billing">{harness.billing}</p>
        {harness.limits && <p className="mp-harness-limits"><Icon name="alert" size={11} /> {harness.limits}</p>}
        {row.blockedReason && <p className="mp-harness-limits"><Icon name="alert" size={11} /> {row.blockedReason}</p>}
      </div>
      </div>
      <div className="mp-detail-foot">
        {/* Effort lives here permanently: the chip's gray suffix names the level, this strip edits it.
            Collapsed control-row groups (§3) append below when the prompter's row overflows —
            rendered whole rather than filtered, because the search box narrows MODELS and hiding a
            permission mode behind a model query would be absurd. */}
        {[{ label: "Effort", items: effortItems }, ...(overflow ?? [])].map((g) => (
          <div key={g.label} className="mp-seg-group" role="group" aria-label={g.label}>
            <span className="mp-seg-label">{g.label}</span>
            <div className="mp-seg">
              {g.items.map((it, i) => (
                <button key={i} type="button" className="mp-seg-opt" aria-pressed={!!it.checked}
                  onClick={() => { it.onSelect(); onClose(); }}>{it.label}</button>
              ))}
            </div>
          </div>
        ))}
        <button type="button" className="mp-use" disabled={!!row.blockedReason} onClick={onUse}>
          {row.selected && row.kind === route ? "Keep model" : "Use model"}
        </button>
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return <div className="mp-stat"><span className="mp-stat-k">{k}</span><span className="mp-stat-v">{v}</span></div>;
}
