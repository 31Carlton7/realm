import { Icon, type IconName } from "@realm/ui";
import { DEFAULT_KEYBINDINGS, chordsForCommand, displayKeyChord } from "@realm/contracts";
import { useCallback, useSyncExternalStore } from "react";
import { useAppStoreMaybe, type NewTabTool } from "../../state/store";
import { PageIcon } from "../../components/PageIcon";

/** A page this space's profile went to — a row of the history (`browsers.recent`), as this page draws it:
 *  with the icon it last showed, when it showed one. */
export type RecentVisit = { url: string; title: string; favicon?: string };

const TOOLS: { tool: NewTabTool; label: string; icon: IconName; hint: string; command?: string }[] = [
  { tool: "files", label: "Files", icon: "folder", hint: "Find a file in this space's checkout", command: "palette.files" },
  { tool: "terminal", label: "Terminal", icon: "terminal", hint: "A shell in the session's checkout" },
  { tool: "documents", label: "Documents", icon: "documents", hint: "The session's documents" },
  { tool: "simulator", label: "Simulator", icon: "simulator", hint: "A device on this Mac" },
  { tool: "machine", label: "Machine", icon: "machine", hint: "Connect to another computer" },
];

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
  const keybindings = useSyncExternalStore(
    useCallback((cb: () => void) => store?.subscribe(cb) ?? (() => {}), [store]),
    () => store?.getState().keybindings ?? DEFAULT_KEYBINDINGS,
  );
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
    <div className="new-tab" role="region" aria-label="New tab">
      <section className="new-tab-section" aria-label="Tools">
        <h2 className="new-tab-label">Tools</h2>
        <ul className="new-tab-list">
          {TOOLS.map((t) => {
            const chord = kbd(t.command);
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
