import {
  AGENT_CLI_COMMANDS, AGENT_LOGIN_HINTS, AGENT_META, AGENT_SUPPORTS_PERMISSION_MODES, NOTIFICATION_CATEGORIES,
  PERMISSION_MODES, SELECTABLE_AGENT_KINDS, type AgentKind, type NotificationCategory,
} from "@realm/contracts";
import { Icon } from "@realm/ui";
import { useEffect, useState } from "react";
import { agentAvailability } from "../../state/agent-availability";
import { useApp } from "../../state/store";
import type { PaneProps } from "../registry";
import type { ThemePref } from "../../theme/useTheme";

type SettingsTab = "engines" | "app" | "permissions";
const TABS: { id: SettingsTab; label: string }[] = [
  { id: "engines", label: "Engines" }, { id: "app", label: "App" }, { id: "permissions", label: "Permissions" },
];

/**
 * The Settings page (Plan 12 W6, Universe screenshot 5) — a `settings-page` destination on W4's
 * sentinel convention, reached from the bottom-left gear and the palette. Three tabs down the
 * `.page-rail`: Engines (the agent probe, rendered), App (theme, notification switches, the default
 * permission mode for new sessions), Permissions (macOS TCC, honest states only).
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
          <span className="page-sub">Engines, app preferences, and what macOS lets Realm do.</span>
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

/** Engine rows in a fixed, honest order: the offerable kinds, then Gemini — listed, not hidden,
 *  with its dead-end named (SELECTABLE_AGENT_KINDS's reasoning) — then anything else the server's
 *  adapter registry probes (the dev harness's fake). */
const ENGINE_ORDER: AgentKind[] = [...SELECTABLE_AGENT_KINDS, "acp:gemini"];

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
        {/* The dead-end note (AGENT_LOGIN_HINTS's reasoning): Gemini appears, honestly, rather than
            being hidden — but the row says why Realm won't offer it for new sessions. */}
        {!offered && kind !== "fake" && <p className="settings-hint">Not offered for new sessions. {AGENT_LOGIN_HINTS[kind]}</p>}
        {a.state === "missing" && install && <CommandCopy command={install} />}
        {a.state === "logged_out" && login && <CommandCopy command={login} />}
        {p && !p.available && p.reason && <p className="settings-hint">{p.reason}</p>}
      </div>
    </li>
  );
}

const THEME_CHOICES: { pref: ThemePref; label: string }[] = [
  { pref: "system", label: "System" }, { pref: "light", label: "Light" }, { pref: "dark", label: "Dark" },
];

/** Human words for W5's notification categories — one label + one sentence each, default-on. */
const CATEGORY_COPY: Record<NotificationCategory, { label: string; desc: string }> = {
  permission: { label: "Permission requests", desc: "An agent is waiting on your yes or no." },
  session_done: { label: "Sessions finishing", desc: "A session settled while you were looking elsewhere." },
  mcp_health: { label: "Connection trouble", desc: "An MCP server failed or tripped its circuit breaker." },
  agent_probe: { label: "Engine regressions", desc: "A CLI that used to work stops probing available." },
  worktree_hazard: { label: "Worktree hazards", desc: "A removal or restore was refused because the tree changed underneath it." },
};

function AppTab() {
  const themePref = useApp((s) => s.themePref);
  const setThemePref = useApp((s) => s.setThemePref);
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
    </div>
  );
}

const TCC_STATE_LABEL = { granted: "Granted", denied: "Not granted", unknown: "Can't be checked until used" } as const;

function PermissionsTab() {
  const rows = useApp((s) => s.tccRows);
  const refreshTcc = useApp((s) => s.refreshTcc);
  const openTccPane = useApp((s) => s.openTccPane);
  const run = useApp((s) => s.run);
  useEffect(() => { void run(() => refreshTcc()); }, [run, refreshTcc]);
  return (
    <div className="form">
      <p className="page-lede">What macOS lets Realm — and the agents it runs — touch. Realm only claims a state it has a real, prompt-free way to check; the rest say so.</p>
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
