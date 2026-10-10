import { AGENT_META, MCP_SECRET_STORAGE_NOTE, SPACE_COLORS, tildePath, type AgentAccount, type AgentSignIn, type ClaudeDir, type McpServer, type Profile, type Skill } from "@realm/contracts";
import { Icon, type IconName } from "@realm/ui";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useApp, type AgentProbe, type ProfilePageTab, type ProfileUsage } from "../../state/store";
import { AgentSignInSteps, runningSignIn } from "../../components/AgentSignInSteps";
import { MoveScopeConfirm } from "../../components/scoped/ScopeGroups";
import { McpServerForm } from "../../components/sidebar/McpSection";
import { IconPicker } from "../../components/IconPicker";
import { SpaceIcon } from "../../components/SpaceIcon";
import type { PaneProps } from "../registry";
import { PageRail } from "../../components/page-nav";
import { PageScroll, useDissolve } from "../../components/ScrollFades";
import { MemoryDoc } from "../../components/settings/MemoryDoc";
import { accountTitle } from "../session/Composer";

const HEX = /^#[0-9a-f]{6}$/i;

const PROFILE_TABS: { id: ProfilePageTab; label: string; icon: IconName }[] = [
  { id: "general", label: "General", icon: "settings" },
  { id: "skills", label: "Skills", icon: "sparkles" },
  { id: "connections", label: "Connections", icon: "plug" },
  { id: "memory", label: "Memory", icon: "context" },
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
  const tab = useApp((s) => (profile ? s.profilePageTab[profile.id] : undefined) ?? "general");
  const setProfilePageTab = useApp((s) => s.setProfilePageTab);
  const navigateInPane = useApp((s) => s.navigateInPane); // tabs are stops on the pane's trail
  const railStrip = useRef<HTMLDivElement>(null);
  useDissolve(railStrip, "x");

  const run = useApp((s) => s.run);

  if (!space) return <div className="pane-placeholder muted">This page's space no longer exists.</div>;
  if (!profile) return <div className="pane-placeholder muted">This space's profile no longer exists.</div>;
  const profileSpaces = spaces.filter((sp) => sp.profileId === profile.id);

  return (
    <div className="page profile-page-pane">
      <div className="page-body">
        {/* Two lists, one rail. The page's sections and the profile's spaces are both "where this
            page can take you", and as a chip strip above the head the spaces were a third band that
            read as decoration over the title rather than as navigation beside it. Separate columns
            rather than one, so the gap between them can say "different kind of thing" while the rows
            inside each keep the rail's own rhythm. */}
        <PageRail label="Profile" back>
        <div className="page-rail" ref={railStrip}>
          <fieldset className="page-rail-list">
            <legend className="visually-hidden">Profile page section</legend>
            {PROFILE_TABS.map((t) => (
              <label key={t.id} className="settings-tab page-rail-tab" data-selected={tab === t.id || undefined}>
                <input type="radio" name={`profile-page-tab-${item.id}`} value={t.id} checked={tab === t.id} onChange={() => { setProfilePageTab(profile.id, t.id); navigateInPane(item.id, t.id); }} />
                <Icon name={t.icon} size={16} className="page-rail-glyph" />
                {t.label}
              </label>
            ))}
          </fieldset>
          {/* Buttons, not radios: a space is somewhere to GO, and the tabs above are a choice of what
              this page shows. Wearing the tabs' look would promise the rail keeps one of them lit. */}
          {profileSpaces.length > 0 && (
            <nav className="page-rail-list" aria-label={`Spaces of ${profile.name}`}>
              <span className="page-rail-head">Spaces</span>
              {profileSpaces.map((sp) => (
                <button key={sp.id} type="button" className="settings-tab page-rail-tab page-rail-space"
                  title={`Switch to ${sp.name}`} onClick={() => run(() => selectSpace(sp.id))}>
                  <SpaceIcon icon={sp.icon} size={14} />
                  <span className="page-rail-space-name">{sp.name}</span>
                </button>
              ))}
            </nav>
          )}
        </div>
        </PageRail>
        <PageScroll>
          <header className="page-head">
            <div className="page-title"><h1>{profile.name}</h1></div>
          </header>
          {tab === "general" && <ProfileGeneralTab profile={profile} />}
          {tab === "skills" && <ProfileSkillsTab spaceId={spaceId} profileId={profile.id} profileName={profile.name} spaceName={space.name} />}
          {tab === "connections" && <ProfileConnectionsTab spaceId={spaceId} profileId={profile.id} profileName={profile.name} spaceName={space.name} />}
          {tab === "memory" && <ProfileMemoryTab profileId={profile.id} profileName={profile.name} />}
        </PageScroll>
      </div>
    </div>
  );
}

/**
 * The General tab (Plan 27 Phase 2): the profile's name, icon and colour, and deleting it. A profile is
 * an identity now — its own spaces, browser cookies, saved sign-ins and passkeys — so this is where it
 * is edited, as a space is on its own page.
 *
 * The Claude config folder its sessions sign in from is named here as well, between the colour and
 * the delete. That field is keyed by the profile, so neither a half-typed path nor an account
 * follows the page from one profile to the next.
 */
function ProfileGeneralTab({ profile }: { profile: Profile }) {
  const renameProfile = useApp((s) => s.renameProfile);
  const updateProfile = useApp((s) => s.updateProfile);
  const recolourProfile = useApp((s) => s.recolourProfile);
  const run = useApp((s) => s.run);
  const [name, setName] = useState(profile.name);
  const [hex, setHex] = useState(profile.color);
  useEffect(() => { setName(profile.name); }, [profile.name]);
  useEffect(() => { setHex(profile.color); }, [profile.color]);
  const commitName = () => {
    const n = name.trim();
    if (n && n !== profile.name) run(() => renameProfile(profile.id, n));
    else setName(profile.name);
  };
  const commitHex = (v: string) => {
    const h = v.trim().toLowerCase();
    setHex(h);
    if (HEX.test(h) && h !== profile.color) run(() => recolourProfile(profile.id, h));
  };
  return (
    <div className="form">
      <label className="field"><span>Name</span>
        <input aria-label="Profile name" value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName}
          onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
      </label>
      <div className="field"><span>Icon</span>
        <IconPicker icon={profile.icon} profileId={profile.id} onPick={(icon) => run(() => updateProfile({ id: profile.id, icon }))} />
      </div>
      <div className="field"><span>Colour</span>
        <div className="swatches" role="radiogroup" aria-label="Colour">
          {SPACE_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={profile.color === c} aria-label={`Colour ${c}`} className="swatch"
              data-selected={profile.color === c || undefined} style={{ background: c }} onClick={() => commitHex(c)} />
          ))}
          <input aria-label="Custom colour" className="hex" value={hex} onChange={(e) => commitHex(e.target.value)} placeholder="#rrggbb" spellCheck={false} />
        </div>
      </div>
      <ClaudeFolderField key={profile.id} profile={profile} />
      <DeleteProfile profile={profile} />
    </div>
  );
}

/** What the page says where Claude's row for a folder does not say whether it is signed in. */
const CANT_TELL = "Realm can't tell whether this folder is signed in.";

/** What Sign in says in its tooltip while a Claude sign-in runs for another folder. The server
 *  keeps one unfinished sign-in for each agent, whichever folder it lands in, so starting one here
 *  ends that one, and its page in the browser then leads nowhere. */
const STOPS_ANOTHER_SIGN_IN = "Starting this sign-in stops the Claude sign-in that is running for another folder.";

/**
 * What the General tab says about the sign-in of a profile's Claude config folder.
 *
 * - `checking`: nothing has answered for this folder yet.
 * - `missing`: the named folder is not on disk. No session starts under it, and Claude Code makes a
 *   folder it is pointed at and does not find, so a sign-in there would make the folder Realm says
 *   it never makes. No Sign in is offered.
 * - `override`: a variable in Realm's own environment outranks every folder's sign-in. Signing the
 *   folder in would change nothing a session uses, so no Sign in is offered here either.
 * - `signed-in` and `signed-out`: what the folder's own probe said.
 * - `unknown`: Claude Code is not installed, or could not say. `says` is its own reason where it
 *   gave one.
 */
type FolderSignIn =
  | { state: "checking" | "missing" | "signed-out" }
  | { state: "override"; variable: string }
  | { state: "signed-in" | "unknown"; says: string };

/**
 * "Signed in as EMAIL (PLAN, ORG)." for the account a folder is signed in as.
 *
 * Cut from the account chip's own sentence (`accountTitle`) and not written again, so the two agree
 * on the bracket: the plan as the chip names it, and the organisation only where it says more than
 * the email does. A second copy of that rule is the copy that falls behind. If the chip's sentence
 * ever opens another way it is shown whole, which is still true of the folder.
 */
function signedInAs(account: AgentAccount): string {
  const said = accountTitle("claude", account, undefined);
  const lead = `${AGENT_META.claude.label} is signed in as `;
  return said.startsWith(lead) ? `Signed in as ${said.slice(lead.length)}` : said;
}

/**
 * The sign-in state of a folder, from the folder's own answer and Claude's row for it.
 *
 * The folder's answer is read first. The server runs nothing under a missing folder and reports it
 * signed out, and an API key in Realm's environment does not show in the CLI's own status, so in
 * both cases the row alone would offer a Sign in that cannot help. A row for a CLI that is not
 * installed is read before its sign-in for the same reason: there is nothing there to sign in to.
 *
 * A folder is missing where either says so: its own answer, or the row (`homeMissing`). The answer
 * is read when the profiles are and the row each time the tab is shown, so the row is the first to
 * say that a folder went while the page was away. The server refuses a sign-in there, and a line
 * that offered one would be offering a press that ends in a toast.
 */
function folderSignIn(folder: ClaudeDir | undefined, row: AgentProbe | null | undefined): FolderSignIn {
  if (folder?.missing || row?.homeMissing) return { state: "missing" };
  if (folder?.override) return { state: "override", variable: folder.override };
  if (row === undefined) return { state: "checking" };
  if (row === null || !row.available || row.loggedIn === null) return { state: "unknown", says: row?.reason || CANT_TELL };
  if (!row.loggedIn) return { state: "signed-out" };
  return { state: "signed-in", says: row.account ? signedInAs(row.account) : "Signed in." };
}

/** The sentence for a sign-in state. The variable is set in mono: it is a name a person goes and
 *  looks for, in their shell's own files. */
function signInSentence(signIn: FolderSignIn, profileName: string): ReactNode {
  switch (signIn.state) {
    case "checking": return "Checking…";
    case "missing": return `This folder is missing. Claude sessions in ${profileName}'s spaces can't start until you choose a folder or use the default.`;
    case "override": return <>Realm's environment sets <code className="env-path">{signIn.variable}</code>, which Claude uses instead of this folder's sign-in.</>;
    case "signed-out": return "Not signed in.";
    default: return signIn.says;
  }
}

/**
 * Claude's row for a profile's config folder, the way to ask for it again, and the way to let go of
 * the one held.
 *
 * Asked as the tab is shown and again whenever the folder's answer changes, from what the server
 * last learned (`ask(false)`). It is not asked before the folder is known: the row is a fact about
 * a folder, and until then the page names none.
 *
 * An answer is kept only while it is about the profile on the page, the folder, and whether that
 * folder is on disk. The page follows its space to another profile, and a profile can be named
 * another folder while an answer is on its way; either answer landing late would put one account
 * under another folder's path. And the row held for a folder that is missing is the server's
 * stand-in for one, since Claude Code is asked nothing about a folder that is not there: kept once
 * the folder is back, it would speak for a folder nothing had looked at yet. So the row reads as
 * not answered from the moment any of the three changes, and an answer for what the page has left
 * is let go.
 *
 * `forget` lets the held row go while all three stand, for a page that knows the row is out of
 * date: a sign-in it watched has finished since the row was read. The row then reads as not
 * answered until the next answer lands.
 *
 * A fresh ask (`ask(true)`) that fails, or answers no row, leaves what was held: it is made when a
 * sign-in may have finished, and a lost call says nothing about that. Where nothing is held, as
 * after `forget`, it answers null as an ordinary ask that fails does, which the page reads as not
 * being able to tell. Left unanswered, the line would wait on a reply that is not coming.
 */
function useFolderRow(profileId: string, folder: ClaudeDir | undefined): { row: AgentProbe | null | undefined; ask: (force: boolean) => void; forget: () => void } {
  const probeProfileClaude = useApp((s) => s.probeProfileClaude);
  const about = folder ? `${profileId}\n${folder.inForce}\n${folder.missing}` : null;
  const wanted = useRef<string | null>(null);
  const [answer, setAnswer] = useState<{ about: string; row: AgentProbe | null } | null>(null);
  useEffect(() => {
    wanted.current = about;
    return () => { wanted.current = null; };
  }, [about]);
  const ask = useCallback((force: boolean) => {
    if (about === null) return;
    const land = (row: AgentProbe | null) => {
      if (wanted.current !== about) return;
      setAnswer((held) => (force && row === null && held?.about === about ? held : { about, row }));
    };
    void probeProfileClaude(profileId, force).then(land, () => land(null));
  }, [about, profileId, probeProfileClaude]);
  const forget = useCallback(() => setAnswer(null), []);
  useEffect(() => { ask(false); }, [ask, folder?.dir, folder?.missing, folder?.override]);
  return { row: answer !== null && answer.about === about ? answer.row : undefined, ask, forget };
}

/**
 * The folder that holds `path`, which is where the folder dialog opens: the folders a person
 * chooses between sit side by side there. A path with no folder over it is answered the root.
 */
function parentFolder(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : "/";
}

/**
 * The space-less Claude sign-in the window holds, where it is this folder's: the one that lands in
 * the folder the profile names, or in the default folder where the profile names none
 * (`AgentSignIn.home`). A sign-in started for another folder is another page's, and is not shown
 * here. Null where the window holds none, and until the folder is known.
 */
function signInFor(folder: ClaudeDir | undefined, held: AgentSignIn | undefined): AgentSignIn | null {
  return folder && held && (held.home ?? null) === folder.dir ? held : null;
}

/**
 * A profile's Claude config folder: the folder in force, the ways to name another, and whether that
 * folder is signed in.
 *
 * The field shows the folder in force and never a blank, the default folder included, so what a
 * person reads there is what the profile's next session runs under. It is a draft only while it is
 * typed in. Enter sends it, and so does moving the keyboard to another control. The window losing
 * the keyboard does not: the folder dialog opening, or a switch to another app, leaves the draft in
 * the field as it was typed. Nor is a draft sent that would change nothing: one that reads as the
 * shown folder does, or an empty one while the profile names no folder. Escape puts the shown
 * folder back, and once the server has stored or refused a draft the field shows the stored folder
 * again. A refusal is the server's own sentence, in a toast. Escape is the field's only while there
 * is a draft to put back; with none it is the page's way out, as it is everywhere else on the page.
 *
 * Choose… and Use the default act on the stored folder. A press on either leaves the keyboard in
 * the field, so a half-typed path is not sent on the way to the button, to be refused in a toast
 * about a path the person had already given up on. The dialog opens on the folder that holds the
 * one in force, where the folders a person chooses between are listed side by side, the hidden
 * ones among them. It offers no New Folder, since Realm makes no folder here, and it hands an alias
 * back as it is named: the server keeps a path as it was named, and Claude Code files a sign-in
 * under that spelling. A second press on Choose… while its dialog is up opens no second dialog over
 * the first.
 *
 * Until the window holds this profile's folder the field is off and says so, and the page reads the
 * folder itself: a path shown before then would be a guess.
 *
 * Sign in runs Claude Code's own login for this profile's folder, with no space around it, as the
 * first run's card does (`startAgentSignIn`). While a sign-in for this folder runs, its steps stand
 * in place of the line under the field (`AgentSignInSteps`), keyed by the sign-in, so a code typed
 * for one is never left in the field for the next. A sign-in running for another folder is not
 * shown here. The server keeps one unfinished sign-in for Claude whichever folder it lands in, so
 * while one runs elsewhere Sign in says in its tooltip that a press stops it.
 *
 * When the page has watched a sign-in run and it reports that it is done, the row the page holds
 * was read before the sign-in. It is let go and asked for again, so the line reads "Checking…"
 * with no button until the answer lands, and never "Not signed in." over a folder that has just
 * been signed in. The row is let go before the window is painted again (a layout effect), so the
 * button is not drawn for one frame either. A profile that names a folder asks from what the
 * server last learned: the server reads that folder afresh to confirm a sign-in before it reports
 * one done, so the answer is at hand. A profile on the default folder asks afresh. There the
 * server's confirming read only amends its list of every agent and leaves that list's age as it
 * was, and a plain ask of a list past its age waits on every agent's probe. When it was cancelled
 * the line is back at once, and the row is asked for afresh behind it, since a cancel can land
 * after the login itself has finished. When the sign-in did not finish, the line is back with its
 * button, under the sentence the first run's card says of one.
 *
 * While that line reads "Not signed in.", says the folder is missing, or says it can't tell, the
 * page reads the folders again each time the window comes back to the front. It asks for the row
 * afresh as well, as the install card does, wherever the folder's own answer does not say the
 * folder is missing. That is under "Not signed in.", where a row could not say or a call for one
 * was lost, and where only the row says the folder is missing: the folder may have
 * gone since its answer was read, which the read puts right, or gone and come back between two
 * reads, which only a fresh row does. Where the folder's answer says it is missing nothing is
 * asked, since the server asks Claude Code nothing about a folder that is not there. A folder can
 * be put back, and a sign-in finished, in a terminal that tells this page nothing.
 */
function ClaudeFolderField({ profile }: { profile: Profile }) {
  const folder = useApp((s) => s.claudeDirs[profile.id]);
  const userHome = useApp((s) => s.userHome);
  const held = useApp((s) => s.agentSignIns.claude);
  const loadClaudeDirs = useApp((s) => s.loadClaudeDirs);
  const setClaudeDir = useApp((s) => s.setClaudeDir);
  const pickFolder = useApp((s) => s.pickFolder);
  const startAgentSignIn = useApp((s) => s.startAgentSignIn);
  const run = useApp((s) => s.run);
  const known = folder !== undefined;
  const shown = folder ? tildePath(folder.inForce, userHome) : "";
  const [text, setText] = useState(shown);
  const [settled, setSettled] = useState(0);
  const picking = useRef(false);
  useEffect(() => { setText(shown); }, [shown, settled]);
  useEffect(() => { if (!known) void loadClaudeDirs(); }, [known, loadClaudeDirs]);
  const { row, ask, forget } = useFolderRow(profile.id, folder);
  const signIn = folderSignIn(folder, row);
  const signedOut = signIn.state === "signed-out";
  const rereads = signedOut || signIn.state === "missing" || signIn.state === "unknown";
  useEffect(() => {
    if (!rereads) return;
    const again = () => {
      void loadClaudeDirs();
      if (!folder?.missing) ask(true);
    };
    window.addEventListener("focus", again);
    return () => window.removeEventListener("focus", again);
  }, [rereads, folder?.missing, ask, loadClaudeDirs]);
  const own = signInFor(folder, held);
  const live = runningSignIn(own);
  const ended = live ? null : own?.state ?? null;
  const elsewhere = own === null && runningSignIn(held) !== null;
  const onDefaultFolder = folder?.dir === null;
  const watched = useRef(false);
  useLayoutEffect(() => {
    if (watched.current && ended === "done") { forget(); ask(onDefaultFolder); }
    else if (watched.current && ended === "cancelled") ask(true);
    watched.current = live !== null;
  }, [live, ended, ask, forget, onDefaultFolder]);

  const write = async (dir: string | null) => {
    try { await setClaudeDir(profile.id, dir); }
    finally { setSettled((n) => n + 1); }
  };
  const commit = () => {
    if (!folder) return;
    const typed = text.trim();
    if (typed === shown || (typed === "" && folder.dir === null)) setText(shown);
    else run(() => write(typed === "" ? null : typed));
  };
  const choose = () => {
    if (!folder || picking.current) return;
    picking.current = true;
    run(async () => {
      try {
        const picked = await pickFolder({ hidden: true, create: false, aliases: false, from: parentFolder(folder.inForce) });
        if (picked !== null) await write(picked);
      } finally { picking.current = false; }
    });
  };

  return (
    <div className="field"><span>Claude config folder</span>
      <div className="claude-folder-row">
        <input aria-label="Claude config folder" className={known ? "env-path" : undefined} value={text} disabled={!known}
          placeholder={known ? undefined : "Checking…"} spellCheck={false} autoComplete="off"
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => { if (document.activeElement !== e.currentTarget) commit(); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape" && text !== shown) { e.preventDefault(); e.stopPropagation(); setText(shown); }
          }} />
        <button type="button" className="btn" disabled={!known} onMouseDown={(e) => e.preventDefault()} onClick={choose}>Choose…</button>
        {folder && folder.dir !== null && (
          <button type="button" className="btn" onMouseDown={(e) => e.preventDefault()} onClick={() => run(() => write(null))}>Use the default</button>
        )}
      </div>
      {(live || (signedOut && ended === "failed")) && (
        <div aria-live="polite">
          {live
            ? <AgentSignInSteps key={live.id} signIn={live} name={AGENT_META.claude.label} />
            : <p className="settings-hint" data-tone="danger" title={own?.detail ?? undefined}>The sign-in didn't finish. Try again.</p>}
        </div>
      )}
      {!live && (
        <div className="claude-folder-state">
          <span role="status">{signInSentence(signIn, profile.name)}</span>
          {signedOut && (
            <button type="button" className="btn" title={elsewhere ? STOPS_ANOTHER_SIGN_IN : undefined}
              onClick={() => run(() => startAgentSignIn("claude", profile.id))}>Sign in</button>
          )}
        </div>
      )}
      <p className="settings-hint">New Claude sessions in {profile.name}'s spaces use this folder's sign-in, memory, and commands. A conversation keeps the sign-in it began with.</p>
    </div>
  );
}

/** "3 spaces and 12 sessions" — what the delete takes, counted, in words. */
export function usageWords(u: ProfileUsage): string {
  const spaces = u.spaces === 1 ? "1 space" : `${u.spaces} spaces`;
  const sessions = u.sessions === 1 ? "1 session" : `${u.sessions} sessions`;
  return `${spaces} and ${sessions}`;
}

/**
 * Deleting a profile, guarded the way the thing it destroys deserves. It takes the profile's spaces and
 * every session in them — running agents are stopped — and its browser cookies, saved sign-ins and
 * passkeys. So the confirm says how much, in counts read from the server at the moment it opens, and
 * asks for the profile's name to be typed: a stray click on the second button of a two-step confirm is
 * exactly the accident this cannot afford. The last profile is never offered — every space needs one —
 * and the button says why rather than vanishing.
 */
function DeleteProfile({ profile }: { profile: Profile }) {
  const last = useApp((s) => s.profiles.length <= 1);
  const profileUsage = useApp((s) => s.profileUsage);
  const deleteProfile = useApp((s) => s.deleteProfile);
  const run = useApp((s) => s.run);
  const [usage, setUsage] = useState<ProfileUsage | null>(null);
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState("");
  const open = () => { setTyped(""); setUsage(null); setAsking(true); void profileUsage(profile.id).then(setUsage, () => setUsage(null)); };
  if (last) {
    return (
      <div className="form-actions danger-zone">
        <button type="button" className="btn danger" disabled>Delete profile…</button>
        <span className="muted">This is the only profile, so it can't be deleted. Make another profile first.</span>
      </div>
    );
  }
  if (!asking) {
    return (
      <div className="form-actions danger-zone">
        <button type="button" className="btn danger" onClick={open}>Delete profile…</button>
      </div>
    );
  }
  const matches = typed.trim() === profile.name;
  return (
    <div className="field danger-zone profile-delete" role="group" aria-label={`Delete ${profile.name}`}>
      <p className="settings-hint">
        {usage === null
          ? `Deleting ${profile.name} deletes its spaces and every session in them.`
          : `Deleting ${profile.name} deletes its ${usageWords(usage)}.`}{" "}
        Running agents in them are stopped, and its browser sign-ins, saved sign-ins and passkeys are
        deleted. Folders on disk are kept.
      </p>
      <label className="settings-input-label">Type {profile.name} to confirm
        <input aria-label={`Type ${profile.name} to confirm`} value={typed} autoComplete="off" spellCheck={false}
          onChange={(e) => setTyped(e.target.value)} />
      </label>
      <div className="form-actions">
        <button type="button" className="btn" onClick={() => setAsking(false)}>Cancel</button>
        <button type="button" className="btn danger" disabled={!matches} onClick={() => run(() => deleteProfile(profile.id))}>Delete {profile.name}</button>
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
  const openSkillPage = useApp((s) => s.openSkillPage);
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
          : <ul className="settings-list">{own.map((sk) => <ProfileSkillRow key={sk.id} spaceId={spaceId} skill={sk} profileName={profileName} spaceName={spaceName} onOpen={() => run(() => openSkillPage(sk.id))} />)}</ul>}
      </div>
      {everywhere.length > 0 && (
        <div className="field">
          <span>Everywhere</span>
          <p className="settings-hint">{EVERYWHERE_NOTE}</p>
          <ul className="settings-list">
            {everywhere.map((sk) => (
              <li key={sk.id} className="settings-row">
                <div className="settings-row-main">
                  <button type="button" className="settings-row-name skill-open" onClick={() => run(() => openSkillPage(sk.id))}>{sk.name}</button>
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

/** One of the profile's own skills: the row plus its demote move behind the shared confirm. The name
 *  is the same door every other skill list carries — it opens the Library's one skill viewer. */
function ProfileSkillRow({ spaceId, skill: sk, profileName, spaceName, onOpen }: { spaceId: string; skill: Skill; profileName: string; spaceName: string; onOpen: () => void }) {
  const demoteSkill = useApp((s) => s.demoteSkill);
  const run = useApp((s) => s.run);
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="settings-row" data-invalid={!sk.valid || undefined}>
      <div className="settings-row-main">
        <button type="button" className="settings-row-name skill-open" onClick={onOpen}>{sk.name}</button>
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

/**
 * The Memory tab: the profile document at its defining scope, edited in full — the one place it is
 * edited at all, now that the Library's row shows what it says rather than a second editor. The
 * reach is still SAID (a save lands in every space of the profile), as page copy rather than a
 * warning about being somewhere else. Cap posture is MemoryDoc's: over MEMORY_DOC_MAX nothing is
 * sent, and the overage is named.
 */
function ProfileMemoryTab({ profileId, profileName }: { profileId: string; profileName: string }) {
  const stored = useApp((s) => s.profileMemory[profileId]);
  const refreshProfileMemory = useApp((s) => s.refreshProfileMemory);
  const saveProfileMemoryDoc = useApp((s) => s.saveProfileMemoryDoc);
  const run = useApp((s) => s.run);
  useEffect(() => { run(() => refreshProfileMemory(profileId)); }, [profileId, refreshProfileMemory, run]);

  if (!stored) return <div className="form settings-panel"><p className="env-empty">Loading…</p></div>;
  const reveal = window.realm?.files?.reveal;
  // The same page a space's memory is (MemoryDoc), keyed by the profile so a draft never follows
  // the page from one profile to the next. The reach is page copy, not a banner: this page IS the
  // defining scope.
  return (
    <div className="form settings-panel memory-page">
      <p className="page-lede">Travels into every new session in every space of {profileName}, injected before each space's own memory.</p>
      <div className="settings-row scope-doc-row">
        <MemoryDoc key={profileId} label={`${profileName} memory document`} doc={stored.doc}
          onSave={(text) => saveProfileMemoryDoc(profileId, text)}
          placeholder={`Durable context for every ${profileName} space — conventions, links, standing instructions…`} />
      </div>
      <div className="settings-group">
        <div className="settings-row memory-path-row">
          <div className="settings-row-main">
            <span className="settings-row-name">Stored at</span>
            <code className="env-path settings-row-desc">{stored.path}</code>
          </div>
          {reveal && <button type="button" className="btn-quiet" onClick={() => { void reveal(stored.path); }}>Show in Finder</button>}
        </div>
      </div>
    </div>
  );
}
