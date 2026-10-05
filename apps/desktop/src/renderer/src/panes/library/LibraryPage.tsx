import type { MemoryState } from "@realm/contracts";
import { PageScroll, useDissolve } from "../../components/ScrollFades";
import { Icon } from "@realm/ui";
import { useEffect, useRef, useState } from "react";
import { useApp } from "../../state/store";
import { memoryReaderNames } from "../../components/settings/MemoryPanel";
import { MemoryDoc } from "../../components/settings/MemoryDoc";
import { SpaceIcon } from "../../components/SpaceIcon";
import { SkillsPanel } from "../../components/settings/SkillsPanel";
import { LibraryFiles } from "./LibraryFiles";
import { LibrarySaved } from "./LibrarySaved";
import { SkillViewer } from "./SkillViewer";
import type { PaneProps } from "../registry";
import { PageRail } from "../../components/page-nav";

/* Files leads. Skills and memory are what you INSTALL into a space and change rarely; files are
   what the work produced, and they are the reason someone opens a Library at all. Saved is what the
   reader KEPT of the work, so it follows the files and comes before the installed things. */
const LIBRARY_TABS = [
  { id: "files", label: "Files", icon: "artifact" }, { id: "saved", label: "Saved", icon: "saved" },
  { id: "skills", label: "Skills", icon: "sparkles" }, { id: "memory", label: "Memory", icon: "context" },
] as const;
type LibraryTab = (typeof LIBRARY_TABS)[number]["id"];

/**
 * The Library page — everything a space HAS, on the W3 page pattern (`.page` / `.page-head` /
 * `.page-rail` / `.page-content`).
 *
 * Four tabs, and Files and Saved are not like the other two. Skills and memory are installable things
 * grouped by the scoping contract — "This space" / "From <profile>" / "Everywhere". Files are the
 * OUTPUT of the work: every file any session wrote or was given, across every space in the profile,
 * read from the server's `artifacts` index rather than folded out of transcripts (see LibraryFiles).
 * Saved is what the reader kept of it — every turn saved from a scroll track, across the same
 * profile (see LibrarySaved).
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
  /* Files and Memory span every space of the profile, so the head names the profile; Skills is a
     scoped list seen from ONE space, so it names that space — the vantage is a fact about what the
     section shows, and the sections show different things. */
  const profileName = useApp((s) => s.profiles.find((p) => p.id === space?.profileId)?.name ?? "");
  const [tab, setTab] = useState<LibraryTab>("files");
  const railStrip = useRef<HTMLFieldSetElement>(null);
  useDissolve(railStrip, "x");
  /* The skill being READ, if any. Store state rather than the tab's kind, because the space page's
     and the profile page's Skills lists open a skill by naming it here and then opening this page —
     one skill viewer, reached the same way from all three lists. Opening one replaces the page's
     body rather than taking a pane: a `SKILL.md` is reading, and design.md gives reading the
     available width, not a 420px sheet. */
  const openSkill = useApp((s) => s.librarySkill[spaceId] ?? null);
  const setLibrarySkill = useApp((s) => s.setLibrarySkill);
  const skills = useApp((s) => s.spaceSkills[spaceId]);
  const openName = openSkill === null ? null : skills?.find((sk) => sk.id === openSkill)?.name ?? openSkill;
  /* Back lands on Skills whatever the tab was, because Skills IS the list this page shows a skill
     from — and a skill opened from the space page would otherwise close onto Files, a tab the user
     never chose. */
  const closeSkill = () => { setLibrarySkill(spaceId, null); setTab("skills"); };
  /* A section picked from the rail — which, over the panes, is in the sidebar and still showing while
     a skill is read, Skills lit — goes to that section, out of the skill if one is open. */
  const shown: LibraryTab = openSkill !== null ? "skills" : tab;
  const pick = (next: LibraryTab) => { if (openSkill !== null) setLibrarySkill(spaceId, null); setTab(next); };
  const rail = (
    <fieldset className="page-rail" ref={railStrip}>
      <legend className="visually-hidden">Library section</legend>
      {LIBRARY_TABS.map((t) => (
        <label key={t.id} className="settings-tab page-rail-tab" data-selected={shown === t.id || undefined}>
          {/* onClick as well as onChange: a radio that is already checked fires no change, and Skills
              is checked while a skill is open — clicking it is how the list comes back. */}
          <input type="radio" name={`library-tab-${item.id}`} value={t.id} checked={shown === t.id}
            onChange={() => pick(t.id)} onClick={() => { if (openSkill !== null) pick(t.id); }} />
          <Icon name={t.icon} size={16} className="page-rail-glyph" />
          {t.label}
        </label>
      ))}
    </fieldset>
  );

  if (!space) return <div className="pane-placeholder muted">This page's space no longer exists.</div>;

  /* The head is the column's first child wherever the column is drawn — the list's, Files' own, a
     skill's — so it scrolls away with what it names. */
  const head = (
    <header className="page-head">
      {/* Reading a skill, the head is the skill's — its name is the h1, and the way back to the list
          is the control immediately left of it. A second "Library" title above a skill's name would
          be two headings for one page, and the back button already says where back goes. */}
      {openSkill !== null && (
        <button type="button" className="icon-btn page-back" aria-label="Back to skills" onClick={closeSkill}>
          <Icon name="chevronLeft" size={14} />
        </button>
      )}
      {/* The section it shows, as Settings' head names its page: "Library" is the pane bar's word and
          the column's Back already says where back goes. */}
      <div className="page-title"><h1>{openName ?? LIBRARY_TABS.find((t) => t.id === shown)!.label}</h1></div>
      {/* The vantage, kept. It used to live in the sub-title paragraph, and that paragraph went —
          but WHICH space a scope-grouped page is seen from is a fact about what it is showing, not
          decoration, and it is the only place that fact appears. */}
      <span className="page-vantage">{shown === "skills" ? space.name : profileName}</span>
    </header>
  );

  return (
    <div className="page library-page-pane">
      {openSkill !== null ? (
        <>
          {/* Reading a skill, the Library's sections stay in the sidebar, so the column does not change
              under it; in the page there is only the skill, with its own way back beside its name. */}
          <PageRail label="Library" inline={false}>{rail}</PageRail>
          <SkillViewer spaceId={spaceId} id={openSkill} onBack={closeSkill} head={head} />
        </>
      ) : (
      <div className="page-body">
        <PageRail label="Library">{rail}</PageRail>
        {/* Files brings its own scroller, because its toolbar rides in it under the head; the other two
            are reading columns. Both ends dissolve, but only when there is something under them — and
            only over the column: a band on the body would be drawn over the rail above it. */}
        {tab === "files" ? <LibraryFiles spaceId={spaceId} head={head} /> : (
          <PageScroll>
            {head}
            {tab === "skills" && <SkillsPanel spaceId={spaceId} onOpen={(id) => setLibrarySkill(spaceId, id)} />}
            {tab === "saved" && <LibrarySaved spaceId={spaceId} />}
            {tab === "memory" && <LibraryMemoryTab spaceId={spaceId} />}
          </PageScroll>
        )}
      </div>
      )}
    </div>
  );
}

/** The first line a document says something on, for a row that has one line to say what it is
 *  about: markdown's own marks off, and an imported block's fence skipped. */
export function gistOf(doc: string): string {
  for (const raw of doc.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("<!--")) continue;
    return line.replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "");
  }
  return "";
}

/**
 * The Memory section: what every new session starts with, for every space of the window's profile.
 *
 * Reached from the rail, the Library is not one space's — its files already span the profile — so
 * its memory is the index of all of it. The profile's own document leads, under "Every space",
 * because it goes into each of them; then every space with its own, in the sidebar's order. The
 * space the page was opened from is open with its editor, which keeps the old page's one-click path;
 * the rest are a line each — name, size, first line — and open in place. A space's own page
 * (Overview › Memory) still edits that space's alone.
 *
 * Profiles stay separate: a window shows its own profile's spaces, as the sidebar beside it does.
 */
function LibraryMemoryTab({ spaceId }: { spaceId: string }) {
  const vantage = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const allSpaces = useApp((s) => s.spaces);
  const profiles = useApp((s) => s.profiles);
  const spaceMemory = useApp((s) => s.spaceMemory);
  const profileMemory = useApp((s) => s.profileMemory);
  const refreshMemory = useApp((s) => s.refreshMemory);
  const refreshProfileMemory = useApp((s) => s.refreshProfileMemory);
  const saveProfileMemoryDoc = useApp((s) => s.saveProfileMemoryDoc);
  const run = useApp((s) => s.run);
  const profileId = vantage?.profileId ?? null;
  const profile = profiles.find((p) => p.id === profileId) ?? null;
  const spaces = allSpaces.filter((x) => x.profileId === profileId);
  const [open, setOpen] = useState<string | null>(spaceId);
  const ids = spaces.map((x) => x.id).join(" ");
  useEffect(() => { for (const id of ids.split(" ")) if (id) run(() => refreshMemory(id)); }, [ids, refreshMemory, run]);
  useEffect(() => { if (profileId) run(() => refreshProfileMemory(profileId)); }, [profileId, refreshProfileMemory, run]);
  const own = profileId ? profileMemory[profileId] : undefined;
  return (
    <div className="form settings-panel memory-page">
      {/* Who reads it, from the channel table — the one sentence the page needs before anything. */}
      <p className="page-lede">
        Every new {memoryReaderNames()} session starts with {profile ? `${profile.name}'s` : "its profile's"} memory, then its own space's.
      </p>
      {profile && (
        <>
          <h3 className="settings-head">Every space</h3>
          <div className="settings-row scope-doc-row">
            {own ? (
              <MemoryDoc key={profile.id} label={`${profile.name} memory document`} doc={own.doc}
                lead={<span className="memory-doc-title"><Icon name="user" size={16} />{profile.name}</span>}
                onSave={(text) => saveProfileMemoryDoc(profile.id, text)}
                placeholder={`Durable context for every ${profile.name} space — conventions, links, standing instructions…`} />
            ) : <p className="env-empty">Loading…</p>}
          </div>
        </>
      )}
      <h3 className="settings-head">Each space</h3>
      <ul className="settings-list memory-spaces">
        {spaces.map((sp) => (
          <SpaceMemoryCard key={sp.id} spaceId={sp.id} memory={spaceMemory[sp.id]} open={open === sp.id} current={sp.id === spaceId}
            profileName={profile?.name ?? "the profile"} onToggle={() => setOpen((o) => (o === sp.id ? null : sp.id))} />
        ))}
      </ul>
    </div>
  );
}

const fmt = (n: number): string => n.toLocaleString("en-US");

/**
 * One space's memory in the index: a line while it is shut — the space, the first thing its document
 * says, and how long it is — and, open, the same document the space's own page edits, with the
 * space's three facts under it: whether the profile's memory goes in here (this space's override,
 * which never touches the profile document), the opt-in AGENTS.md, and where the file is kept.
 */
function SpaceMemoryCard({ spaceId, memory, open, current, profileName, onToggle }: {
  spaceId: string; memory: MemoryState | undefined; open: boolean; current: boolean; profileName: string; onToggle: () => void;
}) {
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const saveMemoryDoc = useApp((s) => s.saveMemoryDoc);
  if (!space) return null;
  const doc = memory?.doc ?? "";
  const empty = doc.trim() === "";
  const name = (
    <>
      <Icon name="chevronRight" size={12} className="memory-space-caret" />
      <SpaceIcon icon={space.icon} size={16} />
      <span className="memory-space-name">{space.name}</span>
      {current && <span className="memory-space-here">This space</span>}
    </>
  );
  if (!open) {
    return (
      <li className="settings-row memory-space">
        <button type="button" className="memory-space-head" aria-expanded={false} onClick={onToggle}>
          {name}
          <span className="memory-space-gist" data-empty={empty || undefined}>
            {memory === undefined ? "" : empty ? "Nothing written yet" : gistOf(doc)}
          </span>
          {!empty && <span className="memory-space-size">{fmt(doc.length)} characters</span>}
        </button>
      </li>
    );
  }
  return (
    <li className="settings-row scope-doc-row memory-space" data-open="">
      {memory === undefined ? <p className="env-empty">Loading…</p> : (
        <>
          <MemoryDoc key={space.id} label={`${space.name} memory document`} doc={memory.doc}
            lead={<button type="button" className="memory-space-head" aria-expanded onClick={onToggle}>{name}</button>}
            onSave={(text) => saveMemoryDoc(space.id, text)}
            placeholder="Conventions, links, standing instructions — anything you would otherwise retype at the start of every session." />
          <SpaceMemoryFacts spaceId={space.id} spaceName={space.name} memory={memory} profileName={profileName} />
        </>
      )}
    </li>
  );
}

function SpaceMemoryFacts({ spaceId, spaceName, memory, profileName }: { spaceId: string; spaceName: string; memory: MemoryState; profileName: string }) {
  const setProfileDocEnabled = useApp((s) => s.setProfileDocEnabled);
  const setAgentsFile = useApp((s) => s.setAgentsFile);
  const run = useApp((s) => s.run);
  const af = memory.agentsFile;
  const reveal = window.realm?.files?.reveal;
  return (
    <div className="memory-space-facts">
      {memory.profile && (
        <label className="memory-fact" title={`Defined for all of ${profileName} — this switch is ${spaceName}'s override, and leaves the document as it is.`}>
          <span className="memory-fact-label">{profileName}'s memory goes in here too</span>
          <input type="checkbox" role="switch" className="switch" aria-label={`${profileName} memory in ${spaceName}`}
            checked={memory.profile.enabledHere} onChange={(e) => run(() => setProfileDocEnabled(spaceId, e.target.checked))} />
        </label>
      )}
      {af.writable || af.enabled ? (
        <label className="memory-fact" title={af.path}>
          <span className="memory-fact-label">
            Also write AGENTS.md
            <span className="memory-fact-sub">Agents started from a terminal in this folder read it too{af.exists && !af.managedByRealm ? " — except this one, which Realm did not write" : ""}.</span>
          </span>
          <input type="checkbox" role="switch" className="switch" aria-label="Write AGENTS.md into the space folder"
            checked={af.enabled} onChange={(e) => run(() => setAgentsFile(spaceId, e.target.checked))} />
        </label>
      ) : (
        <p className="memory-fact"><span className="memory-fact-sub">No AGENTS.md here: {af.reason}.</span></p>
      )}
      <div className="memory-fact">
        <span className="memory-fact-label">Stored at <code className="env-path">{memory.path}</code></span>
        {reveal && <button type="button" className="btn-quiet" onClick={() => { void reveal(memory.path); }}>Show in Finder</button>}
      </div>
    </div>
  );
}
