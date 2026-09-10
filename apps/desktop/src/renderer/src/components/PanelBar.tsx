import { Icon } from "@realm/ui";
import { useRef, useState } from "react";
import { PAGE_REF_IDS, type Item } from "@realm/contracts";
import { paneActions, paneMeta } from "../panes/registry";
import { useApp } from "../state/store";
import { Menu } from "./Menu";
import { RenameInput } from "./RenameInput";

/**
 * Pages, not objects: the sidebar's destination pages plus a space's own Overview. Their `refId` is
 * a well-known sentinel rather than a row (PAGE_REF_IDS), so there is nothing behind the item to
 * lose — deleting one and re-opening it from the sidebar produces the identical page.
 */
const PAGE_KINDS: ReadonlySet<Item["kind"]> = new Set<Item["kind"]>([
  ...(Object.keys(PAGE_REF_IDS) as Item["kind"][]), "space-page",
]);

/**
 * The kinds whose bar closes by DELETING rather than lifting the item out of the layout.
 *
 * A layout-only close leaves the row behind in the space, which is right for a session or a diff —
 * a transcript and a checkout outlive any pane that showed them, and the rule that closing must
 * never imply deletion is about exactly those. It is wrong for everything here: a destination page
 * is a view with no object under it, and a terminal, browser or documents pane is a thing you
 * opened at a moment and are done with. Closing those left a drift of rows nobody asked to keep,
 * so the bar offers the delete outright — named, wearing a trash, and (where there IS something
 * under it) two-step. The layout-only close stays reachable, on ⌘W and in the ⋯ menu.
 */
const DELETES_ON_CLOSE: ReadonlySet<Item["kind"]> = new Set<Item["kind"]>([
  ...PAGE_KINDS, "terminal", "browser", "documents",
]);

/** Slim per-panel header: item icon + click-to-rename title, per-kind meta (right), ⋯ menu + close.
 *  Split/close/focus stay leaf-scoped callbacks (the host owns focus semantics); rename/delete are
 *  item-scoped and go straight to the store, like the sidebar's context menu. */
export function PanelBar({ item, leafId, onSplit, onClose, zoomed = false, onZoom, onUnzoom }: {
  item: Item;
  /** The leaf this bar heads — the key its back/forward trail is kept under. */
  leafId: string;
  onSplit: (dir: "row" | "col") => void; onClose: () => void;
  /** This pane is the one filling the host — the state its bar's focus toggle reads as ON. */
  zoomed?: boolean;
  onZoom?: () => void; onUnzoom?: () => void;
}) {
  const deleteItem = useApp((s) => s.deleteItem);
  const run = useApp((s) => s.run);
  // Subscribed to the trail itself, not to canPaneNav(): the selector has to re-read on every history
  // write or the arrows would stay greyed out until some other state change happened to re-render.
  const history = useApp((s) => s.paneHistory[leafId]);
  const stepPaneNav = useApp((s) => s.stepPaneNav);
  const canBack = !!history && history.index > 0;
  const canForward = !!history && history.index < history.entries.length - 1;
  // The palette's "Rename focused item" arms renamingItemId; items are unique in the layout, so at
  // most one PanelBar answers. Local state covers the click-to-rename path.
  const renameArmed = useApp((s) => s.renamingItemId === item.id);
  const requestRename = useApp((s) => s.requestRename);
  const [renaming, setRenaming] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Two-step destructive confirm (U-H2), same pattern as the sidebar's item menu.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const Meta = paneMeta[item.kind];
  const Actions = paneActions[item.kind];
  const isBrowser = item.kind === "browser";
  const closeMenu = () => { setMenuOpen(false); setConfirmingDelete(false); };
  const deletesOnClose = DELETES_ON_CLOSE.has(item.kind);
  /* The confirm is owed by the OBJECT, not by the button. A pty, a live web view and a document
     workspace are each something a stray click would cost you, so those arm first; a page has
     nothing under it, and a step that guards nothing is the dead chrome this bar bans. */
  const confirmFirst = !PAGE_KINDS.has(item.kind);
  const deleteNow = () => run(() => deleteItem(item.id));
  /**
   * Focus (fill the host) and Unfocus (back to the split) as ONE toggle, filled while it is on.
   *
   * It replaces a banner across the top of the pane host that read "Focused: <title> | Unfocus". The
   * banner existed because a focused pane hides its siblings, so something had to carry the state the
   * screen no longer showed — but a whole strip to say what a lit button says is a row of chrome
   * charged for one bit. The bit lives on the control that changes it now.
   *
   * `data-on` and one glyph, which is the treatment `SessionSummaryButton` already wears: the icon
   * cannot fill (only the stroke pack ships), so the BUTTON does. Swapping the glyph as well would
   * say the same thing twice, in two directions — maximize/minimize argues with the fill about which
   * way the control is pointing.
   *
   * The NAME flips rather than carrying `aria-pressed`. A toggle takes one or the other, never both:
   * "Unfocus Two, pressed" is a sentence at war with itself. The flipped name is also how a screen
   * reader learns the pane IS focused, which is the banner's job inherited rather than dropped.
   */
  const focusToggle = (zoomed ? onUnzoom : onZoom) ? (
    <button className="icon-btn" data-on={zoomed || undefined}
      aria-label={zoomed ? `Unfocus ${item.title}` : `Focus ${item.title}`}
      title={zoomed ? "Unfocus (⌘⇧F)" : "Focus — fill the space (⌘⇧F)"}
      onClick={zoomed ? onUnzoom : onZoom}><Icon name="focusPane" size={14} /></button>
  ) : null;
  return (
    <div className="panel-bar">
      {/* The pane's own trail, at the LEFT edge where every back button in every app lives. Rendered
          disabled rather than hidden at the ends of the trail: arrows that come and go would shift
          the title under the pointer mid-click, and a greyed arrow is how a user learns the pane
          remembers at all. */}
      <span className="panel-nav">
        <button className="icon-btn" aria-label={`Back in ${item.title}`} title="Back (⌘[)"
          disabled={!canBack} onClick={() => run(() => stepPaneNav(leafId, -1))}><Icon name="chevronLeft" size={14} /></button>
        <button className="icon-btn" aria-label={`Forward in ${item.title}`} title="Forward (⌘])"
          disabled={!canForward} onClick={() => run(() => stepPaneNav(leafId, 1))}><Icon name="chevronRight" size={14} /></button>
      </span>
      <span className="panel-icon"><Icon name={item.kind} size={14} /></span>
      {(renaming || renameArmed)
        ? <span className="panel-rename"><RenameInput item={item} onDone={() => { setRenaming(false); if (renameArmed) requestRename(null); }} /></span>
        : (
          <button className="panel-title" title="Click to rename" aria-label={`Rename ${item.title}`}
            onClick={() => setRenaming(true)}>{item.title}</button>
        )}
      <span className="panel-meta">{Meta ? <Meta item={item} /> : null}</span>
      <span className="panel-actions">
        {Actions ? <Actions item={item} /> : null}
        {isBrowser ? (
          // W2.3 (no-overlay): a browser pane's header may never spawn a dropdown — the native view
          // paints over anything that opens below the bar. Everything the ⋯ menu carried is inline:
          // rename is the title itself (click to rename), split is a pair of toolbar buttons, and
          // delete is the bar's own trailing control, two-step (U-H2) there like everywhere else.
          <>
            {focusToggle}
            <button className="icon-btn" aria-label={`Split ${item.title} right`} title="Split right (⌘\)"
              onClick={() => onSplit("row")}><Icon name="splitRight" size={14} /></button>
            <button className="icon-btn" aria-label={`Split ${item.title} down`} title="Split down (⌘⇧\)"
              onClick={() => onSplit("col")}><Icon name="splitDown" size={14} /></button>
          </>
        ) : (
          <>
          {focusToggle}
          <button ref={menuBtn} className="icon-btn" aria-label={`Pane menu for ${item.title}`} aria-haspopup="menu"
            aria-expanded={menuOpen} title="Pane menu" onClick={() => { setConfirmingDelete(false); setMenuOpen((v) => !v); }}>
            <Icon name="more" size={14} />
          </button>
          </>
        )}
        {/* The bar's last control: the × that lifts a pane out of the layout, or — for a page,
            terminal, browser or documents pane — the trash that ends the thing itself. */}
        {!deletesOnClose ? (
          <button className="icon-btn" aria-label={`Close ${item.title}`} title="Close (⌘W)" onClick={onClose}><Icon name="close" size={14} /></button>
        ) : confirmingDelete ? (
          <button className="icon-btn danger panel-confirm" aria-label={`Really delete ${item.title}?`}
            title="Click again to delete" onBlur={() => setConfirmingDelete(false)}
            onClick={deleteNow}>Really delete?</button>
        ) : (
          <button className="icon-btn danger" aria-label={`Delete ${item.title}`}
            title="Delete — removes it from the space, not just this pane"
            onClick={() => (confirmFirst ? setConfirmingDelete(true) : deleteNow())}><Icon name="trash" size={14} /></button>
        )}
      </span>
      {!isBrowser && menuOpen && (
        <Menu anchorRef={menuBtn} align="right" label={`Actions for ${item.title}`} onClose={closeMenu} items={[
          { label: "Rename", onSelect: () => setRenaming(true) },
          { kind: "separator" },
          { label: "Split right", kbd: "⌘\\", onSelect: () => onSplit("row") },
          { label: "Split down", kbd: "⌘⇧\\", onSelect: () => onSplit("col") },
          ...(zoomed
            ? (onUnzoom ? [{ label: "Unfocus pane", kbd: "⌘⇧F", onSelect: onUnzoom }] : [])
            : (onZoom ? [{ label: "Focus pane", kbd: "⌘⇧F", onSelect: onZoom }] : [])),
          // Where the bar's own control deletes, this is the only route left to the layout-only
          // close — so it says which of the two it is, instead of leaving "Close" to mean either.
          { label: deletesOnClose ? "Close pane (keep in space)" : "Close", kbd: "⌘W", onSelect: onClose },
          // Delete lives in the bar for those kinds; repeating it here would be two controls for
          // one action, and only one of them would ever wear the armed state.
          ...(deletesOnClose ? [] : [
            { kind: "separator" as const },
            confirmingDelete
              ? { label: <strong>Really delete?</strong>, danger: true, onSelect: () => run(() => deleteItem(item.id)) }
              : { label: "Delete", danger: true, keepOpen: true, onSelect: () => setConfirmingDelete(true) },
          ]),
        ]} />
      )}
    </div>
  );
}
