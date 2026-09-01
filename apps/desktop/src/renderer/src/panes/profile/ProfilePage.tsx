import { MCP_SECRET_STORAGE_NOTE, MEMORY_DOC_MAX, type McpServer, type Skill } from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
import { useApp, type ProfilePageTab } from "../../state/store";
import { MoveScopeConfirm } from "../../components/scoped/ScopeGroups";
import { McpServerForm } from "../../components/sidebar/McpSection";
import { SpaceIcon } from "../../components/SpaceIcon";
import type { PaneProps } from "../registry";

const PROFILE_TABS: { id: ProfilePageTab; label: string }[] = [
  { id: "skills", label: "Skills" },
  { id: "connections", label: "Connections" },
  { id: "memory", label: "Memory" },
];

/** The one sentence every pre-scoping row carries here: these rows are governed per space, so the
 *  page points at where they are actually used instead of pretending to own them. */
const EVERYWHERE_NOTE = "Available in every space until someone moves it — manage it from a space page.";

/**
 * The profile PAGE (Plan 14 W2) — the defining-scope home W4-p12's "Edit in profile" affordances
 * pointed at, on W3's `.page` pattern. A `profile-page` destination item (sentinel refId,
 * `PAGE_REF_IDS`); the profile is derived LIVE from `item.spaceId`'s space — never stored — so a
 * space moved between profiles moves its page's subject with it, and the page can never keep editing
 * a profile its space has left (the named W2 mutant is the inverse: showing another profile's items).
 *
 * Each tab lists the profile's OWN items — defining scope = THIS profile — with the full editors and
 * no banner, because this page IS the defining scope the banners named. Pre-scoping ("Everywhere")
 * rows are listed read-only with a note pointing at their space of use; another profile's rows are
 * not listed at all. Demote ("Keep in one space…") pins an item to the VANTAGE space, per the W2-p12
 * semantics the shared confirm states.
 */
export function ProfilePage({ item }: PaneProps) {
  const spaceId = item.spaceId;
  const space = useApp((s) => s.spaces.find((x) => x.id === spaceId));
  const profile = useApp((s) => s.profiles.find((p) => p.id === space?.profileId));
  const spaces = useApp((s) => s.spaces);
  const selectSpace = useApp((s) => s.selectSpace);
  const tab = useApp((s) => (profile ? s.profilePageTab[profile.id] : undefined) ?? "skills");
  const setProfilePageTab = useApp((s) => s.setProfilePageTab);
  const run = useApp((s) => s.run);

  if (!space) return <div className="pane-placeholder muted">This page's space no longer exists.</div>;
  if (!profile) return <div className="pane-placeholder muted">This space's profile no longer exists.</div>;
  const profileSpaces = spaces.filter((sp) => sp.profileId === profile.id);

  return (
    <div className="page profile-page-pane">
      <header className="page-head">
        <span className="page-glyph"><Icon name={profile.icon} size={20} /></span>
        <div className="page-title">
          <h1>{profile.name}</h1>
          <span className="page-sub">Skills, connections and memory defined here reach every space of this profile.</span>
        </div>
      </header>
      {/* The profile's spaces as jump chips: the page's subject is a group of spaces, and each chip
          goes to one of them (the space switcher's own path — never a second navigation scheme). */}
      <div className="profile-spaces" aria-label={`Spaces of ${profile.name}`}>
        {profileSpaces.map((sp) => (
          <button key={sp.id} type="button" className="profile-chip" title={`Switch to ${sp.name}`}
            onClick={() => run(() => selectSpace(sp.id))}>
            <SpaceIcon icon={sp.icon} size={13} /> {sp.name}
          </button>
        ))}
      </div>
      <div className="page-body">
        <fieldset className="page-rail">
          <legend className="visually-hidden">Profile page section</legend>
          {PROFILE_TABS.map((t) => (
            <label key={t.id} className="settings-tab page-rail-tab" data-selected={tab === t.id || undefined}>
              <input type="radio" name={`profile-page-tab-${item.id}`} value={t.id} checked={tab === t.id} onChange={() => setProfilePageTab(profile.id, t.id)} />
              {t.label}
            </label>
          ))}
        </fieldset>
        <div className="page-content">
          {tab === "skills" && <ProfileSkillsTab spaceId={spaceId} profileId={profile.id} profileName={profile.name} spaceName={space.name} />}
          {tab === "connections" && <ProfileConnectionsTab spaceId={spaceId} profileId={profile.id} profileName={profile.name} spaceName={space.name} />}
          {tab === "memory" && <ProfileMemoryTab profileId={profile.id} profileName={profile.name} />}
        </div>
      </div>
    </div>
  );
}

/** Is this row the page's OWN? Strictly the page's profile — a row scoped to any OTHER profile is
 *  not shown here at all: rendering (or worse, editing) it would be the named W2 mutant. */
const ownedBy = (scope: Skill["scope"] | McpServer["scope"], profileId: string) =>
  scope.kind === "profile" && scope.profileId === profileId;
const isEverywhere = (scope: Skill["scope"] | McpServer["scope"]) =>
  scope.kind === "space" && scope.spaceId === null;

/**
 * The Skills tab: the profile's own skills, plus pre-scoping rows read-only. Skills have no editor at
 * any scope (a skill IS its directory — SkillsPanel's rule), so "full editor" here means the full
 * defining-scope affordance set: the row, and the demote move. Enablement stays per space — each
 * space's own Skills tab holds that switch — so no toggle pretends otherwise here.
 */
function ProfileSkillsTab({ spaceId, profileId, profileName, spaceName }: { spaceId: string; profileId: string; profileName: string; spaceName: string }) {
  const skills = useApp((s) => s.spaceSkills[spaceId]);
  const refreshSkills = useApp((s) => s.refreshSkills);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => refreshSkills(spaceId)); }, [spaceId, refreshSkills, run]);

  if (!skills) return <div className="form settings-panel"><p className="env-empty">Loading…</p></div>;
  const own = skills.filter((sk) => ownedBy(sk.scope, profileId));
  const everywhere = skills.filter((sk) => isEverywhere(sk.scope));

  return (
    <div className="form settings-panel">
      <p className="settings-note">Skills here are seen by every space of {profileName}. Each space keeps its own on/off switch, on its Skills tab.</p>
      <div className="field">
        <span>{profileName}'s skills</span>
        {own.length === 0
          ? <p className="env-empty">No skills are defined at this profile yet — move one here with "Move to profile…" on a space's Skills tab.</p>
          : <ul className="settings-list">{own.map((sk) => <ProfileSkillRow key={sk.id} spaceId={spaceId} skill={sk} profileName={profileName} spaceName={spaceName} />)}</ul>}
      </div>
      {everywhere.length > 0 && (
        <div className="field">
          <span>Everywhere</span>
          <p className="settings-hint">{EVERYWHERE_NOTE}</p>
          <ul className="settings-list">
            {everywhere.map((sk) => (
              <li key={sk.id} className="settings-row">
                <div className="settings-row-main">
                  <span className="settings-row-name">{sk.name}</span>
                  <span className="settings-row-desc">{sk.valid ? sk.description : sk.reason}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One of the profile's own skills: the row plus its demote move behind the shared confirm. */
function ProfileSkillRow({ spaceId, skill: sk, profileName, spaceName }: { spaceId: string; skill: Skill; profileName: string; spaceName: string }) {
  const demoteSkill = useApp((s) => s.demoteSkill);
  const run = useApp((s) => s.run);
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="settings-row" data-invalid={!sk.valid || undefined}>
      <div className="settings-row-main">
        <span className="settings-row-name">{sk.name}</span>
        {sk.valid
          ? <span className="settings-row-desc">{sk.description}</span>
          : <span className="settings-row-problem"><Icon name="alert" size={12} /> {sk.reason}</span>}
      </div>
      {sk.valid && !confirming && (
        <button type="button" className="btn-quiet scope-move" onClick={() => setConfirming(true)}>Keep in one space…</button>
      )}
      {confirming && (
        <MoveScopeConfirm direction="demote" name={sk.name} profileName={profileName} spaceName={spaceName}
          onCancel={() => setConfirming(false)}
          onConfirm={() => { setConfirming(false); run(() => demoteSkill(spaceId, sk.id)); }} />
      )}
    </li>
  );
}

/**
 * The Connections tab: the profile's own MCP servers with the FULL editor — the same McpServerForm,
 * worn without a banner, because this page is the defining scope the banner used to name — plus
 * pre-scoping rows read-only. Fetches through the same store slot McpSection uses (clear first, so a
 * stale space's rows never flash; the cleanup un-records the mounted panel).
 */
function ProfileConnectionsTab({ spaceId, profileId, profileName, spaceName }: { spaceId: string; profileId: string; profileName: string; spaceName: string }) {
  const servers = useApp((s) => s.mcpServers);
  const refreshMcpServers = useApp((s) => s.refreshMcpServers);
  const clearMcpServers = useApp((s) => s.clearMcpServers);
  const run = useApp((s) => s.run);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run/refreshMcpServers/clearMcpServers are stable store actions
  useEffect(() => {
    clearMcpServers(spaceId); run(() => refreshMcpServers(spaceId));
    return () => clearMcpServers(null);
  }, [spaceId]);

  const own = servers.filter((sv) => ownedBy(sv.scope, profileId));
  const everywhere = servers.filter((sv) => isEverywhere(sv.scope));

  return (
    <div className="form settings-panel">
      <div className="field">
        <span>{profileName}'s MCP servers</span>
        {own.length === 0
          ? <p className="env-empty">No servers are defined at this profile yet — move one here with "Move to profile…" on a space's Connections tab.</p>
          : <ul className="env-list">{own.map((sv) => <ProfileServerRow key={sv.id} spaceId={spaceId} server={sv} profileName={profileName} spaceName={spaceName} />)}</ul>}
      </div>
      {everywhere.length > 0 && (
        <div className="field">
          <span>Everywhere</span>
          <p className="settings-hint">{EVERYWHERE_NOTE}</p>
          <ul className="env-list">
            {everywhere.map((sv) => (
              <li key={sv.id} className="env-row mcp-row">
                <div className="env-main">
                  <span className="env-name">{sv.name}</span>
                  <span className="env-kind">{sv.transport}</span>
                </div>
                <div className="env-meta">
                  <code className="env-path">{(sv.transport === "stdio" ? [sv.command, ...sv.args].filter(Boolean).join(" ") : sv.url) || "(no endpoint set)"}</code>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="settings-note">{MCP_SECRET_STORAGE_NOTE}</p>
    </div>
  );
}

/** One of the profile's own servers: full edit (no banner — this IS the defining scope), removal with
 *  its reach named, and the demote move. Enablement is per space and lives on space pages. */
function ProfileServerRow({ spaceId, server, profileName, spaceName }: { spaceId: string; server: McpServer; profileName: string; spaceName: string }) {
  const demoteMcpServer = useApp((s) => s.demoteMcpServer);
  const removeMcpServer = useApp((s) => s.removeMcpServer);
  const run = useApp((s) => s.run);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmMove, setConfirmMove] = useState(false);
  const endpoint = server.transport === "stdio" ? [server.command, ...server.args].filter(Boolean).join(" ") : server.url;
  return (
    <li className="env-row mcp-row">
      <div className="env-main">
        <span className="env-name">{server.name}</span>
        <span className="env-kind">{server.transport}</span>
      </div>
      <div className="env-meta">
        <code className="env-path">{endpoint || "(no endpoint set)"}</code>
      </div>
      <div className="env-actions">
        <button type="button" className="btn-quiet" onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Edit"}</button>
        {!confirmMove && (
          <button type="button" className="btn-quiet" onClick={() => setConfirmMove(true)}>Keep in one space…</button>
        )}
        {confirmDelete
          ? <>
              <span className="muted">Removes it for every space of {profileName}.</span>
              <button type="button" className="btn-quiet" onClick={() => setConfirmDelete(false)}>Cancel</button>
              <button type="button" className="btn-quiet danger" onClick={() => run(() => removeMcpServer(server.id))}>Remove</button>
            </>
          : <button type="button" className="btn-quiet" onClick={() => setConfirmDelete(true)}>Remove…</button>}
      </div>
      {confirmMove && (
        <MoveScopeConfirm direction="demote" name={server.name} profileName={profileName} spaceName={spaceName}
          onCancel={() => setConfirmMove(false)}
          onConfirm={() => { setConfirmMove(false); run(() => demoteMcpServer(spaceId, server.id)); }} />
      )}
      {editing && <McpServerForm spaceId={spaceId} server={server} onDone={() => setEditing(false)} />}
    </li>
  );
}

const fmt = (n: number): string => n.toLocaleString("en-US");

/**
 * The Memory tab: the profile document at its defining scope, edited in full — no banner, because
 * this page IS the scope the Library's banner editor named. The reach is still SAID (a save lands in
 * every space of the profile), just as page copy rather than a warning about being somewhere else.
 * Cap posture is MemoryPanel's: over MEMORY_DOC_MAX the save is refused with the overage named.
 */
function ProfileMemoryTab({ profileId, profileName }: { profileId: string; profileName: string }) {
  const stored = useApp((s) => s.profileMemory[profileId]);
  const refreshProfileMemory = useApp((s) => s.refreshProfileMemory);
  const saveProfileMemoryDoc = useApp((s) => s.saveProfileMemoryDoc);
  const run = useApp((s) => s.run);
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { run(() => refreshProfileMemory(profileId)); }, [profileId, refreshProfileMemory, run]);
  useEffect(() => { setDraft(null); }, [profileId]);

  if (!stored) return <div className="form settings-panel"><p className="env-empty">Loading…</p></div>;
  const text = draft ?? stored.doc;
  const over = text.length - MEMORY_DOC_MAX;
  const dirty = draft !== null && draft !== stored.doc;

  return (
    <div className="form settings-panel">
      <div className="field">
        <span>{profileName} memory</span>
        <p className="settings-hint">Travels into every new session in every space of {profileName}, injected before each space's own memory. Stored at <code className="env-path">{stored.path}</code>.</p>
        <textarea className="memory-doc" aria-label={`${profileName} memory document`} value={text} rows={10} spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={`Durable context for every ${profileName} space — conventions, links, standing instructions…`} />
        <div className="memory-meta">
          <span className="settings-hint" data-tone={over > 0 ? "danger" : undefined}>
            {fmt(text.length)} / {fmt(MEMORY_DOC_MAX)}
            {over > 0 && ` — over the cap by ${fmt(over)} characters. Trim it down; Realm will not truncate it.`}
          </span>
          <button type="button" className="btn primary" disabled={!dirty || over > 0}
            onClick={() => run(async () => { await saveProfileMemoryDoc(profileId, text); setDraft(null); })}>Save memory</button>
        </div>
      </div>
    </div>
  );
}
