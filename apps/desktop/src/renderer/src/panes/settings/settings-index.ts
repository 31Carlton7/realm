import type { IconName } from "@realm/ui";
import {
  AGENT_META, CARET_COPY, KEY_COMMANDS, NOTIFICATION_CATEGORIES, SELECTABLE_AGENT_KINDS,
  TERMINALS_CURSOR_BLINK_COPY, TERMINALS_CURSOR_STYLE_COPY, TERMINALS_HISTORY_COPY, type NotificationCategory,
} from "@realm/contracts";

/** One page of Settings, as the rail lists it. */
export type SettingsTab =
  | "general" | "appearance" | "keys" | "notifications"
  | "engines" | "usage"
  | "signins"
  | "permissions" | "computer-use"
  | "import" | "archived";

/**
 * The rail, in reading order: a heading per kind of question, and the pages that answer it.
 *
 * Seven flat tabs read as seven equal things, and they were not — "App" alone held a theme picker, a
 * permission default, a notification relay and the credits. Split by what a person comes here
 * about: themselves and the app's manners, the engines and what they cost, the browser, the Mac, and
 * the data Realm keeps.
 */
export const SETTINGS_GROUPS: readonly { label: string; tabs: readonly { id: SettingsTab; label: string; icon: IconName }[] }[] = [
  { label: "You", tabs: [
    { id: "general", label: "General", icon: "settings" }, { id: "appearance", label: "Appearance", icon: "sun" },
    { id: "keys", label: "Keys", icon: "command" }, { id: "notifications", label: "Notifications", icon: "bell" },
  ] },
  { label: "Engines", tabs: [{ id: "engines", label: "Engines", icon: "cpu" }, { id: "usage", label: "Usage", icon: "gauge" }] },
  { label: "Browser", tabs: [{ id: "signins", label: "Sign-ins", icon: "key" }] },
  { label: "Computer", tabs: [{ id: "permissions", label: "Permissions", icon: "shield" }, { id: "computer-use", label: "Computer use", icon: "pointer" }] },
  { label: "Data", tabs: [{ id: "import", label: "Import", icon: "inboxDownload" }, { id: "archived", label: "Archived", icon: "archive" }] },
];

export function settingsTabLabel(tab: SettingsTab): string {
  for (const g of SETTINGS_GROUPS) for (const t of g.tabs) if (t.id === tab) return t.label;
  return tab;
}

/** Human words for W5's notification categories, default-on. The sentence is the row's `title`:
 *  nine of them stacked under nine labels they mostly restated was the bulk of that page's reading. */
export const CATEGORY_COPY: Record<NotificationCategory, { label: string; desc: string }> = {
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

/**
 * One thing a search can land on.
 *
 * `id` is what the element on the page carries as `data-setting`, which is how a jump finds it once
 * its page has rendered. A `page` entry has no element: it stands for a page that is a report rather
 * than a list of rows, and landing on it opens the page.
 */
export type SettingEntry = {
  id: string;
  tab: SettingsTab;
  /** The heading the row sits under, where its page has more than one group. */
  section?: string;
  /** The row's label as the page prints it, so a result and the row it lands on read the same. */
  label: string;
  /** Words someone might type for this row that its label does not contain. Matched, never shown. */
  terms?: string;
  page?: true;
  /** For a row a page draws only where the platform has the thing (the App icon row needs a Dock).
   *  False means search leaves it out — a result that lands on a row that is not there is a dead
   *  end — and the index-agrees-with-page test does not expect it. Absent means always. */
  available?: () => boolean;
};

/**
 * Every row a search can find, in the order the pages draw them.
 *
 * Written out rather than read off the rendered pages, because only one page is rendered at a time
 * and rendering the rest to search them would run what they run on mount — the Usage page reads a
 * whole time range, the Engines page probes every CLI. `settings-search.test.tsx` renders each page
 * and holds the two in step: every entry is on its page, and every row on a page is here.
 */
export const SETTINGS_INDEX: readonly SettingEntry[] = [
  // General
  { id: "submit-key", tab: "general", section: "Sessions", label: "Send message with", terms: "enter return submit keyboard" },
  { id: "mid-turn", tab: "general", section: "Sessions", label: "A message typed while a turn is running", terms: "queue steer interrupt" },
  { id: "default-permission", tab: "general", section: "Sessions", label: "New sessions start in", terms: "permission mode default full access accept edits ask bypass" },
  { id: "default-model", tab: "general", section: "Sessions", label: "Model for new sessions", terms: "default last used agent claude codex opus sonnet fable haiku gpt" },
  { id: "open-files-in", tab: "general", section: "Files", label: "Open files in", terms: "editor cursor vscode code zed xcode ide path" },
  { id: "sidebar-activity-order", tab: "general", section: "Sidebar", label: "Sort spaces by activity", terms: "order drag strip" },
  { id: "confirm-delete", tab: "general", section: "Deleting", label: "Ask before deleting", terms: "confirm delete trash" },
  { id: "terminal-history", tab: "general", section: "Terminals", label: TERMINALS_HISTORY_COPY.label, terms: "output history restart" },
  { id: "terminal-dock", tab: "general", section: "Terminals", label: "Session terminal", terms: "bottom right position dock place shell" },
  { id: "terminal-colors", tab: "general", section: "Terminals", label: "Terminal colours", terms: "colors palette ansi theme p10k powerlevel10k shell xterm" },
  { id: "updates", tab: "general", section: "Updates", label: "Check for updates", terms: "version restart install" },
  { id: "prevent-sleep", tab: "general", section: "Power", label: "Keep the Mac awake while agents work", terms: "sleep caffeinate battery idle" },
  { id: "low-power", tab: "general", section: "Power", label: "Low power", terms: "battery animation motion energy" },
  { id: "easter-eggs", tab: "general", section: "Easter eggs", label: "Let Realm mess around", terms: "fun playful" },

  // Appearance
  { id: "theme", tab: "appearance", label: "Theme", terms: "mode dark light system" },
  { id: "palette-dark", tab: "appearance", label: "Dark theme", terms: "palette colours colors" },
  { id: "palette-light", tab: "appearance", label: "Light theme", terms: "palette colours colors" },
  { id: "theme-colours", tab: "appearance", label: "Accent, background and foreground", terms: "colours colors hex copy custom" },
  { id: "vscode-theme", tab: "appearance", label: "Import a VS Code theme", terms: "colours colors palette json" },
  { id: "contrast", tab: "appearance", label: "Contrast", terms: "ink text legibility readability" },
  { id: "sidebar-translucency", tab: "appearance", label: "Sidebar translucency", terms: "transparency transparent vibrancy material opacity window" },
  { id: "pane-translucency", tab: "appearance", label: "Pane translucency", terms: "transparency transparent vibrancy material opacity window" },
  { id: "reduce-motion", tab: "appearance", label: "Reduce motion", terms: "animation movement accessibility" },
  { id: "app-icon", tab: "appearance", label: "App icon", terms: "dock logo alternate custom graphite",
    available: () => typeof window.realm?.appIcon?.set === "function" },
  { id: "ui-font", tab: "appearance", section: "Text", label: "UI font", terms: "typeface family weight interface" },
  { id: "ui-font-size", tab: "appearance", section: "Text", label: "UI font size", terms: "text bigger smaller larger zoom px" },
  { id: "content-font", tab: "appearance", section: "Text", label: "Content font", terms: "prose messages markdown documents serif typeface family" },
  { id: "line-height", tab: "appearance", section: "Text", label: "Line height", terms: "leading spacing" },
  { id: "code-font", tab: "appearance", section: "Text", label: "Code font", terms: "monospace typeface family" },
  { id: "code-font-size", tab: "appearance", section: "Text", label: "Code font size", terms: "text bigger smaller larger terminal px" },
  { id: "font-library", tab: "appearance", section: "Text", label: "Add a font from Google Fonts", terms: "download install typeface family" },
  { id: "caret-preview", tab: "appearance", section: "Cursor", label: "Try the cursor", terms: "caret preview type field" },
  { id: "caret-shape", tab: "appearance", section: "Cursor", label: CARET_COPY.shape.label, terms: "caret line thin pill beam block outline underline prompter field editor" },
  { id: "caret-animation", tab: "appearance", section: "Cursor", label: CARET_COPY.animation.label, terms: "caret blink smooth fade phase expand pulse solid still rest" },
  { id: "caret-glide", tab: "appearance", section: "Cursor", label: CARET_COPY.glide.label, terms: "caret smooth movement slide" },
  { id: "caret-colour", tab: "appearance", section: "Cursor", label: CARET_COPY.colour.label, terms: "caret color accent ink" },
  { id: "terminal-cursor-style", tab: "appearance", section: "Cursor", label: TERMINALS_CURSOR_STYLE_COPY.label, terms: "terminals caret block bar line underline shape" },
  { id: "terminal-cursor-blink", tab: "appearance", section: "Cursor", label: TERMINALS_CURSOR_BLINK_COPY.label, terms: "terminals caret" },

  // Keys: every command a chord can be bound to, under the group the page lists it in.
  { id: "keys", tab: "keys", label: "Shortcuts", terms: "keyboard keybindings hotkeys chord" },
  ...KEY_COMMANDS.map((c): SettingEntry => ({ id: `key:${c.id}`, tab: "keys", section: c.group, label: c.label, terms: "shortcut keyboard" })),

  // Notifications
  { id: "desktop-notifications", tab: "notifications", label: "Notify me outside Realm", terms: "system banner dock badge alert" },
  { id: "sound-cues", tab: "notifications", label: "Play a sound with it", terms: "chime audio cue" },
  { id: "sound-volume", tab: "notifications", label: "Volume", terms: "sound loudness audio" },
  { id: "relay-imessage", tab: "notifications", label: "Text me when an agent needs me", terms: "imessage sms phone messages relay" },
  { id: "relay-slack", tab: "notifications", label: "Post to Slack", terms: "webhook relay" },
  ...NOTIFICATION_CATEGORIES.map((c): SettingEntry => ({ id: `notify:${c}`, tab: "notifications", section: "Notify me about", label: CATEGORY_COPY[c].label })),

  // Engines
  { id: "engine-checks", tab: "engines", label: "Check for new models", terms: "updates cli version catalog" },
  ...SELECTABLE_AGENT_KINDS.map((k): SettingEntry => ({ id: `engine:${k}`, tab: "engines", label: AGENT_META[k].label, terms: "agent cli install update sign login" })),
  { id: "failover", tab: "engines", label: "Failover", terms: "retry stalled turn hand over fallback limit chain" },
  { id: "laya", tab: "engines", label: "Laya (local decisions)", terms: "local model shadow assist recordings evaluation log" },

  // Usage
  { id: "usage", tab: "usage", label: "Spend, tokens and activity", terms: "cost money usage chart heaviest sessions plan limits", page: true },
  { id: "usage-budget", tab: "usage", label: "Monthly budget", terms: "spend limit threshold cost" },

  // Sign-ins
  { id: "signins-profile", tab: "signins", label: "Sign-ins for this profile", terms: "profile share copy cookies isolate separate" },
  { id: "saved-signins", tab: "signins", label: "Saved sign-ins", terms: "password credential login account generated agent sign-up" },
  { id: "passkeys", tab: "signins", label: "Passkeys", terms: "webauthn" },
  { id: "touch-id", tab: "signins", label: "Touch ID", terms: "fingerprint presence biometric" },

  // Permissions
  { id: "computer-control", tab: "computer-use", label: "Computer control", terms: "accessibility screen recording grant macos" },
  { id: "computer-spaces", tab: "computer-use", label: "Computer control in each space", terms: "realm-computer apps always allowed bundle switch drive" },
  { id: "mac-apps", tab: "permissions", label: "Apps on this Mac", terms: "calendar reminders contacts mail messages notes automation full disk access grant macos" },
  { id: "realm-access", tab: "permissions", label: "Realm's own access", terms: "files folders full disk grant macos" },

  // Import
  { id: "import", tab: "import", label: "Import from the agent CLIs", terms: "claude codex cursor transcripts memory skills history", page: true },

  // Archived
  { id: "archived", tab: "archived", label: "Archived sessions", terms: "archive restore unarchive delete shelf old", page: true },
];

/** Words, lower-cased and split on everything that is not a letter or a digit — so "sign in" finds
 *  "Sign-ins" and "subagent" does not have to know where the label put its hyphen. */
const words = (s: string): string[] => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * The entries a query finds: each typed word must START a word of the row — its label, its page,
 * its section, or the terms it is known by. A prefix rather than a substring, because a substring
 * search on a short word matches everything: "in" is inside "Line height", "Blink" and "Sign-ins".
 *
 * Ranked by where the words landed — all in the label first, then label and place, then anything
 * that needed the terms — and in page order within a rank, so a query that names a page lists that
 * page's rows as the page draws them.
 */
export function searchSettings(query: string): SettingEntry[] {
  const typed = words(query);
  if (typed.length === 0) return [];
  const starts = (pool: string[]) => typed.every((w) => pool.some((p) => p.startsWith(w)));
  const hits: { entry: SettingEntry; rank: number; at: number }[] = [];
  SETTINGS_INDEX.forEach((entry, at) => {
    if (entry.available?.() === false) return;
    const label = words(entry.label);
    const place = [...label, ...words(settingsTabLabel(entry.tab)), ...words(entry.section ?? "")];
    const all = [...place, ...words(entry.terms ?? "")];
    if (!starts(all)) return;
    hits.push({ entry, rank: starts(label) ? 0 : starts(place) ? 1 : 2, at });
  });
  return hits.sort((a, b) => a.rank - b.rank || a.at - b.at).map((h) => h.entry);
}

/** Where a result lives, the way the rest of the app writes a place: "Appearance ▸ Text". */
export function settingPlace(entry: SettingEntry): string {
  return [settingsTabLabel(entry.tab), entry.section].filter(Boolean).join(" ▸ ");
}
