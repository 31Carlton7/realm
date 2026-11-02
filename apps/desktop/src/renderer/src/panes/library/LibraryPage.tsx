import { PageScroll, useDissolve } from "../../components/ScrollFades";
import { Icon } from "@realm/ui";
import { useRef, useState } from "react";
import { useApp, type LibraryTab } from "../../state/store";
import { SkillsPanel } from "../../components/settings/SkillsPanel";
import { LibraryFiles, type LibraryFilesHandle } from "./LibraryFiles";
import { LibrarySaved } from "./LibrarySaved";
import { MemoryLibrary } from "./MemoryLibrary";
import { SkillViewer } from "./SkillViewer";
import type { PaneProps } from "../registry";
import { PageRail } from "../../components/page-nav";
import { useFileDrop } from "../../components/use-file-drop";

/* Files leads. Skills and memory are what you INSTALL into a space and change rarely; files are
   what the work produced, and they are the reason someone opens a Library at all. Saved is what the
   reader KEPT of the work, so it follows the files and comes before the installed things. */
const LIBRARY_TABS: readonly { id: LibraryTab; label: string; icon: string }[] = [
  { id: "files", label: "Files", icon: "artifact" }, { id: "saved", label: "Saved", icon: "saved" },
  { id: "skills", label: "Skills", icon: "sparkles" }, { id: "memory", label: "Memory", icon: "context" },
];

/**
 * The Library page — everything a space HAS, on the W3 page pattern (`.page` / `.page-head` /
 * `.page-rail` / `.page-content`).
 *
 * Four tabs, and Files and Saved are not like the other two. Skills are installable things grouped by
 * the scoping contract — "This space" / "From <profile>" / "Everywhere". Files are the OUTPUT of the
 * work: every file any session wrote or was given, across every space in the profile, read from the
 * server's `artifacts` index rather than folded out of transcripts (see LibraryFiles). Saved is what
 * the reader kept of it — every turn saved from a scroll track, across the same profile (see
 * LibrarySaved). Memory is every memory file an agent reads, Realm's and each agent's own, with the
 * places they are kept in the column under the sections (see MemoryLibrary).
 *
 * The vantage is `item.spaceId` — the space whose layout holds this pane, stamped at open time by
 * `openDestinationPage` (the item's refId is the kind's sentinel, PAGE_REF_IDS; there is no row behind
 * this page). Everything renders from THAT space's view, never "the active space", so a pane surviving
 * a space switch cannot silently regroup under another space's profile.
 *
 * The tab is the store's, per space, because Profile settings ▸ Memory lands the page on Memory.
 */
export function LibraryPage({ item }: PaneProps) {
  const spaceId = item.spaceId;
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  /* Files and Memory span every space of the profile, so the head names the profile; Skills is a
     scoped list seen from ONE space, so it names that space — the vantage is a fact about what the
     section shows, and the sections show different things. */
  const profileName = useApp((s) => s.profiles.find((p) => p.id === space?.profileId)?.name ?? "");
  const tab = useApp((s) => s.libraryTab[spaceId] ?? "files");
  const setLibraryTab = useApp((s) => s.setLibraryTab);
  const setTab = (next: LibraryTab) => setLibraryTab(spaceId, next);
  /* The memory source the Memory section is narrowed to; null is all of them, which is what the
     section's own row in the column shows — so the row is lit only then, and a click on it clears it. */
  const [memorySource, setMemorySource] = useState<string | null>(null);
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
  const pick = (next: LibraryTab) => {
    if (openSkill !== null) setLibrarySkill(spaceId, null);
    if (next === "memory") setMemorySource(null);
    setTab(next);
  };
  /* Files dropped anywhere on the page while it shows its files are added to the Library: the whole
     page is the target, as a whole pane is a session's, and its glow is inset from the page's own edge
     rather than drawn through the column of files. What to do with them is the column's. */
  const files = useRef<LibraryFilesHandle>(null);
  const drop = useFileDrop((dropped) => files.current?.drop(dropped));
  const takesFiles = openSkill === null && tab === "files";
  const rail = (
    <fieldset className="page-rail" ref={railStrip}>
      <legend className="visually-hidden">Library section</legend>
      {LIBRARY_TABS.map((t) => (
        <label key={t.id} className="settings-tab page-rail-tab" data-selected={(shown === t.id && !(t.id === "memory" && memorySource !== null)) || undefined}>
          {/* onClick as well as onChange: a radio that is already checked fires no change, and Skills
              is checked while a skill is open — clicking it is how the list comes back. Memory is
              checked while a source narrows it, and clicking it is how every source comes back. */}
          <input type="radio" name={`library-tab-${item.id}`} value={t.id} checked={shown === t.id}
            onChange={() => pick(t.id)} onClick={() => { if (openSkill !== null || (t.id === "memory" && memorySource !== null)) pick(t.id); }} />
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
      {/* The section it shows, as Settings' head names its page: "Library" is the pane bar's word, and
          the rail's lit button says where the page came from. */}
      <div className="page-title"><h1>{openName ?? LIBRARY_TABS.find((t) => t.id === shown)!.label}</h1></div>
      {/* The vantage, kept. It used to live in the sub-title paragraph, and that paragraph went —
          but WHICH space a scope-grouped page is seen from is a fact about what it is showing, not
          decoration, and it is the only place that fact appears. */}
      <span className="page-vantage">{shown === "skills" ? space.name : profileName}</span>
    </header>
  );

  return (
    <div className="page library-page-pane" {...(takesFiles ? drop.handlers : {})}>
      {openSkill !== null ? (
        <>
          {/* Reading a skill, the Library's sections stay in the sidebar, so the column does not change
              under it; in the page there is only the skill, with its own way back beside its name. */}
          <PageRail label="Library" title="Library" inline={false}>{rail}</PageRail>
          <SkillViewer spaceId={spaceId} id={openSkill} onBack={closeSkill} head={head} />
        </>
      ) : shown === "memory" ? (
        <MemoryLibrary spaceId={spaceId} rail={rail} source={memorySource} onSource={setMemorySource} />
      ) : (
      <div className="page-body">
        {/* In the sidebar's column, under the page's name, as Scheduled's and Code review's columns are
            under theirs; the head beside it names the section, so the two never say the same word. */}
        <PageRail label="Library" title="Library">{rail}</PageRail>
        {/* Files brings its own scroller, because its toolbar rides in it under the head; the others
            are reading columns. Both ends dissolve, but only when there is something under them — and
            only over the column: a band on the body would be drawn over the rail above it. */}
        {tab === "files" ? <LibraryFiles ref={files} spaceId={spaceId} head={head} /> : (
          <PageScroll>
            {head}
            {tab === "skills" && <SkillsPanel spaceId={spaceId} onOpen={(id) => setLibrarySkill(spaceId, id)} />}
            {tab === "saved" && <LibrarySaved spaceId={spaceId} />}
          </PageScroll>
        )}
      </div>
      )}
      {takesFiles && drop.dropping && (
        <div className="session-drop library-drop" aria-hidden="true">
          <span className="quick-chat-drop-label"><Icon name="add" size={14} />Drop to add to the Library</span>
        </div>
      )}
    </div>
  );
}
