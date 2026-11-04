import { Icon } from "@realm/ui";
import { TAB_TEXT_CAPS, formatAttachmentSize, tabCardFlag, type TabCard, type TabEntry } from "@realm/contracts";
import { PageIcon } from "../../components/PageIcon";
import { useCallback, useSyncExternalStore } from "react";
import { useAppStoreMaybe, type DraftTab } from "../../state/store";
import { tabDetail } from "./mention-sources";

/**
 * The panes a message hands over, as cards: in the prompter beside the draft, each with its size and
 * a ×, and on the sent message, where a click goes to the pane.
 *
 * The prompter's attachment card, in everything but what it holds — the same mark, name and second
 * line on the same object fill — because to the person sending it a tab is one more thing attached.
 */

const fmtChars = (n: number): string => n.toLocaleString("en-US");

type TabLine = { what: string; word: string | null; flag: "truncated" | "large" | "closed" | null; tip: string | null };

/** A card's second line — what the pane is and its size, then a word when it is cut, large or closed —
 *  and the sentence its tip says when there is one. Only a cut or a closed pane is a warning, and only
 *  its word wears the warning ink: a large card asks nothing of the person. */
function tabLine(t: Pick<TabEntry, "kind" | "url">, card: TabCard | null): TabLine {
  if (!card) return { what: "Reading…", word: null, flag: null, tip: null };
  if (card.closed) return { what: "", word: "Closed", flag: "closed", tip: "This pane is closed, so nothing of it will be sent." };
  const what = `${tabDetail(t)} · ${formatAttachmentSize(card.bytes)}`;
  const flag = tabCardFlag(card);
  if (flag === "truncated") {
    const kept = card.kind === "terminal" ? `the last ${fmtChars(TAB_TEXT_CAPS.terminal)} characters of its output` : `its first ${fmtChars(TAB_TEXT_CAPS[card.kind as "browser" | "documents"])} characters`;
    return { what, word: "Cut to fit", flag, tip: `Too long to send whole: the agent gets ${kept}.` };
  }
  if (flag === "large") return { what, word: "Large", flag, tip: "A large card takes a good share of the agent's context." };
  return { what, word: null, flag: null, tip: null };
}

/** The line as text, for a screen reader and the tip's sentence. */
const lineText = (l: TabLine): string => [l.what, l.word].filter(Boolean).join(" · ");

function LineView({ line }: { line: TabLine }) {
  return (
    <span className="attach-card-kind">
      {line.what}{line.what && line.word ? " · " : ""}{line.word && <span className="tab-card-word">{line.word}</span>}
    </span>
  );
}

function TabMark({ tab }: { tab: Pick<TabEntry, "kind" | "favicon"> }) {
  return <span className="attach-card-mark"><PageIcon src={tab.kind === "browser" ? tab.favicon : undefined} fallback={tab.kind} size={20} /></span>;
}

/** The draft's cards, under the attachments. */
export function DraftTabRow({ tabs, onRemove }: { tabs: readonly DraftTab[]; onRemove: (itemId: string) => void }) {
  if (tabs.length === 0) return null;
  return (
    <ul className="composer-attachments composer-tabs" aria-label="Tabs">
      {tabs.map((t) => {
        const line = tabLine(t, t.card);
        const { flag, tip } = line;
        const name = t.card?.title || t.title;
        return (
          <li key={t.itemId} className="composer-attach-item">
            <span className="attach-tile" data-layout="card" data-tab={t.kind} data-flag={flag ?? undefined}>
              <span className="attach-open">
                <TabMark tab={t} />
                <span className="attach-card-text" aria-hidden="true">
                  <span className="attach-card-name">{name}</span>
                  <LineView line={line} />
                </span>
                <span className="visually-hidden">{name} — {lineText(line)}{tip ? `. ${tip}` : ""}</span>
              </span>
              <span className="attach-tip" aria-hidden="true">
                <span className="attach-tip-name">{t.path ?? tabDetail(t)}</span>
                {tip && <span className="attach-tip-detail">{tip}</span>}
              </span>
              <button type="button" className="attach-remove" aria-label={`Remove ${name}`} onClick={() => onRemove(t.itemId)}>
                <Icon name="close" size={12} />
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const NO_ITEMS: readonly { id: string; favicon?: string }[] = [];

/** The sent message's cards, from the store: the page icons the log does not keep come from the
 *  panes as they are now, and a click goes to the pane (`openTabCard`). Bare, outside a store (a unit
 *  test of the transcript alone), the cards are drawn and a click does nothing. */
export function UserTabs({ tabs }: { tabs: readonly TabCard[] }) {
  const store = useAppStoreMaybe();
  const subscribe = useCallback((cb: () => void) => (store ? store.subscribe(cb) : () => {}), [store]);
  const items = useSyncExternalStore(subscribe, () => store?.getState().items ?? NO_ITEMS);
  const favicons = Object.fromEntries(items.flatMap((i) => (i.favicon ? [[i.id, i.favicon]] : [])));
  return <SentTabRow tabs={tabs} favicons={favicons} onOpen={(card) => { void store?.getState().openTabCard(card); }} />;
}

/** The sent message's cards, above its bubble. `favicons` are the space's panes' icons by item id,
 *  which the transcript does not keep. */
function SentTabRow({ tabs, favicons, onOpen }: { tabs: readonly TabCard[]; favicons: Readonly<Record<string, string>>; onOpen: (card: TabCard) => void }) {
  return (
    <ul className="msg-user-files msg-user-tabs" aria-label="Tabs">
      {tabs.map((t) => {
        const line: TabLine = t.closed ? { what: "Was closed", word: null, flag: null, tip: null } : tabLine(t, t);
        return (
          <li key={t.itemId}>
            <span className="attach-tile" data-layout="card" data-tab={t.kind} data-flag={line.flag ?? undefined}>
              <button type="button" className="attach-open" aria-label={`Open ${t.title}`} onClick={() => onOpen(t)}>
                <TabMark tab={{ kind: t.kind, favicon: favicons[t.itemId] ?? "" }} />
                <span className="attach-card-text" aria-hidden="true">
                  <span className="attach-card-name">{t.title}</span>
                  <LineView line={line} />
                </span>
              </button>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
