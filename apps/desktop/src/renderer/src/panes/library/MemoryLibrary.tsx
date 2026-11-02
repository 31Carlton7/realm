import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { Icon } from "@realm/ui";
import {
  AGENT_META, MEMORY_EXTERNAL_UNCONFIRMED, MEMORY_LIBRARY_GROUP_LABEL,
  type MemoryLibraryEntry, type MemoryLibraryFile, type MemoryLibraryGroup, type MemoryLibrarySource, type MemoryLibraryType,
} from "@realm/contracts";
import { useApp } from "../../state/store";
import { PageRail } from "../../components/page-nav";
import { useDissolve } from "../../components/ScrollFades";
import { SpaceIcon } from "../../components/SpaceIcon";
import { age, ago } from "../code-review/code-review-model";
import { stampTitle, useNow } from "../session/timestamps";

/* The documents pane's own editors — Markdown rendered for reading, source for writing — split out the
   way the pane splits them, so a page that is never opened never pays for either. */
const RichTextEditor = lazy(() => import("../documents/RichTextEditor").then((m) => ({ default: m.RichTextEditor })));
const CodeEditor = lazy(() => import("../documents/CodeEditor").then((m) => ({ default: m.CodeEditor })));

const NOOP = () => {};
const GROUPS: readonly MemoryLibraryGroup[] = ["realm", "claude", "codex", "cursor", "gemini"];
const GROUP_MARK: Record<Exclude<MemoryLibraryGroup, "realm">, string> = {
  claude: AGENT_META.claude.icon, codex: AGENT_META.codex.icon, cursor: AGENT_META["acp:cursor"].icon, gemini: AGENT_META["acp:gemini"].icon,
};
const TYPES: readonly { id: MemoryLibraryType; label: string; title: string }[] = [
  { id: "user", label: "About you", title: "Who you are and how you like to work" },
  { id: "feedback", label: "Feedback", title: "How an agent should or should not do something" },
  { id: "project", label: "Project", title: "A fact about the work: a decision, a convention, a date" },
  { id: "reference", label: "Reference", title: "Where something is kept: a link, a folder, a dashboard" },
];
/** What the property list leaves out: the head already says them. */
const SHOWN_ELSEWHERE = new Set(["name", "description", "type", "metadata.type"]);

/** The glyph a source wears in the column: its space's icon where it is one space's folder. */
function SourceGlyph({ source }: { source: MemoryLibrarySource }) {
  const icon = useApp((s) => (source.spaceId ? s.spaces.find((sp) => sp.id === source.spaceId)?.icon : undefined));
  if (icon) return <SpaceIcon icon={icon} size={16} />;
  const name = source.group !== "realm" ? (source.spaceId ? "folder" : source.label === "Project memory" ? "folder" : GROUP_MARK[source.group])
    : source.label === "Memory documents" ? "note" : "commit";
  return <Icon name={name} size={16} className="page-rail-glyph" />;
}

/** Where a memory sits, in the list's few words: its source (unless the list is that source's), the
 *  folder inside it, and how long ago it changed. */
function whereOf(e: MemoryLibraryEntry, source: MemoryLibrarySource | undefined, filtered: boolean): string {
  const parts: string[] = [];
  if (!filtered && source) parts.push(source.group === "realm" ? source.label : `${MEMORY_LIBRARY_GROUP_LABEL[source.group]} · ${source.label}`);
  if (e.folder) parts.push(e.folder);
  return parts.join(" · ");
}

/** `[[a link]]` as a Markdown link whose target is what was written, so the reader draws it as a link
 *  and a click on it can be looked up in the file's `links`. Fenced code is left as it is. */
export function linkWikiLinks(body: string): string {
  let fenced = false;
  return body.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line; }
    return fenced ? line : line.replace(/\[\[([^[\]\n]+)\]\]/g, (_, t: string) => `[${t}](<${t}>)`);
  }).join("\n");
}

/** The body without its opening `# Title` line when that is the title the head already shows. */
export function withoutTitle(body: string, title: string): string {
  const m = /^\s*#{1,6}\s+(.+?)\s*\n/.exec(body.endsWith("\n") ? body : `${body}\n`);
  return m && m[1] === title ? body.slice(m[0].length).replace(/^\n+/, "") : body;
}

type Mode = { kind: "read" } | { kind: "edit"; draft: string } | { kind: "new" };

/**
 * The Library's Memory section: every Markdown memory file an agent on this Mac reads — Realm's own
 * repos and documents, and each agent's own files for every space of the profile — under one search.
 *
 * Three columns, as Mail lays out mailboxes, messages and the one being read: the sources take the
 * sidebar's column under the Library's sections (`PageRail`), the list of memories stands in the page,
 * and beside it the memory being read — rendered as the documents pane renders Markdown, with its
 * frontmatter as a quiet list of properties and who reads it. Edit is the documents pane's source
 * editor; a save is one write, which in a Realm repo is one commit. A file outside Realm asks once
 * before it is written, and its Delete says it goes to the Trash.
 *
 * `source` is the LibraryPage's, because the Library's own Memory row is what clears it.
 */
export function MemoryLibrary({ spaceId, rail, source: sourceId, onSource }: {
  spaceId: string; rail: ReactNode; source: string | null; onSource: (id: string | null) => void;
}) {
  const profileId = useApp((s) => s.spaces.find((x) => x.id === spaceId)?.profileId ?? null);
  const profileName = useApp((s) => s.profiles.find((p) => p.id === profileId)?.name ?? "");
  const rev = useApp((s) => s.memoryLibraryRev);
  const listSources = useApp((s) => s.memoryLibrarySources);
  const listMemories = useApp((s) => s.memoryLibraryList);
  const readMemory = useApp((s) => s.memoryLibraryRead);
  const run = useApp((s) => s.run);
  const [sources, setSources] = useState<MemoryLibrarySource[] | null>(null);
  const [entries, setEntries] = useState<MemoryLibraryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [file, setFile] = useState<MemoryLibraryFile | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "read" });
  /** Re-read on the way back to the window: an agent outside Realm may have written a file meanwhile. */
  const [focusRev, setFocusRev] = useState(0);
  useEffect(() => {
    const onFocus = () => setFocusRev((n) => n + 1);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useEffect(() => {
    if (!profileId) return;
    let live = true;
    run(async () => { const s = await listSources(profileId); if (live) setSources(s); });
    return () => { live = false; };
  }, [profileId, rev, focusRev, listSources, run]);

  /* The list is read again on every keystroke and kept on screen until the next answer lands, so the
     search narrows in place rather than blinking empty between letters. */
  useEffect(() => {
    if (!profileId) return;
    let live = true;
    const q = query.trim();
    run(async () => {
      const list = await listMemories(profileId, { ...(sourceId ? { sourceId } : {}), ...(q ? { query: q } : {}) });
      if (live) setEntries(list);
    });
    return () => { live = false; };
  }, [profileId, sourceId, query, rev, focusRev, listMemories, run]);

  const shownId = picked ?? entries?.[0]?.id ?? null;
  const editing = mode.kind !== "read";
  useEffect(() => {
    if (!shownId || !profileId || editing) return;
    let live = true;
    run(async () => {
      try {
        const f = await readMemory(shownId, profileId);
        if (live) setFile(f);
      } catch (e) {
        // Deleted or moved since it was listed: the list's next read drops it, and the reader goes blank.
        if (live) setFile(null);
        if ((e as { code?: string }).code !== "MEMORY_FILE_NOT_FOUND") throw e;
      }
    });
    return () => { live = false; };
  }, [shownId, profileId, rev, focusRev, editing, readMemory, run]);

  const byId = useMemo(() => new Map((sources ?? []).map((s) => [s.id, s])), [sources]);
  const source = sourceId ? byId.get(sourceId) : undefined;
  const open = useCallback((id: string) => { setPicked(id); setMode({ kind: "read" }); }, []);
  const pickSource = (id: string | null) => { onSource(id); setPicked(null); setMode({ kind: "read" }); };

  const nav = (
    <>
      {rail}
      {sources && <MemorySources sources={sources} current={sourceId} onPick={pickSource} />}
    </>
  );
  return (
    <div className="page-body memory-lib">
      <PageRail label="Library" title="Library">{nav}</PageRail>
      <MemoryList title={source?.label ?? "Memory"} vantage={source ? null : profileName} source={source} byId={byId}
        entries={entries} query={query} onQuery={setQuery} shownId={file?.id ?? shownId} onOpen={open}
        onNew={() => setMode({ kind: "new" })} newing={mode.kind === "new"} />
      <section className="memory-lib-reader" aria-label="Memory">
        {mode.kind === "new" && sources ? (
          <NewMemory sources={sources} spaceId={spaceId} preferred={source?.creatable ? source.id : null}
            onCancel={() => setMode({ kind: "read" })} onMade={(id) => { onSource(null); open(id); }} />
        ) : file && file.id === shownId ? (
          mode.kind === "edit"
            ? <MemoryEditor file={file} source={byId.get(file.sourceId)} profileId={profileId ?? ""} draft={mode.draft} onDraft={(draft) => setMode({ kind: "edit", draft })}
                onDone={(saved) => { if (saved) setFile(saved); setMode({ kind: "read" }); }} />
            : <MemoryReader file={file} source={byId.get(file.sourceId)} onOpen={open} onEdit={() => setMode({ kind: "edit", draft: file.text })}
                onDeleted={() => { setPicked(null); setFile(null); }} />
        ) : entries && entries.length === 0 ? (
          <div className="memory-lib-empty">
            <p className="memory-lib-empty-title">{query.trim() ? "Nothing matches" : "No memory here yet"}</p>
            <p className="memory-lib-empty-line">
              {query.trim() ? "Search reads every memory's name, description and text — try fewer words." : "Agents save what they learn here as they work, or write one yourself."}
            </p>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/** The sources, in the sidebar's column under the Library's sections: grouped by whose files they are,
 *  each with its glyph and how many memories it holds. */
function MemorySources({ sources, current, onPick }: { sources: MemoryLibrarySource[]; current: string | null; onPick: (id: string | null) => void }) {
  return (
    <nav className="memory-sources" aria-label="Where memory is kept">
      {GROUPS.map((g) => {
        const here = sources.filter((s) => s.group === g);
        if (here.length === 0) return null;
        return (
          <section key={g} className="memory-source-group" aria-label={MEMORY_LIBRARY_GROUP_LABEL[g]}>
            <div className="group-label">{MEMORY_LIBRARY_GROUP_LABEL[g]}</div>
            <ul className="memory-source-list">
              {here.map((s) => (
                <li key={s.id}>
                  <button type="button" className="memory-source" data-selected={current === s.id || undefined} aria-current={current === s.id || undefined}
                    title={`${s.path}\n${s.by}`} onClick={() => onPick(current === s.id ? null : s.id)}>
                    <SourceGlyph source={s} />
                    <span className="memory-source-name">{s.label}</span>
                    <span className="memory-source-count">{s.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </nav>
  );
}

function MemoryList({ title, vantage, source, byId, entries, query, onQuery, shownId, onOpen, onNew, newing }: {
  title: string; vantage: string | null; source: MemoryLibrarySource | undefined; byId: Map<string, MemoryLibrarySource>;
  entries: MemoryLibraryEntry[] | null; query: string; onQuery: (q: string) => void; shownId: string | null;
  onOpen: (id: string) => void; onNew: () => void; newing: boolean;
}) {
  const now = useNow();
  const scroller = useRef<HTMLUListElement>(null);
  useDissolve(scroller);
  const reveal = window.realm?.files?.reveal;
  return (
    <section className="memory-lib-list" aria-label="Memories">
      <header className="memory-lib-head">
        <h1 className="memory-lib-title">{title}</h1>
        {vantage && <span className="page-vantage">{vantage}</span>}
        <button type="button" className="icon-btn memory-lib-new" aria-label="New memory" title="New memory" aria-pressed={newing} onClick={onNew}>
          <Icon name="add" size={16} />
        </button>
      </header>
      <label className="library-search memory-lib-search">
        <Icon name="search" size={14} />
        <input className="search-field" type="search" aria-label="Search memory" placeholder="Search memory"
          value={query} onChange={(e) => onQuery(e.target.value)} />
      </label>
      {source && (
        <div className="memory-source-note">
          <p>{source.by}</p>
          {reveal && <button type="button" className="btn-quiet" onClick={() => { void reveal(source.path); }}>Show in Finder</button>}
        </div>
      )}
      {entries === null ? null : entries.length === 0 ? (
        <p className="memory-lib-note">{query.trim() ? `No memory matches “${query.trim()}”.` : "Nothing is kept here yet."}</p>
      ) : (
        <ul className="memory-rows" ref={scroller}>
          {entries.map((e) => {
            const where = whereOf(e, byId.get(e.sourceId), source !== undefined);
            const line = e.match && e.match !== e.description ? e.match : e.description;
            return (
              <li key={e.id}>
                <button type="button" className="memory-row" data-selected={shownId === e.id || undefined} aria-current={shownId === e.id || undefined}
                  onClick={() => onOpen(e.id)}>
                  <span className="memory-row-title">{e.title}</span>
                  <span className="memory-row-line" data-empty={line ? undefined : ""}>{line ?? "Empty"}</span>
                  <span className="memory-row-where">
                    {where && <span className="memory-row-place">{where}</span>}
                    <time dateTime={new Date(e.updatedAt).toISOString()} title={stampTitle(e.updatedAt)}>{age(e.updatedAt, now)}</time>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** "Claude in Realm, as its own memory." — each reader of a file as one line. */
function Readers({ file }: { file: MemoryLibraryFile }) {
  if (file.readBy.length === 0) return <>No agent in Realm reads it.</>;
  return (
    <>
      {file.readBy.map((r) => (
        <span key={`${r.who}${r.where}`} className="memory-reader-line">
          {r.who} {r.where}{r.how && <span className="memory-prop-quiet">, {r.how}</span>}
        </span>
      ))}
    </>
  );
}

function MemoryReader({ file, source, onOpen, onEdit, onDeleted }: {
  file: MemoryLibraryFile; source: MemoryLibrarySource | undefined; onOpen: (id: string) => void; onEdit: () => void; onDeleted: () => void;
}) {
  const remove = useApp((s) => s.memoryLibraryDelete);
  const toast = useApp((s) => s.toast);
  const run = useApp((s) => s.run);
  const now = useNow();
  const [confirming, setConfirming] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  useDissolve(scroller);
  useEffect(() => setConfirming(false), [file.id]);
  const reveal = window.realm?.files?.reveal;
  const name = file.rel.split("/").at(-1)!;
  const props = file.frontmatter.filter((f) => !SHOWN_ELSEWHERE.has(f.key));
  /* What the head already says is not said again under it: a description is a lede only where the
     frontmatter gave one (otherwise it is the body's own first line), and a title taken from the body's
     opening heading leaves that heading out. */
  const lede = file.frontmatter.some((f) => f.key === "description") ? file.description : null;
  const body = withoutTitle(file.body, file.title);
  /* A link a memory makes to another opens it here, and one that leads nowhere the library knows says
     so; a web link is left to the window's own handling. */
  const follow = (e: ReactMouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href");
    if (!href) return;
    const link = file.links.find((l) => l.target === href);
    if (!link) return;
    e.preventDefault();
    if (link.id) onOpen(link.id);
    else toast({ tone: "info", text: `${href} is not a memory file Realm can find.` });
  };
  const doDelete = () => run(async () => {
    await remove(file.id, file.external);
    toast({ tone: "info", text: file.external ? `${name} is in the Trash.` : `Removed ${name} from the memory repo.` });
    onDeleted();
  });
  return (
    <article className="memory-reader">
      <header className="memory-reader-head">
        <div className="memory-reader-heading">
          <h2 className="memory-reader-title">{file.title}</h2>
          <p className="memory-reader-where">
            {source ? (source.group === "realm" ? source.label : `${MEMORY_LIBRARY_GROUP_LABEL[source.group]} · ${source.label}`) : ""}
            {file.folder ? ` · ${file.folder}` : ""}
            {" · "}<time dateTime={new Date(file.updatedAt).toISOString()} title={stampTitle(file.updatedAt)}>Edited {ago(file.updatedAt, now)}</time>
          </p>
        </div>
        <div className="memory-reader-actions">
          {reveal && (
            <button type="button" className="icon-btn" aria-label="Show in Finder" title="Show in Finder" onClick={() => { void reveal(file.path); }}>
              <Icon name="folder" size={16} />
            </button>
          )}
          {file.deletable && (
            <button type="button" className="btn" aria-label={`Delete ${file.title}`} aria-pressed={confirming} onClick={() => setConfirming((c) => !c)}>
              Delete…
            </button>
          )}
          {file.writable && <button type="button" className="btn" onClick={onEdit}><Icon name="edit" size={14} />Edit</button>}
        </div>
      </header>
      {confirming && (
        <div className="memory-confirm" role="group" aria-label={`Delete ${file.title}`}>
          <p>
            Delete {name}? {file.external
              ? "It moves to the Trash, and the agent that reads it stops seeing it."
              : "It is removed from the memory repo with a commit, and its line leaves MEMORY.md."}
          </p>
          <button type="button" className="btn" onClick={() => setConfirming(false)}>Cancel</button>
          <button type="button" className="btn destructive" onClick={doDelete}>{file.external ? "Move to Trash" : "Delete"}</button>
        </div>
      )}
      <div className="memory-reader-scroll" ref={scroller}>
        {lede && <p className="memory-reader-desc">{lede}</p>}
        <dl className="memory-props">
          {file.type && <><dt>Type</dt><dd>{TYPES.find((t) => t.id === file.type)?.label ?? file.type}</dd></>}
          <dt>Read by</dt><dd className="memory-readers"><Readers file={file} /></dd>
          {props.map((p) => <PropRow key={p.key} k={p.key} v={p.value} />)}
          <dt>File</dt><dd><code className="memory-path" title={file.path}>{file.path}</code></dd>
        </dl>
        {file.note && <p className="memory-reader-note">{file.note}</p>}
        <div className="memory-reader-body" data-selectable onClickCapture={follow}>
          {body.trim() === "" ? <p className="memory-lib-note">Nothing written below the properties.</p> : (
            <Suspense fallback={null}>
              <RichTextEditor key={`${file.id}:${file.updatedAt}`} text={linkWikiLinks(body)} onChange={NOOP} readOnly />
            </Suspense>
          )}
        </div>
      </div>
    </article>
  );
}

function PropRow({ k, v }: { k: string; v: string }) {
  return <><dt>{k.replace(/^metadata\./, "")}</dt><dd>{v}</dd></>;
}

/**
 * Editing a memory: the whole file, frontmatter included, in the documents pane's source editor. Save
 * writes it — one commit in a Realm repo. A file outside Realm asks first, once: the yes is kept for
 * that file while the page is open.
 */
function MemoryEditor({ file, source, profileId, draft, onDraft, onDone }: {
  file: MemoryLibraryFile; source: MemoryLibrarySource | undefined; profileId: string; draft: string;
  onDraft: (text: string) => void; onDone: (saved: MemoryLibraryFile | null) => void;
}) {
  const write = useApp((s) => s.memoryLibraryWrite);
  const read = useApp((s) => s.memoryLibraryRead);
  const run = useApp((s) => s.run);
  const [state, setState] = useState<"idle" | "asking" | "saving">("idle");
  const dirty = draft !== file.text;
  const owner = source && source.group !== "realm" ? MEMORY_LIBRARY_GROUP_LABEL[source.group] : null;
  const save = (confirmExternal: boolean) => {
    if (!dirty) { onDone(null); return; }
    if (file.external && !confirmExternal && !confirmedOutside.has(file.id)) { setState("asking"); return; }
    setState("saving");
    run(async () => {
      try {
        await write(file.id, draft, file.external);
        if (file.external) confirmedOutside.add(file.id);
        onDone(await read(file.id, profileId));
      } catch (e) {
        setState((e as { code?: string }).code === MEMORY_EXTERNAL_UNCONFIRMED ? "asking" : "idle");
        throw e;
      }
    });
  };
  const name = file.rel.split("/").at(-1)!;
  return (
    <div className="memory-reader memory-editor">
      <header className="memory-reader-head">
        <div className="memory-reader-heading">
          <h2 className="memory-reader-title">{file.title}</h2>
          <p className="memory-reader-where">
            {state === "saving" ? "Saving…" : dirty ? "Edited" : "No changes"}
            {file.external ? ` · ${owner ? `${owner}'s own file` : "A file"}, outside Realm` : " · Saving makes one commit"}
          </p>
        </div>
        <div className="memory-reader-actions">
          <button type="button" className="btn" onClick={() => onDone(null)}>Cancel</button>
          <button type="button" className="btn primary" disabled={!dirty || state === "saving"} aria-busy={state === "saving" || undefined}
            onClick={() => save(false)}>Save</button>
        </div>
      </header>
      {state === "asking" && (
        <div className="memory-confirm" role="group" aria-label={`Write ${name}`}>
          <p title={file.path}>{name} is {owner ? `${owner}'s` : "an agent's"} own file, outside Realm. Write your change into it?</p>
          <button type="button" className="btn" onClick={() => setState("idle")}>Keep editing</button>
          <button type="button" className="btn primary" onClick={() => { confirmedOutside.add(file.id); save(true); }}>Write it</button>
        </div>
      )}
      <div className="memory-editor-body">
        <Suspense fallback={null}>
          <CodeEditor path={file.path} text={draft} onChange={onDraft} onSave={() => save(false)} />
        </Suspense>
      </div>
    </div>
  );
}

/** The files outside Realm the person said yes to writing, while the app is open — asked once each. */
const confirmedOutside = new Set<string>();

/** Where a new memory can go: a Realm repo's root, or a space's folder of the profile's repo. */
type Place = { key: string; sourceId: string; spaceId?: string; label: string };

function NewMemory({ sources, spaceId, preferred, onCancel, onMade }: {
  sources: MemoryLibrarySource[]; spaceId: string; preferred: string | null; onCancel: () => void; onMade: (id: string) => void;
}) {
  const create = useApp((s) => s.memoryLibraryCreate);
  const spaces = useApp((s) => s.spaces);
  const run = useApp((s) => s.run);
  const profileId = spaces.find((x) => x.id === spaceId)?.profileId;
  const places = useMemo<Place[]>(() => sources.filter((s) => s.creatable).flatMap((s) => {
    if (s.spaceId !== null) return [{ key: s.id, sourceId: s.id, label: s.label }];
    const folders = spaces.filter((sp) => sp.profileId === profileId).map((sp) => ({ key: `${s.id}/${sp.id}`, sourceId: s.id, spaceId: sp.id, label: `${s.label} · ${sp.name}` }));
    return [{ key: s.id, sourceId: s.id, label: `${s.label} · every space` }, ...folders];
  }), [sources, spaces, profileId]);
  /* The space the page was opened from, in the profile's repo, unless a repo was picked in the column:
     what a person writes down while working is most often about that work. */
  const first = places.find((p) => (preferred ? p.key === preferred : p.spaceId === spaceId)) ?? places[0];
  const [where, setWhere] = useState(first?.key ?? "");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<MemoryLibraryType>("project");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const place = places.find((p) => p.key === where);
  const ready = place !== undefined && name.trim() !== "" && description.trim() !== "" && !saving;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || !place) return;
    setSaving(true);
    run(async () => {
      try {
        const made = await create({ sourceId: place.sourceId, ...(place.spaceId ? { spaceId: place.spaceId } : {}), name: name.trim(), description: description.trim(), type, body });
        onMade(made.id);
      } finally { setSaving(false); }
    });
  };
  if (places.length === 0) {
    return (
      <div className="memory-lib-empty">
        <p className="memory-lib-empty-title">No memory repo to write in</p>
        <p className="memory-lib-empty-line">New memories go in a Realm memory repo. Make one in Profile settings ▸ Memory.</p>
        <button type="button" className="btn" onClick={onCancel}>Back</button>
      </div>
    );
  }
  return (
    <form className="memory-reader memory-new" onSubmit={submit} aria-label="New memory">
      <header className="memory-reader-head">
        <div className="memory-reader-heading">
          <h2 className="memory-reader-title">New memory</h2>
          <p className="memory-reader-where">Saved as one commit, and listed in MEMORY.md</p>
        </div>
        <div className="memory-reader-actions">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!ready} aria-busy={saving || undefined}>Save memory</button>
        </div>
      </header>
      <div className="memory-new-fields">
        <label className="field memory-new-name">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Spring creator campaign" autoFocus maxLength={200} />
        </label>
        <label className="field memory-new-desc">
          <span>Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line: what it is, so an agent knows when to read it" maxLength={500} />
        </label>
        <label className="field">
          <span>Where</span>
          <select value={where} onChange={(e) => setWhere(e.target.value)}>
            {places.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value as MemoryLibraryType)} title={TYPES.find((t) => t.id === type)?.title}>
            {TYPES.map((t) => <option key={t.id} value={t.id} title={t.title}>{t.label}</option>)}
          </select>
        </label>
      </div>
      <div className="memory-new-text">
        <span className="memory-new-label">Text</span>
        <div className="memory-editor-body">
          <Suspense fallback={null}>
            <CodeEditor path="new-memory.md" text={body} onChange={setBody} />
          </Suspense>
        </div>
      </div>
    </form>
  );
}
