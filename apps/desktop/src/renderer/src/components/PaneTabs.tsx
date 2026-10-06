import { Icon } from "@realm/ui";
import { Fragment, useContext, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { chordsForCommand, displayKeyChord, type Item, type KeyContext } from "@realm/contracts";
import { useApp, useAppStore } from "../state/store";
import { REALM_ITEM_TYPE } from "./drag-types";
import { Menu } from "./Menu";
import { SIDE_TOOLS, openSideTool, sideToolReady } from "./side-tools";
import { DELETES_ON_CLOSE, PAGE_KINDS } from "./pane-close";
import { ItemIcon } from "./PageIcon";
import { terminalTitle, useTerminalPrograms } from "./ProgramMark";
import { ScrollFadesX } from "./ScrollFades";
import { OwnerCueContext } from "./owner-cue";

/**
 * The side panel's tab strip, in its bar where a single pane's title goes.
 *
 * In the bar rather than a row above it: the pane under it brings chrome of its own (a browser's
 * address bar, a session's composer), and a strip stacked over a bar over a toolbar is three rows of
 * chrome before the page. The strip is the title — each tab names its item, the one showing is lit.
 *
 * Each tab is draggable like a sidebar row. Dropped on another tab it lands beside it, on the side of
 * the tab the pointer was on, and belongs to that tab's session from then on; dropped on a pane edge
 * it leaves the strip as a pane of its own (`openItemAt`), which is the one way something an agent
 * opened becomes part of the user's own arrangement.
 *
 * The strip holds the tabs of every session on screen, a run per session in the order its pane is
 * read (contracts/view.ts). While several share it, it says whose each tab is three quiet ways and no
 * loud one: a hairline between one session's run and the next, the session's name in each tab's
 * tooltip, and — while the pointer is on a tab — a mark on that session's pane (`OwnerCueContext`).
 * One session's strip wears none of it: there is nothing to tell apart.
 *
 * The close on a tab is the pane bar's own last control, with its own rule: a session or a diff
 * leaves the layout and stays in the space, while a browser, terminal or documents pane is deleted —
 * two-step where there is something under it, as the bar's is.
 *
 * The "+" after the last tab is where a person adds one, for the session the keyboard is working for
 * — the pane it is in, or the session whose tab it is in: a blank tab, or the same tab with the panel
 * filling the host ("full view", which is pane focus) — and, under them, every tool that session can
 * open beside it (`SIDE_TOOLS`), which is where the session's bar used to keep them. A menu rather than
 * a row of buttons, because the strip is the bar's data of unbounded length and every control beside
 * it would come out of its width. The menu is the shared one, so it goes round a browser view rather
 * than under it (no-overlay.ts).
 *
 * Choosing a tab shows it without taking the keyboard from the prompter that has it (the pane host
 * leaves the focus where it is for a press in the bar, and the tab hands the caret back); a click
 * into the tab's own content is what moves it.
 *
 * A browser's tab wears its page's own icon once the page has offered one, as a browser's tabs do, and
 * the kind's glyph until then. A terminal's tab wears what it is running — an agent's tile, a tool's
 * glyph — and says it before the title: "claude · realm".
 *
 * A peek's tab says what it is twice over, in the shape and the words: an eye where the kind's glyph
 * goes and its title in italic, because it is the one tab here that will not be here tomorrow — and
 * it does not drag, since an edge would make it part of an arrangement it was never written into.
 *
 * More tabs than the bar has room for scroll sideways, and the strip dissolves at whichever end has
 * more of it past the edge, as every scroller in the app does — it used to stop at a hard cut through
 * the middle of a title. The "+" and the bar's own buttons are outside the scroller, so they stay
 * crisp beside it.
 */
export function PaneTabs({ leafId, tabs, activeId, owners, onRename }: {
  leafId: string;
  tabs: Item[];
  activeId: string;
  /** Whose each tab is, while several sessions' tabs share the strip; absent while one does. */
  owners?: Record<string, string>;
  /** Double-click on the tab showing: rename it, as a click on a single pane's title does. */
  onRename: () => void;
}) {
  const openItem = useApp((s) => s.openItem);
  const closeFromLayout = useApp((s) => s.closeFromLayout);
  const deleteItem = useApp((s) => s.deleteItem);
  const moveTab = useApp((s) => s.moveTab);
  const confirmDelete = useApp((s) => s.confirmDelete);
  const newTab = useApp((s) => s.newTab);
  const keybindings = useApp((s) => s.keybindings);
  const store = useAppStore();
  /* The session a new tab is for, whose tools the "+" opens: the one the keyboard is working for, else
     the first on screen (`peekOwner`). With no session on screen there are no tools, only a new tab. */
  const served = useApp((s) => {
    const owner = s.peekOwner();
    const it = owner ? s.items.find((i) => i.id === owner) : undefined;
    return it?.kind === "session" ? it.refId : null;
  });
  const items = useApp((s) => s.items);
  const ownerTitle = (id: string) => items.find((i) => i.id === id)?.title ?? "";
  const cue = useContext(OwnerCueContext);
  /* Which of its tools can open now, as one string so the selector hands back something stable. */
  const ready = useApp((s) => (served ? SIDE_TOOLS.filter((t) => sideToolReady(s, served, t.tool)).map((t) => t.tool).join(" ") : ""));
  const peekId = useApp((s) => s.peek?.item.id ?? null);
  const run = useApp((s) => s.run);
  const programOf = useTerminalPrograms(tabs.some((t) => t.kind === "terminal"));
  const [arming, setArming] = useState<string | null>(null);
  /** The tab a drag is over, and which side of it the dragged tab would land on. */
  const [over, setOver] = useState<{ id: string; after: boolean } | null>(null);
  /** What had the keyboard when a tab was pressed — the prompter it goes back to once the tab shows. */
  const caret = useRef<HTMLElement | null>(null);
  const [adding, setAdding] = useState(false);
  const addBtn = useRef<HTMLButtonElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  /* The tab showing is brought clear of the dissolve when it CHANGES — chosen from the sidebar, or
     opened by an agent past the strip's end — so it is never the one selected under the fade or off
     the edge. Only then: a strip someone has scrolled by hand stays where they put it. */
  useLayoutEffect(() => {
    const el = strip.current;
    const tab = el?.querySelector<HTMLElement>(".pane-tab[data-active]");
    if (!el || !tab) return;
    const band = parseFloat(getComputedStyle(el).getPropertyValue("--fade-w")) || 0;
    const s = el.getBoundingClientRect(), t = tab.getBoundingClientRect();
    if (t.left < s.left + band) el.scrollLeft -= s.left + band - t.left;
    else if (t.right > s.right - band) el.scrollLeft += t.right - (s.right - band);
  }, [activeId]);
  const ids = tabs.map((t) => t.id);
  const carriesItem = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(REALM_ITEM_TYPE);
  /* From the keymap the handler reads, as the palette's hints are: a user who rebinds the chord sees
     their own, and an unbound command shows none rather than one Realm has no basis for. */
  const chord = (command: string, context?: KeyContext) => {
    const c = chordsForCommand(keybindings, command, context)[0];
    return c ? displayKeyChord(c) : undefined;
  };
  /* A tool's chord is printed only where the row and the key run the same thing: ⌘J is this session's
     terminal, ⌘P its documents, asked of a session in focus — the context the key's own rule names. */
  const toolChord = (tool: string) => (tool === "terminal" ? chord("terminal.toggle", { sessionFocus: true }) : tool === "documents" ? chord("palette.files") : undefined);
  return (
    <div className="pane-strip">
      <ScrollFadesX scroller={strip} />
      <div className="pane-tabs" role="tablist" aria-label="Tabs" ref={strip} onPointerLeave={() => cue(null)}>
        {tabs.map((t, i) => {
          const active = t.id === activeId;
          const peek = t.id === peekId;
          const title = t.kind === "terminal" ? terminalTitle(t.title, programOf(t.refId)) : t.title;
          const owner = owners?.[t.id];
          // The run's first tab after another session's: the hairline between them.
          const runStart = !!owners && i > 0 && owners[tabs[i - 1]!.id] !== owner;
          const whose = owner ? ownerTitle(owner) : "";
          const deletes = DELETES_ON_CLOSE.has(t.kind);
          const close = () => {
            if (!deletes) { run(() => closeFromLayout(t.id)); return; }
            if (confirmDelete && !PAGE_KINDS.has(t.kind) && arming !== t.id) { setArming(t.id); return; }
            setArming(null);
            run(() => deleteItem(t.id));
          };
          /* Where a drop on this tab lands: before it, or after it when the pointer is on its far half
             — the only way to reach the end of a run that another session's run follows. */
          const sideOf = (e: DragEvent<HTMLElement>) => {
            const r = e.currentTarget.getBoundingClientRect();
            return r.width > 0 && e.clientX > r.left + r.width / 2;
          };
          return (
            <Fragment key={t.id}>
            {runStart && <span className="pane-tab-run" aria-hidden="true" />}
            <div className="pane-tab" data-active={active || undefined} data-peek={peek || undefined}
              data-over={over?.id === t.id ? (over.after ? "after" : "before") : undefined}
              onPointerEnter={() => cue(owner ?? null)}
              onDragOver={(e) => { if (carriesItem(e)) { e.preventDefault(); e.stopPropagation(); setOver({ id: t.id, after: sideOf(e) }); } }}
              onDragLeave={() => setOver((o) => (o?.id === t.id ? null : o))}
              onDrop={(e) => {
                if (!carriesItem(e)) return;
                e.preventDefault();
                e.stopPropagation();
                setOver(null);
                const id = e.dataTransfer.getData(REALM_ITEM_TYPE);
                if (!id || id === t.id) return;
                // Its place among the OTHER tabs, beside this one; and it is this tab's session's now.
                const rest = ids.filter((x) => x !== id);
                const at = rest.indexOf(t.id) + (sideOf(e) ? 1 : 0);
                // A tab of this strip moves; anything else — a sidebar row, a pane of the split —
                // joins it, and lands where it was dropped.
                if (ids.includes(id)) run(() => moveTab(leafId, id, at, owner));
                else run(async () => { await openItem(id, leafId); await moveTab(leafId, id, at, owner); });
              }}>
              <button type="button" role="tab" className="pane-tab-label" aria-selected={active}
                aria-label={peek ? `Peek: ${t.title}` : undefined}
                title={peek ? `${t.title} — a peek, not kept in the view` : whose ? `${title} — ${whose}` : title}
                draggable={!peek} onDragStart={peek ? undefined : (e) => { e.dataTransfer.setData(REALM_ITEM_TYPE, t.id); e.dataTransfer.effectAllowed = "move"; }}
                onPointerDown={() => { caret.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
                onClick={() => {
                  // The caret goes back where it was: choosing a tab is looking at it, not typing in it.
                  const back = caret.current;
                  caret.current = null;
                  if (back && back !== document.body && back.matches("textarea, input, [contenteditable='true']")) back.focus({ preventScroll: true });
                  if (!active) run(() => openItem(t.id, leafId));
                }}
                onDoubleClick={active && !peek ? onRename : undefined}>
                {peek ? <Icon name="peek" size={14} /> : <ItemIcon item={t} size={14} />}
                <span className="pane-tab-title">{title}</span>
              </button>
              {arming === t.id ? (
                <button type="button" className="icon-btn danger pane-tab-confirm" aria-label={`Really delete ${t.title}?`}
                  title="Click again to delete" autoFocus onBlur={() => setArming(null)} onClick={close}>Delete?</button>
              ) : (
                <button type="button" className="icon-btn pane-tab-close" aria-label={deletes ? `Delete ${t.title}` : `Close ${t.title}`}
                  title={deletes ? "Delete — removes it from the space, not just this tab" : "Close tab (keep in space)"}
                  onClick={close}><Icon name="close" size={12} /></button>
              )}
            </div>
            </Fragment>
          );
        })}
      </div>
      <button ref={addBtn} type="button" className="icon-btn pane-tabs-add" aria-label="New tab"
        title={served ? "New tab — a page, or one of this session's tools" : "New tab"}
        aria-haspopup="menu" aria-expanded={adding} onClick={() => setAdding((v) => !v)}>
        <Icon name="add" size={14} />
      </button>
      {adding && (
        <Menu anchorRef={addBtn} label="New tab" onClose={() => setAdding(false)} items={[
          { label: "New tab", icon: <Icon name="add" size={14} />, kbd: chord("pane.newTab"), onSelect: () => run(() => newTab()) },
          /* The glyph pane focus wears in the bar and in every pane's menu, because this is that action. */
          { label: "New tab in full view", icon: <Icon name="focusPane" size={14} />, kbd: chord("pane.newTabFullView"),
            onSelect: () => run(() => newTab(null, { full: true })) },
          ...(served ? [
            { kind: "separator" as const },
            ...SIDE_TOOLS.filter((t) => ready.split(" ").includes(t.tool)).map((t) => ({
              label: t.label, icon: <Icon name={t.icon} size={14} />, kbd: toolChord(t.tool), title: t.hint,
              onSelect: () => run(() => openSideTool(store.getState(), served, t.tool)),
            })),
          ] : []),
        ]} />
      )}
    </div>
  );
}
