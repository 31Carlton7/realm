import { PageScroll } from "../../components/ScrollFades";
import {
  AGENT_CLI_COMMANDS, AGENT_LOGIN_HINTS, AGENT_META, AGENT_SUPPORTS_PERMISSION_MODES,
  CREDENTIAL_2FA_NOTE, CREDENTIAL_PRESENCE_TTLS, CREDENTIAL_STORAGE_NOTE, NOTIFICATION_CATEGORIES,
  PERMISSION_MODES, SELECTABLE_AGENT_KINDS, TERMINALS_HISTORY_COPY, type AgentKind, type MidTurnMode, type NotificationCategory,
} from "@realm/contracts";
import { CONTRAST_RANGE, DEFAULT_GROUND_ALPHA, FONT_FACES, FONT_WEIGHTS, GROUND_ALPHA_RANGE, Icon, REALM_SEED,
  THEMES, contrastMisses, deriveVars, exportTheme, importTheme, isHexColour, isOverridden, overrideKey,
  allThemes, paletteFor, seedFor, themeModes, themeSwatches,
  type FontId, type FontRole, type FontWeight, type Mode, type ThemeName, type ThemeOverride } from "@realm/ui";
import type { ThemeSeed } from "@realm/contracts";
import { useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import { Sheet } from "../../components/Sheet";
import { Spinner } from "../../components/Spinner";
import { agentAvailability, isBlocked } from "../../state/agent-availability";
import { useApp, type CliJob, type SubmitKey } from "../../state/store";
import type { PaneProps } from "../registry";
import { hasWindowMaterial, useResolvedMode, type ThemePref } from "../../theme/useTheme";
import { ImportPanel } from "../../components/settings/ImportPanel";
import { UsagePanel } from "./usage/UsagePanel";
import { FailoverPanel } from "./FailoverPanel";
import { Signature } from "./Signature";
import { KeybindingsPanel } from "../../components/settings/KeybindingsPanel";

type SettingsTab = "engines" | "usage" | "app" | "keys" | "signins" | "import" | "permissions";
const TABS: { id: SettingsTab; label: string }[] = [
  { id: "engines", label: "Engines" }, { id: "usage", label: "Usage" }, { id: "app", label: "App" }, { id: "keys", label: "Keys" },
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
    <div className="page settings-page-pane">
      <header className="page-head">
        <div className="page-title"><h1>Settings</h1></div>
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
        {/* Both ends dissolve, but only when there is something under them — and only over the
            column. The rail is a sibling of the wrapper rather than a thing under a band: a blurred
            tab row reads as a rendering fault, and it is the one row that has to stay legible while
            the content beneath it scrolls. */}
        <PageScroll>
          {tab === "engines" && <EnginesTab />}
          {tab === "usage" && <UsagePanel />}
          {tab === "app" && <AppTab />}
          {tab === "keys" && <KeybindingsPanel />}
          {tab === "signins" && <SignInsTab />}
          {tab === "import" && <ImportPanel />}
          {tab === "permissions" && <PermissionsTab />}
        </PageScroll>
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
  /** Which check is in flight, so its own button can say so and neither can be double-fired. */
  const [checking, setChecking] = useState<"updates" | "models" | null>(null);
  // Mount rides both server caches — the 30s probe and the six-hour version sweep. Only the buttons
  // force past them, and only the buttons reach the network.
  useEffect(() => { void run(() => probeAgents(false)); void run(() => refreshCliStatus(false)); }, [run, probeAgents, refreshCliStatus]);
  const kinds: AgentKind[] = [...ENGINE_ORDER, ...agentProbe.map((p) => p.kind).filter((k) => !ENGINE_ORDER.includes(k))];
  return (
    <div className="form">
      {/* No lede. "The agent CLIs Realm can run" is what the tab is called and what the cards below
          plainly are; a sentence restating a page's own name is the chrome this pass removed
          everywhere else. */}
      <div className="engines-head">
        {/* The named mutant: a cached answer shown as fresh. Both are forced, so what renders after
            a click is what a child process and a registry just reported — never the caches the mount
            ride uses. The probe is forced alongside the status because the two answer different
            halves of a row: the status knows versions, only the probe knows sign-in. */}
        <button type="button" className="btn" disabled={checking === "updates"}
          onClick={() => run(async () => {
            setChecking("updates");
            try { await Promise.all([probeAgents(true), refreshCliStatus(true)]); }
            finally { setChecking(null); }
          })}>
          {/* The button says what it is doing while it does it. Both calls shell out to child
              processes and a registry, which on a cold machine is seconds — long enough that a
              button which only ever looked idle read as one that had not registered the click. */}
          {checking === "updates" && <Spinner size={12} />}
          {checking === "updates" ? "Checking…" : "Check for updates"}
        </button>
        {/* Nothing here is a new list Realm made up: it re-asks each provider for the catalog it
            reports live, and refetches the public price rows. */}
        <button type="button" className="btn" disabled={checking === "models"}
          onClick={() => run(async () => {
            setChecking("models");
            try { await checkForNewModels(); } finally { setChecking(null); }
          })}>
          {checking === "models" && <Spinner size={12} />}
          {checking === "models" ? "Checking…" : "Check for new models"}
        </button>
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
        : <ul className="engines-list">{kinds.map((k) => <EngineCard key={k} kind={k} />)}</ul>}
      {/* Directly under the engine list, because it is a statement ABOUT that list: which of these
          may take over when the one a session is on cannot finish. */}
      <h3 className="settings-head">Failover</h3>
      <FailoverPanel />
    </div>
  );
}

/**
 * One engine, as a card.
 *
 * It was a flat row that flattened four different questions into one run-on sentence — "Installed ·
 * 0.146.0 · signed in · v0.153.4 available" — and then, for anything not ready, stacked a command
 * block and up to three explanatory paragraphs underneath it. With twelve engines and most of them
 * not installed, that is the wall of text this page was.
 *
 * Two changes carry the redesign. The facts split into a status pill and small labelled chips, so
 * "is it there", "which version", "am I signed in" and "is there a newer one" are four things you
 * can find rather than one sentence you have to parse. And the prose — install commands, login
 * hints, probe reasons — folds behind a disclosure, opened by default only when the engine needs
 * something from you. A ready engine is one line; a broken one still explains itself in full.
 */
function EngineCard({ kind }: { kind: AgentKind }) {
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
  // card only renders them, so a button can never offer something the server would refuse.
  /* Three offers, not two. An update with a known newer version NAMES it and takes the primary
     button. An update where nothing newer is known is the CLI's own updater — five of them ship one,
     and it resolves latest against the vendor's channel rather than the npm registry Realm watches,
     which is the only channel cursor-agent has at all. That one is a quiet button and says what it
     really does: it goes and looks. Calling it "Update" would promise an update nobody has found. */
  const offer = cli && cli.action !== "none" && cli.command
    ? {
        command: cli.command,
        action: cli.action,
        label: cli.action === "install" ? "Install"
          : cli.updateAvailable && cli.latest ? `Update to ${engineVersionLabel(cli.latest)}`
          : "Check for updates",
        primary: cli.action === "install" || cli.updateAvailable,
      }
    : null;
  const offered = (SELECTABLE_AGENT_KINDS as readonly AgentKind[]).includes(kind);
  const blocked = isBlocked(a) && kind !== "fake";
  const state = !p ? "unknown" : !p.available ? "missing" : p.loggedIn === false ? "logged_out" : "ready";
  const STATE_LABEL = { unknown: "Checking…", missing: "Not installed", logged_out: "Signed out", ready: "Ready" };

  /* The facts, as chips. Each is a separate answer, and only the ones there is an answer FOR are
     drawn — an engine that is not installed has no version, and a probe that could not tell whether
     you are signed in (Claude's keychain, every ACP agent) says nothing rather than guessing. */
  const chips: { label: string; tone?: "warn" }[] = [];
  if (p?.available && p.version) chips.push({ label: engineVersionLabel(p.version) });
  if (p?.loggedIn === true) chips.push({ label: "Signed in" });
  if (!offered && kind !== "fake") chips.push({ label: "Not offered for new sessions" });
  /* An update Realm can APPLY gets the primary button in the head. One it cannot — a Homebrew or a
     hand-built install, where running npm would leave a second copy on the PATH — gets a button too,
     because "there is a newer version" with no affordance beside it reads as a dead end. That one
     opens the card's own details, which hold the command and the reason. */
  const update = cli?.updateAvailable && cli.latest ? engineVersionLabel(cli.latest) : null;

  // Everything wordy. Open by default only when the engine needs something FROM YOU — a job in
  // flight, or a block to clear. Deliberately not a refusal: "there is a newer version and Realm
  // will not install it for you" is worth knowing and not worth two sentences of your attention
  // unprompted, and the chip above already says a newer version exists.
  const [openDetails, setOpenDetails] = useState(false);
  const details = [
    offer ? "offer" : null,
    !offer && a.state === "missing" && install ? "install" : null,
    a.state === "logged_out" && login ? "login" : null,
    cli?.refusal ? "refusal" : null,
    blocked ? "hint" : null,
    p && !p.available && p.reason ? "reason" : null,
  ].filter(Boolean);
  const wantsYou = Boolean(job) || blocked;

  return (
    <li className="engine-card" aria-label={`${meta.label}: ${STATE_LABEL[state]}`} data-state={state}>
      <div className="engine-head">
        <span className="engine-mark"><Icon name={meta.icon} size={20} colored /></span>
        <span className="engine-name">{meta.label}</span>
        <span className="engine-pill" data-state={state}>{STATE_LABEL[state]}</span>
        {offer ? (
          <button type="button" className={`btn engine-run${offer.primary ? " primary" : ""}`} disabled={job?.state === "running"}
            onClick={() => run(() => runCliAction(kind, offer.action as "install" | "update"))}>
            {job?.state === "running" && <Spinner size={12} />}
            {job?.state === "running" ? "Working…" : offer.label}
          </button>
        ) : update ? (
          <button type="button" className="btn engine-run" onClick={() => setOpenDetails(true)}>
            Update to {update}
          </button>
        ) : null}
      </div>
      {chips.length > 0 && (
        <div className="engine-chips">
          {chips.map((c) => <span key={c.label} className="engine-chip" data-tone={c.tone}>{c.label}</span>)}
        </div>
      )}
      {details.length > 0 && (
        <details className="engine-details" open={wantsYou || openDetails || undefined}
          onToggle={(e) => setOpenDetails((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>{blocked ? "What to do" : "Details"}</summary>
          <div className="engine-details-body">
            {offer && <CommandCopy command={offer.command} />}
            {!offer && a.state === "missing" && install && <CommandCopy command={install} />}
            {/* Signing in is never Realm's to run — it is a browser flow or an API key, and a command
                that would sit waiting on a prompt Realm has closed. */}
            {a.state === "logged_out" && login && <CommandCopy command={login} />}
            {/* An update Realm found but will not apply says why, with the copy it is talking about —
                "which one?" is the next question for anyone with two of something on their PATH. */}
            {cli?.refusal && <p className="settings-hint">{cli.refusal}{cli.binPath ? ` (${cli.binPath})` : ""}</p>}
            {/* The login hint on ANY blocked card, not just un-offered ones. It used to hang off
                `!offered`, which held only while every kind with something awkward to explain was
                also withheld. Gemini broke that when it was offered again: `login` is null for it
                (it needs an API key, Vertex credentials, or a gateway), so the card would have gone
                from a full explanation to nothing but "Not installed". */}
            {blocked && <p className="settings-hint">{AGENT_LOGIN_HINTS[kind]}</p>}
            {p && !p.available && p.reason && <p className="settings-hint">{p.reason}</p>}
          </div>
        </details>
      )}
      {job && <CliJobPanel job={job} onDismiss={() => dismissCliJob(kind)} />}
    </li>
  );
}


/**
 * A range input whose FILL is drawn by us.
 *
 * `accent-color` fills a native track but leaves its geometry alone, and `appearance: none` gives
 * back the geometry but takes the fill with it. Neither alone produces a track that matches the rest
 * of the app, so the filled portion rides a CSS variable computed here — from the same three numbers
 * the input itself is given, so the paint and the value cannot disagree.
 */
function Slider({ value, min, max, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { value: number; min: number; max: number }) {
  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return <input type="range" {...rest} min={min} max={max} value={value}
    style={{ "--fill": `${pct}%` } as React.CSSProperties} />;
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

/** Named for what happens to the MESSAGE, not for the mechanism: "steer" is the word the adapters and
 *  `AGENT_MIDTURN_DELIVERY` use, and it says nothing to someone who has not read them. */
const MID_TURN_CHOICES: { mode: MidTurnMode; label: string }[] = [
  { mode: "queue", label: "Waits its turn" }, { mode: "steer", label: "Sends now" },
];

/** Human words for W5's notification categories, default-on. The sentence is the row's `title` now:
 *  nine of them stacked under nine labels they mostly restated was the bulk of this tab's reading. */
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
 *  card to show in the light row.
 *
 *  The cards and their disclosure, without a row around them: the live face is a row of the
 *  Appearance group and the other face is a disclosure inside one, and a `.settings-row` nested in a
 *  `.settings-row` would paint a second surface on top of the first. */
/**
 * Importing a VS Code colour theme, and what is already imported.
 *
 * Under the grid rather than in it: importing is a thing you do once, and a card shaped like a
 * palette that is actually a file picker would be a card that repaints nothing when you press it.
 *
 * Each imported theme gets a line rather than only a card, because a card cannot say the two things
 * an import owes you — where it came from, and how much of it Realm had to work out. A theme whose
 * file stated three of the thirteen colours looks like a theme until you notice it is mostly Realm.
 */
function ImportedThemes({ face }: { face: Mode }) {
  const themes = useApp((s) => s.customThemes);
  const importThemeFile = useApp((s) => s.importThemeFile);
  const removeCustomTheme = useApp((s) => s.removeCustomTheme);
  const setThemeName = useApp((s) => s.setThemeName);
  const run = useApp((s) => s.run);
  // Only the ones with THIS face. A dark import has nothing to offer the light slot, and listing it
  // under a grid that cannot select it would be a row that does nothing.
  const mine = themes.filter((t) => t.mode === face);
  return (
    <div className="theme-vsc-list">
      {mine.map((t) => (
        <div key={t.id} className="theme-vsc">
          <span className="theme-vsc-name">{t.label}</span>
          {/* What the file did not say. Silent when it said everything, because a note that appears
              every time is a note nobody reads by the third import. */}
          {t.source.derived.length > 0 && (
            <span className="theme-vsc-note" title={`Not stated in the file: ${t.source.derived.join(", ")}`}>
              {t.source.derived.length} of 13 worked out
            </span>
          )}
          <button type="button" className="btn-quiet" aria-label={`Remove ${t.label}`}
            onClick={() => run(() => removeCustomTheme(t.id))}>Remove</button>
        </div>
      ))}
      <button type="button" className="btn-quiet theme-vsc-add"
        onClick={() => run(async () => {
          const id = await importThemeFile();
          // Selected on arrival, for the face it actually has: importing a theme and then having to
          // find it in the grid is two steps where the first one already said what you wanted.
          if (id) await setThemeName(face, id);
        })}>
        Import a VS Code theme…
      </button>
    </div>
  );
}

/**
 * A face for one role: the bundled family, a system stack, anything installed on this Mac, and
 * anything downloaded from Google Fonts.
 *
 * Grouped, because the four sources answer different questions and a flat list of seven hundred
 * families answers none of them. The two Realm ships lead, because they are the ones guaranteed to
 * have the axes the chrome is drawn against.
 *
 * The CODE role is offered only monospace families out of the Google catalog, and every local family
 * regardless — the OS list carries no category, and refusing to show someone a font they have
 * installed because Realm cannot tell what kind it is would be guessing at their expense.
 */
function FontSelect({ role, value, onPick }: { role: FontRole; value: FontId; onPick: (id: FontId) => void }) {
  const installed = useApp((s) => s.installedFonts);
  const local = useApp((s) => s.localFonts);
  const refreshLocalFonts = useApp((s) => s.refreshLocalFonts);
  const run = useApp((s) => s.run);
  // Read when the control mounts, not at boot: it is a permissioned call for a list most launches
  // never look at.
  useEffect(() => { if (local.length === 0) run(() => refreshLocalFonts()); }, [local.length, refreshLocalFonts, run]);
  /* A family that is no longer on offer — uninstalled from the Mac since it was chosen, or a theme
     file edited by hand. Without a matching option the select renders BLANK, which tells the reader
     their font setting is empty when it is not: the stack still names that family and still falls
     through to the fallback behind it. So it gets an option of its own that says what happened. */
  const known = value === "bundled" || value === "system"
    || installed.some((f) => f.family === value) || local.includes(value);
  return (
    <select aria-label={role === "ui" ? "UI font" : "Code font"} value={value}
      onChange={(e) => onPick(e.target.value)}>
      {FONT_FACES[role].map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
      {!known && <option value={value}>{value} — not installed</option>}
      {installed.length > 0 && (
        <optgroup label="From Google Fonts">
          {installed.map((f) => <option key={f.family} value={f.family}>{f.family}</option>)}
        </optgroup>
      )}
      {local.length > 0 && (
        <optgroup label="On this Mac">
          {local.map((f) => <option key={f} value={f}>{f}</option>)}
        </optgroup>
      )}
    </select>
  );
}

/**
 * Getting a family from Google Fonts, and what has already been got.
 *
 * It DOWNLOADS rather than linking, and the row says so, because that is the fact a person needs:
 * the font is on this Mac afterwards and the app never asks Google about it again. An app that
 * re-fetched its own typeface every launch would have no text the first time you opened it on a
 * plane, and would be telling Google when you open your editor.
 *
 * The catalog is fetched when this is first opened rather than at boot — two thousand entries and a
 * 2.7MB download, for a list most launches never look at.
 */
function FontLibrary() {
  const installed = useApp((s) => s.installedFonts);
  const catalog = useApp((s) => s.fontCatalog);
  const refreshFontCatalog = useApp((s) => s.refreshFontCatalog);
  const installFont = useApp((s) => s.installFont);
  const removeFont = useApp((s) => s.removeFont);
  const run = useApp((s) => s.run);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { if (open && !catalog) run(() => refreshFontCatalog()); }, [open, catalog, refreshFontCatalog, run]);

  const have = new Set(installed.map((f) => f.family));
  const q = query.trim().toLowerCase();
  /* Capped at twenty. The catalog is two thousand families and a select of all of them is a list
     nobody scrolls — the search is the way through it, and a cap is what makes typing feel like it
     is doing something. */
  const shown = (catalog ?? []).filter((f) => !have.has(f.family) && (!q || f.family.toLowerCase().includes(q))).slice(0, 20);

  return (
    <div className="font-library">
      {installed.length > 0 && (
        <ul className="font-installed">
          {installed.map((f) => (
            <li key={f.family}>
              {/* Set IN the family it names — the only honest preview of a typeface is the typeface. */}
              <span className="font-installed-name" style={{ fontFamily: `"${f.family}", var(--font-ui)` }}>{f.family}</span>
              <span className="font-installed-size">{Math.round(f.bytes / 1024)} KB</span>
              <button type="button" className="btn-quiet" aria-label={`Remove ${f.family}`}
                onClick={() => run(() => removeFont(f.family))}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn-quiet font-library-toggle" aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        {open ? "Close" : "Add a font from Google Fonts…"}
      </button>
      {open && (
        <div className="font-browser">
          <input className="search-field" type="search" aria-label="Search Google Fonts"
            placeholder={catalog ? `Search ${catalog.length} families…` : "Loading the catalogue…"}
            value={query} onChange={(e) => setQuery(e.target.value)} />
          {catalog === null ? <p className="env-empty">Fetching the list from Google…</p> : shown.length === 0 ? (
            <p className="env-empty">{q ? "No family matches that." : "Everything here is already installed."}</p>
          ) : (
            <ul className="font-results">
              {shown.map((f) => (
                <li key={f.family}>
                  <span className="font-result-name">{f.family}</span>
                  <span className="font-result-cat">{f.category}</span>
                  <button type="button" className="btn-quiet" disabled={busy !== null}
                    onClick={() => run(async () => {
                      setBusy(f.family);
                      try { await installFont(f.family); } finally { setBusy(null); }
                    })}>{busy === f.family ? "Downloading…" : "Add"}</button>
                </li>
              ))}
            </ul>
          )}
          {/* The one fact that is not obvious and that the whole design turns on. */}
          <p className="settings-hint">Realm downloads the files once and keeps them on this Mac. Nothing is fetched from Google afterwards.</p>
        </div>
      )}
    </div>
  );
}

/** The palette the konami sequence pays out, and the only one the grid ever withholds. */
const LOCKED_PALETTE: ThemeName = "phosphor";

function PaletteChoices({ face, selected, onSelect }:
  { face: Mode; selected: ThemeName; onSelect: (name: ThemeName) => void }) {
  const konamiUnlocked = useApp((s) => s.konamiUnlocked);
  // Hidden rather than disabled: a locked card in the grid would advertise that something is missing
  // and turn the whole thing into a puzzle with a visible answer slot.
  /* `allThemes()` rather than `THEMES`: an imported VS Code theme is a palette like any other once
     it has been translated, and the grid is where you choose a palette. It is read through the store
     so the grid re-renders when one is imported — the registry itself is module state and would not
     notify anyone. */
  useApp((s) => s.customThemes);
  const offered = allThemes().filter((t) => themeModes(t.name).includes(face) && (t.name !== LOCKED_PALETTE || konamiUnlocked));
  const palette = offered.find((t) => t.name === selected) ?? THEMES[0]!;
  // The preview is of the palette AS EDITED, at the contrast in force — a preview of something other
  // than what the window will do is worse than no preview.
  const override = useApp((s) => s.themeOverrides[overrideKey(palette.name, face)]);
  const contrast = useApp((s) => s.contrast);
  return (
    <>
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
      <ImportedThemes face={face} />
      {/* The blurb, the code preview and the three seed fields are all answers to "what does this
          palette actually look like in use" — a question you ask once, while choosing, and never
          again. Open, they were two screens of chrome per face, on a tab whose other six settings
          are one row each. Behind one disclosure they are still a click away and no longer the
          shape of the page. */}
      <details className="theme-detail">
        <summary>{palette.label}: preview and colours</summary>
        <p className="settings-hint">{palette.blurb}{palette.credit ? ` ${palette.credit}.` : ""}</p>
        <CodePreview vars={facePalette(palette.name, face, override, contrast)} />
        <ThemeOverrideEditor name={palette.name} face={face} />
      </details>
    </>
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
        <div className="theme-vsc">
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
  const terminalHistory = useApp((s) => s.terminalHistory);
  const setTerminalHistory = useApp((s) => s.setTerminalHistory);
  const setDesktopNotifications = useApp((s) => s.setDesktopNotifications);
  const soundCues = useApp((s) => s.soundCues);
  const soundVolume = useApp((s) => s.soundVolume);
  const setSoundCues = useApp((s) => s.setSoundCues);
  const setSoundVolume = useApp((s) => s.setSoundVolume);
  const relay = useApp((s) => s.notificationRelay);
  const setNotificationRelay = useApp((s) => s.setNotificationRelay);
  const setDefaultPermissionMode = useApp((s) => s.setDefaultPermissionMode);
  const setMidTurnMode = useApp((s) => s.setMidTurnMode);
  const midTurnMode = useApp((s) => s.midTurnMode);
  const easterEggs = useApp((s) => s.easterEggs);
  const lowPower = useApp((s) => s.lowPower);
  const setLowPower = useApp((s) => s.setLowPower);
  const setEasterEggs = useApp((s) => s.setEasterEggs);
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
    /* Grouped lists, not a form of stacked fields with a paragraph under each. A settings tab is
       scanned for the control you came for; every sentence between two rows is a sentence between
       every visit and that control. What survives on screen is a label, its control, and the few
       lines that say something the control cannot — an unavailable option's reason, a consequence
       that outlives the click. The rest rides the control's own `title`. */
    <div className="form settings-app">
      <h3 className="settings-head">Appearance</h3>
      <div className="settings-group">
        <div className="settings-row" data-stack>
          <div className="settings-row-main"><span className="settings-row-name">Theme</span></div>
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
        </div>

        {/* The face you are LOOKING at, in full. `data-live` marks it so the window and the page agree
            about which row explains what is in front of you. */}
        <div className="settings-row" data-stack data-live>
          <div className="settings-row-main">
            <span className="settings-row-name">{mode === "light" ? "Light theme" : "Dark theme"}</span>
          </div>
          <PaletteChoices face={mode} selected={themeNames[mode]}
            onSelect={(name) => run(() => setThemeName(mode, name))} />
        </div>
        {/* And the other one, folded away. Setting the face you are not in is the whole reason there
            are two rows — but it is a thing you do occasionally, and open it doubled the length of the
            tab with a grid nobody looking at this window can see the effect of. */}
        <div className="settings-row" data-stack>
          <details className="theme-other">
            <summary>{mode === "light" ? "Dark" : "Light"} palette</summary>
            <PaletteChoices face={mode === "light" ? "dark" : "light"} selected={themeNames[mode === "light" ? "dark" : "light"]}
              onSelect={(name) => run(() => setThemeName(mode === "light" ? "dark" : "light", name))} />
          </details>
        </div>

        <div className="settings-row">
          <div className="settings-row-main"><span className="settings-row-name">Contrast</span></div>
          {/* The ink ramp's SPREAD — how far the secondary and hint tiers fall below primary text. It
              is the only thing in the palette that is a matter of eyes rather than of design: the hues
              are the palette's identity and the surfaces are its structure, and a slider that moved
              either would be a repaint wearing the word "contrast". It cannot make anything illegible
              at any setting, because every tier is floored at WCAG before the ramp is walked — which
              is why the whole of that is a title and none of it is a paragraph. */}
          <div className="slider-row" title="How far labels and metadata sit below primary text. Every tier stays above the contrast Realm holds its palettes to, whatever this says — turning it down recedes them, it does not make them unreadable.">
            <Slider aria-label="Contrast"
              min={CONTRAST_RANGE.min} max={CONTRAST_RANGE.max} step={1}
              value={contrast} onChange={(e) => run(() => setContrast(Number(e.target.value)))} />
            <span className="slider-value">{contrast}</span>
          </div>
        </div>

        <div className="settings-row">
          <div className="settings-row-main">
            <span className="settings-row-name">Window translucency</span>
            {/* Off macOS the control is inert, and a disabled control with no reason beside it is the
                one case where the sentence has to stay on the page: there is nothing else to explain
                why this row does nothing. On a Mac the same explanation is a title, because the
                control works and reads correctly without it. */}
            {!material && (
              <span className="settings-row-desc">
                {`${PLATFORM_NAMES[window.realm?.platform ?? ""] ?? "This platform"} has no window material — there is nothing behind the window to reveal. The setting is kept and applies on a Mac.`}
              </span>
            )}
          </div>
          {/* A switch and an amount over ONE stored number, not two controls that can disagree: fully
              opaque IS off, because covering the material completely is the same as not having asked
              for it. So the switch reads `groundAlpha < max` and writes either the maximum or the
              default, and the slider is inert while it is off — nothing here can put the app in a
              state where the switch says one thing and the amount another.
              The slider runs the way its label reads — right is MORE transparent — while the stored
              value is the ground's OPACITY, because that is what the stylesheet composes. `flip` is the
              one place the two meet. step 1, not a coarser grid: the range spans an odd number of
              points, so any step above 1 leaves one of its two ends unreachable. */}
          <div className="slider-row" title={material
            ? "The sidebar and the panes both show the desktop behind the window, each as thinly as its own text allows: the sidebar holds labels and goes furthest, a pane holds the reading and stops where body text would fall below the contrast every theme here is held to. Realm also follows the system's Reduce Transparency setting — with it on both surfaces are opaque whatever this says, and your value comes back when you turn it off."
            : undefined}>
            <input type="checkbox" role="switch" className="switch" aria-label="Window translucency"
              disabled={!material} checked={translucent}
              onChange={(e) => run(() => setGroundAlpha(e.target.checked ? DEFAULT_GROUND_ALPHA : GROUND_ALPHA_RANGE.max))} />
            <Slider aria-label="Background transparency" disabled={!material || !translucent}
              min={GROUND_ALPHA_RANGE.min} max={GROUND_ALPHA_RANGE.max} step={1}
              value={flip(groundAlpha)} onChange={(e) => run(() => setGroundAlpha(flip(Number(e.target.value))))} />
            <span className="slider-value">{100 - groundAlpha}%</span>
          </div>
        </div>
      </div>
      {/* One line, not a switch (Plan 14 W5): the OS setting is the control, and styles.css's global
          prefers-reduced-motion kill is what makes this sentence true. It stays visible because it is
          the only place the app answers "where is the motion setting" — but it is a clause now. */}
      <p className="settings-hint">Animations follow the system's Reduce Motion setting.</p>

      <h3 className="settings-head">Text</h3>
      <div className="settings-group">
        <div className="settings-row">
          <div className="settings-row-main"><span className="settings-row-name">UI font</span></div>
          <div className="font-row">
            <FontSelect role="ui" value={fonts.ui} onPick={(id) => run(() => setFonts({ ui: id }))} />
            <select aria-label="UI font weight" value={fonts.uiWeight}
              onChange={(e) => run(() => setFonts({ uiWeight: e.target.value as FontWeight }))}>
              {FONT_WEIGHTS.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
            </select>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-row-main"><span className="settings-row-name">Code font</span></div>
          <div className="font-row" title="Code, diffs, terminals and keyboard hints. Open terminals change face with this setting; their font size does not follow it.">
            <FontSelect role="code" value={fonts.code} onPick={(id) => run(() => setFonts({ code: id }))} />
          </div>
        </div>
      </div>
      {/* Kept on the page, where the rest of this tab's prose went to a title: it explains a control
          that ISN'T there. The asymmetry is a fact about the stylesheet, not a judgement — every mono
          surface sets its font with the `font:` shorthand, which resets weight by definition, so a
          code weight would mean editing fifty-odd rules or hiding a weight inside a family name. */}
      <p className="settings-hint">Weight follows the app's own scale here.</p>
      <FontLibrary />

      <h3 className="settings-head">Sessions</h3>
      <div className="settings-group">
        <div className="settings-row">
          <div className="settings-row-main"><span className="settings-row-name">Send message with</span></div>
          <fieldset className="settings-tabs" aria-label="Send message with"
            title={submitKey === "enter" ? "Enter sends; Shift+Enter inserts a newline." : "⌘/Ctrl+Enter sends; Enter inserts a newline."}>
            {SUBMIT_KEY_CHOICES.map((k) => (
              <label key={k.pref} className="settings-tab" data-selected={submitKey === k.pref || undefined}>
                <input type="radio" name="settings-submit-key" value={k.pref} checked={submitKey === k.pref}
                  onChange={() => run(() => setSubmitKey(k.pref))} />
                {k.label}
              </label>
            ))}
          </fieldset>
        </div>
        <div className="settings-row" data-stack>
          <div className="settings-row-main"><span className="settings-row-name">A message typed while a turn is running</span></div>
          <>
              <fieldset className="settings-tabs" aria-label="Mid-turn prompts">
                {MID_TURN_CHOICES.map((c) => (
                  <label key={c.mode} className="settings-tab" data-selected={midTurnMode === c.mode || undefined}>
                    <input type="radio" name="settings-mid-turn" value={c.mode} checked={midTurnMode === c.mode}
                      onChange={() => run(() => setMidTurnMode(c.mode))} />
                    {c.label}
                  </label>
                ))}
              </fieldset>
              <p className="settings-hint">
                Codex takes a steered message into the turn it is already running. Every other agent
                has its turn stopped to take it, which aborts the tool call in flight and denies any
                permission prompt waiting. A queued message goes out when the turn ends — or now, from
                its row above the prompter.
              </p>
          </>
        </div>
        <div className="settings-row" data-stack>
          <div className="settings-row-main"><span className="settings-row-name">New sessions start in</span></div>
          {prefs === null ? <p className="env-empty">Loading preferences…</p> : (
            <>
              <fieldset className="settings-tabs" aria-label="Default permission mode"
                title="Realm can't set an ACP agent's permission mode — those mode ids are the agent's own, with nothing honest to map ours onto.">
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
              {/* Which agents obey this is not decoration: it is the difference between a default and
                  a wish, and there is no other place the app says so. */}
              <p className="settings-hint">
                Applies to new {labels(supported)} sessions; each session's chip can still change it.
                {unsupported.length > 0 && ` ${labels(unsupported)} sessions ignore it and start on the agent's own default.`}
              </p>
            </>
          )}
        </div>
      </div>

      <h3 className="settings-head">Terminals</h3>
      <ul className="settings-list">
        <li className="settings-row">
          <div className="settings-row-main">
            <span className="settings-row-name">{TERMINALS_HISTORY_COPY.label}</span>
            {/* The detail names what is actually being kept, because "terminal output" is whatever a
                command printed — and says what turning it off does, because it does something. */}
            <span className="settings-row-desc">{TERMINALS_HISTORY_COPY.detail}</span>
          </div>
          <input type="checkbox" role="switch" className="switch" aria-label={TERMINALS_HISTORY_COPY.label}
            checked={terminalHistory}
            onChange={(e) => run(() => setTerminalHistory(e.target.checked))} />
        </li>
      </ul>

      <h3 className="settings-head">Notifications</h3>
      <ul className="settings-list">
        <li className="settings-row">
          <div className="settings-row-main">
            <span className="settings-row-name">Notify me outside Realm</span>
            {/* The two things one switch does. Kept visible: a switch that also counts badges is
                doing something its label does not say. */}
            <span className="settings-row-desc">Post a system notification, and count unread ones on the dock icon.</span>
          </div>
          <input type="checkbox" role="switch" className="switch" aria-label="Notify me outside Realm"
            checked={desktopNotifications}
            onChange={(e) => run(() => setDesktopNotifications(e.target.checked))} />
        </li>
        {/* Nested under the switch above, and inert while it is off, because the sound is part of a
            notification rather than a second way of being told: it plays only alongside one that
            was actually posted. */}
        <li className="settings-row" title="One cue when a turn finishes, another when an agent is waiting on you. The sound follows the system volume, so muting the machine mutes it.">
          <div className="settings-row-main"><span className="settings-row-name">Play a sound with it</span></div>
          <input type="checkbox" role="switch" className="switch" aria-label="Play a sound with it"
            disabled={!desktopNotifications} checked={soundCues}
            onChange={(e) => run(() => setSoundCues(e.target.checked))} />
        </li>
        {/* The volume is a row of its own with its own label, rather than a bare slider under the
            switch: the readout used to have to name its own quantity ("Volume 50%") because nothing
            beside it did. In a labelled row the number is just the number. */}
        <li className="settings-row">
          <div className="settings-row-main"><span className="settings-row-name">Volume</span></div>
          <div className="slider-row">
            <Slider aria-label="Sound volume" disabled={!desktopNotifications || !soundCues}
              min={0} max={100} step={5}
              value={Math.round(soundVolume * 100)}
              onChange={(e) => run(() => setSoundVolume(Number(e.target.value) / 100))} />
            <span className="slider-value">{Math.round(soundVolume * 100)}%</span>
          </div>
        </li>
        {/* Beyond the machine. Independent of the desktop switch: the point is the moments you are
            NOT at this Mac. Only a permission waiting, a finished session or a blocked run leave —
            never MCP or probe chatter — and a repeat of one open condition is sent once. */}
        <li className="settings-row" title="Sent through Messages on this Mac (the `mac` CLI). A phone number or Apple ID email, exactly as Messages knows it.">
          <div className="settings-row-main">
            <span className="settings-row-name">Text me when an agent needs me</span>
            <span className="settings-row-desc">An iMessage when a session is waiting on a permission, finishes, or fails.</span>
          </div>
          <input className="settings-text" type="text" aria-label="iMessage handle" placeholder="+1 555 123 4567 or you@icloud.com"
            value={relay.imessage} spellCheck={false}
            onChange={(e) => run(() => setNotificationRelay({ imessage: e.target.value }))} />
        </li>
        <li className="settings-row" title="A Slack incoming-webhook URL. The same three moments, posted as one line.">
          <div className="settings-row-main"><span className="settings-row-name">Post to Slack</span></div>
          <input className="settings-text" type="url" aria-label="Slack webhook URL" placeholder="https://hooks.slack.com/services/…"
            value={relay.slackWebhook} spellCheck={false}
            onChange={(e) => run(() => setNotificationRelay({ slackWebhook: e.target.value }))} />
        </li>
      </ul>
      {/* The one thing the three rows above do not say: none of it happens while you are looking at
          Realm. */}
      <p className="settings-hint" title="Clicking one opens the session it came from. The categories below decide what counts; this decides whether it leaves the app.">Only when Realm is not the app you are in.</p>

      <h3 className="settings-head">Notify me about</h3>
      {prefs === null ? <p className="env-empty">Loading preferences…</p> : (
        <ul className="settings-list">
          {/* Nine rows, nine labels. The sentence each used to carry restated its own label for the
              length of a paragraph — "Permission requests: an agent is waiting on your yes or no" —
              and nine of them were most of the reading on this tab. They ride the row now. */}
          {NOTIFICATION_CATEGORIES.map((c) => (
            <li key={c} className="settings-row" title={CATEGORY_COPY[c].desc}>
              <div className="settings-row-main">
                <span className="settings-row-name">{CATEGORY_COPY[c].label}</span>
              </div>
              <input type="checkbox" role="switch" className="switch" aria-label={CATEGORY_COPY[c].label}
                checked={!prefs.disabledCategories.includes(c)}
                onChange={(e) => run(() => setNotificationCategoryEnabled(c, e.target.checked))} />
            </li>
          ))}
        </ul>
      )}
      <p className="settings-hint">Switching one off stops new rows from being written; the feed keeps what is already in it.</p>

      <h3 className="settings-head">Updates</h3>
      <UpdatesField />

      <h3 className="settings-head">Power</h3>
      <ul className="settings-list">
        <li className="settings-row" title="Realm already stops its animations while its window is in the background. This keeps them off while you are looking at it too, and stops the transcript's dissolve from blurring what passes under it. Nothing about what an agent does changes.">
          <div className="settings-row-main">
            <span className="settings-row-name">Low power</span>
            <span className="settings-row-detail">Keep the motion off, and the dissolve unblurred</span>
          </div>
          <input type="checkbox" role="switch" className="switch" aria-label="Low power"
            checked={lowPower}
            onChange={(e) => run(() => setLowPower(e.target.checked))} />
        </li>
      </ul>
      {/* The number is the point: a claim about battery that does not say how much is a claim nobody
          can check. It is measured by `scripts/power-audit.mjs` against the built app. */}
      <p className="settings-hint">
        Realm stops animating whenever its window loses focus, which is most of the time an agent is
        working. This switch keeps it off while the window is in front too — about half a core per
        pane, on the machine it was measured on.
      </p>

      <h3 className="settings-head">Easter eggs</h3>
      <ul className="settings-list">
        <li className="settings-row" title="Run labels that name the people Carlton works with, a gradient on the heavier models, and one thing you have to find.">
          <div className="settings-row-main">
            <span className="settings-row-name">Let Realm mess around</span>
          </div>
          <input type="checkbox" role="switch" className="switch" aria-label="Let Realm mess around"
            checked={easterEggs}
            onChange={(e) => run(() => setEasterEggs(e.target.checked))} />
        </li>
      </ul>
      {/* Deliberately vague. Listing them here is the one thing that would spend them. */}
      <p className="settings-hint">Off by default. None of it changes what an agent does.</p>
      <FriendPacks />

      <Attribution />
    </div>
  );
}

/**
 * The friend packs: a word, and the groups it has opened.
 *
 * The field says what it is for and nothing about what exists. There is no list of locked groups, no
 * count, and no "close, try again" — a wrong word gets the same nothing as a word for a group that
 * was never written. That is not coyness for its own sake: the packs are named after the words that
 * open them, so anything this told you about the ones you have not unlocked would be a hint at
 * somebody else's passphrase.
 *
 * Only shown while the eggs are ON. The switch above is the consent boundary for the whole feature,
 * and a passphrase box under a switch someone left off is a puzzle they did not opt into.
 */
function FriendPacks() {
  const eggs = useApp((s) => s.easterEggs);
  const packs = useApp((s) => s.eggPacks);
  const unlockEggPack = useApp((s) => s.unlockEggPack);
  const forgetEggPack = useApp((s) => s.forgetEggPack);
  const refreshEggPacks = useApp((s) => s.refreshEggPacks);
  const run = useApp((s) => s.run);
  const [word, setWord] = useState("");
  const [state, setState] = useState<"idle" | "trying" | "wrong">("idle");
  useEffect(() => { void run(() => refreshEggPacks()); }, [run, refreshEggPacks]);
  if (!eggs) return null;

  const submit = async () => {
    const typed = word.trim();
    if (!typed || state === "trying") return;
    setState("trying");
    // Through `run` like every other action, but the ANSWER is drawn here: a wrong word is not an
    // error the error bar should carry, it is a thing the field says.
    const pack = await unlockEggPack(typed).catch(() => null);
    if (pack) { setWord(""); setState("idle"); return; }
    setState("wrong");
  };

  return (
    <div className="settings-packs">
      <label className="settings-pack-field">
        <span className="settings-row-name">If someone gave you a word</span>
        <input type="text" value={word} spellCheck={false} autoComplete="off"
          aria-label="Friend group passphrase"
          placeholder="type it here"
          onChange={(e) => { setWord(e.target.value); if (state === "wrong") setState("idle"); }}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }} />
      </label>
      {/* One line, and it never says how close you were. */}
      {state === "wrong" && <p className="settings-hint" role="status">Nothing opens with that.</p>}
      {packs.length > 0 && (
        <ul className="settings-list">
          {packs.map((p) => (
            <li key={p.id} className="settings-row">
              <div className="settings-row-main">
                <span className="settings-row-name">{p.group}</span>
                <span className="settings-row-desc">{p.labels.length} lines, in the working labels</span>
              </div>
              {/* Forgetting drops the word, not the pack: the same word opens it again. */}
              <button type="button" className="btn btn-quiet" onClick={() => run(() => forgetEggPack(p.id))}>Forget</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Who made this, at the bottom of the last tab.
 *
 * Outside the easter-egg switch on purpose: authorship is not a joke, and a credit you have to
 * enable is not a credit. The signature is the playful part, and it is a behaviour of this row
 * rather than a treatment on the page — Settings is a page of controls someone sits on all day, and
 * `wash-surfaces.test.tsx` holds it plain.
 */
function Attribution() {
  return (
    <div className="settings-attribution">
      <Signature />
      <p className="settings-attribution-line">
        Made by <a href="https://x.com/31Carlton7" target="_blank" rel="noreferrer">Carlton Aikins</a>
      </p>
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
  /** Whether the add-a-sign-in sheet is up. Closed by a successful save, so the list behind it is
   *  the confirmation — a sheet that stayed open over the row it just made would ask "did that
   *  work?" of someone who can see that it did. */
  const [adding, setAdding] = useState(false);

  const canSave = origin.trim() !== "" && value !== "" && !saving;

  async function save() {
    setError(null);
    setSaving(true);
    try {
      await addCredential({ origin: origin.trim(), username: username.trim(), label: label.trim(), value });
      // Cleared on success AND only on success: a rejected save keeps what the user typed so they can
      // fix the address without retyping the password.
      setOrigin(""); setUsername(""); setLabel(""); setValue("");
      // …and the sheet closes, so the new row IS the confirmation. A sheet left open over the thing
      // it just made asks "did that work?" of someone who can see that it did.
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That sign-in could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="form">

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

      <div className="field">
        <div className="mcp-section-head">
          <span>Saved sign-ins</span>
          {/* A saved sign-in is a secret. Composing one is a sequence — an address, a username, a
              password, and the pinning rule that governs all three — and it sat permanently open in
              the middle of the page, four fields deep, whether or not anyone was adding anything.
              In a sheet it is something you start and finish. */}
          <button type="button" className="btn" disabled={status !== null && !status.available}
            onClick={() => setAdding(true)}>
            <Icon name="add" size={14} /> Add a sign-in
          </button>
        </div>
        {credentials === null ? <p className="env-empty">Loading…</p> : credentials.length === 0 ? (
          <div className="creds-empty">
            <p className="creds-empty-line">No saved sign-ins yet.</p>
            <p className="creds-empty-sub">
              One saved here can be typed into a page by an agent that never sees it. Realm checks the
              page is really on the site you saved it for, asks you to approve that specific fill, and
              asks for Touch ID — every time.
            </p>
          </div>
        ) : (
          <ul className="settings-list creds-list">
            {credentials.map((c) => (
              <li key={c.id} className="settings-row" aria-label={`${c.origin}${c.username ? `: ${c.username}` : ""}`}>
                <span className="creds-mark" aria-hidden="true"><Icon name="lock" size={16} /></span>
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

      {adding && (
      <Sheet title="Add a sign-in" onClose={() => setAdding(false)} width={480}>
      <div className="form creds-form">
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
        {/* The pinning rule, next to the field it constrains rather than under the button. It is
            the thing a person needs BEFORE typing an address, not after committing one. */}
        <p className="settings-hint">
          Realm pins the sign-in to exactly this address. A sign-in saved for https://example.com will
          not fill on https://login.example.com or on any lookalike — subdomains are different sites.
        </p>
        <div className="sheet-actions">
          <span className="diff-head-spacer" />
          <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
          <button type="button" className="btn primary" disabled={!canSave}
            onClick={() => { void save(); }}>
            {saving && <Spinner size={12} />}
            {saving ? "Saving…" : "Save sign-in"}
          </button>
        </div>
      </div>
      </Sheet>
      )}

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
  if (!status) return <p className="env-empty">Loading…</p>;
  const st = status.state;
  const desc =
    st.kind === "disabled" ? UPDATE_DISABLED_COPY[st.reason]
    : st.kind === "checking" ? "Checking for updates…"
    : st.kind === "up-to-date" ? "You're on the latest version."
    : st.kind === "downloading" ? `Downloading v${st.version}…`
    : st.kind === "downloaded" ? `v${st.version} is ready — restart to finish installing.`
    : st.kind === "error" ? `Update check failed: ${st.message}`
    : "Realm checks for updates on launch. You can also check now.";
  /* The one row on this tab whose description is the whole point of it: what the updater is doing,
     or why it cannot. The section head above says "Updates", so the row says the version instead. */
  return (
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
  );
}

/**
 * The real macOS icon for each capability's app, fetched once and cached for the window's life.
 *
 * A permissions page that names Calendar, Reminders and Mail in words asks the reader to translate;
 * their own icons are the thing they already recognise. Realm draws no stand-in — a capability with
 * no app (Full Disk Access) and one whose app is not installed (the iWork bundles are optional) both
 * answer null, and those rows show nothing rather than a generic placeholder that would claim there
 * is an app to think about.
 */
const APP_ICONS = new Map<string, string | null>();
function useAppIcon(id: string): string | null {
  const macAppIcon = useApp((s) => s.macAppIcon);
  /* Read THROUGH the cache on every render, and re-render when it fills. The obvious shape — hold
     the url in state, set it when the promise lands — loses the answer whenever the effect's
     cleanup runs before that: the cache fills, `live` is already false, and nothing ever reads the
     cache again because `useState`'s initialiser only runs at mount. That is not hypothetical; it
     is what shipped and why the icons were missing in a real window while the IPC answered fine. */
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (APP_ICONS.has(id)) return;
    // Marked pending BEFORE the await, so a second row for the same app does not ask twice.
    APP_ICONS.set(id, null);
    void macAppIcon(id)
      .then((url) => { APP_ICONS.set(id, url); if (url) redraw(); })
      .catch(() => { /* stays null; the row simply shows nothing */ });
  }, [id, macAppIcon]);
  return APP_ICONS.get(id) ?? null;
}

/** The icon slot. Absent rather than empty when there is no app: a blank box in a column of icons
 *  reads as an image that failed to load. */
function AppIcon({ id }: { id: string }) {
  const icon = useAppIcon(id);
  return icon ? <img className="tcc-app-icon" src={icon} alt="" aria-hidden="true" /> : null;
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
    <div className="computer-access-field">
      <h3 className="settings-head">Computer control</h3>
      {/* One line on the page; the qualifications live in its title. A settings tab is scanned for
          the control you came for, and three sentences before the first switch is three sentences
          between every visit and that control. */}
      <p className="settings-hint" title="Off until you switch it on for a space, and every action against an app asks you first.">
        What agents need to read and drive other apps on this Mac.
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
              <li key={r.id} className="settings-row tcc-row" aria-label={`${r.label}: ${TCC_STATE_LABEL[r.state]}`} title={r.detail}>
                <AppIcon id={r.id} />
                <div className="settings-row-main">
                  <span className="settings-row-name">{r.label}</span>
                  <span className="tcc-state" data-state={r.state}>
                    {r.state === "granted" && <Icon name="check" size={12} />}
                    {TCC_STATE_LABEL[r.state]}
                  </span>
                  {/* What a grant BUYS is worth a sentence while you are deciding, and worth nothing
                      once you have decided: a granted row's chip already says the only thing left to
                      know. The sentence stays on the row's title either way. */}
                  {r.state !== "granted" && <span className="settings-row-desc">{r.detail}</span>}
                </div>
                <div className="mac-row-actions">
                  {r.canPrompt && (
                    /* `askExplanation` rides the BUTTON now instead of stacking a second paragraph
                       under the row. It was always a sentence about what clicking does — that the
                       dialog's only button opens System Settings, and that nothing is granted until
                       you switch Realm on there — which is a thing to read at the button, not two
                       lines above it and again for every row on the page. */
                    <button type="button" className="btn-quiet" disabled={requesting !== null}
                      title={r.askExplanation ?? undefined}
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

  if (status === null) return <div className="mac-access-field"><h3 className="settings-head">Apps on this Mac</h3><p className="env-empty">Checking…</p></div>;

  if (!status.cli.present) {
    return (
      <div className="mac-access-field"><h3 className="settings-head">Apps on this Mac</h3>
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
    <div className="mac-access-field">
      <h3 className="settings-head">Apps on this Mac</h3>
      <p className="settings-hint" title={`macOS grants these to ${status.host.name}, once, for every session: granting here is what stops an agent from stalling mid-task to ask you for them.`}>
        What agents can reach through the <code>mac</code> command — Calendar, Mail, Messages, Notes and the rest.
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
      {/* What the button will DO stays on the page — it opens system dialogs one after another, and
          that is worth knowing before clicking. The mechanics behind it are a title. */}
      <p className="settings-hint" title={promptable.length === 0 ? undefined
        : `Realm runs one read-only command per capability — the listed one — and macOS puts up its own dialog for each. ${
            promptable.some((r) => r.launchesApp) ? "The app-control ones open their app to ask." : "Nothing opens."}`}>
        {promptable.length === 0
          ? "Every capability macOS can be asked about has been asked about."
          : "macOS puts up its own dialog for each, one at a time."}
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
  const says = row.state !== "granted" && !(row.canPrompt && row.grantCommand);
  return (
    <li className="settings-row tcc-row" aria-label={`${row.label}: ${MAC_STATE_LABEL[row.state]}`} title={row.detail}>
      <AppIcon id={row.id} />
      <div className="settings-row-main">
        <span className="settings-row-name">{row.label}</span>
        <span className="tcc-state" data-state={MAC_STATE_TONE[row.state]}>
          {row.state === "granted" && <Icon name="check" size={12} />}
          {MAC_STATE_LABEL[row.state]}
        </span>
        {/* Doctor's own fix line, but only where it is still telling the reader something. On a
            granted row it restates the chip beside it ("macOS reports the grant"), and on a
            promptable one it paraphrases the command printed directly underneath ("run any `mac
            calendar` command") — fourteen rows of that is what made this page a wall. Where asking
            cannot work, it is the instruction that matters and it stays. The row's title keeps all
            of them. */}
        {says && <span className="settings-row-desc">{row.detail}</span>}
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
    <div className="realm-access-field">
      <h3 className="settings-head">Realm's own access</h3>
      <p className="settings-hint" title="Realm only claims a state it has a real, prompt-free way to check; the rest say so.">What macOS lets the app itself touch.</p>
      {rows === null ? <p className="env-empty">Checking…</p> : (
        <ul className="settings-list">
          {rows.map((r) => (
            <li key={r.id} className="settings-row tcc-row" aria-label={`${r.label}: ${TCC_STATE_LABEL[r.state]}`} title={r.detail}>
              <AppIcon id={r.id} />
              <div className="settings-row-main">
                <span className="settings-row-name">{r.label}</span>
                <span className="tcc-state" data-state={r.state}>
                  {r.state === "granted" && <Icon name="check" size={12} />}
                  {TCC_STATE_LABEL[r.state]}
                </span>
                {r.state !== "granted" && <span className="settings-row-desc">{r.detail}</span>}
              </div>
              <button type="button" className="btn-quiet" onClick={() => run(() => openTccPane(r.id))}>Open System Settings</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
