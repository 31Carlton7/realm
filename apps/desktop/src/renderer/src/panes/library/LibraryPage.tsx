import { MEMORY_DOC_MAX, type ProfileMemoryState } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useState } from "react";
import { useApp } from "../../state/store";
import { MemoryPanel } from "../../components/settings/MemoryPanel";
import { SkillsPanel } from "../../components/settings/SkillsPanel";
import { ScopeGroups } from "../../components/scoped/ScopeGroups";
import type { PaneProps } from "../registry";

const LIBRARY_TABS = [{ id: "skills", label: "Skills" }, { id: "memory", label: "Memory" }] as const;
type LibraryTab = (typeof LIBRARY_TABS)[number]["id"];

/**
 * The Library page (Plan 12 W4) — everything installable, grouped by the scoping contract: skills and
 * memory docs, in "This space" / "From <profile>" / "Everywhere" sections, on the W3 page pattern
 * (`.page` / `.page-head` / `.page-rail` / `.page-content`).
 *
 * The vantage is `item.spaceId` — the space whose layout holds this pane, stamped at open time by
 * `openDestinationPage` (the item's refId is the kind's sentinel, PAGE_REF_IDS; there is no row behind
 * this page). Everything renders from THAT space's view, never "the active space", so a pane surviving
 * a space switch cannot silently regroup under another space's profile.
 *
 * The tab is component state, unlike the space page's per-space store slot: no opener lands the
 * Library on a section, so there is no cross-surface selection to persist.
 */
export function LibraryPage({ item }: PaneProps) {
  const spaceId = item.spaceId;
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const [tab, setTab] = useState<LibraryTab>("skills");

  if (!space) return <div className="pane-placeholder muted">This page's space no longer exists.</div>;

  return (
    <div className="page library-page-pane">
      <header className="page-head">
        <span className="page-glyph"><Icon name="library-page" size={20} /></span>
        <div className="page-title">
          <h1>Library</h1>
          <span className="page-sub">Skills and memory, grouped by where each is defined — seen from {space.name}.</span>
        </div>
      </header>
      <div className="page-body">
        <fieldset className="page-rail">
          <legend className="visually-hidden">Library section</legend>
          {LIBRARY_TABS.map((t) => (
            <label key={t.id} className="settings-tab page-rail-tab" data-selected={tab === t.id || undefined}>
              <input type="radio" name={`library-tab-${item.id}`} value={t.id} checked={tab === t.id} onChange={() => setTab(t.id)} />
              {t.label}
            </label>
          ))}
        </fieldset>
        <div className="page-content">
          {tab === "skills" && <SkillsPanel spaceId={spaceId} />}
          {tab === "memory" && <LibraryMemoryTab spaceId={spaceId} />}
        </div>
      </div>
    </div>
  );
}

/**
 * The Memory tab: this space's doc and the inherited profile doc as scoped groups. The space doc's
 * entry IS the existing MemoryPanel — it is already the defining-scope editor for that doc (reused,
 * not forked; it also carries the AGENTS.md toggle and per-agent honesty that belong wherever the doc
 * is edited). The profile doc renders as an inherited row: per-space toggle, editable only through
 * "Edit in profile". Memory has no pre-scoping rows, so no "Everywhere" group can appear here.
 */
function LibraryMemoryTab({ spaceId }: { spaceId: string }) {
  const memory = useApp((s) => s.spaceMemory[spaceId]);
  return (
    <div className="form settings-panel">
      <ScopeGroups entries={[
        {
          key: "space-doc", scope: { kind: "space", spaceId },
          row: <li key="space-doc" className="settings-row scope-doc-row"><MemoryPanel spaceId={spaceId} /></li>,
        },
        ...(memory?.profile ? [{
          key: "profile-doc", scope: { kind: "profile" as const, profileId: memory.profile.profileId },
          row: <ProfileMemoryRow key="profile-doc" spaceId={spaceId} profile={memory.profile} />,
        }] : []),
      ]} />
    </div>
  );
}

const fmt = (n: number): string => n.toLocaleString("en-US");

/**
 * The inherited profile doc, following §2's contract to the letter: the switch is THIS space's
 * override (`memory.setProfileDocEnabled` — it never touches the doc), and the document is edited only
 * behind "Edit in profile", where the editor names its reach before any keystroke. Same cap posture as
 * MemoryPanel: over MEMORY_DOC_MAX the save is refused with the overage named, never truncated.
 */
function ProfileMemoryRow({ spaceId, profile }: { spaceId: string; profile: ProfileMemoryState }) {
  const profiles = useApp((s) => s.profiles);
  const stored = useApp((s) => s.profileMemory[profile.profileId]);
  const refreshProfileMemory = useApp((s) => s.refreshProfileMemory);
  const saveProfileMemoryDoc = useApp((s) => s.saveProfileMemoryDoc);
  const setProfileDocEnabled = useApp((s) => s.setProfileDocEnabled);
  const openProfilePage = useApp((s) => s.openProfilePage);
  const run = useApp((s) => s.run);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);

  const name = profiles.find((p) => p.id === profile.profileId)?.name ?? "profile";
  // The editor reads the defining scope's own fetch once it lands; the row summary reads the
  // space-view snapshot either way.
  const text = draft ?? stored?.doc ?? profile.doc;
  const over = text.length - MEMORY_DOC_MAX;
  const dirty = draft !== null && draft !== (stored?.doc ?? profile.doc);

  const toggleEditor = () => {
    if (!editing) run(() => refreshProfileMemory(profile.profileId));
    setDraft(null);
    setEditing((v) => !v);
  };

  return (
    <li className="settings-row scope-doc-row">
      <div className="settings-row-main">
        <span className="settings-row-name">{name} memory</span>
        <span className="settings-row-desc">
          {profile.doc.trim() === ""
            ? "Empty — nothing extra travels into this space's sessions."
            : `${fmt(profile.doc.length)} characters, injected before this space's own memory.`}
        </span>
      </div>
      {/* Plan 14 W2: the defining scope has a real page now, so "Edit in profile" JUMPS there
          (primary); the banner-wearing inline editor below stays as the fallback behind "Edit here…". */}
      {!editing && (
        <button type="button" className="btn-quiet scope-move" onClick={() => run(() => openProfilePage("memory"))}>Edit in profile…</button>
      )}
      <button type="button" className="btn-quiet scope-move" onClick={toggleEditor}>{editing ? "Close" : "Edit here…"}</button>
      <input type="checkbox" role="switch" className="switch" aria-label={`${name} memory in this space`}
        title={`Defined in ${name} — this switch is this space's override.`}
        checked={profile.enabledHere} onChange={(e) => run(() => setProfileDocEnabled(spaceId, e.target.checked))} />
      {editing && (
        <div className="scope-doc-editor">
          <p className="settings-note scope-note">Defined in {name}. Changes here apply to every space of {name}.</p>
          <textarea className="memory-doc" aria-label={`${name} memory document`} value={text} rows={8} spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Durable context for every ${name} space — conventions, links, standing instructions…`} />
          <div className="memory-meta">
            <span className="settings-hint" data-tone={over > 0 ? "danger" : undefined}>
              {fmt(text.length)} / {fmt(MEMORY_DOC_MAX)}
              {over > 0 && ` — over the cap by ${fmt(over)} characters. Trim it down; Realm will not truncate it.`}
            </span>
            <button type="button" className="btn primary" disabled={!dirty || over > 0}
              onClick={() => run(async () => { await saveProfileMemoryDoc(profile.profileId, text); setDraft(null); })}>Save memory</button>
          </div>
        </div>
      )}
    </li>
  );
}
