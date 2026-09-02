import {
  AGENT_CLI_COMMANDS, AGENT_LOGIN_HINTS, AGENT_META, AGENT_SUPPORTS_PERMISSION_MODES, NOTIFICATION_CATEGORIES,
  PERMISSION_MODES, SELECTABLE_AGENT_KINDS, type AgentKind, type NotificationCategory,
} from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
import { agentAvailability, isBlocked } from "../../state/agent-availability";
import { useApp, type SubmitKey } from "../../state/store";
import type { PaneProps } from "../registry";
import type { ThemePref } from "../../theme/useTheme";
import { ImportPanel } from "../../components/settings/ImportPanel";

type SettingsTab = "engines" | "app" | "import" | "permissions";
const TABS: { id: SettingsTab; label: string }[] = [
  { id: "engines", label: "Engines" }, { id: "app", label: "App" }, { id: "import", label: "Import" }, { id: "permissions", label: "Permissions" },
];

/**
 * The Settings page (Plan 12 W6, Universe screenshot 5) — a `settings-page` destination on W4's
 * sentinel convention, reached from the bottom-left gear and the palette. Four tabs down the
 * `.page-rail`: Engines (the agent probe, rendered), App (theme, notification switches, the default
 * permission mode for new sessions), Import (transcripts, memory and skills out of the agent CLIs'
 * own stores), Permissions (macOS TCC, honest states only).
 *
 * The pane's `item` goes unused like the Notifications page's: nothing here has a per-space vantage —
 * engines, app preferences and TCC grants are facts about the machine and the app, not a space.
 */

/** "2.1.223" → "v2.1.223", but "codex-cli 0.146.0" stays as-is — the v is for bare numbers only
 *  (live-pass finding: "vcodex-cli"). */
export function engineVersionLabel(version: string): string {
  return /^\d/.test(version) ? `v${version}` : version;
}

export function SettingsPage(_props: PaneProps) {
  const [tab, setTab] = useState<SettingsTab>("engines");
  return (
    <div className="page settings-page-pane">
      <header className="page-head">
        <span className="page-glyph"><Icon name="settings-page" size={20} /></span>
        <div className="page-title">
          <h1>Settings</h1>
          <span className="page-sub">Engines, app preferences, importing from the agent CLIs, and what macOS lets Realm do.</span>
        </div>
      </header>
      <div className="page-body">
        <fieldset className="page-rail">
          <legend className="visually-hidden">Settings section</legend>
          {TABS.map((t) => (
            <label key={t.id} className="settings-tab page-rail-tab" data-selected={tab === t.id || undefined}>
              <input type="radio" name="settings-page-tab" value={t.id} checked={tab === t.id} onChange={() => setTab(t.id)} />
              {t.label}
            </label>
          ))}
        </fieldset>
        <div className="page-content">
          {tab === "engines" && <EnginesTab />}
          {tab === "app" && <AppTab />}
          {tab === "import" && <ImportPanel />}
          {tab === "permissions" && <PermissionsTab />}
        </div>
      </div>
    </div>
  );
}

/** A command offered for copying — the install card's affordance, re-rendered. The command travels
 *  to the clipboard verbatim: no trailing newline anywhere near a terminal (typed-never-run). */
function CommandCopy({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="install-cmd">
      <code>{command}</code>
      <button className="tool-copy" aria-label="Copy command" title={copied ? "Copied" : "Copy"}
        onClick={() => { void navigator.clipboard?.writeText(command); setCopied(true); }}>
        <Icon name={copied ? "check" : "copy"} size={12} />
      </button>
    </div>
  );
}

/** Engine rows in a fixed, honest order: every offerable kind, then anything else the server's adapter
 *  registry probes (the dev harness's fake, and any kind withheld from the picker).
 *
 *  Gemini used to be appended by hand here because it was registered but not offered. Plan 18 put it
 *  back in SELECTABLE_AGENT_KINDS — so the hand-append became a DUPLICATE row, which is exactly why
 *  this list is derived rather than restated. Anything withheld still shows up, through the probe tail
 *  below; nothing needs naming twice. */
const ENGINE_ORDER: AgentKind[] = [...SELECTABLE_AGENT_KINDS];

function EnginesTab() {
  const agentProbe = useApp((s) => s.agentProbe);
  const probeAgents = useApp((s) => s.probeAgents);
  const run = useApp((s) => s.run);
  // Mount rides the server's TTL cache; only "Re-check" forces past it.
  useEffect(() => { void run(() => probeAgents(false)); }, [run, probeAgents]);
  const kinds: AgentKind[] = [...ENGINE_ORDER, ...agentProbe.map((p) => p.kind).filter((k) => !ENGINE_ORDER.includes(k))];
  return (
    <div className="form">
      <div className="engines-head">
        <p className="page-lede">The agent CLIs Realm can run, as they look on this machine right now.</p>
        {/* The named mutant: a cached probe shown as fresh. Forced, so what renders after the click
            is what a child process just reported — never the TTL cache the mount ride uses. */}
        <button type="button" className="btn" onClick={() => run(() => probeAgents(true))}>Re-check</button>
      </div>
      {agentProbe.length === 0
        ? <p className="env-empty">Checking the installed CLIs…</p>
        : <ul className="page-list engines-list">{kinds.map((k) => <EngineRow key={k} kind={k} />)}</ul>}
    </div>
  );
}

function EngineRow({ kind }: { kind: AgentKind }) {
  const agentProbe = useApp((s) => s.agentProbe);
  const p = agentProbe.find((x) => x.kind === kind);
  const meta = AGENT_META[kind];
  const a = agentAvailability(kind, agentProbe);
  const { install, login } = AGENT_CLI_COMMANDS[kind];
  const offered = (SELECTABLE_AGENT_KINDS as readonly AgentKind[]).includes(kind);
  // Signed-in identity, exactly as far as the probe carries it: a boolean at best (Claude's keychain
  // and both ACP agents report null = "couldn't tell", which renders as nothing, not as either claim).
  const identity = p?.loggedIn === true ? "signed in" : p?.loggedIn === false ? "signed out" : null;
  const status = !p ? "Checking…"
    : p.available ? ["Installed", p.version ? engineVersionLabel(p.version) : null, identity].filter(Boolean).join(" · ")
    : "Not installed";
  return (
    <li className="engine-row" aria-label={`${meta.label}: ${status}`}>
      <span className="engine-mark"><Icon name={meta.icon} size={18} colored /></span>
      <div className="engine-main">
        <div className="engine-line">
          <span className="engine-name">{meta.label}</span>
          <span className="engine-status" data-state={!p ? "unknown" : p.available ? "installed" : "missing"}>{status}</span>
        </div>
        {/* A kind Realm keeps registered but will not offer says so, and only that — the how-to-fix
            sentence below is shared with every other blocked row. */}
        {!offered && kind !== "fake" && <p className="settings-hint">Not offered for new sessions.</p>}
        {a.state === "missing" && install && <CommandCopy command={install} />}
        {a.state === "logged_out" && login && <CommandCopy command={login} />}
        {/* The login hint on ANY blocked row, not just un-offered ones. It used to hang off `!offered`,
            which was fine only while every kind with something awkward to explain was also withheld.
            Gemini broke that the moment it was offered again: `login` is null for it (there is no login
            command — it needs an API key, Vertex credentials, or a gateway), so the row would have gone
            from a full explanation to nothing but "Not installed". A blocked agent must always say what
            would unblock it. */}
        {isBlocked(a) && kind !== "fake" && <p className="settings-hint">{AGENT_LOGIN_HINTS[kind]}</p>}
        {p && !p.available && p.reason && <p className="settings-hint">{p.reason}</p>}
      </div>
    </li>
  );
}

const THEME_CHOICES: { pref: ThemePref; label: string }[] = [
  { pref: "system", label: "System" }, { pref: "light", label: "Light" }, { pref: "dark", label: "Dark" },
];

const SUBMIT_KEY_CHOICES: { pref: SubmitKey; label: string }[] = [
  { pref: "enter", label: "Enter" }, { pref: "cmdEnter", label: "⌘/Ctrl+Enter" },
];

/** Human words for W5's notification categories — one label + one sentence each, default-on. */
const CATEGORY_COPY: Record<NotificationCategory, { label: string; desc: string }> = {
  permission: { label: "Permission requests", desc: "An agent is waiting on your yes or no." },
  session_done: { label: "Sessions finishing", desc: "A session settled while you were looking elsewhere." },
  mcp_health: { label: "Connection trouble", desc: "An MCP server failed or tripped its circuit breaker." },
  agent_probe: { label: "Engine regressions", desc: "A CLI that used to work stops probing available." },
  worktree_hazard: { label: "Worktree hazards", desc: "A removal or restore was refused because the tree changed underneath it." },
  review_done: { label: "Reviews finishing", desc: "A requested review landed its verdict on the diff pane." },
  run_blocked: { label: "Runs needing you", desc: "An unattended run stopped and asked for a person." },
  run_done: { label: "Runs finishing", desc: "A durable run reached a final state." },
};

function AppTab() {
  const themePref = useApp((s) => s.themePref);
  const setThemePref = useApp((s) => s.setThemePref);
  const submitKey = useApp((s) => s.submitKey);
  const setSubmitKey = useApp((s) => s.setSubmitKey);
  const prefs = useApp((s) => s.settingsPrefs);
  const refreshSettingsPrefs = useApp((s) => s.refreshSettingsPrefs);
  const setNotificationCategoryEnabled = useApp((s) => s.setNotificationCategoryEnabled);
  const setDefaultPermissionMode = useApp((s) => s.setDefaultPermissionMode);
  const run = useApp((s) => s.run);
  useEffect(() => { void run(() => refreshSettingsPrefs()); }, [run, refreshSettingsPrefs]);
  // bypassPermissions must never be a one-click slip, HERE least of all — this is every future
  // session at once. Same two-step as the composer chip (U-M7): arm for 5s, apply only on the
  // explicit confirm; the control meanwhile stays on the current mode.
  const [confirmBypass, setConfirmBypass] = useState(false);
  useEffect(() => {
    if (!confirmBypass) return;
    const t = setTimeout(() => setConfirmBypass(false), 5000);
    return () => clearTimeout(t);
  }, [confirmBypass]);

  const supported = SELECTABLE_AGENT_KINDS.filter((k) => AGENT_SUPPORTS_PERMISSION_MODES[k]);
  const unsupported = SELECTABLE_AGENT_KINDS.filter((k) => !AGENT_SUPPORTS_PERMISSION_MODES[k]);
  const labels = (ks: readonly AgentKind[]) => ks.map((k) => AGENT_META[k].label).join(", ");

  return (
    <div className="form">
      <div className="field"><span>Theme</span>
        <fieldset className="settings-tabs" aria-label="Theme">
          {THEME_CHOICES.map((t) => (
            <label key={t.pref} className="settings-tab" data-selected={themePref === t.pref || undefined}>
              <input type="radio" name="settings-theme" value={t.pref} checked={themePref === t.pref}
                onChange={() => run(() => setThemePref(t.pref))} />
              {t.label}
            </label>
          ))}
        </fieldset>
        {/* One line, not a switch (Plan 14 W5): the OS setting is the control, and styles.css's global
            prefers-reduced-motion kill is what makes this sentence true. */}
        <p className="settings-hint">Realm follows the system's Reduce Motion setting everywhere — with it on, animations and transitions are disabled app-wide.</p>
      </div>

      <div className="field"><span>Send message with</span>
        <fieldset className="settings-tabs" aria-label="Send message with">
          {SUBMIT_KEY_CHOICES.map((k) => (
            <label key={k.pref} className="settings-tab" data-selected={submitKey === k.pref || undefined}>
              <input type="radio" name="settings-submit-key" value={k.pref} checked={submitKey === k.pref}
                onChange={() => run(() => setSubmitKey(k.pref))} />
              {k.label}
            </label>
          ))}
        </fieldset>
        <p className="settings-hint">
          {submitKey === "enter" ? "Enter sends; Shift+Enter inserts a newline." : "⌘/Ctrl+Enter sends; Enter inserts a newline."}
        </p>
      </div>

      <div className="field"><span>Notifications</span>
        <p className="settings-hint">Switching a category off stops new rows from being written — what is already in the feed stays, including any permission request an agent is still blocked on.</p>
        {prefs === null ? <p className="env-empty">Loading preferences…</p> : (
          <ul className="settings-list">
            {NOTIFICATION_CATEGORIES.map((c) => (
              <li key={c} className="settings-row">
                <div className="settings-row-main">
                  <span className="settings-row-name">{CATEGORY_COPY[c].label}</span>
                  <span className="settings-row-desc">{CATEGORY_COPY[c].desc}</span>
                </div>
                <input type="checkbox" role="switch" className="switch" aria-label={CATEGORY_COPY[c].label}
                  checked={!prefs.disabledCategories.includes(c)}
                  onChange={(e) => run(() => setNotificationCategoryEnabled(c, e.target.checked))} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="field"><span>New sessions start in</span>
        {prefs === null ? <p className="env-empty">Loading preferences…</p> : (
          <>
            <fieldset className="settings-tabs" aria-label="Default permission mode">
              {PERMISSION_MODES.map((m) => (
                <label key={m.id} className="settings-tab" data-selected={prefs.defaultPermissionMode === m.id || undefined}>
                  <input type="radio" name="settings-default-permission" value={m.id} checked={prefs.defaultPermissionMode === m.id}
                    onChange={() => {
                      if (m.id === "bypassPermissions" && prefs.defaultPermissionMode !== "bypassPermissions") { setConfirmBypass(true); return; }
                      setConfirmBypass(false);
                      void run(() => setDefaultPermissionMode(m.id));
                    }} />
                  {m.label}
                </label>
              ))}
            </fieldset>
            {confirmBypass && (
              <button type="button" className="composer-chip bypass-confirm"
                onClick={() => { setConfirmBypass(false); void run(() => setDefaultPermissionMode("bypassPermissions")); }}>
                Every new session will run tools and edit files without asking first. Confirm Full access as the default
              </button>
            )}
            <p className="settings-hint">
              Applies to new {labels(supported)} sessions; each session's chip can still change it.
              {unsupported.length > 0 && ` ${labels(unsupported)} sessions ignore it — Realm can't set that agent's permission mode, so they start on the agent's own default.`}
            </p>
          </>
        )}
      </div>

      <UpdatesField />
    </div>
  );
}

/** Why the Updates button is disabled, in words — one honest sentence per gate reason (Plan 15 W1).
 *  The reasons are main's (updater.ts): the renderer names them, it never decides them. */
export const UPDATE_DISABLED_COPY = {
  dev: "Update checks don't run in development builds.",
  unsigned: "Updates unavailable: unsigned build — macOS can only install a signed update. Signing steps: docs/dev/signing.md.",
  "no-feed": "Updates unavailable: no public update feed — this build's releases are private. Activation conditions: README → Updates.",
} as const;

/** One line per updater state — every word is a fact main reported, and the button only ever claims
 *  an action that would really run (no fake spinner: `checking` IS a check in flight in main). */
function UpdatesField() {
  const status = useApp((s) => s.updateStatus);
  const refreshUpdateStatus = useApp((s) => s.refreshUpdateStatus);
  const checkForUpdates = useApp((s) => s.checkForUpdates);
  const installUpdate = useApp((s) => s.installUpdate);
  const run = useApp((s) => s.run);
  useEffect(() => { void run(() => refreshUpdateStatus()); }, [run, refreshUpdateStatus]);
  if (!status) return <div className="field"><span>Updates</span><p className="env-empty">Loading…</p></div>;
  const st = status.state;
  const desc =
    st.kind === "disabled" ? UPDATE_DISABLED_COPY[st.reason]
    : st.kind === "checking" ? "Checking for updates…"
    : st.kind === "up-to-date" ? "You're on the latest version."
    : st.kind === "downloading" ? `Downloading v${st.version}…`
    : st.kind === "downloaded" ? `v${st.version} is ready — restart to finish installing.`
    : st.kind === "error" ? `Update check failed: ${st.message}`
    : "Checks only run when you ask — nothing polls in the background.";
  return (
    <div className="field"><span>Updates</span>
      <div className="settings-row update-row">
        <div className="settings-row-main">
          <span className="settings-row-name">Realm v{status.version}</span>
          <span className="settings-row-desc">{desc}</span>
        </div>
        {st.kind === "downloaded"
          ? <button type="button" className="btn" onClick={() => run(() => installUpdate())}>Restart to update</button>
          : <button type="button" className="btn" disabled={st.kind === "disabled" || st.kind === "checking" || st.kind === "downloading"}
              onClick={() => run(() => checkForUpdates())}>
              Check for updates
            </button>}
      </div>
    </div>
  );
}

const TCC_STATE_LABEL = { granted: "Granted", denied: "Not granted", unknown: "Can't be checked until used" } as const;

function PermissionsTab() {
  return (
    <div className="form">
      <MacAccessSection />
      <RealmAccessSection />
    </div>
  );
}

/** One word per `mac doctor` state. `writeOnly` gets its own — it is a HALF grant (writes land,
 *  reads come back empty), and calling it "Granted" would put a green check over a capability that
 *  silently returns nothing. */
const MAC_STATE_LABEL: Record<MacAccessState, string> = {
  granted: "Granted",
  denied: "Refused",
  notRequested: "Not asked yet",
  writeOnly: "Add-only",
  unknown: "Unknown",
};

/** Green only for a real grant; `writeOnly` is deliberately styled as the warning it is. */
const MAC_STATE_TONE: Record<MacAccessState, "granted" | "denied" | "unknown"> = {
  granted: "granted", denied: "denied", writeOnly: "denied", notRequested: "unknown", unknown: "unknown",
};

const MAC_GROUP_COPY: { group: MacAccessRow["group"]; label: string; hint: string }[] = [
  { group: "data", label: "Calendar, Reminders & Contacts", hint: "macOS asks once, in a dialog. Nothing opens." },
  { group: "automation", label: "App control (Automation)", hint: "Each of these opens its app to ask — macOS only offers the dialog while the app is running." },
  { group: "disk", label: "Full Disk Access", hint: "The one macOS has no dialog for: it has to be switched on in System Settings." },
  { group: "other", label: "Also reported by mac doctor", hint: "Capabilities this version of Realm has no command for. Grant them in System Settings." },
];

/**
 * "Apps on this Mac" — the grantable half of the Permissions tab. Every claim here is `mac doctor`'s,
 * and every button only ever offers an action that can really work: rows macOS has already refused
 * point at System Settings instead of a prompt (denials are sticky — re-asking is guaranteed to
 * fail), and Full Disk Access, which has no dialog at all, offers the drag instead.
 */
function MacAccessSection() {
  const status = useApp((s) => s.macAccess);
  const granting = useApp((s) => s.macGranting);
  const queue = useApp((s) => s.macGrantQueue);
  const refreshMacAccess = useApp((s) => s.refreshMacAccess);
  const grantAllMacAccess = useApp((s) => s.grantAllMacAccess);
  const run = useApp((s) => s.run);
  useEffect(() => { void run(() => refreshMacAccess()); }, [run, refreshMacAccess]);

  if (status === null) return <div className="field mac-access-field"><span>Apps on this Mac</span><p className="env-empty">Checking…</p></div>;

  if (!status.cli.present) {
    return (
      <div className="field mac-access-field"><span>Apps on this Mac</span>
        <p className="settings-hint">
          Realm drives Calendar, Mail, Messages, Notes and the rest through the <code>mac</code> CLI, which isn't on this
          machine — so there are no permissions to grant yet. Realm looked on your login shell's PATH and in {status.cli.searched.join(" and ")}.
        </p>
      </div>
    );
  }

  const rows = status.rows;
  const promptable = rows.filter((r) => r.canPrompt);
  const settingsOnly = rows.filter((r) => r.needsSettings && !r.canPrompt);
  const granted = rows.filter((r) => r.state === "granted").length;
  const busy = granting !== null;
  const position = queue.length > 0 && granting ? queue.indexOf(granting) + 1 : 0;

  return (
    <div className="field mac-access-field"><span>Apps on this Mac</span>
      <p className="settings-hint">
        What the agents Realm runs can reach through the <code>mac</code> command — Calendar, Mail, Messages, Notes and the rest.
        macOS grants these to <strong>{status.host.name}</strong>, once, for every session: granting here is what stops an agent
        from stalling mid-task to ask you for them.
      </p>
      {/* The dev caveat, stated where it matters: under `pnpm dev` the host is Electron, and every
          grant made here lands on Electron rather than on the Realm the user will ship and run. */}
      {!status.host.packaged && (
        <p className="settings-row-problem">
          <Icon name="shield" size={12} />
          This is a development build, so macOS will attribute these grants to “{status.host.name}” — they won't carry into the packaged Realm.app.
        </p>
      )}

      <div className="mac-access-head">
        <span className="settings-row-desc">{granted} of {rows.length} granted</span>
        <button type="button" className="btn" disabled={busy || promptable.length === 0}
          onClick={() => run(() => grantAllMacAccess())}>
          {busy ? `Asking macOS… ${position || 1} of ${queue.length || 1}` : promptable.length === 0 ? "Nothing left to ask" : `Ask for all ${promptable.length}`}
        </button>
      </div>
      <p className="settings-hint">
        {promptable.length === 0
          ? "Every capability macOS can be asked about has been asked about."
          : `Realm runs one read-only command per capability — the listed one — and macOS puts up its own dialog for each. They come one at a time; ${
              promptable.some((r) => r.launchesApp) ? "the app-control ones open their app to ask." : "nothing opens."}`}
        {settingsOnly.length > 0 && ` ${settingsOnly.map((r) => r.label).join(", ")} can't be asked for at all and stay for System Settings.`}
      </p>

      {MAC_GROUP_COPY.map(({ group, label, hint }) => {
        const groupRows = rows.filter((r) => r.group === group);
        if (groupRows.length === 0) return null;
        return (
          <div key={group} className="mac-access-group">
            <p className="scope-group-label">{label}</p>
            <p className="settings-hint mac-group-hint">{hint}</p>
            <ul className="settings-list">
              {groupRows.map((r) => <MacAccessRowView key={r.id} row={r} />)}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function MacAccessRowView({ row }: { row: MacAccessRow }) {
  const granting = useApp((s) => s.macGranting);
  const grantMacAccess = useApp((s) => s.grantMacAccess);
  const openMacAccessPane = useApp((s) => s.openMacAccessPane);
  const revealRealmApp = useApp((s) => s.revealRealmApp);
  const run = useApp((s) => s.run);
  const busy = granting !== null;
  const mine = granting === row.id;
  return (
    <li className="settings-row tcc-row" aria-label={`${row.label}: ${MAC_STATE_LABEL[row.state]}`}>
      <div className="settings-row-main">
        <span className="settings-row-name">{row.label}</span>
        <span className="tcc-state" data-state={MAC_STATE_TONE[row.state]}>
          {row.state === "granted" && <Icon name="check" size={12} />}
          {MAC_STATE_LABEL[row.state]}
        </span>
        <span className="settings-row-desc">{row.detail}</span>
        {/* The command is shown BEFORE it runs, not described after — the user can read exactly what
            Realm is about to execute on their machine, and every one of them only lists. */}
        {row.canPrompt && row.grantCommand && (
          <span className="settings-row-desc mac-grant-cmd">
            Realm will run <code>{row.grantCommand}</code>{row.launchesApp ? `, which opens ${row.label}.` : "."}
          </span>
        )}
      </div>
      <div className="mac-row-actions">
        {row.canPrompt && (
          <button type="button" className="btn-quiet" disabled={busy}
            onClick={() => run(() => grantMacAccess(row.id))}>
            {mine ? "Waiting for macOS…" : "Ask macOS"}
          </button>
        )}
        {row.needsSettings && (
          <button type="button" className="btn-quiet" onClick={() => run(() => openMacAccessPane(row.id))}>Open System Settings</button>
        )}
        {/* Full Disk Access is a drag-the-app list, so hand the user the app to drag. */}
        {row.group === "disk" && row.needsSettings && (
          <button type="button" className="btn-quiet" onClick={() => run(() => revealRealmApp())}>Show app in Finder</button>
        )}
      </div>
    </li>
  );
}

/** The original TCC rows (Plan 12 W6) — what macOS lets Realm ITSELF do. Nothing here can be granted
 *  from a settings page, which is exactly why every row's only action is a deep link. */
function RealmAccessSection() {
  const rows = useApp((s) => s.tccRows);
  const refreshTcc = useApp((s) => s.refreshTcc);
  const openTccPane = useApp((s) => s.openTccPane);
  const run = useApp((s) => s.run);
  useEffect(() => { void run(() => refreshTcc()); }, [run, refreshTcc]);
  return (
    <div className="field realm-access-field"><span>Realm's own access</span>
      <p className="settings-hint">What macOS lets the app itself touch. Realm only claims a state it has a real, prompt-free way to check; the rest say so.</p>
      {rows === null ? <p className="env-empty">Checking…</p> : (
        <ul className="settings-list">
          {rows.map((r) => (
            <li key={r.id} className="settings-row tcc-row" aria-label={`${r.label}: ${TCC_STATE_LABEL[r.state]}`}>
              <div className="settings-row-main">
                <span className="settings-row-name">{r.label}</span>
                <span className="tcc-state" data-state={r.state}>
                  {r.state === "granted" && <Icon name="check" size={12} />}
                  {TCC_STATE_LABEL[r.state]}
                </span>
                <span className="settings-row-desc">{r.detail}</span>
              </div>
              <button type="button" className="btn-quiet" onClick={() => run(() => openTccPane(r.id))}>Open System Settings</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
