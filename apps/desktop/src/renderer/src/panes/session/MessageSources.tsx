import { Icon } from "@realm/ui";
import { useId, useState } from "react";
import type { Source } from "./message-sources";

/**
 * The pages the answer above was built from, folded away until asked for.
 *
 * Collapsed by default because a source list is a citation, not content: the reader who wants to
 * check where something came from goes looking, and the one who does not should not have four
 * URLs between them and the next message.
 *
 * No favicons, unlike the reference. A favicon is fetched from the site it belongs to, so drawing
 * one would have Realm making a request to every host an agent ever read, from the transcript,
 * days later — a network call the reader did not ask for, to say nothing they cannot already see
 * in the hostname.
 */
export function MessageSources({ sources }: { sources: readonly Source[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="msg-sources" data-open={open || undefined}>
      <button className="msg-sources-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevronDown" size={12} className="msg-sources-chevron" />
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
