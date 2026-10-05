import { Icon } from "@realm/ui";
import { DEFAULT_KEYBINDINGS, chordsForCommand, displayKeyChord, findLeafOfItem } from "@realm/contracts";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { useAppStoreMaybe, type AppState, type NewTabTool } from "../../state/store";
import { PageIcon } from "../../components/PageIcon";
import { useDissolve } from "../../components/ScrollFades";
import { SIDE_TOOLS } from "../../components/side-tools";

/** A page this space's profile went to — a row of the history (`browsers.recent`), as this page draws it:
 *  with the icon it last showed, when it showed one. */
export type RecentVisit = { url: string; title: string; favicon?: string };

/* Documents is where a file is found as well as made, so it is the one row for both and wears ⌘P —
   a "Files" row beside it opened the same search somewhere else. */
const CHORD: Partial<Record<NewTabTool, string>> = { documents: "palette.files" };

/** Whether this blank tab is in a session's side pane — the only place its sub-agents can open. */
const servesSession = (s: AppState, itemId: string): boolean => {
  const owner = s.layout ? findLeafOfItem(s.layout, itemId)?.owner : undefined;
  return !!owner && s.items.some((i) => i.id === owner && i.kind === "session");
};

/**
 * What a blank browser tab shows instead of an empty page: the session's tools, under the address
 * field the browser's chrome already has — focused, as a fresh tab's is. Not a second field over the
 * page: two controls for one action is one too many, and the one in the chrome is where the URL
 * stays once the page loads.
 *
 * A tool opens where the tab stood, and the blank tab goes (`openFromNewTab`): "+ › New tab ›
 * Terminal" is a terminal in the side pane, not a terminal and an empty browser.
 *
 * The pages this space's profile went to last go under the tools, newest first, and choosing one
 * takes this tab there. With none the section is not drawn — an empty "Recently visited" is a heading
 * over nothing.
 */
export function NewTabPage({ itemId, recent = [], onVisit }: {
  itemId: string;
  recent?: readonly RecentVisit[];
  onVisit?: (url: string) => void;
}) {
  // Nullable, like the pane around it: its unit tests render it with no store, and there is nothing a
  // tool could open into there.
  const store = useAppStoreMaybe();
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  const subscribe = useCallback((cb: () => void) => store?.subscribe(cb) ?? (() => {}), [store]);
  const keybindings = useSyncExternalStore(subscribe, () => store?.getState().keybindings ?? DEFAULT_KEYBINDINGS);
  const session = useSyncExternalStore(subscribe, () => (store ? servesSession(store.getState(), itemId) : false));
  const tools = SIDE_TOOLS.filter((t) => t.tool !== "agents" || session);
  /* From the keymap the handler reads, never a literal — the palette's own rule for its hints. */
  const kbd = (command: string | undefined) => {
    const chord = command ? chordsForCommand(keybindings, command)[0] : undefined;
    return chord ? displayKeyChord(chord) : null;
  };
  const open = (tool: NewTabTool) => {
    const s = store?.getState();
    s?.run(() => s.openFromNewTab(itemId, tool));
  };
  return (
    <div className="new-tab" ref={scroller} role="region" aria-label="New tab">
      <section className="new-tab-section" aria-label="Tools">
        <h2 className="new-tab-label">Tools</h2>
        <ul className="new-tab-list">
          {tools.map((t) => {
            const chord = kbd(CHORD[t.tool]);
            return (
              <li key={t.tool}>
                <button type="button" className="new-tab-row" title={t.hint} disabled={!store} onClick={() => open(t.tool)}>
                  <Icon name={t.icon} size={16} />
                  <span className="new-tab-row-label">{t.label}</span>
                  {chord && <kbd className="menu-kbd">{chord}</kbd>}
                </button>
              </li>
            );
          })}
        </ul>
      </section>
      {recent.length > 0 && (
        <section className="new-tab-section" aria-label="Recently visited">
          <h2 className="new-tab-label">Recently visited</h2>
          <ul className="new-tab-list">
            {recent.map((v) => (
              <li key={v.url}>
                <button type="button" className="new-tab-row" title={v.url} onClick={() => onVisit?.(v.url)}>
                  <PageIcon src={v.favicon} fallback="browser" size={16} />
                  <span className="new-tab-row-label">{v.title || v.url}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
