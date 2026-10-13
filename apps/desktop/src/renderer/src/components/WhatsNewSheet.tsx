import { useCallback, useEffect, useRef, useState } from "react";
import { useApp, useAppStore } from "../state/store";
import { Sheet } from "./Sheet";
import iconUrl from "../assets/app-icons/default.png";

/**
 * What's new in the Realm that is running: its icon, its version, and its part of the changelog as a
 * list, with the whole changelog one click away (main/whats-new.ts, which bakes the notes in at build
 * time). Opens on its own once after an update, and again from the rail, Help ▸ What's New or the
 * palette. Closing it — Done, the ×, Escape or a click outside — marks this version's notes as seen.
 */
export function WhatsNewSheet() {
  const closeSheet = useApp((s) => s.closeSheet);
  const [news, setNews] = useState<WhatsNew | null>(null);
  useEffect(() => {
    let live = true;
    void window.realm?.whatsNew?.notes().then((n) => { if (live) setNews(n); });
    return () => { live = false; };
  }, []);
  const close = useCallback(() => {
    void window.realm?.whatsNew?.seen();
    closeSheet();
  }, [closeSheet]);
  if (!news) return null;
  const { version, notes, url } = news;
  return (
    <Sheet title="What's new" onClose={close} width={440} footer={<>
      <a className="btn" href={url} target="_blank" rel="noreferrer">Full changelog</a>
      <button type="button" className="btn primary" onClick={close}>Done</button>
    </>}>
      <div className="whats-new">
        <div className="whats-new-hero">
          <img className="whats-new-icon" src={iconUrl} alt="" width={64} height={64} draggable={false} />
          <p className="whats-new-version">Realm {version}</p>
          {notes?.date && <p className="whats-new-date">{releaseDate(notes.date)}</p>}
        </div>
        {notes && notes.groups.length > 0 ? notes.groups.map((g, i) => (
          <section key={i} className="whats-new-group" aria-label={g.title ?? undefined}>
            {g.title && <h4>{g.title}</h4>}
            <ul>
              {g.items.map((item, j) => (
                <li key={j}>{item.map((s, k) => <Span key={k} span={s} />)}</li>
              ))}
            </ul>
          </section>
        )) : (
          <p className="whats-new-none">The notes for this version are in the full changelog.</p>
        )}
      </div>
    </Sheet>
  );
}

function Span({ span }: { span: WhatsNewSpan }) {
  const text = span.code ? <code>{span.text}</code> : span.text;
  return span.strong ? <strong>{text}</strong> : <>{text}</>;
}

const dateFormat = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
/** `2026-10-12` → `October 12, 2026`, fixed to UTC so the day never shifts under the reader's clock. */
export const releaseDate = (date: string): string => dateFormat.format(new Date(`${date}T00:00:00Z`));

/**
 * Opens the sheet once after an update. Main answers `claim` true for the first window to ask after
 * the version changed, and false for every other ask — so a second window, or a reload, does not open
 * it again. It waits for a space: first run has its own page, and an update never lands there.
 */
export function WhatsNewBridge() {
  const store = useAppStore();
  const ready = useApp((s) => s.booted && s.spaces.length > 0);
  const asked = useRef(false);
  useEffect(() => {
    const bridge = window.realm?.whatsNew;
    if (!ready || asked.current || !bridge) return;
    asked.current = true;
    void bridge.claim().then((owed) => {
      if (owed && store.getState().sheet === null) store.getState().openSheet({ kind: "whats-new" });
    });
  }, [ready, store]);
  return null;
}
