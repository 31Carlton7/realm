import { z } from "zod";
import { BROWSER_READ_ONLY_TOOLS } from "./browser-agent";
import { vendorToolClass } from "./risk-vendors";

/**
 * What a tool call can do to the world, in four classes (the dynamic-Teams plan, §4). Every Realm
 * tool, every connector tool and every MCP tool a space can reach falls in exactly one, and a team's
 * Policies page reads them in these words.
 *
 * This module only CLASSES. Nothing here decides whether a call runs; the engines' own modes and
 * Realm's existing gates still do that.
 */
export const RISK_CLASSES = ["read", "internal-write", "reversible-external", "irreversible-external"] as const;
export const RiskClassSchema = z.enum(RISK_CLASSES);
export type RiskClass = z.infer<typeof RiskClassSchema>;

/** The Policies page's words for each class. */
export const RISK_CLASS_WORDS: Record<RiskClass, string> = {
  read: "Reading",
  "internal-write": "Changing files and records in this space",
  "reversible-external": "Changes elsewhere that can be undone",
  "irreversible-external": "Things that can't be taken back",
};

/** Higher is riskier. */
export const riskRank = (c: RiskClass): number => RISK_CLASSES.indexOf(c);
const riskier = (a: RiskClass, b: RiskClass): RiskClass => (riskRank(a) >= riskRank(b) ? a : b);

/* ─────────────────────────────── Realm's own tools ─────────────────────────────── */

type RealmToolClass = {
  class: RiskClass;
  /**
   * Set on a tool that only reads but still asks first in both engines, saying why. Such a tool is
   * classed `read` for the person — it changes nothing they would call a change — and is left out of
   * `REALM_READ_ONLY_TOOLS`, so neither engine runs it without a card.
   */
  asksFirst?: string;
};

const read: RealmToolClass = { class: "read" };
const internal: RealmToolClass = { class: "internal-write" };
const reversible: RealmToolClass = { class: "reversible-external" };
const irreversible: RealmToolClass = { class: "irreversible-external" };
const readAsking = (why: string): RealmToolClass => ({ class: "read", asksFirst: why });

const SHOWS_ELSEWHERE = "it shows what is outside this space";

/**
 * Every tool Realm's own providers list, by the name the gateway lists it under (`<provider>__<tool>`).
 * Exhaustive: `realm-tool-classes.test.ts` lists every provider through the real gateway and fails on
 * a name that is missing here.
 *
 * The acting tools (a page, a device, an app, a machine) are `reversible-external`: what they do lands
 * outside Realm, and a team may raise a surface past that once policies exist. A tool that types into
 * a shell, spends a secret in a request, or hands a file to a web page is `irreversible-external`,
 * because what it sends cannot be called back.
 *
 * Entries classed `read` without `asksFirst` are `REALM_READ_ONLY_TOOLS` — the names both engines run
 * with no prompt. Each is here because its handler only reads:
 *   - the `realm-browser` five — see `BROWSER_READ_ONLY_TOOLS`, including why `browser_credentials`
 *     (names and origins, no field for a password) is safe;
 *   - `workspace_state`, `sessions_list`, `session_read`, `space_list` — what is in this space and
 *     profile and what its sessions said, as the sidebar already shows it;
 *   - `settings_get` — the five settings an agent may change (theme and the like), none of them secret;
 *   - `agent_peers` — the other sessions in this space and whether each can be asked;
 *   - `agent_status` — this session's own delegated runs, without collecting them;
 *   - `schedule_list` — the space's schedules;
 *   - `docs_search`, `docs_read` — the text of files in the space's folder;
 *   - `docs_state` — which files the space's Documents panes have open;
 *   - `record_list` — the team's record files, by name;
 *   - `review_status` — where this session's submissions to Review stand;
 *   - `memory_index`, `memory_read`, `memory_search` — the memory repo, which refuses a secret's shape
 *     on every write;
 *   - `goal_status` — the session's goal, turns and budget;
 *   - `vault_list` — the vault's secrets by NAME and host; there is no field for a value.
 *
 * NEVER class `read` (without `asksFirst`) a tool that changes state, sends something, moves the
 * user's screen or reveals a secret value: such a name runs with no prompt from either engine. Classed
 * otherwise on purpose: `docs_open`, `pane_show`, `session_open`, `space_switch` (each changes what is
 * on screen); `team_roles` (re-hashes approved reviews, and sends one back to the person when a file
 * changed under it); `vault_http` (spends a secret).
 */
export const REALM_TOOL_CLASSES: Readonly<Record<string, RealmToolClass>> = {
  // Promptless reads first, in the order `REALM_READ_ONLY_TOOLS` has always listed them.
  ...Object.fromEntries(BROWSER_READ_ONLY_TOOLS.map((t) => [`realm-browser__${t}`, read])),
  "realm-workspace__workspace_state": read,
  "realm-workspace__sessions_list": read,
  "realm-workspace__session_read": read,
  "realm-workspace__space_list": read,
  "realm-workspace__settings_get": read,
  "realm-agent__agent_peers": read,
  "realm-agent__agent_status": read,
  "realm-schedule__schedule_list": read,
  "realm-docs__docs_search": read,
  "realm-docs__docs_read": read,
  "realm-docs__docs_state": read,
  "realm-team__record_list": read,
  "realm-team__review_status": read,
  "realm-memory__memory_index": read,
  "realm-memory__memory_read": read,
  "realm-memory__memory_search": read,
  "realm-goal__goal_status": read,
  "realm-vault__vault_list": read,

  "realm-browser__browser_open": reversible,
  "realm-browser__browser_navigate": reversible,
  "realm-browser__browser_act": reversible,
  "realm-browser__browser_do": reversible,
  "realm-browser__browser_batch": reversible,
  "realm-browser__browser_dismiss_dialog": reversible,
  "realm-browser__browser_fill_credential": reversible,
  "realm-browser__browser_download": internal,
  "realm-browser__browser_upload": irreversible,

  "realm-agent__browser_agent_run": internal,
  "realm-agent__agent_run": internal,
  "realm-agent__agent_start": internal,
  "realm-agent__agent_wait": internal,
  "realm-agent__agent_review": internal,
  "realm-agent__agent_ask": internal,
  "realm-agent__agent_answer": internal,

  "realm-ui__ui_ask": internal,

  "realm-computer__computer_list_apps": readAsking(SHOWS_ELSEWHERE),
  "realm-computer__computer_snapshot": readAsking(SHOWS_ELSEWHERE),
  "realm-computer__computer_act": reversible,
  "realm-computer__computer_do": reversible,

  "realm-terminal__terminal_list": readAsking("it names what each terminal is running"),
  "realm-terminal__terminal_read": readAsking("a terminal's output can hold what was typed into it"),
  "realm-terminal__terminal_wait": readAsking("a terminal's output can hold what was typed into it"),
  "realm-terminal__terminal_open": internal,
  "realm-terminal__terminal_close": internal,
  "realm-terminal__terminal_write": irreversible,
  "realm-terminal__signin_start": reversible,

  "realm-app__app_snapshot": readAsking("it reads Realm's own window"),
  "realm-app__app_act": internal,

  "realm-docs__docs_list": readAsking("it makes the space's Documents workspace the first time"),
  "realm-docs__docs_progress": readAsking("it makes the space's Documents workspace the first time"),
  "realm-docs__docs_open": internal,

  "realm-vm__vm_list": readAsking(SHOWS_ELSEWHERE),
  "realm-vm__vm_screenshot": readAsking(SHOWS_ELSEWHERE),
  "realm-vm__vm_connect": reversible,
  "realm-vm__vm_start": reversible,
  "realm-vm__vm_stop": reversible,
  "realm-vm__vm_act": reversible,

  "realm-simulator__simulator_list": readAsking(SHOWS_ELSEWHERE),
  "realm-simulator__simulator_screenshot": readAsking(SHOWS_ELSEWHERE),
  "realm-simulator__simulator_elements": readAsking(SHOWS_ELSEWHERE),
  "realm-simulator__simulator_apps": readAsking(SHOWS_ELSEWHERE),
  "realm-simulator__simulator_open": internal,
  "realm-simulator__simulator_install": reversible,
  "realm-simulator__simulator_launch": reversible,
  "realm-simulator__simulator_open_url": reversible,
  "realm-simulator__simulator_do": reversible,
  "realm-simulator__simulator_tap": reversible,
  "realm-simulator__simulator_double_tap": reversible,
  "realm-simulator__simulator_long_press": reversible,
  "realm-simulator__simulator_swipe": reversible,
  "realm-simulator__simulator_type": reversible,
  "realm-simulator__simulator_press": reversible,

  "realm-goal__update_goal": internal,

  "realm-workspace__pane_show": internal,
  "realm-workspace__session_open": internal,
  "realm-workspace__space_switch": internal,
  "realm-workspace__settings_set": internal,

  "realm-schedule__schedule_create": internal,

  "realm-team__team_roles": internal,
  "realm-team__record_read": readAsking("it logs the read on the team's activity"),
  "realm-team__record_update": internal,
  "realm-team__review_submit": internal,
  "realm-team__team_handoff": internal,
  "realm-team__team_mention": internal,

  "realm-vault__vault_http": irreversible,

  "realm-memory__memory_save": internal,
  "realm-memory__memory_remove": internal,
  "realm-memory__memory_write_file": internal,
};

/* ─────────────────────────────── names and verbs ─────────────────────────────── */

/** A tool name as words: split on `_`, `-`, `.`, `/` and camelCase, lower-cased. */
export function toolWords(name: string): string[] {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.toLowerCase());
}

/**
 * The verb floor (§4.2): a tool whose name says it sends, pays or destroys is never classed below
 * `reversible-external` by a server's annotations or the vendor table. `message`, `order` and
 * `release` count only as the first word, where they are verbs — `message_user` sends, `get_message`
 * and `get_release` read.
 */
const FLOOR_ANYWHERE = new Set([
  "send", "reply", "forward", "post", "publish", "tweet", "dm", "invite", "share", "pay", "charge", "refund",
  "transfer", "purchase", "buy", "delete", "remove", "destroy", "trash", "merge", "deploy", "submit",
]);
const FLOOR_FIRST = new Set(["message", "order", "release"]);

/** The word that puts this tool under the floor, or null. */
export function floorWord(tool: string): string | null {
  const words = toolWords(tool);
  if (words.length > 0 && FLOOR_FIRST.has(words[0]!)) return words[0]!;
  return words.find((w) => FLOOR_ANYWHERE.has(w)) ?? null;
}

const VERBS = new Set([
  ...FLOOR_ANYWHERE, ...FLOOR_FIRST,
  "get", "list", "read", "search", "fetch", "find", "query", "view", "show", "open", "close", "create", "add", "save",
  "update", "edit", "set", "write", "upload", "download", "install", "launch", "start", "stop", "run", "wait", "ask",
  "answer", "act", "do", "tap", "swipe", "type", "press", "navigate", "connect", "snapshot", "screenshot", "label",
  "unlabel", "mark", "apply", "move", "copy", "archive", "restore", "resolve", "respond", "suggest", "extract",
  "generate", "export", "import", "duplicate", "convert", "spawn", "schedule", "review", "mention", "handoff", "fill",
  "dismiss", "batch", "use", "push", "fork", "retire", "prepare", "check", "request", "switch", "unshare", "whoami",
]);

/** The verb a tool's name leads with — the first word that is a verb, else its first word. */
export function verbOf(tool: string): string {
  const words = toolWords(tool);
  return words.find((w) => VERBS.has(w)) ?? words[0] ?? tool;
}

/* ─────────────────────────────── MCP annotations ─────────────────────────────── */

/** The four hints of the MCP spec's `ToolAnnotations`, as a server lists them. */
export type ToolHints = { readOnlyHint?: unknown; destructiveHint?: unknown; openWorldHint?: unknown; idempotentHint?: unknown };

const hasHints = (a: ToolHints | null | undefined): a is ToolHints =>
  !!a && ["readOnlyHint", "destructiveHint", "openWorldHint"].some((k) => typeof (a as Record<string, unknown>)[k] === "boolean");

/**
 * A server's hints mapped as the spec defines them, including its defaults: `readOnlyHint` false,
 * `destructiveHint` true, `openWorldHint` true. `ignoreReadOnly` is the verb floor's reading: a tool
 * called `send_…` that says it only reads is not believed, and its other hints decide.
 */
export function annotationClass(a: ToolHints, ignoreReadOnly = false): RiskClass {
  if (a.readOnlyHint === true && !ignoreReadOnly) return "read";
  if (a.openWorldHint === false && !ignoreReadOnly) return "internal-write";
  if (a.destructiveHint === false) return "reversible-external";
  return "irreversible-external";
}

/* ─────────────────────────────── the classifier ─────────────────────────────── */

/** Who decided a tool's class: the person, Realm's own table, Realm's table for a vendor, the
 *  tool's server (its annotations), or nobody. */
export const RISK_SOURCES = ["you", "realm", "vendor", "server", "unclassified"] as const;
export const RiskSourceSchema = z.enum(RISK_SOURCES);
export type RiskSource = z.infer<typeof RiskSourceSchema>;

/** A person's word on one tool (`tool_classes`). `sealed` is whether main's stamp on it checked out;
 *  nothing can stamp one yet, so a lowering is never confirmed. */
export type ToolClassOverride = { class: RiskClass; verb: string | null; sealed: boolean };

export type ToolToClass = {
  /** `realm:<provider>` for Realm's own tools, `mcp:<server row id>` for a server row. */
  connector: string;
  tool: string;
  /** A server row's URL host, which picks the vendor table. */
  host?: string | null;
  annotations?: ToolHints | null;
};

export type ToolClass = {
  class: RiskClass;
  source: RiskSource;
  verb: string;
  /** The word that held the class up past what the source said, when the floor did. */
  floor: string | null;
  /** A person's lowering that was set aside because nothing confirmed it. */
  overrideIgnored: boolean;
  /** Realm's own read that still asks first, and why (`REALM_TOOL_CLASSES`). */
  asksFirst: string | null;
};

/**
 * One tool's class (§4.2). The first source that answers wins — Realm's own table, the vendor table,
 * the server's annotations — and a tool with none of them is `irreversible-external`, unclassified.
 * The verb floor applies to the vendor table and to annotations; Realm's own table is curated with
 * its tools and stands as written. A person's override may raise the class freely; it lowers it only
 * when sealed, and otherwise is set aside and said so.
 */
export function classifyTool(t: ToolToClass, override: ToolClassOverride | null = null): ToolClass {
  const derived = derivedClass(t);
  if (!override) return derived;
  const verb = override.verb ?? derived.verb;
  if (riskRank(override.class) >= riskRank(derived.class) || override.sealed)
    return { ...derived, class: override.class, source: "you", verb, floor: null };
  return { ...derived, overrideIgnored: true };
}

function derivedClass(t: ToolToClass): ToolClass {
  const verb = verbOf(t.tool);
  const base = { verb, floor: null, overrideIgnored: false, asksFirst: null };
  if (t.connector.startsWith("realm:")) {
    const own = REALM_TOOL_CLASSES[`${t.connector.slice(6)}__${t.tool}`];
    if (own) return { ...base, class: own.class, source: "realm", asksFirst: own.asksFirst ?? null };
    return { ...base, class: "irreversible-external", source: "unclassified" };
  }
  const word = floorWord(t.tool);
  const vendor = t.host ? vendorToolClass(t.host, t.tool) : null;
  if (vendor) {
    const held = word && riskRank(vendor) < riskRank("reversible-external");
    return { ...base, class: held ? "reversible-external" : vendor, source: "vendor", floor: held ? word : null };
  }
  if (hasHints(t.annotations)) {
    const said = annotationClass(t.annotations);
    if (!word || riskRank(said) >= riskRank("reversible-external")) return { ...base, class: said, source: "server" };
    return { ...base, class: riskier(annotationClass(t.annotations, true), "reversible-external"), source: "server", floor: word };
  }
  return { ...base, class: "irreversible-external", source: "unclassified" };
}

/* ─────────────────────────────── the Policies page ─────────────────────────────── */

export const TeamPolicyToolSchema = z.object({
  tool: z.string(),
  class: RiskClassSchema,
  source: RiskSourceSchema,
  verb: z.string(),
  floor: z.string().nullable(),
  overrideIgnored: z.boolean(),
  asksFirst: z.string().nullable(),
  /** What a role's call does today with no policy in force: true when the engine asks first. */
  asksToday: z.boolean(),
});
export type TeamPolicyTool = z.infer<typeof TeamPolicyToolSchema>;

export const TeamPolicyConnectorSchema = z.object({
  /** `realm:<provider>` or `mcp:<server row id>`. */
  connector: z.string(),
  kind: z.enum(["realm", "server"]),
  /** What the person calls it: "Realm", "Linear", or a server row's own name. */
  name: z.string(),
  /** A brand mark for a connector Realm offers; null otherwise. */
  icon: z.string().nullable(),
  /** False when the server could not be reached to list its tools just now. */
  reached: z.boolean(),
  tools: z.array(TeamPolicyToolSchema),
});
export type TeamPolicyConnector = z.infer<typeof TeamPolicyConnectorSchema>;

export const TeamPoliciesSchema = z.object({
  spaceId: z.string(),
  connectors: z.array(TeamPolicyConnectorSchema),
});
export type TeamPolicies = z.infer<typeof TeamPoliciesSchema>;
