import { Icon } from "@realm/ui";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useDissolve } from "./ScrollFades";
import { useAnchoredPopover } from "./use-anchored-popover";
import { acceleratorFor, menuLabelText, rasteriseIcon } from "./native-menu";

export type MenuItem =
  | { kind?: "item"; label: ReactNode; onSelect: () => void; disabled?: boolean; title?: string; checked?: boolean; danger?: boolean;
      /** A glyph before the label. Drawn in a fixed slot that EVERY item in the menu reserves as soon
       *  as one item asks for it, so labels stay on one left edge — a menu where three rows start at
       *  x and one starts at x+20 reads as a mistake rather than as emphasis. */
      icon?: ReactNode;
      /** Right-aligned shortcut hint, e.g. "⌘W". Purely visual — the binding lives in the keymap (keys/). */
      kbd?: string;
      /** A quiet line after the label saying what the row does — "Attach files to this message". The
       *  in-app menu draws it as the row's description; an OS menu row has no second voice, so there it
       *  rides the row's tooltip instead. */
      detail?: string;
      /** Selecting keeps the menu open (two-step confirms rebuild their items in place). */
      keepOpen?: boolean;
      /** A row no agent may press, named as `app_act`'s refusal names it (`data-no-agent`): one that
       *  starts something only the person may start. Drawn in the app only — an OS menu row is out of
       *  an agent's reach already. */
      noAgent?: string }
  | { kind: "separator" }
  /** A section's name, over the rows that follow it up to the next one — "Add", "Mode". */
  | { kind: "header"; label: string };

type MenuRow = Extract<MenuItem, { onSelect: () => void }>;
const isRow = (it: MenuItem | undefined): it is MenuRow => it !== undefined && it.kind !== "separator" && it.kind !== "header";

/** Small popup menu, rendered in a portal with fixed positioning so no ancestor overflow can clip
 *  it. Anchor it to a control via `anchorRef` (opens below, flips above near the bottom edge — or
 *  `placement="up"` to open above, flipping below near the top edge; the prompter's chip menus) or
 *  place it at a point via `at` (context menus). Closes on outside pointerdown, Escape, or select.
 *
 *  Keyboard-first (U-M10/A-H3): the first enabled item is focused on open; ArrowUp/Down cycle with
 *  wrap, Home/End jump, Enter/Space select. Focus returns to where it was on close — the element
 *  focused at mount (normally the trigger), or `returnFocusRef` when the caller knows better.
 *  Items with a `checked` boolean render as menuitemcheckbox with aria-checked and a check icon. */
type MenuProps = {
  items: MenuItem[]; onClose: () => void;
  at?: { x: number; y: number }; anchorRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  align?: "left" | "right"; placement?: "down" | "up"; label?: string;
  /**
   * Draw this menu in the app even where an OS menu is on offer.
   *
   * For a menu whose rows explain themselves — a section head, and a line after each label saying
   * what it does — which is the one thing an OS menu cannot carry: its rows have no second voice. The
   * prompter's "+" is that menu. What the OS menu would have given is kept: the arrows, Home/End,
   * Return, Escape and focus going home, and placement clear of a browser pane's native view (the
   * popover hook's), since a page composites over anything the window draws.
   */
  inApp?: boolean;
  /** A class for the drawn surface, for the one menu that needs a width of its own. */
  className?: string;
};

/** In the app, an OS menu; where there is no bridge to one (jsdom, a browser, a live script that set
 *  REALM_HTML_MENUS), the menu draws itself. Decided once per menu, by what the window offers — or by
 *  the caller, with `inApp`. */
export function Menu(props: MenuProps) {
  return window.realm?.popupMenu && !window.realm.htmlMenus && !props.inApp ? <NativeMenu {...props} /> : <HtmlMenu {...props} />;
}

/**
 * The menu as an OS menu (main/native-menu.ts). Everything a Mac menu is comes with it — the system's
 * material, type-to-select, opening over a browser pane's native view — and nothing about the rows
 * changes for the callers: the same items, the same `onSelect`, the same `keepOpen`.
 *
 * The rows are rendered, hidden, inside the app's own tree and READ from there, rather than flattened
 * from the item objects. A label is a React node that may need the app's context to render, and the
 * icons are components; the DOM they produce is the one thing both kinds have in common.
 *
 * `keepOpen` is a two-step confirm or a view change that rebuilds the items in place. An OS menu
 * cannot change under the pointer, so the pick closes it, the caller rebuilds, and it opens again at
 * the same anchor — `round` is what says "again".
 */
function NativeMenu({ items, onClose, at, anchorRef, returnFocusRef }: MenuProps) {
  const rowsRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    let showing = false;
    // Deferred a task so StrictMode's mount-unmount-mount cancels the first open before it reaches
    // main: two OS menus for one click is not something a cleanup can take back.
    const timer = setTimeout(async () => {
      const current = itemsRef.current;
      const rows = Array.from(rowsRef.current?.children ?? []);
      const spec = await Promise.all(current.map(async (it, i): Promise<NativeMenuItem> => {
        if (it.kind === "separator") return { separator: true };
        // A section head is a line of information: drawn, never chosen (main/native-menu.ts).
        if (it.kind === "header") return { label: it.label, enabled: false };
        const row = rows[i];
        const svg = row?.querySelector<SVGSVGElement>("[data-icon] svg");
        const icon = svg ? await rasteriseIcon(svg).catch(() => undefined) : undefined;
        const accelerator = it.kbd ? acceleratorFor(it.kbd) : undefined;
        // Its index as its id: the OS answers with the id of the row chosen (main/native-menu.ts).
        return {
          id: String(i),
          label: row?.querySelector("[data-label]") ? menuLabelText(row.querySelector("[data-label]")!) : "",
          enabled: !it.disabled,
          ...(it.checked !== undefined ? { checked: it.checked } : {}),
          ...(it.title || it.detail ? { toolTip: it.title ?? it.detail } : {}),
          ...(accelerator ? { accelerator } : {}),
          ...(icon ? { icon } : {}),
        };
      }));
      if (!live) return;
      const anchor = anchorRef?.current?.getBoundingClientRect();
      const point = at ?? (anchor ? { x: anchor.left, y: anchor.bottom + 4 } : { x: 0, y: 0 });
      showing = true;
      const picked = await window.realm.popupMenu!(spec, point);
      showing = false;
      if (!live) return;
      const it = picked === null ? undefined : current[Number(picked)];
      if (isRow(it)) {
        it.onSelect();
        if (it.keepOpen) { setRound((r) => r + 1); return; }
      }
      returnFocusRef?.current?.focus();
      onCloseRef.current();
    }, 0);
    return () => {
      live = false;
      clearTimeout(timer);
      if (showing) void window.realm.closeMenu?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one OS menu per round; items are read live
  }, [round]);

  // Portalled like the drawn menu, so the hidden rows never land inside a button or a list that
  // could not hold them; a portal still carries the app's context to the labels.
  return createPortal(
    <div ref={rowsRef} hidden aria-hidden="true" data-native-menu="">
      {items.map((it, i) => !isRow(it)
        ? <div key={i} />
        : <div key={i}><span data-icon="">{it.icon}</span><span data-label="">{it.label}</span></div>)}
    </div>,
    document.body,
  );
}

function HtmlMenu({ items, onClose, at, anchorRef, returnFocusRef, align = "left", placement = "down", label, className }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();
  const { pos, closing, close } = useAnchoredPopover({ ref, anchorRef, at, align, placement, onClose, returnFocusRef, exit: true });
  /* The rows scroll inside the surface, and run out into its edges rather than being cut by them.
     A menu taller than the window above the prompter is the "+" menu with a space's connectors in it. */
  useDissolve(list);

  // Focus-in on open — once the menu has been PLACED. Until then it is `visibility: hidden`, and a
  // hidden element takes no focus: a focus at mount silently stayed on the trigger, so the arrows
  // went nowhere (jsdom, which focuses anything, never noticed). The hook already captured the
  // restore target at mount, so the roving focus this moves in never becomes what focus returns to.
  const focusedIn = useRef(false);
  useLayoutEffect(() => {
    if (!pos || focusedIn.current) return;
    focusedIn.current = true;
    focusItem(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the first placement
  }, [pos]);

  const buttons = () =>
    Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);

  /** Focus the enabled item at index `i`, wrapping both ways (disabled items never match the selector). */
  const focusItem = (i: number) => {
    const bs = buttons(); if (bs.length === 0) return;
    bs[((i % bs.length) + bs.length) % bs.length]?.focus();
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const bs = buttons(); if (bs.length === 0) return;
    const cur = bs.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(cur + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(cur - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem(bs.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bs[cur]?.click(); }
  };

  const style: CSSProperties = { position: "fixed", left: pos?.left ?? -9999, top: pos?.top ?? -9999,
    visibility: pos ? "visible" : "hidden", transformOrigin: pos?.origin ?? "top left" };
  // `inert` is the whole safety story for the exit: for the beat the menu spends fading it is out of
  // the tab order, out of the accessibility tree, and un-hit-testable, so the app behind it behaves
  // as though the menu had already gone. The stylesheet takes its pointer events away as well, for
  // the browsers that paint the fade before they honour the attribute.
  /** Whether ANY item carries a glyph. One reserved slot for the whole menu, or none — see `icon`. */
  const anyIcon = items.some((it) => isRow(it) && it.icon !== undefined);
  const row = (it: MenuItem, i: number) => !isRow(it)
    ? <div key={i} className="menu-sep" role="separator" />
    : (
      /* The pointer moves the one highlight the keyboard moves, as an OS menu's does: two lit rows —
         one under the pointer, one where the arrows left off — would be two answers to "which one". */
      <button key={i} role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
        disabled={it.disabled} title={it.title} aria-checked={it.checked !== undefined ? it.checked : undefined}
        aria-describedby={it.detail ? `${id}-d${i}` : undefined}
        className={(it.checked ? "checked" : "") + (it.danger ? " danger" : "")} data-no-agent={it.noAgent}
        onPointerMove={(e) => { if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true }); }}
        onClick={() => { it.onSelect(); if (!it.keepOpen) close(); }}>
        {anyIcon && <span className="menu-icon" aria-hidden="true">{it.icon}</span>}
        <span className="menu-label">{it.label}</span>
        {/* The description, not part of the name: a row is still found by what it is called. */}
        {it.detail && <span id={`${id}-d${i}`} className="menu-detail" aria-hidden="true">{it.detail}</span>}
        {it.kbd && <kbd className="menu-kbd">{it.kbd}</kbd>}
        {it.checked && <Icon name="check" size={14} className="menu-check" />}
      </button>
    );
  /* A head opens a section, and its rows are a group named for it. Rows before the first head (every
     menu that has none) are drawn as they always were. */
  const sections: { head: string | null; rows: [MenuItem, number][] }[] = [{ head: null, rows: [] }];
  items.forEach((it, i) => {
    if (it.kind === "header") sections.push({ head: it.label, rows: [] });
    else sections[sections.length - 1]!.rows.push([it, i]);
  });
  return createPortal(
    <div ref={ref} role="menu" aria-label={label} className={`menu${className ? ` ${className}` : ""}`} style={style} onKeyDown={onKeyDown}
      data-closing={closing || undefined} inert={closing}>
      <div ref={list} className="menu-list" role="presentation">
        {sections.map((sec, si) => sec.head === null
          ? sec.rows.map(([it, i]) => row(it, i))
          : (
            <div key={`s${si}`} role="group" aria-label={sec.head} className="menu-section">
              <div className="menu-head" aria-hidden="true">{sec.head}</div>
              {sec.rows.map(([it, i]) => row(it, i))}
            </div>
          ))}
      </div>
    </div>,
    document.body,
  );
}
