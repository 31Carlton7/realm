import {
  ACT_PACING, ACT_WINDOW, POLICY_CHECK_WORDS, POLICY_DECISION_WORDS, RISK_CLASSES, RISK_CLASS_WORDS, decisionRank,
  type PolicyCaps, type PolicyCheck, type PolicyCover, type PolicyDecision, type RiskClass, type TeamPolicyConnector,
  type TeamPolicyRow, type TeamPolicyTool,
} from "@realm/contracts";

/** A class in a word or two, for the end of a tool's row. */
export const CLASS_SHORT: Record<RiskClass, string> = {
  read: "Reads",
  "internal-write": "Changes this space",
  "reversible-external": "Can be undone",
  "irreversible-external": "Can't be taken back",
};

/** A tool's name as words: `save_issue` → "save issue"; under its owner, `browser_list` → "list". */
export function toolLabel(tool: string, owner?: string): string {
  const words = tool.replace(/[_-]+/g, " ").trim();
  // "Browser: list", not "Browser: browser list" — a word the owner's name already says goes.
  const first = words.split(" ")[0]!.toLowerCase();
  return owner && words.includes(" ") && owner.toLowerCase().startsWith(first) ? words.slice(first.length + 1) : words;
}

/** What a call does today, in the page's words. */
export const todayWords = (t: Pick<TeamPolicyTool, "asksToday">): string => (t.asksToday ? "Asks each time" : "Without asking");

/** What happens today for every tool of one class: one phrase when they agree, the split when not. */
export function classToday(tools: readonly Pick<TeamPolicyTool, "asksToday">[]): string {
  const asking = tools.filter((t) => t.asksToday).length;
  if (tools.length === 0) return "Nothing here does this";
  if (asking === tools.length) return "Asks each time";
  if (asking === 0) return "Without asking";
  return `${tools.length - asking} without asking · ${asking} ask`;
}

export type ClassRow = {
  class: RiskClass;
  words: string;
  count: number;
  today: string;
  /** Up to three tools of this class, connections first: "Linear: save issue". */
  examples: string[];
};

/** The "By kind of action" card: one row per class, in order from reading to the irreversible. */
export function classRows(connectors: readonly TeamPolicyConnector[]): ClassRow[] {
  const all = connectors.flatMap((c) => c.tools.map((t) => ({ c, t })));
  return RISK_CLASSES.map((cls) => {
    const mine = all.filter(({ t }) => t.class === cls);
    const servers = mine.filter(({ c }) => c.kind === "server");
    const examples = [...servers, ...mine.filter(({ c }) => c.kind === "realm")].slice(0, 3).map(({ c, t }) => `${c.name}: ${toolLabel(t.tool, c.name)}`);
    return { class: cls, words: RISK_CLASS_WORDS[cls], count: mine.length, today: classToday(mine.map(({ t }) => t)), examples };
  });
}

/** "14 tools · 3 can't be taken back" — and the unclassified, which are the ones that want a person. */
export function connectorSummary(c: Pick<TeamPolicyConnector, "tools" | "reached">): string {
  if (!c.reached) return "Not reached just now";
  const n = c.tools.length;
  const parts = [`${n} tool${n === 1 ? "" : "s"}`];
  const unclassified = c.tools.filter((t) => t.source === "unclassified").length;
  const irreversible = c.tools.filter((t) => t.class === "irreversible-external").length - unclassified;
  if (irreversible > 0) parts.push(`${irreversible} can't be taken back`);
  if (unclassified > 0) parts.push(`${unclassified} Realm can't classify`);
  return parts.join(" · ");
}

/** Who classed a connector's tools, said once for the connector. */
export function connectorSource(c: Pick<TeamPolicyConnector, "kind" | "name" | "tools" | "reached">): string {
  if (!c.reached) return "Realm lists its tools once it answers";
  if (c.kind === "realm") return "Classed by Realm";
  const sources = new Set(c.tools.map((t) => t.source));
  if (sources.has("vendor")) return `Classed by Realm's list for ${c.name}`;
  if (sources.has("server")) return `Labelled by ${c.name}'s server`;
  return "Its server labels none of its tools";
}

/** One tool's source and anything that overrode it, in a line. */
export function toolNote(c: Pick<TeamPolicyConnector, "name">, t: TeamPolicyTool): string {
  const parts: string[] = [];
  if (t.floor && t.source === "server") parts.push(`Its server labels it read-only or local; Realm reads “${t.floor}”`);
  else {
    if (t.source === "you") parts.push("Set by you");
    else if (t.source === "vendor") parts.push(`Realm's list for ${c.name}`);
    else if (t.source === "server") parts.push(`Labelled by ${c.name}'s server`);
    else if (t.source === "unclassified") parts.push("No label, so treated as something that can't be taken back");
    if (t.floor) parts.push(`Realm reads “${t.floor}”`);
  }
  if (t.overrideIgnored) parts.push("your lower class is not confirmed on this Mac");
  if (t.asksFirst) parts.push(`asks first: ${t.asksFirst}`);
  return parts.join(" · ");
}

const hour = (h: number): string => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 || h === 24 ? "AM" : "PM"}`;
const gap = (ms: number): string => (ms >= 3_600_000 ? `${ms / 3_600_000} h apart` : `${ms / 60_000} min apart`);

/** A row's limits in a line: "3 a day per account · 2 h apart · 8 AM–10 PM". Empty when it has none. */
export function capsLine(caps: PolicyCaps): string {
  const parts: string[] = [];
  if (caps.perDay !== undefined) parts.push(`${caps.perDay} a day per account`);
  if (caps.gapMs) parts.push(gap(caps.gapMs));
  if (caps.window) parts.push(`${hour(caps.window.start)}–${hour(caps.window.end)}`);
  if (caps.teamPerDay !== undefined) parts.push(`${caps.teamPerDay} a day for the team`);
  return parts.join(" · ");
}

/** "Checks: consent on the record · #ad or the platform's label". Empty when a row checks nothing. */
export const checksLine = (checks: readonly Pick<PolicyCheck, "id">[]): string =>
  checks.length === 0 ? "" : `Checks: ${checks.map((c) => POLICY_CHECK_WORDS[c.id]).join(" · ")}`;

/** The "Posts, DMs and email" card: what an approved item's outward act does today, from the pacing
 *  the act service enforces. Drawn only while the team has no rows of its own for them. */
export const ACT_ROWS: { label: string; detail: string }[] = ([["Posts", "post"], ["DMs", "dm"], ["Email", "email"]] as const).map(([label, kind]) => {
  const p = ACT_PACING[kind];
  return { label, detail: capsLine({ perDay: p.perDay, gapMs: p.gapMs, window: { start: ACT_WINDOW.startHour, end: ACT_WINDOW.endHour } }) };
});

/** The team's own rows for posts, DMs and email, by the verb they key. */
export const VERB_WORDS: Record<string, string> = { post: "Posts", dm: "DMs", email: "Email" };

/* ─────────────────────────────── changing a rule ─────────────────────────────── */

/** What a role does, said after "Let Versed's roles …". */
export const CLASS_DOING: Record<RiskClass, string> = {
  read: "read",
  "internal-write": "change files and records in this space",
  "reversible-external": "make changes elsewhere that can be undone",
  "irreversible-external": "do things that can't be taken back",
};

/** What a person says a tool does, in "What does this do?"'s words. */
export const CLASS_ANSWER: Record<RiskClass, string> = {
  read: "Only reads",
  "internal-write": "Changes this space",
  "reversible-external": "Changes something elsewhere that can be undone",
  "irreversible-external": "Can't be taken back",
};

const VERB_DOING: Record<string, string> = { post: "post", dm: "send DMs", email: "send email" };
export const verbDoing = (verb: string): string => VERB_DOING[verb] ?? verb;

/** A decision is a loosening when it lets more through than what is in force: the press's whole test. */
export const loosens = (to: PolicyDecision, from: PolicyDecision): boolean => decisionRank(to) < decisionRank(from);

/**
 * What one stored row means here: the decision in force, and whether it is a loosening the person
 * pressed on another Mac, or one written behind Realm's back — either way it holds no seal that checks
 * out, so the floor stands and the page says so.
 */
export function rowInForce(row: TeamPolicyRow | undefined, floor: PolicyDecision, sealsChecked: boolean): { decision: PolicyDecision; unconfirmed: boolean } {
  if (!row) return { decision: floor, unconfirmed: false };
  if (loosens(row.decision, floor) && !(row.sealed && sealsChecked)) return { decision: floor, unconfirmed: true };
  return { decision: row.decision, unconfirmed: false };
}

/** What a row would govern, for asking `policyRowProblem` before anyone presses. */
export function coverOf(tools: readonly Pick<TeamPolicyTool, "class" | "verb">[], classes: readonly RiskClass[] = []): PolicyCover {
  const all = [...new Set([...classes, ...tools.map((t) => t.class)])];
  const irreversibleVerbs = [...new Set(tools.filter((t) => t.class === "irreversible-external").map((t) => t.verb))];
  return { classes: all, irreversibleVerbs };
}

const EXTERNAL_CLASSES: readonly RiskClass[] = ["reversible-external", "irreversible-external"];
/** "Without asking" on anything elsewhere carries a daily limit (§4.3). */
export const needsCap = (decision: PolicyDecision, cover: PolicyCover): boolean =>
  decision === "auto" && cover.classes.some((c) => EXTERNAL_CLASSES.includes(c));

/** The warning a loosening opens with, in the vault's grammar: the question, what it costs, the
 *  decision's own words on its button, and the line macOS shows after "Realm wants to ". */
export function looseningWords(input: {
  team: string; doing: string; to: PolicyDecision; from: PolicyDecision; perDay: number | null; irreversible: boolean;
}): { title: string; body: string; button: string; reason: string } {
  const { team, doing, to, from, perDay, irreversible } = input;
  const how = to === "auto" ? "without asking" : to === "ask" ? "once you say yes on their card" : "once you approve and press each one";
  const title = `Let ${team}'s roles ${doing} ${how}?`;
  const today = `Today it is “${POLICY_DECISION_WORDS[from]}”.`;
  const body = to === "auto"
    ? [perDay !== null ? `They could then do it up to ${perDay} time${perDay === 1 ? "" : "s"} a day with nobody reading it first.` : "They could then do it with no card in their session.",
      irreversible ? "It can't be taken back." : "",
      "Realm keeps a line for each in Activity."].filter(Boolean).join(" ")
    : to === "ask"
      ? `${today} Each one would then wait on a card in the role's session until you answer it.`
      : `${today} Each one would then wait in Review until you approve it and press it.`;
  const button = to === "auto" ? (perDay !== null ? `Allow, up to ${perDay} a day` : "Allow without asking")
    : to === "ask" ? "Allow, asking each time" : "Allow, after you press";
  const reason = `let ${team}'s roles ${doing} ${how}${to === "auto" && perDay !== null ? `, up to ${perDay} a day` : ""}`;
  return { title, body, button, reason: reason.length > 200 ? `${reason.slice(0, 199)}…` : reason };
}

const CLASS_CLAIM: Record<RiskClass, string> = {
  read: "only reads",
  "internal-write": "only changes this space",
  "reversible-external": "changes something elsewhere that can be undone",
  "irreversible-external": "can't be taken back",
};
const CLASS_CLAIM_SHORT: Record<RiskClass, string> = { ...CLASS_CLAIM, "reversible-external": "can be undone" };

/** The warning a lowered class opens with: what the person is vouching for, and what it then does. */
export function classLoweringWords(input: { tool: string; to: RiskClass; from: RiskClass; then: PolicyDecision }): { title: string; body: string; button: string; reason: string } {
  const { tool, to, from, then } = input;
  const reason = `treat ${tool} as something that ${CLASS_CLAIM[to]}`;
  return {
    title: `Say ${tool} ${CLASS_CLAIM[to]}?`,
    body: `Realm reads it today as “${RISK_CLASS_WORDS[from]}”. On your word it follows the rule for “${RISK_CLASS_WORDS[to]}” instead: ${POLICY_DECISION_WORDS[then].toLowerCase()}. If it does more than you say, nothing in Realm will catch it.`,
    button: `It ${CLASS_CLAIM_SHORT[to]}`,
    reason: reason.length > 200 ? `${reason.slice(0, 199)}…` : reason,
  };
}
