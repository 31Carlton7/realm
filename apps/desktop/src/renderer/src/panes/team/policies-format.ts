import {
  ACT_PACING, ACT_WINDOW, RISK_CLASSES, RISK_CLASS_WORDS,
  type RiskClass, type TeamPolicyConnector, type TeamPolicyTool,
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

const hour = (h: number): string => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "AM" : "PM"}`;
const gap = (ms: number): string => (ms >= 3_600_000 ? `${ms / 3_600_000} h apart` : `${ms / 60_000} min apart`);

/** The "Posts, DMs and email" card: what an approved item's outward act does today, from the pacing
 *  the act service enforces. */
export const ACT_ROWS: { label: string; detail: string }[] = ([["Posts", "post"], ["DMs", "dm"], ["Email", "email"]] as const).map(([label, kind]) => {
  const p = ACT_PACING[kind];
  return { label, detail: `${p.perDay} a day per account · ${gap(p.gapMs)} · ${hour(ACT_WINDOW.startHour)}–${hour(ACT_WINDOW.endHour)}` };
});
