import { Icon } from "@realm/ui";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPopover } from "./use-anchored-popover";
import { acceleratorFor, menuLabelText, rasteriseIcon } from "./native-menu";

export type MenuItem =
  | { kind?: "item"; label: ReactNode; onSelect: () => void; disabled?: boolean; title?: string; checked?: boolean; danger?: boolean;
      /** A glyph before the label. Drawn in a fixed slot that EVERY item in the menu reserves as soon
       *  as one item asks for it, so labels stay on one left edge — a menu where three rows start at
       *  x and one starts at x+20 reads as a mistake rather than as emphasis. */
      icon?: ReactNode;
      /** Right-aligned shortcut hint, e.g. "⌘W". Purely visual — the binding lives in hotkeys.ts. */
      kbd?: string;
      /** Selecting keeps the menu open (two-step confirms rebuild their items in place). */
      keepOpen?: boolean }
  | { kind: "separator" };

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
};

/** In the app, an OS menu; where there is no bridge to one (jsdom, a browser, a live script that set
 *  REALM_HTML_MENUS), the menu draws itself. Decided once per menu, by what the window offers. */
export function Menu(props: MenuProps) {
  return window.realm?.popupMenu && !window.realm.htmlMenus ? <NativeMenu {...props} /> : <HtmlMenu {...props} />;
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
          ...(it.title ? { toolTip: it.title } : {}),
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
      if (it && it.kind !== "separator") {
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
      {items.map((it, i) => it.kind === "separator"
        ? <div key={i} />
        : <div key={i}><span data-icon="">{it.icon}</span><span data-label="">{it.label}</span></div>)}
    </div>,
    document.body,
  );
}

function HtmlMenu({ items, onClose, at, anchorRef, returnFocusRef, align = "left", placement = "down", label }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { pos, closing, close } = useAnchoredPopover({ ref, anchorRef, at, align, placement, onClose, returnFocusRef, exit: true });

  // Focus-in on open. The hook already captured the restore target at mount, so the roving focus
  // this moves into the menu never becomes the thing focus returns to.
  useLayoutEffect(() => {
    focusItem(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount only
  }, []);

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
  const anyIcon = items.some((it) => it.kind !== "separator" && it.icon !== undefined);
  return createPortal(
    <div ref={ref} role="menu" aria-label={label} className="menu" style={style} onKeyDown={onKeyDown}
      data-closing={closing || undefined} inert={closing}>
      {items.map((it, i) => it.kind === "separator"
        ? <div key={i} className="menu-sep" role="separator" />
        : (
          <button key={i} role={it.checked !== undefined ? "menuitemcheckbox" : "menuitem"}
            disabled={it.disabled} title={it.title} aria-checked={it.checked !== undefined ? it.checked : undefined}
            className={(it.checked ? "checked" : "") + (it.danger ? " danger" : "")}
            onClick={() => { it.onSelect(); if (!it.keepOpen) close(); }}>
            {anyIcon && <span className="menu-icon" aria-hidden="true">{it.icon}</span>}
            <span className="menu-label">{it.label}</span>
            {it.kbd && <kbd className="menu-kbd">{it.kbd}</kbd>}
            {it.checked && <Icon name="check" size={14} className="menu-check" />}
          </button>
        ))}
    </div>,
    document.body,
  );
}
