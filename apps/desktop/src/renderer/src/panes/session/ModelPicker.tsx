import { AGENT_META, type AgentKind, type ModelInfo } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ScrollFades } from "../../components/ScrollFades";
import { useAnchoredPopover } from "../../components/use-anchored-popover";
import { useAutoHideScrollbar } from "../../components/use-auto-hide-scrollbar";
import {
  agentRowHint, billingLead, chipLabel, chipTitle, effortCurrent, fastModeHint, fastModeShown, fastModeTitle, fastModeUntried, filterRows, flatten,
  formatEffort, groupRows, holdRows, isHarnessDefault, modelAbout, modelIdOn, modelLabel, type EffortControl, type FastMode, type ModelRow,
} from "./model-catalog";

export { formatEffort };

/** How many favourites get a ⌘-digit shortcut. Nine because ⌘0 is not a tenth — it is a different
 *  key users read as "zero", and a tenth badge nobody can press is worse than no badge. */
const MAX_SHORTCUTS = 9;

/** The most of the list a box held after a pick insists on keeping (`ModelPopover`'s `floor`): three
 *  rows and the list's own padding, which is enough to see the row just pressed and its neighbours. */
const LIST_FLOOR = 32 * 3 + 22;

/** Controls the prompter's control row could not fit: when its left group overflows, the permission
 *  chip collapses into this popover as a labelled group instead of wrapping the row. Items mirror the
 *  chip's own menu items exactly — same labels, same handlers. */
export type OverflowGroup = { label: string; items: { label: string; checked?: boolean; onSelect: () => void }[] };

/** A sentence with its commands set as code: `AGENT_NOTES` marks them with backticks, which read as
 *  stray punctuation printed raw. The plain form is for a tooltip, which has no code face. */
const withCode = (text: string) => text.split(/`([^`]+)`/).map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part));
const plain = (text: string) => text.replace(/`/g, "");

/** The levels Realm's light answers to — the track's field, the knob's shine, the chip's pass. Below
 *  these it stays out of the way entirely: a treatment every level wore would say nothing about the
 *  one that was picked. */
export const HEAVY_EFFORTS = new Set(["xhigh", "max"]);

/** Whether the app is holding its motion still: the reader asked (`prefers-reduced-motion`, which the
 *  app's own Reduce motion setting drives), or Low power is on. A moment that cannot play is not
 *  started, rather than started and frozen at its first frame. */
const motionHeld = (): boolean =>
  (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false) || document.documentElement.dataset.quiet === "always";

/**
 * Play a one-shot animation by setting `attr` on `el`, and take the attribute off when THAT animation
 * ends. Stateless in the same way the hero greeting's nod is: the mark goes on, the `animationend` the
 * browser is about to fire takes it off. Returns the listener's cleanup.
 */
function replay(el: HTMLElement | null, attr: string, value: string, animation: string): (() => void) | undefined {
  if (!el || motionHeld()) return;
  // Removing and re-adding in one frame would replay nothing: reading a layout property forces the
  // removal to land first.
  el.removeAttribute(attr);
  void el.offsetWidth;
  el.setAttribute(attr, value);
  // Its OWN end, by name: the focus ring's halo can be running on the same element and end first.
  const done = (e: AnimationEvent) => {
    if (e.animationName !== animation) return;
    el.removeAttribute(attr);
    el.removeEventListener("animationend", done);
  };
  el.addEventListener("animationend", done);
  return () => el.removeEventListener("animationend", done);
}

/**
 * The chip answers when the session commits to more: a pass of light when it moves up to one of the
 * heavy levels (two at Max), and a quicker glint when fast mode is switched on. Switching either off
 * is quiet.
 *
 * One mechanism for both, because the chip has one `animation`: two that each claimed it would cancel
 * each other, and the later commit is the one the chip should answer. Watches what the session
 * actually holds rather than a click — the chip is the control that outlives the change — so a level
 * the session was opened at, or a re-render that changed nothing, plays nothing.
 */
function useChipSweep(ref: RefObject<HTMLButtonElement | null>, effort: string | null, fastOn: boolean) {
  const previous = useRef({ effort, fastOn });
  useEffect(() => {
    const was = previous.current;
    previous.current = { effort, fastOn };
    const kind = fastOn && !was.fastOn ? "fast"
      : effort !== was.effort && effort && HEAVY_EFFORTS.has(effort) ? effort : null;
    if (kind) return replay(ref.current, "data-sweep", kind, "rl-chip-sweep");
  }, [ref, effort, fastOn]);
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
 * - **How it runs, on the same surface.** Effort and fast mode are the popover's foot — Codex's own
 *   card: the bolt, the level by name, a reset to the model's default, a track with a dot per level —
 *   adjusted without leaving it, and each drawn only where the harness will actually receive it.
 * - **Open until you leave it.** A pick changes the model and leaves the card to set its level and its
 *   speed in the same visit; a click outside, the chip again, or Escape put the picker away.
 */
export function ModelPicker({ kind, model, effort, rows, info, onToggleFavorite, onPick, overflow, fast, eggs = false }: {
  kind: AgentKind;
  model: string | null;
  /** The session's reasoning level and what its model takes, or absent where the harness takes none —
   *  the chip's grey suffix names the level in force. */
  effort?: EffortControl;
  /** Built by the Composer, so anything else that resolves a route resolves it against these rows. */
  rows: ModelRow[];
  /** The model catalog by canonical key (`store.modelInfo`). Empty is a supported state: rows render
   *  without prices rather than waiting for a network round trip. */
  info: Record<string, ModelInfo>;
  onToggleFavorite: (key: string) => void;
  onPick: (kind: AgentKind, modelId: string | null) => void;
  /** Fast mode, or absent where Realm cannot ask this harness for it at all. */
  fast?: FastMode;
  overflow?: OverflowGroup[];
  /** Whether the easter eggs are on. They run the heavy levels' light hot, and nothing else here. */
  eggs?: boolean;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const label = chipLabel(kind, model, rows);
  // The tooltip spells the whole thing out, the vendor's word included, for anyone who needs it.
  const fullName = rows.find((r) => r.selected)?.label ?? label;
  const bolt = fast ? fastModeShown(fast) : false;
  // The level in force, by name — the session's own, or the model's default where one is named.
  const level = effort && effort.levels.length > 0 ? effortCurrent(effort).choice?.label ?? null : null;
  useChipSweep(btn, effort?.value ?? null, fast?.on ?? false);

  return (
    <>
      {/* The mark is the HARNESS's, in colour: the one fact the model's own name cannot carry, and the
          only place a session says which CLI is running it. */}
      <button ref={btn} type="button" className="ghost-chip model-chip" aria-label="Model"
        title={chipTitle(fullName, kind, level, bolt)}
        aria-haspopup="dialog" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        <ModelChipText kind={kind} label={label} level={level} fast={bolt} />
        <Icon name="chevronDown" size={12} className="chip-caret" />
      </button>
      {open && <ModelPopover kind={kind} name={label} rows={rows} info={info} anchorRef={btn} onClose={() => setOpen(false)} onPick={onPick}
        onToggleFavorite={onToggleFavorite} effort={effort} overflow={overflow} fast={fast} eggs={eggs} />}
    </>
  );
}

/**
 * What the model chip says, in its own words: the harness's mark, the model, the level in force and
 * the bolt. Anything else that names how work will run reads the same way — a scheduled task's card
 * and its row in the column — because they are the same four facts about the same session to come.
 */
export function ModelChipText({ kind, label, level, fast }: { kind: AgentKind; label: string; level: string | null; fast: boolean }) {
  return (
    <>
      <Icon name={AGENT_META[kind].icon} size={14} colored className="chip-brand" />
      <span className="chip-label">{label}</span>
      {level && <span className="chip-effort">{level}</span>}
      {/* The bolt Codex's own chip wears for its Fast tier: the speed asked for, on a model nothing
          has said cannot serve it. */}
      {fast && <Icon name="zap" size={12} className="chip-fast" />}
    </>
  );
}

function ModelPopover({ kind, name, rows, info, anchorRef, onClose, onPick, onToggleFavorite, effort, overflow, fast, eggs }: {
  kind: AgentKind;
  /** The current model's name, as the chip shows it — what the fast-mode line talks about. */
  name: string;
  rows: ModelRow[];
  info: Record<string, ModelInfo>;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void; onPick: (kind: AgentKind, modelId: string | null) => void;
  onToggleFavorite: (key: string) => void;
  effort?: EffortControl;
  fast?: FastMode;
  overflow?: OverflowGroup[];
  eggs?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Right-aligned, opening upward from the chip, which sits at the right end of the control row.
  const { pos, closing } = useAnchoredPopover({ ref, anchorRef, placement: "up", align: "right", onClose, exit: true });
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
  /** The harness chosen for a row with more than one, where the user changed it with ←/→ or picked it
   *  through one. Keyed by row, so re-routing one model never re-routes the next one looked at. */
  const [routes, setRoutes] = useState<Record<string, AgentKind>>({});
  /* The list and the harness it leads with, as they were when the picker opened (`holdRows`): a pick
     that moves the session to another harness must not re-sort the list under the pointer. */
  const [opened] = useState(() => ({ rows, kind }));
  const held = useMemo(() => holdRows(rows, opened.rows), [rows, opened]);
  /** The box's height from the first pick on. The new model's card can be another size — more levels,
   *  none, no bolt — and the popover hangs from its chip, so a card that changed height moved
   *  everything above it, the row just pressed included. Held, the list takes up the difference: it is
   *  the one part that scrolls. A search lets go, because a shorter list is a smaller box. */
  const [height, setHeight] = useState<number | null>(null);
  /** How much of the list a held box keeps, so a card that grew cannot squeeze it to nothing: past
   *  that, the box grows by what the card still needs rather than clip it. */
  const [floor, setFloor] = useState(0);
  /** Room under the list's last row, for a list scrolled near its end when a card smaller than the one
   *  it replaces gives the list the difference: with nothing more to show, the browser pulls the
   *  scroll back and every row comes down under the pointer. */
  const [slack, setSlack] = useState(0);
  /** A model has just been picked here: until the highlight moves or the search changes, ←/→ in the
   *  search field step that model's level, which is what the keyboard reaches for next. */
  const [tuning, setTuning] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useAutoHideScrollbar(list);
  useLayoutEffect(() => {
    const el = ref.current;
    if (height !== null && el && el.scrollHeight > height) setHeight(el.scrollHeight);
  });

  const queried = useMemo(() => filterRows(held, query), [held, query]);
  const groups = useMemo(() => groupRows(queried, { query, kind: opened.kind }), [queried, query, opened.kind]);
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

  /* A pick changes the model and leaves the picker open, so the card under the list can set how the
     new model runs in the same visit (the owner, 10-05). */
  const pick = (row: ModelRow | undefined, harness?: AgentKind) => {
    if (!row || row.blockedReason) return;
    const target = harness && row.harnesses.includes(harness) ? harness : row.kind;
    const box = ref.current?.offsetHeight ?? 0;
    if (height === null && box > 0) {
      setHeight(box);
      setFloor(Math.min(wrap.current?.offsetHeight ?? 0, LIST_FLOOR));
    }
    // The most the list can be given is the whole of the card now under it.
    const foot = ref.current?.querySelector<HTMLElement>(".mp-foot")?.offsetHeight ?? 0;
    const l = list.current;
    if (l && foot > 0) setSlack((was) => was + Math.max(0, foot - (l.scrollHeight - l.clientHeight - l.scrollTop)));
    setRoutes((rs) => ({ ...rs, [row.id]: target }));
    setActiveKey(row.id);
    setTuning(true);
    // `modelIdOn` re-reads the id for THAT harness rather than re-sending the resolved one: a foreign
    // id is rejected on the wire.
    onPick(target, modelIdOn(row, target) ?? null);
    // The keyboard stays in the search with its words selected, so the next one typed starts afresh
    // and the list stays as it is until then.
    search.current?.focus();
    search.current?.select();
  };
  const move = (by: number) => {
    setTuning(false);
    setActiveKey(shown[Math.min(shown.length - 1, Math.max(0, cur + by))]?.id ?? null);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "PageDown") { e.preventDefault(); move(8); }
    else if (e.key === "PageUp") { e.preventDefault(); move(-8); }
    // Right after a pick, ←/→ step the picked model's level, as they do on the track.
    else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && tuning && effort && effort.levels.length > 1) {
      e.preventDefault();
      stepLevel(effort, e.key === "ArrowRight" ? 1 : -1);
    }
    // Otherwise they walk the highlighted model's harnesses, where it has more than one; anywhere
    // else they are the search field's own caret keys.
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
  const runs = (effort?.levels.length ?? 0) > 0 || !!fast;
  const hasFoot = runs || (overflow?.length ?? 0) > 0;
  return createPortal(
    <div ref={ref} className="model-picker" aria-label="Model picker" role="dialog"
      style={{ position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: room ?? undefined,
        height: height ?? undefined, "--mp-floor": `${floor}px`, "--mp-slack": `${slack}px`,
        visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "bottom right" } as CSSProperties}
      data-held={height !== null || undefined} data-closing={closing || undefined} data-eggs={eggs || undefined} inert={closing}>
      <div className="mp-search">
        <Icon name="search" size={14} />
        {/* Autofocused because the picker opens for typing — the command palette's bargain. */}
        <input ref={search} autoFocus type="text" value={query} placeholder="Search models" aria-label="Search models"
          role="combobox" aria-expanded aria-controls="mp-list" aria-activedescendant={activeRow ? `mp-${activeRow.id}` : undefined}
          onChange={(e) => { setQuery(e.target.value); setActiveKey(null); setTuning(false); setHeight(null); }} onKeyDown={onKeyDown} />
      </div>
      <div ref={wrap} className="mp-list-wrap">
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
                    // A press keeps the keyboard in the search field, star and routes included: the
                    // picker outlives the click, and the keys it answers next are the field's.
                    onMouseDown={(e) => e.preventDefault()}
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
          {/* Nothing on this surface closes it: the model, the level, fast mode and a folded chip's
              choice are settings on the card you are looking at, and each answers in place. */}
          {runs && <RunCard effort={effort} fast={fast} model={name} />}
          {(overflow ?? []).map((g) => <Segments key={g.label} label={g.label} items={g.items} />)}
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

function Segments({ label, items }: { label: string; items: OverflowGroup["items"] }) {
  return (
    <div className="mp-seg-group" role="group" aria-label={label}>
      <span className="mp-seg-label">{label}</span>
      <div className="mp-seg">
        {items.map((it, i) => (
          <button key={i} type="button" className="mp-seg-opt" aria-pressed={!!it.checked} onClick={it.onSelect}>{it.label}</button>
        ))}
      </div>
    </div>
  );
}

/** Put the level at the `i`th of the model's own, held to the ends of the list. A pointer event
 *  without a position (a synthetic one) names no dot, and changes nothing. */
function setLevel(effort: EffortControl, i: number) {
  if (!Number.isFinite(i)) return;
  const level = effort.levels[Math.max(0, Math.min(effort.levels.length - 1, i))]!;
  if (level.id !== effort.value) effort.onChange(level.id);
}

/** One level up or down from the one in force; from a level nobody chose and the harness never named,
 *  the lightest is the first step. */
function stepLevel(effort: EffortControl, by: number) {
  const { index } = effortCurrent(effort);
  setLevel(effort, index < 0 ? 0 : index + by);
}

/**
 * How the answer is produced — Codex's card, laid into the picker's foot. The bolt is fast mode, the
 * name in the middle is the level in force with the model it is for, the arrow puts the level back to
 * the model's own default, and the track under them has a dot for every level the model takes.
 *
 * Every part is drawn only where it means something: no bolt where Realm cannot ask the harness for
 * fast mode, no track where the harness takes no level, no reset when nothing has been changed.
 */
function RunCard({ effort, fast, model }: { effort?: EffortControl; fast?: FastMode; model: string }) {
  const levels = effort?.levels ?? [];
  const cur = effort && levels.length > 0 ? effortCurrent(effort) : null;
  const def = levels.find((l) => l.id === effort?.defaultId) ?? null;
  const hint = fast ? fastModeHint(fast, model) : null;
  /* Switching fast mode on is a moment: the bolt charges and a glint runs the length of the track,
     the chip catching the same light below. Off is quiet. Read from the request the session holds, so
     the card answers whatever switched it — the bolt, the keyboard, another window — and opening the
     picker on a session already asking for it plays nothing. */
  const bolt = useRef<HTMLButtonElement>(null);
  const [glint, setGlint] = useState(0);
  const wasOn = useRef(fast?.on ?? false);
  useEffect(() => {
    const on = fast?.on ?? false;
    const switchedOn = on && !wasOn.current;
    wasOn.current = on;
    if (!switchedOn || motionHeld()) return;
    setGlint((n) => n + 1);
    return replay(bolt.current, "data-charge", "", "rl-bolt-charge");
  }, [fast?.on]);
  // A refusal of a turn that DID ask is a warning; everything else on this line is information.
  const refused = !!fast && fast.on && fast.state !== null && fast.state !== "on" && !fastModeUntried(fast);
  const unavailable = fast?.availability.state === "unavailable";
  return (
    <div className="mp-run">
      <div className="mp-run-head">
        {fast ? (
          <button ref={bolt} type="button" className="mp-bolt" aria-label="Fast mode" aria-pressed={fast.on && !unavailable}
            aria-disabled={unavailable || undefined} title={fastModeTitle(fast, model)}
            onClick={() => { if (!unavailable) fast.onChange(!fast.on); }}>
            <Icon name="zap" size={14} />
          </button>
        ) : <span className="mp-run-gap" aria-hidden="true" />}
        <span className="mp-run-title">
          <span className="mp-run-level" data-unset={cur && !cur.choice ? "" : undefined}>
            {cur ? cur.choice?.label ?? "Default" : "Fast mode"}
          </span>
          {cur && <span className="mp-run-model">{model}</span>}
        </span>
        {effort && cur?.chosen && effort.value !== effort.defaultId ? (
          <button type="button" className="mp-run-reset" aria-label="Reset effort"
            title={def ? `Back to ${model}’s default, ${def.label}` : "Back to the model’s own default"}
            onClick={() => effort.onChange(null)}>
            <Icon name="undo" size={14} />
          </button>
        ) : <span className="mp-run-gap" aria-hidden="true" />}
      </div>
      {effort && levels.length > 1 && <EffortTrack effort={effort} glint={glint} />}
      {/* Held open whenever there is a bolt, empty or not: the popover grows upward from its chip, so a
          line arriving under the track lifted the bolt out from under the pointer that had just
          switched it on, and the press meant to switch it off again landed on the track instead. */}
      {fast && (
        <p className="mp-fast-note" data-tone={hint && (refused || unavailable) ? "warning" : undefined} title={hint ?? undefined}>{hint}</p>
      )}
    </div>
  );
}

/**
 * The level as a track: a dot for every level the model takes, the knob on the one in force and the
 * fill up to it. A slider for the keyboard — ←/→ (and ↑/↓) step a level, Home and End go to the ends —
 * and for the pointer a press or a drag lands on the nearest dot. A level the session never chose and
 * the harness never named has no knob at all: there is nothing to point at.
 *
 * At a heavy level the session chose, the fill carries Realm's light, as the landing page draws it:
 * streams running up the fill into a core at the knob, faint facets of the mark's cube drifting under
 * them, and a light circling the knob — stronger at Max than at XHigh (styles.css). `glint` counts
 * fast mode being switched on, and each count runs one pass of light along the whole track.
 */
function EffortTrack({ effort, glint = 0 }: { effort: EffortControl; glint?: number }) {
  const { levels } = effort;
  const cur = effortCurrent(effort);
  const heavy = cur.chosen && !!cur.choice && HEAVY_EFFORTS.has(cur.choice.id);
  const ref = useRef<HTMLDivElement>(null);
  const span = levels.length - 1;
  const set = (i: number) => setLevel(effort, i);
  // The dot nearest the pointer, along the run between the first and the last.
  const nearest = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const inset = r.height / 2;
    return Math.round(((clientX - r.left - inset) / Math.max(1, r.width - inset * 2)) * span);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (step !== 0) { e.preventDefault(); stepLevel(effort, step); }
    else if (e.key === "Home") { e.preventDefault(); set(0); }
    else if (e.key === "End") { e.preventDefault(); set(span); }
  };
  return (
    <div ref={ref} className="mp-track" role="slider" tabIndex={0} aria-label="Effort"
      aria-valuemin={0} aria-valuemax={span} aria-valuenow={Math.max(0, cur.index)} aria-valuetext={cur.choice?.label ?? "Default"}
      data-effort={cur.chosen ? cur.choice?.id : undefined}
      style={{ "--at": cur.index < 0 ? 0 : cur.index / span } as CSSProperties}
      onKeyDown={onKeyDown}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture?.(e.pointerId); set(nearest(e.clientX)); }}
      onPointerMove={(e) => { if (e.currentTarget.hasPointerCapture?.(e.pointerId)) set(nearest(e.clientX)); }}>
      {cur.index >= 0 && (
        <span className="mp-track-fill">
          {heavy && <>
            <span className="mp-track-facets" aria-hidden="true" />
            <span className="mp-track-flow" aria-hidden="true" />
            <span className="mp-track-core" aria-hidden="true" />
          </>}
        </span>
      )}
      {levels.map((l, i) => (
        <span key={l.id} className="mp-track-dot" data-passed={i <= cur.index || undefined}
          style={{ "--at": i / span } as CSSProperties} />
      ))}
      {/* Keyed by the count, so each switch-on mounts a fresh pass rather than replaying a finished one. */}
      {glint > 0 && <span key={glint} className="mp-track-glint" aria-hidden="true" />}
      {cur.index >= 0 && <span className="mp-track-knob">{heavy && <span className="mp-track-shine" aria-hidden="true" />}</span>}
    </div>
  );
}
