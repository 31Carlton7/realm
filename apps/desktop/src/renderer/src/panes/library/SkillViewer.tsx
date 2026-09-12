import { AGENT_META, SELECTABLE_AGENT_KINDS, AGENT_SKILL_SUPPORT, formatAttachmentSize, type SkillDetail, type SkillResource } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ScrollFades } from "../../components/ScrollFades";
import { Menu } from "../../components/Menu";
import { MoveScopeConfirm } from "../../components/scoped/ScopeGroups";
import { Markdown } from "../session/Markdown";
import { useApp } from "../../state/store";

/**
 * One skill, read.
 *
 * A skill is a DOCUMENT — someone wrote it to be read, and the list row shows two lines of it. Every
 * other surface in the app that shows a skill (the panel row, the mention picker, search) shows the
 * frontmatter and nothing else, so the thing an agent is actually handed has never been visible
 * anywhere in Realm. This is that page: the prose, the files bundled beside it, and the two facts a
 * reader needs about it — where it lives and whether this space passes it on.
 *
 * It is a PAGE rather than a sheet, and that follows from what it holds. A sheet is 420px of decision;
 * a `SKILL.md` is five hundred lines of reference material with fenced code in it, and design.md's rule
 * for reading work is the available pane, not a centred card. It replaces the Library's list in place
 * (the same pane, the same head, the rail carrying the document's own headings instead of the tabs)
 * so opening a skill costs no pane and closing one loses no scroll position.
 *
 * The document is rendered by the transcript's own `Markdown` — one markdown treatment in the app,
 * fenced code and callouts included. A second renderer here would be a fork of the one thing worth
 * reusing.
 */
export function SkillViewer({ spaceId, id, onBack }: { spaceId: string; id: string; onBack: () => void }) {
  const readSkill = useApp((s) => s.readSkill);
  const run = useApp((s) => s.run);
  const skillsChangedAt = useApp((s) => s.spaceSkills[spaceId]);
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  /* Re-read whenever this space's library answers again — a toggle flipped from the header, a
     promote, or a `skills.changed` broadcast. The row inside the detail carries `enabled` and
     `scope`, so a viewer that never re-read would go on showing the state the page opened on. */
  useEffect(() => {
    let live = true;
    run(async () => {
      try {
        const d = await readSkill(spaceId, id);
        if (live) { setDetail(d); setFailed(false); }
      } catch { if (live) setFailed(true); }
    });
    return () => { live = false; };
  }, [spaceId, id, readSkill, run, skillsChangedAt]);

  const headings = useHeadings(detail?.body ?? "", scroller);

  if (failed) {
    return (
      <div className="page-body">
        <div className="page-scroll"><div className="page-content" ref={scroller}>
          <p className="env-empty">This skill is no longer in this space's library.</p>
          <button type="button" className="btn btn-quiet" onClick={onBack}>Back to skills</button>
        </div></div>
      </div>
    );
  }

  return (
    <div className="page-body">
      {/* The document's own headings, in the column the tab rail was in. Same width, same metrics, so
          the head above it and the column beside it do not move when a skill opens — the page stays
          the page and only its contents change. Absent for a document with no headings, rather than
          an empty rail claiming a structure the skill does not have. */}
      {headings.length > 1 && (
        <nav className="page-rail skill-toc" aria-label="Sections of this skill">
          {headings.map((h) => (
            <a key={h.id} className="settings-tab page-rail-tab skill-toc-link" href={`#${h.id}`}
              data-level={h.level} data-selected={h.active || undefined}
              onClick={(e) => { e.preventDefault(); document.getElementById(h.id)?.scrollIntoView({ block: "start", behavior: "smooth" }); }}>
              {h.text}
            </a>
          ))}
        </nav>
      )}
      <div className="page-scroll">
        <ScrollFades scroller={scroller} />
        <div className="page-content" ref={scroller}>
          {detail === null ? <p className="env-empty">Loading…</p> : (
            <article className="skill-view">
              <SkillHeader spaceId={spaceId} detail={detail} />
              {detail.skill.valid
                ? <Markdown text={detail.body} className="skill-doc skill-body" />
                : <p className="settings-row-problem"><Icon name="alert" size={12} /> {detail.skill.reason}</p>}
              {detail.truncated && (
                <p className="settings-hint">This file is longer than Realm will render. Open it in Finder to read the rest.</p>
              )}
              {detail.resources.length > 0 && <SkillResources spaceId={spaceId} id={id} resources={detail.resources} />}
            </article>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * What the reader needs to know about the skill before the prose starts: what it is for, whether this
 * space hands it to its agents, and where it lives.
 *
 * The description is at reading weight here — it is clamped to two lines in the list on purpose, and
 * this is the surface where the clamp comes off. The switch is the SAME control the row carries, on
 * the same per-space semantics, because a skill has one on/off and it must not be reachable two ways
 * that could drift.
 */
function SkillHeader({ spaceId, detail }: { spaceId: string; detail: SkillDetail }) {
  const sk = detail.skill;
  const profiles = useApp((s) => s.profiles);
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const setSkillEnabled = useApp((s) => s.setSkillEnabled);
  const promoteSkill = useApp((s) => s.promoteSkill);
  const demoteSkill = useApp((s) => s.demoteSkill);
  const run = useApp((s) => s.run);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);

  const inherited = sk.scope.kind === "profile";
  const profileId = sk.scope.kind === "profile" ? sk.scope.profileId : space?.profileId;
  const profileName = profiles.find((p) => p.id === profileId)?.name ?? "profile";
  const dir = sk.path.replace(/\/SKILL\.md$/, "");

  /* The frontmatter keys Realm does NOT read, which is exactly why they are worth showing here: a
     `license`, a `version`, an `allowed-tools` list is something the author wrote for a reader, and
     the app has nowhere else that ever displays one. Realm's own two are already the title and the
     paragraph above, so repeating them would be the page restating itself. */
  const extras = Object.entries(detail.frontmatter).filter(([k]) => k !== "name" && k !== "description");
  const injected = SELECTABLE_AGENT_KINDS.filter((k) => AGENT_SKILL_SUPPORT[k] === "injected");

  return (
    <header className="skill-head">
      <p className="skill-head-desc">{sk.description || "This skill's frontmatter carries no description."}</p>
      <div className="skill-head-controls">
        {/* Invalid skills carry no toggle, for the reason the row states: they are never handed to an
            agent whatever the flag says, and a switch that does nothing would claim otherwise. */}
        {sk.valid && (
          <label className="skill-head-switch">
            <input type="checkbox" role="switch" className="switch" aria-label={`Skill ${sk.name} in this space`}
              title={inherited ? `Defined in ${profileName} — this switch is this space's override.` : undefined}
              checked={sk.enabled} onChange={(e) => run(() => setSkillEnabled(spaceId, sk.id, e.target.checked))} />
            {sk.enabled ? "On in this space" : "Off in this space"}
          </label>
        )}
        <button type="button" className="btn btn-quiet" onClick={() => void window.realm?.files?.reveal?.(dir)}>
          <Icon name="folder" size={14} /> Show in Finder
        </button>
        {sk.valid && (
          <button ref={menuBtn} type="button" className="icon-btn" aria-haspopup="menu" aria-expanded={menuOpen}
            aria-label={`More for ${sk.name}`} onClick={() => setMenuOpen((v) => !v)}>
            <Icon name="more" size={14} />
          </button>
        )}
      </div>

      {/* The facts, in one block. Each is a phrase whose own words say which it is, and they FLOW —
          only the path takes a row of its own, because a path is the one value here of unbounded
          length. Given a row each they were five rows of raised surface between the description and
          the document, which is a claim on room they had nothing to put in.

          The author's own frontmatter keys sit in the same grid rather than in a section under it:
          `license` and `allowed-tools` are facts about the skill exactly as its origin is, and the
          only thing separating them was which of the two Realm happens to read. */}
      <dl className="skill-facts">
        <div><dt>Found in</dt><dd>{sk.origin.label}</dd></div>
        <div><dt>Defined</dt><dd>{sk.scope.kind === "profile" ? `In ${profileName}, inherited here` : sk.scope.spaceId === null ? "Everywhere" : "In this space"}</dd></div>
        <div><dt>Mention as</dt><dd><code className="env-path">@{sk.id}</code></dd></div>
        {/* Which agents are actually GIVEN it — a fact about the switch above, and the reason the
            switch can be on in a space where nothing will ever see the skill. The marks alone said
            nothing: two logos under a panel read as decoration until something names them. */}
        {sk.valid && (
          <div>
            <dt>Given to</dt>
            <dd className="skill-fact-agents">
              {injected.length === 0
                ? "No agent Realm can start takes a skills directory."
                : injected.map((k) => (
                  <span key={k} className="skill-head-agent">
                    <Icon name={AGENT_META[k].icon} size={12} colored /> {AGENT_META[k].label}
                  </span>
                ))}
            </dd>
          </div>
        )}
        {extras.map(([k, v]) => (
          <div key={k}><dt>{k}</dt><dd>{v}</dd></div>
        ))}
        <div className="skill-facts-wide"><dt>On disk</dt><dd><code className="env-path" title={sk.path}>{sk.path}</code></dd></div>
      </dl>

      {menuOpen && (
        <Menu anchorRef={menuBtn} align="right" label={`Actions for ${sk.name}`} onClose={() => setMenuOpen(false)}
          items={[{
            label: inherited ? "Move to this space…" : "Move to profile…",
            onSelect: () => setConfirming(true),
          }]} />
      )}
      {confirming && (
        <MoveScopeConfirm direction={inherited ? "demote" : "promote"} name={sk.name} profileName={profileName}
          onCancel={() => setConfirming(false)}
          onConfirm={() => { setConfirming(false); run(() => (inherited ? demoteSkill : promoteSkill)(spaceId, sk.id)); }} />
      )}
    </header>
  );
}

/**
 * The files bundled beside the `SKILL.md` — the half of a skill that has never been visible in Realm.
 *
 * A skill's own prose keeps pointing at these ("see `references/palette.md`", "run
 * `scripts/render.py`"), so a viewer that shows the document without them shows half the skill. Each
 * opens in place rather than in a pane: they are read in the course of reading the document above,
 * and a pane per reference file would be a pane per footnote.
 *
 * A file Realm will not show is still LISTED, with its size. "What else is in here" is the question,
 * and omitting the font, the image and the wheel answers it wrongly.
 */
function SkillResources({ spaceId, id, resources }: { spaceId: string; id: string; resources: SkillResource[] }) {
  return (
    <section className="skill-files">
      <h2 className="skill-files-head">Files in this skill</h2>
      <ul className="settings-list">
        {resources.map((r) => <SkillResourceRow key={r.rel} spaceId={spaceId} id={id} resource={r} />)}
      </ul>
    </section>
  );
}

function SkillResourceRow({ spaceId, id, resource }: { spaceId: string; id: string; resource: SkillResource }) {
  const readSkillFile = useApp((s) => s.readSkillFile);
  const run = useApp((s) => s.run);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || text !== null) return;
    run(async () => {
      const got = await readSkillFile(spaceId, id, resource.rel);
      setText(got.truncated ? `${got.text}\n\n…cut here. Open the file in Finder to read the rest.` : got.text);
    });
  };

  /* Rendered THROUGH the markdown renderer rather than beside it: a `.md` reference is markdown, and
     everything else is a fenced block in its own language, which is how it picks up the app's one
     highlighter, its one code panel and its one copy button. A second code viewer here would be a
     fork of the thing that already works in every transcript. */
  const ext = resource.rel.split(".").pop() ?? "";
  const isMarkdown = ext === "md" || ext === "markdown";
  const rendered = text === null ? "" : isMarkdown ? text : `\`\`\`${ext}\n${text}\n\`\`\``;

  return (
    <li className="settings-row skill-file-row">
      <div className="settings-row-main">
        {resource.readable ? (
          <button type="button" className="skill-file-name" aria-expanded={open} onClick={toggle}>
            <Icon name="chevronRight" size={12} className="skill-file-caret" />
            <code>{resource.rel}</code>
          </button>
        ) : (
          <span className="skill-file-name" data-inert=""><code>{resource.rel}</code></span>
        )}
        <span className="settings-row-desc">{formatAttachmentSize(resource.size)}{resource.readable ? "" : " · not text Realm can show"}</span>
      </div>
      {open && (
        <div className="skill-file-body">
          {text === null ? <p className="env-empty">Loading…</p> : <Markdown text={rendered} className="skill-doc" />}
        </div>
      )}
    </li>
  );
}

/** One heading of the rendered document: the anchor the rail links to, and whether it is the section
 *  the reader is in. */
type Heading = { id: string; text: string; level: number; active: boolean };

/** `Design tokens & color` → `design-tokens-color`. Deduped by the caller, which is what keeps two
 *  sections called "Examples" from both answering the first link. */
const slugify = (text: string): string =>
  text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "section";

/**
 * The document's own headings, read off the RENDERED markup rather than parsed out of the source.
 *
 * The alternative — a second regex pass over the markdown — has to know what the renderer knows: that
 * a `#` inside a fenced block is not a heading, that setext underlines are, that the app's own
 * extensions have had their turn first. One of those two readers would eventually be wrong about a
 * skill, and it would be this one. Walking the DOM the renderer produced cannot disagree with it.
 *
 * The ids are assigned here for the same reason: `Markdown` writes plain `<h2>`s, and an anchor has
 * to exist before anything can link to it.
 */
function useHeadings(body: string, scroller: React.RefObject<HTMLElement | null>): Heading[] {
  const [found, setFound] = useState<Omit<Heading, "active">[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Layout effect: `Markdown` writes its markup in one of its own, and a heading list read before
  // that lands would be empty on every first paint.
  useLayoutEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const seen = new Set<string>();
    const out: Omit<Heading, "active">[] = [];
    /* `.skill-body` and not `.skill-doc`: a bundled reference file is rendered by the same component
       with the same prose class, and querying that would fold `references/verbs.md`'s own headings
       into the skill's contents the moment someone expanded it. */
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(".skill-body h1, .skill-body h2"))) {
      const text = (el.textContent ?? "").trim();
      if (!text) continue;
      let id = slugify(text);
      for (let n = 2; seen.has(id); n++) id = `${slugify(text)}-${n}`;
      seen.add(id);
      el.id = id;
      out.push({ id, text, level: el.tagName === "H1" ? 1 : 2 });
    }
    setFound((prev) => (prev.length === out.length && prev.every((h, i) => h.id === out[i]!.id) ? prev : out));
  }, [body, scroller]);

  /* Which section the reader is in: the last heading whose top is at or above the column's own top,
     which is the question a table of contents is asking. An IntersectionObserver answers a different
     one — "is this heading on screen" — and a section longer than the viewport has no heading on
     screen at all, so the rail would go blank in the middle of the longest sections. */
  useEffect(() => {
    const root = scroller.current;
    if (!root || found.length === 0) return;
    const measure = () => {
      /* At the END of the scroller the rule above stops being true: the last sections are all on
         screen at once and none of them has passed the top, so the rail would keep pointing at a
         section the reader has scrolled clear of and can no longer reach. There is nowhere further
         to go, so the last heading is where they are. */
      if (root.scrollHeight - root.clientHeight - root.scrollTop <= 2) { setActiveId(found[found.length - 1]!.id); return; }
      const top = root.getBoundingClientRect().top + 8;
      let current = found[0]!.id;
      for (const h of found) {
        const el = document.getElementById(h.id);
        if (el && el.getBoundingClientRect().top <= top) current = h.id;
      }
      setActiveId(current);
    };
    measure();
    root.addEventListener("scroll", measure, { passive: true });
    return () => root.removeEventListener("scroll", measure);
  }, [found, scroller]);

  return useMemo(() => found.map((h) => ({ ...h, active: h.id === activeId })), [found, activeId]);
}
