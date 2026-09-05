import {
  AGENT_CLI_COMMANDS, AGENT_LOGIN_HINTS, AGENT_META, AGENT_SUPPORTS_PERMISSION_MODES,
  CREDENTIAL_2FA_NOTE, CREDENTIAL_PRESENCE_TTLS, CREDENTIAL_STORAGE_NOTE, NOTIFICATION_CATEGORIES,
  PERMISSION_MODES, SELECTABLE_AGENT_KINDS, type AgentKind, type NotificationCategory,
} from "@realm/contracts";
import { CONTRAST_RANGE, DEFAULT_GROUND_ALPHA, FONT_FACES, FONT_WEIGHTS, GROUND_ALPHA_RANGE, Icon, REALM_SEED,
  THEMES, contrastMisses, deriveVars, exportTheme, importTheme, isHexColour, isOverridden, overrideKey,
  paletteFor, seedFor, themeModes, themeSwatches,
  type FontId, type FontWeight, type Mode, type ThemeName, type ThemeOverride, type ThemeSeed } from "@realm/ui";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { agentAvailability, isBlocked } from "../../state/agent-availability";
import { useApp, type CliJob, type SubmitKey } from "../../state/store";
import type { PaneProps } from "../registry";
import { hasWindowMaterial, useResolvedMode, type ThemePref } from "../../theme/useTheme";
import { grainVars } from "../../theme/grain";
import { ImportPanel } from "../../components/settings/ImportPanel";
import { UsagePanel } from "./usage/UsagePanel";

type SettingsTab = "engines" | "usage" | "app" | "signins" | "import" | "permissions";
const TABS: { id: SettingsTab; label: string }[] = [
  { id: "engines", label: "Engines" }, { id: "usage", label: "Usage" }, { id: "app", label: "App" },
  { id: "signins", label: "Sign-ins" }, { id: "import", label: "Import" }, { id: "permissions", label: "Permissions" },
];

/**
 * The Settings page (Plan 12 W6, Universe screenshot 5) — a `settings-page` destination on W4's
 * sentinel convention, reached from the bottom-left gear and the palette. Tabs down the
 * `.page-rail`: Engines (the agent probe, rendered), Usage (spend, tokens and activity over a range,
 * plus the monthly budget), App (theme, notification switches, the default permission mode for new
 * sessions), Import (transcripts, memory and skills out of the agent CLIs' own stores), Permissions
 * (macOS TCC, honest states only).
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
    <div className="page settings-page-pane wash" style={grainVars("settings-page")}>
      <header className="page-head">
        <span className="page-glyph"><Icon name="settings-page" size={20} /></span>
        <div className="page-title">
          <h1>Settings</h1>
          <span className="page-sub">Engines, spend and usage, app preferences, saved sign-ins, importing from the agent CLIs, and what macOS lets Realm do.</span>
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
          {tab === "usage" && <UsagePanel />}
          {tab === "app" && <AppTab />}
          {tab === "signins" && <SignInsTab />}
          {tab === "import" && <ImportPanel />}
          {tab === "permissions" && <PermissionsTab />}
        </div>
      </div>
    </div>
  );
}

/** A command offered for copying — the install card's affordance, re-rendered. The command travels
 *  to the clipboard verbatim: no trailing newline anywhere near a terminal (typed-never-run).
 *
 *  `action`, when given, is the button that RUNS this exact string. It sits beside the command rather
 *  than replacing it, because the promise the CLI manager makes is that the command is readable
 *  before it is run — a button whose command is hidden behind it would be a different promise. */
function CommandCopy({ command, action }: { command: string; action?: React.ReactNode }) {
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
        data-copied={copied || undefined}
        onClick={() => { void navigator.clipboard?.writeText(command); setCopied(true); }}>
        <Icon name="copy" size={12} className="copy-icon" />
        <Icon name="check" size={12} className="copied-icon" />
      </button>
      {action}
    </div>
  );
}

/**
 * The output pane is scrolled to the tail on every chunk: a package manager's interesting line is
 * almost always its last, and a user watching an install is watching the end of it.
 */
function CliJobPanel({ job, onDismiss }: { job: CliJob; onDismiss: () => void }) {
  const tail = useRef<HTMLPreElement>(null);
  useEffect(() => { const el = tail.current; if (el) el.scrollTop = el.scrollHeight; }, [job.output]);
  const state = job.state === "running" ? "Running…" : job.state === "ok" ? "Finished" : job.error ?? "Failed";
  return (
    <div className="cli-job" data-state={job.state} role="group" aria-label={`${job.command}: ${state}`}>
      <div className="cli-job-head">
        <span className="cli-job-state">{state}</span>
        {/* No dismiss while it runs: hiding a package manager's output while it is still writing to
            the machine is the one moment that output matters most. */}
        {job.state !== "running" && (
          <button type="button" className="btn" onClick={onDismiss}>Dismiss</button>
        )}
      </div>
      <pre className="cli-job-output" ref={tail}>{job.output || "Waiting for output…"}</pre>
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
  const refreshCliStatus = useApp((s) => s.refreshCliStatus);
  const checkForNewModels = useApp((s) => s.checkForNewModels);
  const modelCheck = useApp((s) => s.modelCheck);
  const run = useApp((s) => s.run);
  // Mount rides both server caches — the 30s probe and the six-hour version sweep. Only the buttons
  // force past them, and only the buttons reach the network.
  useEffect(() => { void run(() => probeAgents(false)); void run(() => refreshCliStatus(false)); }, [run, probeAgents, refreshCliStatus]);
  const kinds: AgentKind[] = [...ENGINE_ORDER, ...agentProbe.map((p) => p.kind).filter((k) => !ENGINE_ORDER.includes(k))];
  return (
    <div className="form">
      <div className="engines-head">
        <p className="page-lede">The agent CLIs Realm can run, as they look on this machine right now.</p>
        {/* The named mutant: a cached answer shown as fresh. Both are forced, so what renders after
            a click is what a child process and a registry just reported — never the caches the mount
            ride uses. The probe is forced alongside the status because the two answer different
            halves of a row: the status knows versions, only the probe knows sign-in. */}
        <button type="button" className="btn" onClick={() => run(async () => {
          await Promise.all([probeAgents(true), refreshCliStatus(true)]);
        })}>Check for updates</button>
        {/* Nothing here is a new list Realm made up: it re-asks each provider for the catalog it
            reports live, and refetches the public price rows. */}
        <button type="button" className="btn" onClick={() => run(() => checkForNewModels())}>Check for new models</button>
      </div>
      {modelCheck && (
        <p className="settings-hint" role="status">
          {modelCheck.added.length === 0
            ? "No new models — every provider is reporting the same catalog as before."
            : `New models: ${modelCheck.added.map((m) => `${AGENT_META[m.kind].label} ${m.label}`).join(", ")}.`}
        </p>
      )}
      {agentProbe.length === 0
        ? <p className="env-empty">Checking the installed CLIs…</p>
        : <ul className="page-list engines-list">{kinds.map((k) => <EngineRow key={k} kind={k} />)}</ul>}
    </div>
  );
}

function EngineRow({ kind }: { kind: AgentKind }) {
  const agentProbe = useApp((s) => s.agentProbe);
  const cli = useApp((s) => s.cliStatus).find((r) => r.kind === kind);
  const job = useApp((s) => s.cliJobs[kind]);
  const runCliAction = useApp((s) => s.runCliAction);
  const dismissCliJob = useApp((s) => s.dismissCliJob);
  const run = useApp((s) => s.run);
  const p = agentProbe.find((x) => x.kind === kind);
  const meta = AGENT_META[kind];
  const a = agentAvailability(kind, agentProbe);
  const { install, login } = AGENT_CLI_COMMANDS[kind];
  // The one command a click would run, and the label for the click. The server decided both; the
  // row only renders them, so a button can never offer something the server would refuse.
  const offer = cli && cli.action !== "none" && cli.command
    ? { command: cli.command, action: cli.action, label: cli.action === "install" ? "Install" : "Update" }
    : null;
  const offered = (SELECTABLE_AGENT_KINDS as readonly AgentKind[]).includes(kind);
  // Signed-in identity, exactly as far as the probe carries it: a boolean at best (Claude's keychain
  // and both ACP agents report null = "couldn't tell", which renders as nothing, not as either claim).
  const identity = p?.loggedIn === true ? "signed in" : p?.loggedIn === false ? "signed out" : null;
  // Folded into the status line rather than shown as its own badge: "what version am I on" and "is
  // there a newer one" are one sentence.
  const behind = cli?.updateAvailable && cli.latest ? `${engineVersionLabel(cli.latest)} available` : null;
  const status = !p ? "Checking…"
    : p.available ? ["Installed", p.version ? engineVersionLabel(p.version) : null, identity, behind].filter(Boolean).join(" · ")
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
        {offer
          ? <CommandCopy command={offer.command} action={
              <button type="button" className="btn primary engine-run" disabled={job?.state === "running"}
                onClick={() => run(() => runCliAction(kind, offer.action as "install" | "update"))}>
                {offer.label}
              </button>
            } />
          // No offer: the command is still shown, because a user who must run it themselves needs to
          // read it. This is the whole surface for a kind Realm will not install for them.
          : <>
              {a.state === "missing" && install && <CommandCopy command={install} />}
              {a.state === "logged_out" && login && <CommandCopy command={login} />}
            </>}
        {/* Signing in is never Realm's to run — it is a browser flow or an API key, and a command
            that would sit waiting on a prompt Realm has closed. */}
        {offer && a.state === "logged_out" && login && <CommandCopy command={login} />}
        {/* An update Realm found but will not apply says why, right where the button would be — with
            the copy it is talking about, because "which one?" is the next question for anyone who
            has ended up with two of something on their PATH. */}
        {cli?.refusal && <p className="settings-hint">{cli.refusal}{cli.binPath ? ` (${cli.binPath})` : ""}</p>}
        {job && <CliJobPanel job={job} onDismiss={() => dismissCliJob(kind)} />}
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

/** Opacity ⇄ transparency across the allowed range. Its own involution, so one function serves the
 *  read and the write and the two can never disagree about which end is which. */
const flip = (pct: number): number => GROUND_ALPHA_RANGE.min + GROUND_ALPHA_RANGE.max - pct;

/** Only for the sentence explaining why the transparency control is inert; nothing branches on it. */
const PLATFORM_NAMES: Record<string, string> = { win32: "Windows", linux: "Linux" };

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
  budget: { label: "Spend thresholds", desc: "This month's agent spend passed one of your budget thresholds." },
};

/** The seed a face is really wearing. `seedFor` answers null for an untouched Realm, whose whole
 *  point is to write nothing — but a field showing the current colour and a preview painting it both
 *  need values, and Realm's own seeds are the only honest ones to show. */
function faceSeed(name: ThemeName, face: Mode, override: ThemeOverride | undefined): ThemeSeed {
  return seedFor(name, face, override ?? {}) ?? REALM_SEED[face];
}

/** ...and as the palette it derives to. Realm's face is the static CSS in tokens.css, which a preview
 *  nested in the page cannot reach — `data-mode` only flips the token blocks at `:root` — so it is
 *  derived here like any other palette's. */
function facePalette(name: ThemeName, face: Mode, override: ThemeOverride | undefined, contrast: number): Record<string, string> {
  return deriveVars(faceSeed(name, face, override), face, contrast);
}

/** The window, small enough to read at a glance: the ground, the sidebar over it, two cards and the
 *  accent. Built from the derived palette rather than from swatches, so the thing being previewed is
 *  the arrangement the app actually is and not four dots in a row. */
function MiniWindow({ vars }: { vars: Record<string, string> }) {
  return (
    <span className="mini-window" style={vars as CSSProperties} aria-hidden>
      <span className="mini-sidebar"><i /><i /><i /></span>
      <span className="mini-body"><span className="mini-card"><i /><i className="mini-accent" /></span><span className="mini-card"><i /></span></span>
    </span>
  );
}

/** A diff in the palette on the row above it. The spans carry highlight.js's own class names, which
 *  styles.css already maps onto the ten `--syn-*` roles — so this themes itself off the scope's
 *  custom properties exactly as a real transcript does, and cannot drift from one. */
function CodePreview({ vars }: { vars: Record<string, string> }) {
  return (
    <pre className="code-preview" style={vars as CSSProperties} aria-label="Preview">
      <code>
        <span className="cp-line"><span className="hljs-comment">{"// resolve the palette for this face"}</span></span>
        <span className="cp-line"><span className="hljs-keyword">export function</span>{" "}<span className="hljs-title">paletteFor</span>(<span className="hljs-params">selection</span>: <span className="hljs-type">ThemeSelection</span>) {"{"}</span>
        <span className="cp-line" data-diff="del">  <span className="hljs-keyword">return</span> selection.<span className="hljs-attr">dark</span>;</span>
        <span className="cp-line" data-diff="add">  <span className="hljs-keyword">const</span> name = selection[<span className="hljs-string">&quot;light&quot;</span>];</span>
        <span className="cp-line" data-diff="add">  <span className="hljs-keyword">return</span> faces(name).length &gt; <span className="hljs-number">0</span> ? name : <span className="hljs-string">&quot;realm&quot;</span>;</span>
        <span className="cp-line">{"}"}</span>
      </code>
    </pre>
  );
}

/** One face's palette picker. A card is painted in the palette it names, in the face this row is
 *  for, off the same derivation the app applies — so what is on the card is what the window becomes.
 *  Only palettes with that face are offered: a palette that cannot dress a lit window has no honest
 *  card to show in the light row. */
function PaletteRow({ face, live, selected, onSelect }:
  { face: Mode; live: boolean; selected: ThemeName; onSelect: (name: ThemeName) => void }) {
  const offered = THEMES.filter((t) => themeModes(t.name).includes(face));
  const palette = offered.find((t) => t.name === selected) ?? THEMES[0]!;
  // The preview is of the palette AS EDITED, at the contrast in force — a preview of something other
  // than what the window will do is worse than no preview.
  const override = useApp((s) => s.themeOverrides[overrideKey(palette.name, face)]);
  const contrast = useApp((s) => s.contrast);
  return (
    <div className="field" data-live={live || undefined}>
      <span>{face === "light" ? "Light theme" : "Dark theme"}</span>
      <fieldset className="theme-grid" aria-label={face === "light" ? "Light theme" : "Dark theme"}>
        {offered.map((t) => {
          const [page, surface, accent, string, line] = themeSwatches(t.name, face);
          return (
            <label key={t.name} className="theme-card" data-selected={selected === t.name || undefined}
              style={{ background: page, borderColor: surface }}>
              <input type="radio" name={`settings-palette-${face}`} value={t.name} checked={selected === t.name}
                onChange={() => onSelect(t.name)} />
              <span className="theme-card-swatches" aria-hidden>
                {[surface, accent, string].map((c, i) => <span key={i} style={{ background: c, boxShadow: `0 0 0 1px ${line}` }} />)}
              </span>
              <span className="theme-card-name" style={{ color: accent }}>{t.label}</span>
            </label>
          );
        })}
      </fieldset>
      <p className="settings-hint">{palette.blurb}{palette.credit ? ` ${palette.credit}.` : ""}</p>
      <CodePreview vars={facePalette(palette.name, face, override, contrast)} />
      <ThemeOverrideEditor name={palette.name} face={face} />
    </div>
  );
}

/** The three seeds that decide what a palette feels like — its paper, its text and its one hue.
 *  Edits go into the SEED and back through the same derivation a vendored palette goes through, so a
 *  moved background gets the surface ladder, the ink ramp and the contrast correction rather than a
 *  raw value written past all three. */
const OVERRIDE_FIELDS = [
  { role: "accent", label: "Accent" }, { role: "bg", label: "Background" }, { role: "ink", label: "Foreground" },
] as const;

function ThemeOverrideEditor({ name, face }: { name: ThemeName; face: Mode }) {
  const override = useApp((s) => s.themeOverrides[overrideKey(name, face)]);
  const contrast = useApp((s) => s.contrast);
  const setThemeOverride = useApp((s) => s.setThemeOverride);
  const resetThemeOverride = useApp((s) => s.resetThemeOverride);
  const run = useApp((s) => s.run);
  const [copied, setCopied] = useState(false);
  const [importing, setImporting] = useState(false);
  const [rejected, setRejected] = useState<string | null>(null);
  const paste = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const seed = faceSeed(name, face, override);
  // Measured at the contrast the app is actually running at, not at the default — the ramp's spread
  // is one of the things a tier's ratio depends on, and a warning computed against a setting the
  // user is not using would name the wrong roles.
  const misses = contrastMisses(seed, face, contrast);
  const label = THEMES.find((t) => t.name === name)?.label ?? name;

  return (
    <fieldset className="theme-overrides" aria-label={`${face === "light" ? "Light" : "Dark"} theme colours`}>
      {OVERRIDE_FIELDS.map(({ role, label }) => (
        <label key={role} className="theme-override">
          <span>{label}</span>
          <input type="color" aria-label={`${label} colour`} value={seed[role]}
            onChange={(e) => run(() => setThemeOverride(name, face, { [role]: e.target.value }))} />
          {/* Text as well as a swatch: a hex is a value you paste from somewhere else, and the OS
              colour picker cannot be typed into. Committed on blur/Enter rather than per keystroke —
              every prefix of a hex is a different colour, and "#f" would repaint the window red on
              the way to "#f92672". */}
          <input type="text" className="hex" aria-label={`${label} hex`} defaultValue={seed[role]} key={seed[role]}
            spellCheck={false} maxLength={7}
            onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
            onBlur={(e) => {
              const hex = e.target.value.trim();
              if (isHexColour(hex)) run(() => setThemeOverride(name, face, { [role]: hex }));
              else e.target.value = seed[role];
            }} />
        </label>
      ))}
      {isOverridden(override) && (
        <button type="button" className="btn-quiet" onClick={() => run(() => resetThemeOverride(name, face))}>
          Reset to {label}
        </button>
      )}
      {/* Copy emits the face AS EDITED, so what lands on the clipboard is what is on screen — the
          palette's own seeds under a set of overrides would be a theme the user was not looking at. */}
      <button type="button" className="btn-quiet"
        onClick={() => { void navigator.clipboard?.writeText(exportTheme(label, face, seed)); setCopied(true); }}>
        {copied ? "Copied" : "Copy theme"}
      </button>
      <button type="button" className="btn-quiet" aria-expanded={importing}
        onClick={() => { setImporting((o) => !o); setRejected(null); }}>Import</button>
      {importing && (
        // A paste box rather than a button that reads the clipboard: a rejection has to be shown
        // beside the thing that was rejected, and reaching for the clipboard on a click is a
        // permission prompt in exchange for one saved keystroke.
        <div className="theme-import">
          <textarea aria-label="Theme to import" spellCheck={false} rows={4}
            placeholder={`{ "realmTheme": 1, "name": …, "mode": "${face}", "seed": { … } }`}
            onChange={() => setRejected(null)} ref={paste} />
          <div className="theme-import-actions">
            <button type="button" className="btn" onClick={() => {
              const result = importTheme(paste.current?.value ?? "", face);
              if (!result.ok) { setRejected(result.reason); return; }
              setRejected(null); setImporting(false);
              run(() => setThemeOverride(name, face, { ...result.doc.seed }));
            }}>Apply</button>
            {rejected && <p className="settings-hint" data-tone="danger">{rejected}</p>}
          </div>
        </div>
      )}
      {/* Named, not corrected. The ground and the ink are the two seeds nothing lifts — moving them
          silently to clear a floor hands back a theme the user did not pick — and a hue that misses
          after its whole lift budget is one this ramp cannot carry. Either way the useful thing to
          show is which colour, and by how much. */}
      {misses.length > 0 && (
        <p className="settings-hint" data-tone="warn">
          {`Below the contrast Realm holds every palette to: ${misses.map((m) => `${m.role} ${m.ratio.toFixed(1)}:1 (needs ${m.floor}:1)`).join(", ")}.`}
        </p>
      )}
    </fieldset>
  );
}

function AppTab() {
  const themePref = useApp((s) => s.themePref);
  const setThemePref = useApp((s) => s.setThemePref);
  const themeNames = useApp((s) => s.themeNames);
  const themeOverrides = useApp((s) => s.themeOverrides);
  const setThemeName = useApp((s) => s.setThemeName);
  const contrast = useApp((s) => s.contrast);
  const setContrast = useApp((s) => s.setContrast);
  const fonts = useApp((s) => s.fonts);
  const setFonts = useApp((s) => s.setFonts);
  const groundAlpha = useApp((s) => s.groundAlpha);
  const setGroundAlpha = useApp((s) => s.setGroundAlpha);
  const submitKey = useApp((s) => s.submitKey);
  const setSubmitKey = useApp((s) => s.setSubmitKey);
  const prefs = useApp((s) => s.settingsPrefs);
  const refreshSettingsPrefs = useApp((s) => s.refreshSettingsPrefs);
  const setNotificationCategoryEnabled = useApp((s) => s.setNotificationCategoryEnabled);
  // Not part of `settingsPrefs`: this one is loaded at boot (the first toast can beat a visit here),
  // so it is never null and the row never renders a loading state the others need.
  const desktopNotifications = useApp((s) => s.desktopNotifications);
  const setDesktopNotifications = useApp((s) => s.setDesktopNotifications);
  const soundCues = useApp((s) => s.soundCues);
  const soundVolume = useApp((s) => s.soundVolume);
  const setSoundCues = useApp((s) => s.setSoundCues);
  const setSoundVolume = useApp((s) => s.setSoundVolume);
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

  // The face on screen. Both slots are always editable — the point of two is that you set the one
  // you are not looking at — so this only decides which row is marked as the live one.
  const mode = useResolvedMode(themePref);
  const material = hasWindowMaterial();
  const translucent = groundAlpha < GROUND_ALPHA_RANGE.max;

  const supported = SELECTABLE_AGENT_KINDS.filter((k) => AGENT_SUPPORTS_PERMISSION_MODES[k]);
  const unsupported = SELECTABLE_AGENT_KINDS.filter((k) => !AGENT_SUPPORTS_PERMISSION_MODES[k]);
  const labels = (ks: readonly AgentKind[]) => ks.map((k) => AGENT_META[k].label).join(", ");

  return (
    <div className="form">
      <div className="field"><span>Theme</span>
        {/* A card per choice, each showing the window it produces. "System" shows both faces because
            that is what choosing it means — the card cannot promise which one you will get. */}
        <fieldset className="mode-grid" aria-label="Theme">
          {THEME_CHOICES.map((t) => (
            <label key={t.pref} className="mode-card" data-selected={themePref === t.pref || undefined}>
              <input type="radio" name="settings-theme" value={t.pref} checked={themePref === t.pref}
                onChange={() => run(() => setThemePref(t.pref))} />
              <span className="mode-card-preview" data-split={t.pref === "system" || undefined}>
                {(t.pref === "system" ? (["light", "dark"] as const) : [t.pref as Mode]).map((face) => (
                  <MiniWindow key={face} vars={facePalette(paletteFor(themeNames, face), face, themeOverrides[overrideKey(paletteFor(themeNames, face), face)], contrast)} />
                ))}
              </span>
              <span className="mode-card-name">{t.label}</span>
            </label>
          ))}
        </fieldset>
        {/* One line, not a switch (Plan 14 W5): the OS setting is the control, and styles.css's global
            prefers-reduced-motion kill is what makes this sentence true. */}
        <p className="settings-hint">Realm follows the system's Reduce Motion setting everywhere — with it on, animations and transitions are disabled app-wide.</p>
      </div>

      {/* A row per face, both always editable: setting the one you are NOT looking at is the whole
          reason there are two. `data-live` marks the one on screen so the window and the page agree
          about which row explains what is in front of you. */}
      {(["light", "dark"] as const).map((face) => (
        <PaletteRow key={face} face={face} live={face === mode} selected={themeNames[face]}
          onSelect={(name) => run(() => setThemeName(face, name))} />
      ))}

      <div className="field"><span>UI font</span>
        {/* Two families, not four hundred. Enumerating installed fonts needs a main-process hop and
            returns mostly faces this layout cannot use — the chrome is set against a four-step weight
            ladder and tabular figures, and a display face picked out of a long list loses both
            silently. The bundled faces are guaranteed to be present and to have those axes; the
            system stack is for someone who would rather Realm looked like the rest of their machine. */}
        <div className="font-row">
          <select aria-label="UI font" value={fonts.ui} onChange={(e) => run(() => setFonts({ ui: e.target.value as FontId }))}>
            {FONT_FACES.ui.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <select aria-label="UI font weight" value={fonts.uiWeight}
            onChange={(e) => run(() => setFonts({ uiWeight: e.target.value as FontWeight }))}>
            {FONT_WEIGHTS.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
          </select>
        </div>
      </div>

      <div className="field"><span>Code font</span>
        <div className="font-row">
          <select aria-label="Code font" value={fonts.code} onChange={(e) => run(() => setFonts({ code: e.target.value as FontId }))}>
            {FONT_FACES.code.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </div>
        {/* The asymmetry is a fact about the stylesheet, not a judgement: every mono surface sets its
            font with the `font:` shorthand, which resets weight by definition, so a code weight would
            mean editing fifty-odd rules or hiding a weight inside a family name. */}
        <p className="settings-hint">Code, diffs, terminals and keyboard hints. Weight follows the app's own scale here — the UI weight above is the one control over it. Open terminals change face with the setting; their font size does not follow it.</p>
      </div>

      <div className="field"><span>Contrast</span>
        {/* The ink ramp's SPREAD — how far the secondary and hint tiers fall below primary text. It
            is the only thing in the palette that is a matter of eyes rather than of design: the hues
            are the palette's identity and the surfaces are its structure, and a slider that moved
            either would be a repaint wearing the word "contrast". It cannot make anything illegible
            at any setting, because every tier is floored at WCAG before the ramp is walked. */}
        <div className="slider-row">
          <input type="range" aria-label="Contrast"
            min={CONTRAST_RANGE.min} max={CONTRAST_RANGE.max} step={1}
            value={contrast} onChange={(e) => run(() => setContrast(Number(e.target.value)))} />
          <span className="slider-value">{contrast}</span>
        </div>
        <p className="settings-hint">How far labels, metadata and hints sit below primary text. Every tier stays above the contrast Realm holds its palettes to, whatever this says — turning it down recedes them, it does not make them unreadable.</p>
      </div>

      <div className="field"><span>Translucent sidebar</span>
        {/* A switch and an amount over ONE stored number, not two controls that can disagree: fully
            opaque IS off, because covering the material completely is the same as not having asked
            for it. So the switch reads `groundAlpha < max` and writes either the maximum or the
            default, and the slider is inert while it is off — nothing here can put the app in a
            state where the switch says one thing and the amount another.
            The slider runs the way its label reads — right is MORE transparent — while the stored
            value is the ground's OPACITY, because that is what the stylesheet composes. `flip` is the
            one place the two meet. step 1, not a coarser grid: the range spans an odd number of
            points, so any step above 1 leaves one of its two ends unreachable. */}
        <div className="slider-row">
          <input type="checkbox" role="switch" className="switch" aria-label="Translucent sidebar"
            disabled={!material} checked={translucent}
            onChange={(e) => run(() => setGroundAlpha(e.target.checked ? DEFAULT_GROUND_ALPHA : GROUND_ALPHA_RANGE.max))} />
          <input type="range" aria-label="Background transparency" disabled={!material || !translucent}
            min={GROUND_ALPHA_RANGE.min} max={GROUND_ALPHA_RANGE.max} step={1}
            value={flip(groundAlpha)} onChange={(e) => run(() => setGroundAlpha(flip(Number(e.target.value))))} />
          <span className="slider-value">{100 - groundAlpha}%</span>
        </div>
        <p className="settings-hint">{material
          ? "The sidebar is the one surface thin enough to show the desktop behind the window. Panes stay opaque on purpose — at any setting where a pane looked translucent, text on it would fall below the contrast every theme here is held to. Realm also follows the system's Reduce Transparency setting: with it on the sidebar is opaque whatever this says, and your value comes back when you turn it off."
          : `${PLATFORM_NAMES[window.realm?.platform ?? ""] ?? "This platform"} has no window material — the window is opaque, so there is nothing behind the sidebar to reveal. The setting is kept and applies on a Mac.`}</p>
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

      <div className="field"><span>Desktop notifications</span>
        <ul className="settings-list">
          <li className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-name">Notify me outside Realm</span>
              <span className="settings-row-desc">Post a system notification, and count unread ones on the dock icon.</span>
            </div>
            <input type="checkbox" role="switch" className="switch" aria-label="Notify me outside Realm"
              checked={desktopNotifications}
              onChange={(e) => run(() => setDesktopNotifications(e.target.checked))} />
          </li>
          {/* Nested under the switch above, and inert while it is off, because the sound is part of a
              notification rather than a second way of being told: it plays only alongside one that
              was actually posted. */}
          <li className="settings-row">
            <div className="settings-row-main">
              <span className="settings-row-name">Play a sound with it</span>
              <span className="settings-row-desc">One cue when a turn finishes, another when an agent is waiting on you.</span>
            </div>
            <input type="checkbox" role="switch" className="switch" aria-label="Play a sound with it"
              disabled={!desktopNotifications} checked={soundCues}
              onChange={(e) => run(() => setSoundCues(e.target.checked))} />
          </li>
        </ul>
        <div className="slider-row">
          <input type="range" aria-label="Sound volume" disabled={!desktopNotifications || !soundCues}
            min={0} max={100} step={5}
            value={Math.round(soundVolume * 100)}
            onChange={(e) => run(() => setSoundVolume(Number(e.target.value) / 100))} />
          <span className="slider-value">{Math.round(soundVolume * 100)}%</span>
        </div>
        <p className="settings-hint">Only when Realm is not the app you are in — a notification for something already on your screen is noise. Clicking one opens the session it came from. The categories below decide what counts; this decides whether it leaves the app. The sound follows your Mac's volume, so muting the machine mutes it.</p>
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


/** How long one Touch ID check licenses further fills. "Every time" is the default and the honest
 *  one; the windows exist because an SSO sign-in is often two fills a few seconds apart. */
const PRESENCE_TTL_LABELS: Record<number, string> = { 0: "Every time", 60_000: "For 1 minute", 300_000: "For 5 minutes" };

/**
 * Settings → Sign-ins: the ONE place a browser credential can be created.
 *
 * That is a security property, not a UI choice, and it is why this is a plain form with a native
 * password field rather than anything cleverer. There is no tool, no RPC method, no file importer and
 * no chat path that reaches `addCredential` — so an agent cannot enroll a credential for the origin
 * it is currently standing on and then ask to have it filled, which is the attack the origin gate
 * would otherwise be powerless against.
 *
 * The list is metadata: origin, username, label. There is no reveal button and no edit-in-place for
 * the value, because main has no method that would answer one. Changing a password means saving a new
 * sign-in and removing the old.
 */
function SignInsTab() {
  const credentials = useApp((s) => s.credentials);
  const status = useApp((s) => s.credentialStatus);
  const refreshCredentials = useApp((s) => s.refreshCredentials);
  const addCredential = useApp((s) => s.addCredential);
  const removeCredential = useApp((s) => s.removeCredential);
  const setCredentialPresenceTtl = useApp((s) => s.setCredentialPresenceTtl);
  const run = useApp((s) => s.run);
  useEffect(() => { void run(() => refreshCredentials()); }, [run, refreshCredentials]);

  const [origin, setOrigin] = useState("");
  const [username, setUsername] = useState("");
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const canSave = origin.trim() !== "" && value !== "" && !saving;

  async function save() {
    setError(null);
    setSaving(true);
    try {
      await addCredential({ origin: origin.trim(), username: username.trim(), label: label.trim(), value });
      // Cleared on success AND only on success: a rejected save keeps what the user typed so they can
      // fix the address without retyping the password.
      setOrigin(""); setUsername(""); setLabel(""); setValue("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "That sign-in could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="form">
      <p className="page-lede">
        Sign-ins you save here can be typed into a page by an agent that never sees them. Realm checks
        the page is really on the site you saved the sign-in for, asks you to approve that specific
        fill, and asks for Touch ID — every time.
      </p>

      {status !== null && !status.available && (
        <p className="settings-hint" role="alert">
          macOS isn't offering Realm an encryption key right now, so sign-ins can't be saved. Realm
          won't store one unencrypted.
        </p>
      )}
      {status !== null && status.available && !status.canPromptTouchID && (
        <p className="settings-hint" role="alert">
          This Mac has no Touch ID sensor. Sign-ins can be saved, but filling one always needs Touch ID,
          so fills will be refused here.
        </p>
      )}

      <div className="field"><span>Saved sign-ins</span>
        {credentials === null ? <p className="env-empty">Loading…</p> : credentials.length === 0 ? (
          <p className="env-empty">No saved sign-ins yet.</p>
        ) : (
          <ul className="settings-list">
            {credentials.map((c) => (
              <li key={c.id} className="settings-row" aria-label={`${c.origin}${c.username ? `: ${c.username}` : ""}`}>
                <div className="settings-row-main">
                  <span className="settings-row-name">{c.origin}</span>
                  <span className="settings-row-desc">{[c.username, c.label].filter(Boolean).join(" · ") || "No username or label"}</span>
                </div>
                <button type="button" className="btn-quiet" onClick={() => run(() => removeCredential(c.id))}>Remove</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="field"><span>Add a sign-in</span>
        <label className="settings-input-label">Site address
          <input type="url" inputMode="url" placeholder="https://example.com" value={origin}
            onChange={(e) => setOrigin(e.target.value)} />
        </label>
        <label className="settings-input-label">Username
          <input type="text" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="settings-input-label">Label
          <input type="text" autoComplete="off" placeholder="Work account" value={label}
            onChange={(e) => setLabel(e.target.value)} />
        </label>
        {/* A real password input: masked by the OS, excluded from autofill managers, and — because
            nothing reads it back — write-only from the moment it is saved. */}
        <label className="settings-input-label">Password
          <input type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {error !== null && <p className="settings-hint" role="alert">{error}</p>}
        <button type="button" className="btn-quiet" disabled={!canSave} onClick={() => { void save(); }}>
          {saving ? "Saving…" : "Save sign-in"}
        </button>
        <p className="settings-hint">
          Realm pins the sign-in to exactly this address. A sign-in saved for https://example.com will
          not fill on https://login.example.com or on any lookalike — subdomains are different sites.
        </p>
      </div>

      <div className="field"><span>Touch ID</span>
        <fieldset className="settings-tabs" aria-label="Ask for Touch ID">
          {CREDENTIAL_PRESENCE_TTLS.map((ms) => (
            <label key={ms} className="settings-tab" data-selected={status?.presenceTtlMs === ms || undefined}>
              <input type="radio" name="settings-credential-ttl" value={ms} checked={status?.presenceTtlMs === ms}
                onChange={() => run(() => setCredentialPresenceTtl(ms))} />
              {PRESENCE_TTL_LABELS[ms]}
            </label>
          ))}
        </fieldset>
        <p className="settings-hint">
          A window only starts after a successful check, and never survives quitting Realm. Signing in
          is often two fills a few seconds apart, which is what the windows are for.
        </p>
      </div>

      <div className="field"><span>What Realm can't do</span>
        <p className="settings-hint">{CREDENTIAL_2FA_NOTE}</p>
        <p className="settings-hint">{CREDENTIAL_STORAGE_NOTE}</p>
      </div>
    </div>
  );
}

/** Why the Updates button is disabled, in words — one honest sentence per gate reason (Plan 15 W1).
 *  The reasons are main's (updater.ts): the renderer names them, it never decides them. */
export const UPDATE_DISABLED_COPY = {
  dev: "Update checks don't run in development builds.",
  unsigned: "Updates unavailable: unsigned build — macOS can only install a signed update. Signing steps: docs/dev/signing.md.",
  "no-feed": "Updates unavailable: this build has no public update feed. See README → Updates.",
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
    : "Realm checks for updates on launch. You can also check now.";
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
      <ComputerAccessSection />
      <MacAccessSection />
      <RealmAccessSection />
    </div>
  );
}

/**
 * "Computer control" — the two grants the `realm-computer` tools need, and the only rows on this
 * page whose buttons can raise a prompt for Realm ITSELF (the "Apps on this Mac" rows prompt on the
 * `mac` CLI's behalf; "Realm's own access" only ever reads).
 *
 * The button says "Ask macOS", not "Grant", because that is all it can do: for both of these macOS
 * shows a dialog that only deep-links to System Settings, and the state does not change until the
 * user flips the switch there. Saying otherwise would make the page look broken when the row stays
 * red after a click.
 */
function ComputerAccessSection() {
  const status = useApp((s) => s.computerAccess);
  const requesting = useApp((s) => s.computerRequesting);
  const refreshComputerAccess = useApp((s) => s.refreshComputerAccess);
  const requestComputerAccess = useApp((s) => s.requestComputerAccess);
  const openComputerAccessPane = useApp((s) => s.openComputerAccessPane);
  const run = useApp((s) => s.run);
  useEffect(() => { void run(() => refreshComputerAccess()); }, [run, refreshComputerAccess]);

  return (
    <div className="field computer-access-field"><span>Computer control</span>
      <p className="settings-hint">
        What agents need to read and drive other apps on this Mac. Off until you switch it on for a space, and every
        action against an app asks you first.
      </p>
      {status === null ? <p className="env-empty">Checking…</p> : (
        <>
          {!status.helperAvailable && (
            <p className="settings-hint">This build has no accessibility helper, so computer control is unavailable whatever macOS has granted.</p>
          )}
          {!status.packaged && (
            <p className="settings-hint">Running from source: macOS will attribute these grants to “{status.hostName}”, not to Realm.app — they will not carry into a packaged build.</p>
          )}
          <ul className="settings-list">
            {status.rows.map((r) => (
              <li key={r.id} className="settings-row tcc-row" aria-label={`${r.label}: ${TCC_STATE_LABEL[r.state]}`}>
                <div className="settings-row-main">
                  <span className="settings-row-name">{r.label}</span>
                  <span className="tcc-state" data-state={r.state}>
                    {r.state === "granted" && <Icon name="check" size={12} />}
                    {TCC_STATE_LABEL[r.state]}
                  </span>
                  <span className="settings-row-desc">{r.detail}</span>
                  {r.askExplanation && <span className="settings-row-desc">{r.askExplanation}</span>}
                </div>
                <div className="mac-row-actions">
                  {r.canPrompt && (
                    <button type="button" className="btn-quiet" disabled={requesting !== null}
                      onClick={() => run(() => requestComputerAccess(r.id))}>
                      {requesting === r.id ? "Waiting for macOS…" : "Ask macOS"}
                    </button>
                  )}
                  {r.needsSettings && (
                    <button type="button" className="btn-quiet" onClick={() => run(() => openComputerAccessPane(r.id))}>Open System Settings</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
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
