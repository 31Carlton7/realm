import { Icon } from "@realm/ui";
import { useEffect, useId, useState } from "react";
import { useAppStoreMaybe } from "../../state/store";
import { getBrowserBridges } from "../browser/browser-client";
import { toSource, type Source } from "./message-sources";

/** How many sites the folded card draws before the rest become a count. */
const STACKED_SOURCES = 3;

/**
 * The pages the answer above was built from, folded away until asked for.
 *
 * Collapsed by default because a source list is a citation, not content: the reader who wants to
 * check where something came from goes looking, and the one who does not should not have four
 * URLs between them and the next message.
 *
 * The folded card shows the first few sites as a stack of circles. A site's icon is the one Realm's
 * own browser panes already keep for it (`useSourceIcons`), never fetched from the site: drawing one
 * from the host would have Realm making a request to every host an agent ever read, from the
 * transcript, days later. A site Realm has no icon for — a page only `WebFetch` read — is its first
 * letter on a neutral circle of the same size.
 */
export function MessageSources({ sources }: { sources: readonly Source[] }) {
  const icons = useSourceIcons(sources.slice(0, STACKED_SOURCES).map((s) => s.host));
  return <SourcesCard sources={sources} icons={icons} />;
}

/** The card itself, with the icons it has been handed by host — `MessageSources` without the lookup. */
export function SourcesCard({ sources, icons }: { sources: readonly Source[]; icons: Readonly<Record<string, string>> }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const stacked = sources.slice(0, STACKED_SOURCES);
  const more = sources.length - stacked.length;
  return (
    <div className="msg-sources" data-open={open || undefined}>
      <button className="msg-sources-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevronDown" size={12} className="msg-sources-chevron" />
        <span className="msg-sources-stack" aria-hidden>
          {stacked.map((s) => <SourceMark key={s.url} host={s.host} icon={icons[s.host]} />)}
          {more > 0 && <span className="msg-source-mark msg-sources-more">+{more}</span>}
        </span>
        <span>{sources.length} {sources.length === 1 ? "source" : "sources"}</span>
      </button>
      {/* `hidden` rather than unmounted: the button's `aria-controls` has to point at something that
          exists, and a list that is built once keeps its numbering stable across every open. */}
      <ol className="msg-sources-list" id={id} hidden={!open}>
        {sources.map((s, i) => (
          <li key={s.url}>
            {/* target=_blank is what hands the url to the OS browser — main's window-open handler
                takes http(s) and opens it there, the same route markdown links already take. */}
            <a href={s.url} target="_blank" rel="noopener noreferrer" title={s.url}>
              <span className="msg-source-n">{i + 1}</span>
              <span className="msg-source-host">{s.host}</span>
              {s.path && <span className="msg-source-path">{s.path}</span>}
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * One site in the stack: its icon clipped to the circle, or its first letter on the neutral fill.
 * Only a `data:` picture is drawn, as `PageIcon` draws one — the window's CSP admits no remote image,
 * and an address would be a broken image in the row. A picture that fails to decode is the letter too.
 */
function SourceMark({ host, icon }: { host: string; icon: string | undefined }) {
  const [broken, setBroken] = useState<string | null>(null);
  const drawable = icon !== undefined && icon.startsWith("data:image/") && icon !== broken;
  return (
    <span className="msg-source-mark">
      {drawable
        ? <img src={icon} alt="" draggable={false} onError={() => setBroken(icon)} />
        : host.charAt(0).toUpperCase()}
    </span>
  );
}

/**
 * The icons Realm already has for these hosts, from the pages this space's profile has visited in
 * its browser panes — an agent's `browser_open` lands there too. A read of local history, never a
 * request to the site. Outside a store (a unit test of the transcript alone) there is no history to
 * read, and every site is its letter.
 */
function useSourceIcons(hosts: readonly string[]): Readonly<Record<string, string>> {
  const store = useAppStoreMaybe();
  const spaceId = store?.getState().activeSpaceId ?? null;
  const key = hosts.join(" ");
  const [icons, setIcons] = useState<Readonly<Record<string, string>>>({});
  useEffect(() => {
    if (!spaceId || key === "") return;
    let live = true;
    const wanted = key.split(" ");
    void Promise.all(wanted.map(async (host): Promise<[string, string] | null> => {
      try {
        const pages = await getBrowserBridges().server.suggest(spaceId, host);
        const page = pages.find((p) => p.favicon !== "" && toSource(p.url)?.host === host);
        return page ? [host, page.favicon] : null;
      } catch { return null; } // a failed read is no icon, and the letter stands in
    })).then((found) => {
      if (live) setIcons(Object.fromEntries(found.filter((f) => f !== null)));
    });
    return () => { live = false; };
  }, [spaceId, key]);
  return icons;
}
