import { AGENT_META, type AgentKind, type ModelInfo } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ScrollFades } from "../../components/ScrollFades";
import { useAnchoredPopover } from "../../components/use-anchored-popover";
import { useAutoHideScrollbar } from "../../components/use-auto-hide-scrollbar";
import {
  agentRowHint, billingLead, chipLabel, fastModeHint, fastModeShown, fastModeUntried, filterRows, flatten, formatEffort, groupRows,
  isHarnessDefault, modelAbout, modelIdOn, modelLabel, type FastMode, type ModelRow,
} from "./model-catalog";

export { formatEffort };

/** How many favourites get a ⌘-digit shortcut. Nine because ⌘0 is not a tenth — it is a different
 *  key users read as "zero", and a tenth badge nobody can press is worse than no badge. */
const MAX_SHORTCUTS = 9;

/** Controls the prompter's control row could not fit: when its left group overflows, the permission
 *  chip collapses into this popover as a labelled group instead of wrapping the row. Items mirror the
 *  chip's own menu items exactly — same labels, same handlers. */
export type OverflowGroup = { label: string; items: { label: string; checked?: boolean; onSelect: () => void;
  /** The effort id behind this button, on the effort group only. Carried rather than re-derived from
   *  the label so the easter-egg gradient can name the level it escalates for. */
  effort?: string }[] };

/** A sentence with its commands set as code: `AGENT_NOTES` marks them with backticks, which read as
 *  stray punctuation printed raw. The plain form is for a tooltip, which has no code face. */
const withCode = (text: string) => text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
const plain = (text: string) => text.replace(/`/g, "");

/** The levels the gradient answers to. Below these it stays out of the way entirely — a treatment
 *  every option wore would say nothing about the one that was picked. */
const HEAVY_EFFORTS = new Set(["xhigh", "max"]);

/**
 * Light the chip up when the session commits to one of the heavy efforts.
 *
 * Watches the effort the session actually holds rather than firing from the button's click: the chip
 * is the control that outlives the change. Stateless in the same way the hero greeting's nod is — the
 * mark goes on, the `animationend` the browser is about to fire takes it off. Under reduced motion no
 * animation runs and no `animationend` arrives, so styles.css paints nothing for the attribute there.
 */
function useEffortSweep(ref: RefObject<HTMLButtonElement | null>, effort: string | null, eggs: boolean) {
  const previous = useRef(effort);
  useEffect(() => {
    const changed = previous.current !== effort;
    previous.current = effort;
    const chip = ref.current;
    if (!changed || !eggs || !effort || !HEAVY_EFFORTS.has(effort) || !chip) return;
    // Removing and re-adding in one frame would replay nothing: reading a layout property forces the
    // removal to land first.
    chip.removeAttribute("data-sweep");
    void chip.offsetWidth;
    chip.setAttribute("data-sweep", effort);
    // Its OWN end, by name: the focus ring's halo can be running on the chip too and ends first.
    const done = (e: AnimationEvent) => {
      if (e.animationName !== "eggs-chip-sweep") return;
      chip.removeAttribute("data-sweep");
      chip.removeEventListener("animationend", done);
    };
    chip.addEventListener("animationend", done);
    return () => chip.removeEventListener("animationend", done);
  }, [ref, effort, eggs]);
}

/**
 * The prompter's model selector: one chip, and one compact list behind it.
 *
 * The chip says who is answering — the harness's mark, the model, its effort, a bolt when fast mode
 * is asked for — and the popover is the shortest path to changing any of it:
 *
 * - **A list, one click per model.** Grouped by the harness a click would run it through, the current
 *   model ticked and in view the moment it opens, search at the top, the keyboard everywhere.
 * - **The harness only where there is a choice.** A model another harness can also run carries that
 *   harness's mark on its row, one click away; every other row shows nothing about routes at all.
 * - **Specs as a line, not a column.** What the highlighted model is for, its context and its price
 *   sit in one fixed strip under the list.
 * - **How it runs, on the same surface.** Effort and fast mode are the popover's foot, adjusted
 *   without leaving it — and each appears only where the harness will actually receive it.
 */
export function ModelPicker({ kind, model, effort, rows, info, onToggleFavorite, onPick, effortItems, overflow, fast, eggs = false }: {
  kind: AgentKind;
  model: string | null;
  /** The session's effort level — the chip's grey suffix — or null where it is unset or the harness
   *  never receives it. */
  effort: string | null;
  /** Built by the Composer, so anything else that resolves a route resolves it against these rows. */
  rows: ModelRow[];
  /** The model catalog by canonical key (`store.modelInfo`). Empty is a supported state: rows render
   *  without prices rather than waiting for a network round trip. */
  info: Record<string, ModelInfo>;
  onToggleFavorite: (key: string) => void;
  onPick: (kind: AgentKind, modelId: string | null) => void;
  /** The effort levels this model takes on this harness; empty draws no effort control. */
  effortItems: OverflowGroup["items"];
  /** Fast mode, or absent where Realm cannot ask this harness for it at all. */
  fast?: FastMode;
  overflow?: OverflowGroup[];
  /** Whether the easter eggs are on. Gates the heavy-effort gradient and nothing else here. */
  eggs?: boolean;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = chipLabel(kind, model, rows);
  // The tooltip spells the whole thing out, the vendor's word included, for anyone who needs it.
  const fullName = rows.find((r) => r.selected)?.label ?? label;
  const bolt = fast ? fastModeShown(fast) : false;
  useEffortSweep(btn, effort, eggs);

  return (
    <>
      {/* The mark is the HARNESS's, in colour: the one fact the model's own name cannot carry, and the
          only place a session says which CLI is running it. */}
      <button ref={btn} type="button" className="ghost-chip model-chip" aria-label="Model"
        title={`${fullName} through ${AGENT_META[kind].label}${effort ? ` · ${formatEffort(effort)} effort` : ""}${bolt ? " · fast mode" : ""}`}
        aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        <Icon name={AGENT_META[kind].icon} size={14} colored className="chip-brand" />
        <span className="chip-label">{label}</span>
        {effort && <span className="chip-effort">{formatEffort(effort)}</span>}
        {/* The bolt Codex's own chip wears for its Fast tier: the speed asked for, on a model nothing
            has said cannot serve it. */}
        {bolt && <Icon name="zap" size={12} className="chip-fast" />}
        <Icon name="chevronDown" size={12} className="chip-caret" />
      </button>
      {open && <ModelPopover kind={kind} name={label} rows={rows} info={info} anchorRef={btn} onClose={() => setOpen(false)} onPick={onPick}
        onToggleFavorite={onToggleFavorite} effortItems={effortItems} overflow={overflow} fast={fast} eggs={eggs} />}
    </>
  );
}

function ModelPopover({ kind, name, rows, info, anchorRef, onClose, onPick, onToggleFavorite, effortItems, overflow, fast, eggs }: {
  kind: AgentKind;
  /** The current model's name, as the chip shows it — what the fast-mode line talks about. */
  name: string;
  rows: ModelRow[];
  info: Record<string, ModelInfo>;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void; onPick: (kind: AgentKind, modelId: string | null) => void;
  onToggleFavorite: (key: string) => void;
  effortItems: OverflowGroup["items"];
  fast?: FastMode;
  overflow?: OverflowGroup[];
  eggs?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Right-aligned, opening upward from the chip, which sits at the right end of the control row.
  const { pos, closing, close } = useAnchoredPopover({ ref, anchorRef, placement: "up", align: "right", onClose, exit: true });
  /* No taller than the roomier side of the chip, less the placement's margins. A brand-new session's
     prompter sits mid-window, where neither side held the whole list, and the picker either landed on
     the chip that opened it or ran off the bottom of the window. Capped, the list — the one part
     that can give — gives, and the popover opens whole beside its chip. */
  const [room, setRoom] = useState<number | null>(null);
  useLayoutEffect(() => {
    const a = anchorRef.current?.getBoundingClientRect();
    if (a) setRoom(Math.floor(Math.max(a.top, window.innerHeight - a.bottom)) - 10);
  }, [anchorRef]);
  const [query, setQuery] = useState("");
  /** The highlighted row by id, starting on the current model. Anchored to the ROW rather than an
   *  index: ⌥↩ re-sorts a starred row into Favourites from under the highlight. */
  const [activeKey, setActiveKey] = useState<string | null>(() => rows.find((r) => r.selected)?.id ?? null);
  /** The harness chosen for a row with more than one, where the user changed it with ←/→. Keyed by
   *  row, so re-routing one model never re-routes the next one looked at. */
  const [routes, setRoutes] = useState<Record<string, AgentKind>>({});
  const list = useRef<HTMLDivElement>(null);
  useAutoHideScrollbar(list);

  const queried = useMemo(() => filterRows(rows, query), [rows, query]);
  const groups = useMemo(() => groupRows(queried, { query, kind }), [queried, query, kind]);
  const shown = useMemo(() => flatten(groups), [groups]);
  /** Matches this session can no longer switch to — left out of the list, and said so. */
  const locked = queried.filter((r) => r.blockedReason).length;
  // Numbered by position in the list, so the badges read 1, 2, 3 down the page.
  const shortcuts = useMemo(() => shown.filter((r) => r.favorite).slice(0, MAX_SHORTCUTS), [shown]);
  const cur = Math.max(0, shown.findIndex((r) => r.id === activeKey));
  const activeRow = shown[cur];
  const routeOf = (r: ModelRow): AgentKind => (routes[r.id] && r.harnesses.includes(routes[r.id]!) ? routes[r.id]! : r.kind);
  const waysOf = (r: ModelRow): AgentKind[] => (r.alternates.length > 0 ? [r.kind, ...r.alternates] : []);

  // The current model in view the moment the list can be measured: centred on the first placement,
  // then only nudged as the highlight walks past an edge.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const row = activeRow && document.getElementById(`mp-${activeRow.id}`);
    const box = list.current;
    if (!row || !box || !pos) return;
    if (!placed.current) {
      placed.current = true;
      const r = row.getBoundingClientRect(), b = box.getBoundingClientRect();
      box.scrollTop += r.top - b.top - (b.height - r.height) / 2;
      return;
    }
    row.scrollIntoView?.({ block: "nearest" });
  }, [activeRow, pos]);

  const pick = (row: ModelRow | undefined, harness?: AgentKind) => {
    if (!row || row.blockedReason) return;
    const target = harness && row.harnesses.includes(harness) ? harness : row.kind;
    // `modelIdOn` re-reads the id for THAT harness rather than re-sending the resolved one: a foreign
    // id is rejected on the wire.
    onPick(target, modelIdOn(row, target) ?? null);
    close();
  };
  const move = (by: number) => setActiveKey(shown[Math.min(shown.length - 1, Math.max(0, cur + by))]?.id ?? null);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "PageDown") { e.preventDefault(); move(8); }
    else if (e.key === "PageUp") { e.preventDefault(); move(-8); }
    // ←/→ walk the highlighted model's harnesses, where it has more than one; anywhere else they are
    // the search field's own caret keys.
    else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && activeRow && waysOf(activeRow).length > 1) {
      e.preventDefault();
      const ways = waysOf(activeRow);
      const at = ways.indexOf(routeOf(activeRow));
      setRoutes({ ...routes, [activeRow.id]: ways[(at + (e.key === "ArrowRight" ? 1 : ways.length - 1)) % ways.length]! });
    }
    // ⌥↩ stars the highlighted row — the keyboard's path to a star focus never enters.
    else if (e.key === "Enter" && e.altKey) { e.preventDefault(); if (activeRow) onToggleFavorite(activeRow.key); }
    else if (e.key === "Enter") { e.preventDefault(); if (activeRow) pick(activeRow, routeOf(activeRow)); }
    // ⌘1…⌘9 pick a favourite. Free to bind here: the window's ⌘-digit space binding does not run
    // while this search field, autofocused for the popover's whole life, holds the keyboard.
    else if (e.metaKey && e.key >= "1" && e.key <= "9") { e.preventDefault(); pick(shortcuts[Number(e.key) - 1]); }
  };

  const harness = AGENT_META[kind].label;
  const hasFoot = effortItems.length > 0 || !!fast || (overflow?.length ?? 0) > 0;
  return createPortal(
    <div ref={ref} className="model-picker" aria-label="Model picker" role="dialog"
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: room ?? undefined,
        visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "bottom right" }}
      data-closing={closing || undefined} data-eggs={eggs || undefined} inert={closing}>
      <div className="mp-search">
        <Icon name="search" size={14} />
        {/* Autofocused because the picker opens for typing — the command palette's bargain. */}
        <input autoFocus type="text" value={query} placeholder="Search models" aria-label="Search models"
          role="combobox" aria-expanded aria-controls="mp-list" aria-activedescendant={activeRow ? `mp-${activeRow.id}` : undefined}
          onChange={(e) => { setQuery(e.target.value); setActiveKey(null); }} onKeyDown={onKeyDown} />
      </div>
      <div className="mp-list-wrap">
        <ScrollFades scroller={list} />
        <div ref={list} className="mp-list" id="mp-list" role="listbox" aria-label="Models">
          {groups.map((g) => (
            <div key={g.id} id={`mp-group-${g.id}`} className="mp-group" role="group" aria-label={g.label || "Results"}>
              {g.label && <div className="mp-group-label" aria-hidden="true">{g.label}</div>}
              {g.rows.map((r) => {
                const active = r === activeRow;
                const ways = waysOf(r);
                const title = g.byHarness ? AGENT_META[r.kind].label : modelLabel(r);
                const hint = g.byHarness ? agentRowHint(r) : null;
                const n = shortcuts.indexOf(r);
                return (
                  <div key={r.id} id={`mp-${r.id}`} role="option" tabIndex={-1} className="mp-row"
                    aria-selected={r.selected}
                    aria-label={[g.byHarness ? AGENT_META[r.kind].label : r.label, hint, r.note].filter(Boolean).join(", ")}
                    data-active={active || undefined}
                    onMouseEnter={() => setActiveKey(r.id)}
                    onClick={() => pick(r, routeOf(r))}>
                    <Icon name={r.icon} size={16} colored className="mp-row-mark" />
                    <span className="mp-row-name">{title}</span>
                    {hint && <span className="mp-row-hint">{hint}</span>}
                    {r.note && <span className="mp-row-hint" data-tone="warning">{r.note}</span>}
                    <span className="mp-row-end">
                      {/* The model's other harnesses, on the row a person is looking at and nowhere
                          else: one click runs it through that one. The lit mark is where Enter goes. */}
                      {active && ways.length > 1 && (
                        <span className="mp-ways" role="group" aria-label={`Run ${r.label} through`}>
                          {ways.map((h) => (
                            <button key={h} type="button" className="mp-way" tabIndex={-1} aria-pressed={h === routeOf(r)}
                              aria-label={`Run ${r.label} through ${AGENT_META[h].label}`} title={`Through ${AGENT_META[h].label}${r.notes[h] ? ` — ${r.notes[h]}` : ""}`}
                              onClick={(e) => { e.stopPropagation(); pick(r, h); }}>
                              <Icon name={AGENT_META[h].icon} size={12} colored />
                            </button>
                          ))}
                        </span>
                      )}
                      {n >= 0 && <kbd className="mp-kbd">⌘{n + 1}</kbd>}
                      {/* On the row under the pointer, and on a starred one — never a column of
                          hollow stars down the whole list. Starring a model is not choosing it. */}
                      {(active || r.favorite) && (
                        <button type="button" className="mp-star" tabIndex={-1} aria-pressed={r.favorite}
                          aria-label={r.favorite ? `Unfavourite ${r.label}` : `Favourite ${r.label}`}
                          title={r.favorite ? "Unfavourite (⌥↩)" : "Favourite (⌥↩)"}
                          onClick={(e) => { e.stopPropagation(); onToggleFavorite(r.key); }}>
                          <Icon name="star" size={12} />
                        </button>
                      )}
                      {r.selected && <Icon name="check" size={14} className="mp-check" />}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
          {shown.length === 0 && (
            <div className="mp-empty">{locked > 0
              ? `No ${harness} model matches “${query.trim()}” — this session has already run, so other agents’ models are not offered.`
              : `No models match “${query.trim()}”.`}</div>
          )}
          {shown.length > 0 && !query.trim() && locked > 0 && (
            <p className="mp-locked">This session has already run on {harness}, so other agents’ models are not offered.</p>
          )}
        </div>
      </div>
      {activeRow && <About row={activeRow} route={routeOf(activeRow)} info={info} />}
      {hasFoot && (
        <div className="mp-foot">
          {/* Effort and fast mode stay put when changed: they are settings on the surface you are
              looking at, and the segment lighting up is the answer. Only a model closes the picker. */}
          {effortItems.length > 0 && <Segments label="Effort" items={effortItems} />}
          {fast && <FastRow fast={fast} model={name} harness={harness} />}
          {/* A folded chip's menu still closes on a pick, as the chip's own menu does. */}
          {(overflow ?? []).map((g) => <Segments key={g.label} label={g.label} items={g.items} onPicked={close} />)}
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * The highlighted model, in two lines that never change height: what it is for (or the one thing
 * about its route that would surprise someone), then its context and price — the public catalog's
 * API list price, with who actually bills for this harness one hover away.
 *
 * Fixed because the popover grows UPWARD from the chip: a strip that took a line more for one model
 * than the next would move every row above it, and the row under the pointer with them.
 */
function About({ row, route, info }: { row: ModelRow; route: AgentKind; info: Record<string, ModelInfo> }) {
  const { note, warning, specs, billing } = modelAbout(row, route, info);
  // Led by the model's name: the strip sits under whichever row the list happens to end on, and it
  // is about the highlighted one, which may be a screen away.
  const name = isHarnessDefault(row) ? AGENT_META[route].label : modelLabel({ ...row, kind: route });
  return (
    <div className="mp-about">
      <p className="mp-about-note" data-tone={warning ? "warning" : undefined} title={plain(warning ?? note)}>
        {warning
          ? <><Icon name="alert" size={12} />{withCode(warning)}</>
          : <><span className="mp-about-name">{name}</span>{withCode(note)}</>}
      </p>
      <p className="mp-about-specs" title={plain(billing)}>{withCode(specs ?? billingLead(billing))}</p>
    </div>
  );
}

function Segments({ label, items, onPicked }: { label: string; items: OverflowGroup["items"]; onPicked?: () => void }) {
  return (
    <div className="mp-seg-group" role="group" aria-label={label}>
      <span className="mp-seg-label">{label}</span>
      <div className="mp-seg">
        {items.map((it, i) => (
          <button key={i} type="button" className="mp-seg-opt" aria-pressed={!!it.checked} data-effort={it.effort}
            onClick={() => { it.onSelect(); onPicked?.(); }}>{it.label}</button>
        ))}
      </div>
    </div>
  );
}

/**
 * Fast mode, honest about how much is known. A switch where the harness said the model can run it,
 * or where nothing has said yet — on, it is a request the first turn answers, and the line under it
 * says so; where the harness said it cannot, no switch, and the models that can, by name.
 */
function FastRow({ fast, model, harness }: { fast: FastMode; model: string; harness: string }) {
  const a = fast.availability;
  const hint = fastModeHint(fast);
  // A refusal of a turn that DID ask is a warning; everything else on this line is information.
  const refused = a.state !== "unavailable" && fast.on && fast.state !== null && fast.state !== "on" && !fastModeUntried(fast);
  const title = a.state === "unknown"
    ? `Nothing has said yet whether ${model} runs fast mode on ${harness}. Switched on, the first turn asks for it and reports what happened.`
    : a.state === "unavailable" ? `${harness} says ${model} cannot run fast mode.` : undefined;
  return (
    <div className="mp-fast" role="group" aria-label="Fast mode" data-state={a.state} title={title}>
      <span className="mp-fast-label" id="mp-fast-label">Fast mode</span>
      <Icon name="zap" size={12} className="mp-fast-mark" />
      {a.state === "unavailable"
        ? <span className="mp-fast-off">Not on {model}</span>
        : <input type="checkbox" role="switch" className="switch" aria-labelledby="mp-fast-label"
            checked={fast.on} onChange={(e) => fast.onChange(e.target.checked)} />}
      {hint && <p className="mp-fast-note" data-tone={refused ? "warning" : undefined}>{hint}</p>}
    </div>
  );
}
