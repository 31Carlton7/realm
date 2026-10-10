import { Icon, isIconName, type IconName } from "@realm/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CREATOR_PRESET, RECORD_PRESETS, parseEntry, parseRecord, recordSectionsByType, recordTemplate, recordTitle, typeNamesFromFolder,
  type ParsedRecord, type RecordHeadField, type RecordLine, type RecordPreset, type RecordSection, type RecordSectionShape, type TeamRecord,
  type TeamRecordType, type TeamSpace,
} from "@realm/contracts";
import { useApp } from "../../state/store";
import { feedTime } from "./team-format";

/**
 * A team's records, by the kinds it keeps (dynamic Teams, PR 1): each kind's list, one record drawn
 * from its type's sections, and the page where a person shapes a kind — its words, its folder, its
 * head fields and sections — with a preview of exactly the file `record_update create` will write.
 */

/** A type's glyph, where Realm's icon set has it. */
export const typeGlyph = (t: Pick<TeamRecordType, "glyph">): IconName => (isIconName(t.glyph) ? t.glyph : "records");

/** The kind a record's path is in — v50's creators/ on a team that keeps no kinds yet. */
export function typeOfPath(team: TeamSpace, path: string): Pick<TeamRecordType, "key" | "one" | "many" | "folder" | "titleField" | "statusField" | "statuses" | "head" | "sections"> | null {
  const folder = path.split("/")[0] ?? "";
  return team.recordTypes.find((t) => t.folder === folder) ?? (team.recordTypes.length === 0 && folder === CREATOR_PRESET.folder ? CREATOR_PRESET : null);
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* ═══════════════════════════════ a kind's list ═══════════════════════════════ */

export function RecordsPage({ spaceId, team, typeKey }: { spaceId: string; team: TeamSpace; typeKey: string | null }) {
  const records = useApp((s) => s.teamRecords[spaceId]);
  const loadTeamRecords = useApp((s) => s.loadTeamRecords);
  const createTeamRecord = useApp((s) => s.createTeamRecord);
  const setSpacePageTab = useApp((s) => s.setSpacePageTab);
  const run = useApp((s) => s.run);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  useEffect(() => { run(() => loadTeamRecords(spaceId)); }, [spaceId, loadTeamRecords, run]);
  const type = (typeKey ? team.recordTypes.find((t) => t.key === typeKey) : null) ?? team.recordTypes[0] ?? null;
  if (!type) return <NewRecordTypePage spaceId={spaceId} team={team} first />;
  const mine = records?.filter((r) => r.kind === type.key || r.path.startsWith(`${type.folder}/`));
  const add = () => run(async () => {
    const r = await createTeamRecord(spaceId, name.trim(), type.key);
    setAdding(false); setName(""); setSpacePageTab(spaceId, `record:${r.path}`);
  });
  return (
    <>
      <header className="page-head">
        <div className="page-title"><h1>{type.many}</h1></div>
        <span className="page-vantage">{mine ? `${mine.length} record${mine.length === 1 ? "" : "s"}` : ""}</span>
        <button type="button" className="btn" onClick={() => setSpacePageTab(spaceId, `recordtype:${type.key}`)}>Edit fields…</button>
        <button type="button" className="btn" onClick={() => setAdding(true)}><Icon name="add" size={16} />New {lower(type.one)}</button>
      </header>
      <div className="form">
        <p className="tp-file"><code>{type.folder}/</code> · team memory · one Markdown file per {lower(type.one)}, read by every role</p>
        {adding && (
          <form className="tp-message tp-inline" onSubmit={(e) => { e.preventDefault(); if (name.trim()) add(); }}>
            <input className="tp-inline-field" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={`The ${lower(type.one)}'s name`} aria-label={`The ${lower(type.one)}'s name`}
              onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setAdding(false); } }} />
            <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
            <button type="submit" className="btn primary" disabled={!name.trim()}>Make record</button>
          </form>
        )}
        {mine && mine.length === 0 && !adding && <p className="tp-empty">No {lower(type.many)} yet. Make one yourself, or a role keeps them with record_update.</p>}
        {mine && mine.length > 0 && (
          <ul className="settings-list">
            {mine.map((r) => (
              <li key={r.path} className="settings-row tp-row-link">
                <button type="button" className="tp-row-button" onClick={() => setSpacePageTab(spaceId, `record:${r.path}`)}>
                  <span className="settings-row-main">
                    <span className="settings-row-name">{r.name}</span>
                    <span className="settings-row-detail t-mono">{r.path}</span>
                  </span>
                  {r.status && <StatusChip status={r.status} />}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="btn-quiet tp-new-type" onClick={() => setSpacePageTab(spaceId, "recordtype:new")}><Icon name="add" size={16} />New record type…</button>
      </div>
    </>
  );
}

const STATUS_TONE: Record<string, "ok" | "warn" | undefined> = { signed: "ok", active: "ok", won: "ok", live: "ok", published: "ok", answered: "ok", fixed: "ok",
  contacted: "warn", negotiating: "warn", paused: "warn", "at-risk": "warn" };
export function StatusChip({ status }: { status: string }) {
  const word = status.split(/[\s,·]/)[0] ?? status;
  return <span className="tp-chip" data-tone={STATUS_TONE[word.toLowerCase()]}>{capital(word)}</span>;
}

/* ═══════════════════════════════ one record ═══════════════════════════════ */

/**
 * A record as Realm draws it, from its type — over the Markdown file that IS the record. A file not in
 * the record's shape is shown as its Markdown, never as a half-drawn form; Edit is the file itself,
 * saved under the person's name.
 */
export function RecordPage({ spaceId, path, team }: { spaceId: string; path: string; team: TeamSpace }) {
  const fetchTeamRecord = useApp((s) => s.fetchTeamRecord);
  const writeTeamRecord = useApp((s) => s.writeTeamRecord);
  const runRole = useApp((s) => s.runRole);
  const reveal = window.realm?.files?.reveal;
  const run = useApp((s) => s.run);
  const [rec, setRec] = useState<TeamRecord | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const records = useApp((s) => s.teamRecords[spaceId]);
  useEffect(() => { run(async () => setRec(await fetchTeamRecord(spaceId, path))); }, [spaceId, path, fetchTeamRecord, run, records]);
  if (!rec) return <p className="tp-empty">Loading…</p>;
  const parsed = parseRecord(rec.markdown);
  const type = typeOfPath(team, rec.path);
  const title = parsed ? (type ? recordTitle(type, parsed) : parsed.title) : rec.name;
  const manager = team.roles.find((r) => r.template === "creator-manager") ?? team.roles[0];
  const save = () => run(async () => { setRec(await writeTeamRecord(spaceId, rec.path, draft)); setEditing(false); });
  return (
    <>
      <header className="page-head">
        <div className="page-title"><h1>{title}</h1></div>
        <span className="page-vantage">{rec.status ? capital(rec.status) : ""}</span>
        {editing ? (
          <>
            <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="btn primary" onClick={save}>Save</button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={() => { setDraft(rec.markdown); setEditing(true); }}>Edit</button>
            {reveal && <button type="button" className="btn" onClick={() => { void reveal(rec.absPath); }}>Show in Finder</button>}
            {manager && <button type="button" className="btn" onClick={() => run(() => runRole(manager.id, `About ${title} (${rec.path}): check the record and tell me what is due.`).then(() => undefined))}>Ask {manager.name}</button>}
          </>
        )}
      </header>
      <div className="form">
        <p className="tp-file"><code>{rec.path}</code> · team memory{rec.lastAuthor ? ` · last changed by ${rec.lastAuthor} ${feedTime(rec.updatedAt ?? Date.now())}` : ""}</p>
        {editing ? (
          <textarea className="tp-record-source" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`${rec.name}'s record, as Markdown`} spellCheck={false} />
        ) : parsed && type ? <RecordView record={parsed} type={type} /> : (
          <>
            <p className="tp-make-note">{parsed ? "No kind of record this team keeps has this folder, so it is shown as written." : "This file is not in a record's shape, so it is shown as written."}</p>
            <pre className="tp-record-source tp-record-pre">{rec.markdown}</pre>
          </>
        )}
      </div>
    </>
  );
}

const ENTRY_GLYPH = (label: string): IconName => {
  const c = label.toLowerCase();
  return c.includes("tiktok") ? "tiktok" : c.includes("instagram") ? "instagram" : c.includes("youtube") ? "youtube" : c.includes("mail") ? "mail" : "user";
};

/** A list line's last ` · ` part, when it is a one-word state ("done", "sent") rather than more detail. */
const STATE_WORD = /^[A-Za-z][\w'-]{0,15}$/;

/**
 * The record drawn from its type: `properties` as a card of `Key: value` rows (the head's fields go
 * in the first such card, as v50's Deal did), `entries` as rows with their parts — a `consent:` part
 * a chip — `list` as rows, dated or not, and `text` as prose. Sections the type does not name are
 * drawn under Other, as written.
 */
export function RecordView({ record, type }: { record: ParsedRecord; type: Pick<RecordPreset, "titleField" | "sections"> }) {
  const { named, other } = recordSectionsByType(type, record);
  const head = record.head.filter((l) => !(type.titleField !== "#" && l.field?.key.toLowerCase() === type.titleField.toLowerCase()));
  const firstProps = named.findIndex((n) => n.section.shape === "properties");
  return (
    <>
      {firstProps === -1 && head.length > 0 && <Properties heading="Details" lines={head} />}
      {named.map(({ section, lines }, i) => (
        <SectionView key={section.heading} section={section} lines={i === firstProps ? [...head, ...lines] : lines} />
      ))}
      {other.length > 0 && (
        <>
          <h3 className="settings-head">Other</h3>
          {other.map((s) => (
            <div key={s.heading} className="tp-other">
              <h4 className="settings-row-title">{s.heading}</h4>
              <ul className="settings-list">
                {s.lines.map((l, i) => <li key={i} className="settings-row"><div className="settings-row-main"><span className="settings-row-name">{l.text}</span></div></li>)}
              </ul>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function SectionView({ section, lines }: { section: RecordSection; lines: RecordLine[] }) {
  const empty = <p className="tp-empty">No {section.heading.toLowerCase()} on record.</p>;
  if (section.shape === "properties") return <Properties heading={section.heading} lines={lines} />;
  if (section.shape === "text") {
    return (
      <>
        <h3 className="settings-head">{section.heading}</h3>
        {lines.length === 0 ? empty : <div className="tp-prose">{lines.map((l, i) => <p key={i}>{l.text}</p>)}</div>}
      </>
    );
  }
  if (section.shape === "entries") {
    const parts = section.parts ?? [];
    return (
      <>
        <h3 className="settings-head">{section.heading}</h3>
        {lines.length === 0 ? empty : (
          <ul className="settings-list">
            {lines.map((l, i) => {
              const e = parseEntry(l, parts);
              const consent = parts.includes("consent");
              const rest = Object.entries(e.parts).filter(([k]) => k !== "consent")
                .map(([k, v]) => (k === "vault" ? `sign-in kept as ${v}` : k === "device" ? v : `${k}: ${v}`));
              return (
                <li key={i} className="settings-row">
                  <span className="t-glyph"><Icon name={ENTRY_GLYPH(e.label)} size={16} /></span>
                  <div className="settings-row-main">
                    <span className="settings-row-name">{e.handle ?? e.label}</span>
                    <span className="settings-row-detail">{[e.handle ? e.label : null, ...rest, e.handle ? e.note : null].filter(Boolean).join(" · ")}</span>
                  </div>
                  {consent && e.handle
                    ? <span className="tp-chip" data-tone={e.parts.consent ? "ok" : "warn"} title={e.parts.consent ? `Consent: ${e.parts.consent}` : "Add consent: to this line before anything is posted to it"}>{e.parts.consent ? "Consented" : "No consent yet"}</span>
                    : !e.handle && e.note && <span className="tp-chip" data-tone="warn">{capital(e.note)}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </>
    );
  }
  return (
    <>
      <h3 className="settings-head">{section.heading}</h3>
      {lines.length === 0 ? empty : (
        <ul className="settings-list">
          {lines.map((l, i) => {
            const [what = "", ...rest] = l.text.split(/\s+·\s+/);
            const last = rest.at(-1);
            const state = last && STATE_WORD.test(last) ? last : undefined;
            const done = state && /^(done|sent|paid|posted|published|fixed|live|won)$/i.test(state);
            return (
              <li key={i} className="settings-row">
                <div className="settings-row-main">
                  <span className="settings-row-name">{what}</span>
                  {rest.length > (state ? 1 : 0) && <span className="settings-row-detail">{rest.slice(0, state ? -1 : undefined).join(" · ")}</span>}
                </div>
                {state && <span className="tp-chip" data-tone={done ? "ok" : "warn"}>{capital(state)}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function Properties({ heading, lines }: { heading: string; lines: RecordLine[] }) {
  const fields = lines.filter((l) => l.field);
  const loose = lines.filter((l) => !l.field);
  return (
    <>
      <h3 className="settings-head">{heading}</h3>
      {fields.length === 0 && loose.length === 0 ? <p className="tp-empty">No {heading.toLowerCase()} on record.</p> : (
        <div className="tp-props">
          {fields.map((l, i) => <PropRow key={i} line={l} />)}
          {loose.map((l, i) => <div key={`loose-${i}`} className="tp-prop-full">{l.text}</div>)}
        </div>
      )}
    </>
  );
}

function PropRow({ line }: { line: RecordLine }) {
  const f = line.field!;
  const statusish = f.key.toLowerCase() === "status";
  return (
    <>
      <div>{f.key}</div>
      <div>{statusish ? <><StatusChip status={f.value} /> <span className="t-faint">{f.value.split(/[\s,·]/).slice(1).join(" ").replace(/^[·,\s]+/, "")}</span></> : f.value}</div>
    </>
  );
}

/* ═══════════════════════════════ a new kind ═══════════════════════════════ */

/** "New record type…": a preset the team does not keep yet, or one written from a name. */
export function NewRecordTypePage({ spaceId, team, first = false }: { spaceId: string; team: TeamSpace; first?: boolean }) {
  const createRecordType = useApp((s) => s.createRecordType);
  const setSpacePageTab = useApp((s) => s.setSpacePageTab);
  const run = useApp((s) => s.run);
  const [name, setName] = useState("");
  const taken = (p: RecordPreset) => team.recordTypes.some((t) => t.key === p.key || t.folder === p.folder);
  const presets = RECORD_PRESETS.filter((p) => !taken(p));
  const make = (input: Parameters<typeof createRecordType>[0]) => run(async () => {
    const t = await createRecordType(input);
    setSpacePageTab(spaceId, `recordtype:${t.key}`);
  });
  const written = name.trim() ? typeNamesFromFolder(name.trim().toLowerCase().replace(/\s+/g, "-") + (/s$/i.test(name.trim()) ? "" : "s")) : null;
  return (
    <>
      <header className="page-head">
        <div className="page-title"><h1>{first ? "Records" : "New record type"}</h1></div>
      </header>
      <div className="form">
        <p className="tp-lede">{first ? "This team keeps no records yet. " : ""}A kind of record is a folder of Markdown files in the team's memory, one per person or thing, with the fields and sections every role reads.</p>
        <h3 className="settings-head">Start from</h3>
        <div className="tp-cards">
          {presets.map((p) => (
            <button key={p.key} type="button" className="tp-card tp-type-card" onClick={() => make({ spaceId, preset: p.key })}>
              <span className="tp-card-head"><span className="tp-mark tp-mark-add"><Icon name={typeGlyph(p)} size={16} /></span><span className="tp-card-name">{p.many}</span></span>
              <span className="tp-card-line">{[p.statusField ? `${p.statusField}: ${p.statuses.slice(0, 3).join(", ")}${p.statuses.length > 3 ? "…" : ""}` : null, p.sections.map((s) => s.heading).join(", ")].filter(Boolean).join(" · ")}</span>
              <span className="tp-card-foot"><code className="t-mono">{p.folder}/</code></span>
            </button>
          ))}
        </div>
        <h3 className="settings-head">Or name your own</h3>
        <form className="tp-message tp-inline" onSubmit={(e) => {
          e.preventDefault();
          if (!written) return;
          make({ spaceId, one: written.one, many: written.many, folder: written.many.toLowerCase().replace(/[^a-z0-9]+/g, "-"), key: written.key, statusField: "Status", statuses: ["new"], head: [{ key: "Status" }], sections: [{ heading: "Notes", shape: "text" }] });
        }}>
          <input className="tp-inline-field" value={name} onChange={(e) => setName(e.target.value)} placeholder="What it keeps, e.g. Vendors" aria-label="The new kind's name" />
          <span className="tp-make-note">{written ? `${written.many} · ${written.many.toLowerCase().replace(/[^a-z0-9]+/g, "-")}/` : ""}</span>
          <button type="submit" className="btn primary" disabled={!written}>Make it</button>
        </form>
      </div>
    </>
  );
}

/* ═══════════════════════════════ shaping a kind ═══════════════════════════════ */

type Draft = Pick<TeamRecordType, "one" | "many" | "folder" | "titleField" | "statusField" | "statuses" | "head" | "sections">;
const draftOf = (t: TeamRecordType): Draft => ({ one: t.one, many: t.many, folder: t.folder, titleField: t.titleField, statusField: t.statusField, statuses: t.statuses, head: t.head, sections: t.sections });

const SHAPES: { id: RecordSectionShape; label: string; title: string }[] = [
  { id: "properties", label: "Properties", title: "Key: value lines, drawn as a card" },
  { id: "entries", label: "Entries", title: "One thing per line, with parts after · (vault: …, consent: …)" },
  { id: "list", label: "List", title: "Lines, one under another" },
  { id: "text", label: "Text", title: "Prose" },
];

/** A check this team's Review already runs on a section, said where the section is shaped. */
const checkOn = (s: RecordSection): string | null => (s.shape === "entries" && (s.parts ?? []).includes("consent") ? "Review reads consent: here before anything is posted for an account" : null);

/**
 * The record type's page, in the settings-card grammar: its words, its folder (fixed once records use
 * it), its title and status, its head fields and sections, and a preview of the file a new record
 * starts as. It keeps itself, as a role's brief does: a pause writes it, and the head says so.
 */
export function RecordTypePage({ spaceId, type }: { spaceId: string; type: TeamRecordType }) {
  const updateRecordType = useApp((s) => s.updateRecordType);
  const archiveRecordType = useApp((s) => s.archiveRecordType);
  const setSpacePageTab = useApp((s) => s.setSpacePageTab);
  const run = useApp((s) => s.run);
  const [draft, setDraft] = useState<Draft>(() => draftOf(type));
  const [state, setState] = useState<"saved" | "edited" | "saving">("saved");
  const [arming, setArming] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(draft);
  latest.current = draft;
  useEffect(() => { if (state === "saved") setDraft(draftOf(type)); }, [type]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const save = (d: Draft) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const patch = Object.fromEntries(Object.entries(d).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((type as Record<string, unknown>)[k])));
    if (Object.keys(patch).length === 0) { setState("saved"); return; }
    setState("saving");
    run(async () => {
      try { await updateRecordType({ id: type.id, ...patch }); setState("saved"); } catch (e) { setState("edited"); throw e; }
    });
  };
  const change = (next: Partial<Draft>) => {
    const d = { ...latest.current, ...next };
    setDraft(d); setState("edited");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => save(latest.current), 1200);
  };
  const preview = useMemo(() => recordTemplate(draft, "Jane Doe"), [draft]);
  const fixed = type.count > 0;
  const fields = draft.head.map((h) => h.key);
  const setHead = (head: RecordHeadField[]) => change({ head, ...(draft.titleField !== "#" && !head.some((h) => h.key === draft.titleField) ? { titleField: "#" } : {}),
    ...(draft.statusField && !head.some((h) => h.key === draft.statusField) ? { statusField: null } : {}) });
  const setSection = (i: number, s: Partial<RecordSection>) => change({ sections: draft.sections.map((x, j) => (j === i ? clean({ ...x, ...s }) : x)) });
  return (
    <>
      <header className="page-head">
        <div className="page-title"><h1>{draft.one || type.one}</h1></div>
        <span className="page-vantage" aria-live="polite">{state === "saving" ? "Saving…" : state === "edited" ? "Edited" : "Saved"}</span>
        <button type="button" className="btn" onClick={() => { save(latest.current); setSpacePageTab(spaceId, `records:${type.key}`); }}>Done</button>
      </header>
      <div className="form" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null) && state === "edited") save(latest.current); }}>
        <p className="tp-file"><code>{type.folder}/</code> · team memory · one Markdown file per {lower(type.one)}{type.preset ? ` · from the ${type.preset} preset` : ""}</p>
        <ul className="settings-list">
          <li className="settings-row">
            <div className="settings-row-main"><span className="settings-row-name">Name</span><span className="settings-row-detail">One, and more than one — what the column and the pages say</span></div>
            <input className="settings-text tp-type-name" aria-label="One" value={draft.one} onChange={(e) => change({ one: e.target.value })} />
            <input className="settings-text tp-type-name" aria-label="More than one" value={draft.many} onChange={(e) => change({ many: e.target.value })} />
          </li>
          <li className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-name">Folder</span>
              <span className="settings-row-detail">{fixed ? `Fixed: ${type.count} record${type.count === 1 ? "" : "s"} use it, and reviews point at their files. A new folder is a new kind of record.` : "One name in the team's memory"}</span>
            </div>
            <input className="settings-text t-mono" aria-label="Folder" value={draft.folder} disabled={fixed} onChange={(e) => change({ folder: e.target.value.toLowerCase() })} />
          </li>
          <li className="settings-row">
            <div className="settings-row-main"><span className="settings-row-name">Title</span></div>
            <select aria-label="Title" value={draft.titleField} onChange={(e) => change({ titleField: e.target.value })}>
              <option value="#">The file's first line</option>
              {fields.map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </li>
          <li className="settings-row" data-stack>
            <div className="settings-row-main tp-type-status">
              <span className="settings-row-name">Status</span>
              <select aria-label="Status field" value={draft.statusField ?? ""} onChange={(e) => change({ statusField: e.target.value || null })}>
                <option value="">None</option>
                {fields.map((f) => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            {draft.statusField && (
              <ListField label="Statuses, first is a new record's" value={draft.statuses} onChange={(statuses) => change({ statuses })} placeholder="prospect, contacted, signed" />
            )}
          </li>
        </ul>

        <h3 className="settings-head">Head</h3>
        <ul className="settings-list">
          {draft.head.map((h, i) => (
            <li key={i} className="settings-row">
              <input className="settings-text tp-type-field" aria-label={`Head field ${i + 1}`} value={h.key}
                onChange={(e) => setHead(draft.head.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
              <span className="settings-row-main" />
              <button type="button" className="icon-btn" aria-label={`Remove ${h.key}`} title={`Remove ${h.key} from the head`} onClick={() => setHead(draft.head.filter((_, j) => j !== i))}><Icon name="close" size={16} /></button>
            </li>
          ))}
        </ul>
        <button type="button" className="btn-quiet tp-new-type" onClick={() => setHead([...draft.head, { key: uniqueName("Field", fields) }])}><Icon name="add" size={16} />Add a field</button>

        <h3 className="settings-head">Sections</h3>
        <ul className="settings-list">
          {draft.sections.map((s, i) => {
            const check = checkOn(s);
            return (
              <li key={i} className="settings-row" data-stack>
                <div className="tp-type-section">
                  <input className="settings-text tp-type-field" aria-label={`Section ${i + 1}`} value={s.heading} onChange={(e) => setSection(i, { heading: e.target.value })} />
                  <fieldset className="settings-tabs" aria-label={`How ${s.heading} is drawn`}>
                    {SHAPES.map((x) => (
                      <label key={x.id} className="settings-tab" data-selected={s.shape === x.id || undefined} title={x.title}>
                        <input type="radio" name={`section-shape-${type.id}-${i}`} value={x.id} checked={s.shape === x.id} onChange={() => setSection(i, { shape: x.id })} />
                        {x.label}
                      </label>
                    ))}
                  </fieldset>
                  {arming === i
                    ? <button type="button" className="btn danger" onClick={() => { setArming(null); change({ sections: draft.sections.filter((_, j) => j !== i) }); }}>{check ? "Remove, and its check" : "Remove"}</button>
                    : <button type="button" className="icon-btn" aria-label={`Remove ${s.heading}`} title={check ? `${s.heading} carries a check: removing it asks first` : `Remove ${s.heading}`}
                        onClick={() => (check ? setArming(i) : change({ sections: draft.sections.filter((_, j) => j !== i) }))}><Icon name="close" size={16} /></button>}
                </div>
                {s.shape === "entries" && <ListField label="Parts after ·" value={s.parts ?? []} onChange={(parts) => setSection(i, { parts })} placeholder="vault, device, consent" />}
                {s.shape === "list" && (
                  <label className="tp-type-dated"><input type="checkbox" checked={s.dated === true} onChange={(e) => setSection(i, { dated: e.target.checked })} />Each line starts with a date</label>
                )}
                {check && <span className="settings-row-detail">{arming === i ? `Without ${s.heading}, Review cannot find consent:, and nothing is posted for any account. Press Remove again to go ahead.` : check}</span>}
              </li>
            );
          })}
        </ul>
        <button type="button" className="btn-quiet tp-new-type" onClick={() => change({ sections: [...draft.sections, { heading: uniqueName("Section", draft.sections.map((s) => s.heading)), shape: "list" }] })}><Icon name="add" size={16} />Add a section</button>

        <h3 className="settings-head">Preview</h3>
        <p className="tp-make-note">What a new {lower(draft.one || type.one)} starts as — the file record_update writes.</p>
        <pre className="tp-record-source tp-record-pre tp-type-preview" aria-label="Preview">{preview}</pre>

        <div className="tp-danger">
          <button type="button" className="btn" onClick={() => run(async () => { await archiveRecordType(type.id, spaceId, true); setSpacePageTab(spaceId, "records"); })}>Archive {type.many}</button>
          <span className="tp-make-note">Hides it from the column. Its files stay in {type.folder}/.</span>
        </div>
      </div>
    </>
  );
}

/** A section's own keys and nothing else: parts only for entries, dated only for a list. */
function clean(s: RecordSection): RecordSection {
  const out: RecordSection = { heading: s.heading, shape: s.shape };
  if (s.shape === "entries" && s.parts) out.parts = s.parts;
  if (s.shape === "list" && s.dated) out.dated = true;
  return out;
}

const uniqueName = (base: string, taken: string[]) => {
  let n = taken.length + 1;
  while (taken.some((t) => t.toLowerCase() === `${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
};

/** A comma-separated list, kept as typed while the field has focus. */
function ListField({ label, value, onChange, placeholder }: { label: string; value: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [text, setText] = useState(value.join(", "));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(value.join(", ")); }, [value, focused]);
  return (
    <label className="tp-type-list">
      <span className="settings-row-detail">{label}</span>
      <input className="settings-text" value={text} placeholder={placeholder} aria-label={label}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onChange={(e) => { setText(e.target.value); onChange(e.target.value.split(",").map((x) => x.trim()).filter(Boolean)); }} />
    </label>
  );
}
