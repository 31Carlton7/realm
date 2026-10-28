import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { BACKGROUND_MODEL } from "./background-model";

type QueryFn = typeof sdkQuery;

/** One memory index the model is shown so it does not save what is already known. */
export type KnownIndex = { label: string; index: string };

export type MemoryExtractionInput = {
  /** The conversation since the last extraction, user and assistant text only, oldest first. */
  transcript: string;
  /** The indexes already in memory for this space: the profile's root and the space's own folder. */
  known: KnownIndex[];
  /** Whether the session's own agent saved memory during this session. */
  agentSaved: boolean;
};

const EXTRACTION_GUIDANCE = [
  "You read a conversation between a person and a coding assistant and decide what is worth remembering",
  "for the person's future sessions, whichever assistant they use next. Most conversations hold nothing",
  "worth keeping, and an empty list is the usual answer.",
  "",
  "Worth keeping:",
  "- how the person likes to work: preferences, and corrections they gave, with the reason they gave;",
  "- decisions that were made and still stand, and why they were made;",
  "- people and their roles: who someone is, what they own, who to ask about what;",
  "- durable facts about the project that a future session could not read from the code: goals,",
  "  deadlines, constraints, and where things live outside the repository.",
  "",
  "Not worth keeping:",
  "- anything a future session can read from the code, the files or git history: layouts, names, what",
  "  a commit changed, how something is implemented;",
  "- the state of this task: what was just done, what is half-finished, next steps, test results;",
  "- secrets of any kind — passwords, tokens, keys, credentials in URLs — not even part of one;",
  "- what is already in memory (listed in the message), unless it has changed: then replace it;",
  "- guesses: keep only what the person said or plainly confirmed.",
  "",
  'Reply with exactly one JSON object and nothing else — no prose, no markdown fence: {"memories": [ ... ]}',
  "with at most 5 items. Each item has these fields:",
  '- "scope": "profile" when it is about the person and holds in every project; "space" when it is about this project;',
  '- "type": "user" (who the person is: role, expertise, preferences), "feedback" (guidance on how to',
  '  work, with its why), "project" (a decision, goal, constraint or fact about this work) or "reference"',
  "  (where something lives outside the code: a dashboard, a document, a channel);",
  '- "name": a short kebab-case slug, such as "prefers-small-prs";',
  '- "description": one line, under 150 characters, saying what the memory is, so a future session can',
  "  tell whether it needs it;",
  '- "body": the memory in plain sentences; for feedback and project memories, say why;',
  '- "replaces" (optional): when this updates something already in memory — for a space memory, that',
  "  memory's name; for a profile memory, the text of the entry it replaces.",
].join("\n");

/**
 * One call reading a quiet session for what is worth remembering. The answer is returned as the
 * model wrote it: the caller parses and validates it, because what is valid (the item schema, the
 * caps) is a rule of Realm's memory, not of this call.
 *
 * The recap's one-shot shape — `maxTurns: 1`, no tools, on the user's own `claude auth login` — on
 * `BACKGROUND_MODEL`. Throws when the call itself fails or comes back empty.
 */
export async function generateMemoryExtraction(input: MemoryExtractionInput, deps: { query?: QueryFn } = {}): Promise<string> {
  const known = input.known.filter((k) => k.index.trim() !== "");
  const prompt = [
    known.length > 0
      ? `Already in memory — do not save these again:\n\n${known.map((k) => `${k.label}:\n${k.index.trim()}`).join("\n\n")}`
      : "Nothing is in memory yet.",
    input.agentSaved
      ? "The assistant already saved memories itself during this session. Do not repeat them; add only what it missed."
      : "The assistant did not save anything to memory during this session.",
    `The conversation (oldest first):\n${input.transcript}`,
  ].join("\n\n");
  return oneShot(deps.query ?? sdkQuery, { prompt, model: BACKGROUND_MODEL, systemPrompt: EXTRACTION_GUIDANCE, what: "memory extraction" });
}

/** One file of the memory repo as the tidy pass is shown it: its path from the repo's root, and its text. */
export type TidyFile = { path: string; text: string };

export type MemoryTidyInput = {
  /** The root `MEMORY.md` and each space folder's `MEMORY.md`. */
  indexes: TidyFile[];
  /** The space folders' fact files, each cut to a bounded length. Only these may be changed. */
  files: TidyFile[];
};

const TIDY_GUIDANCE = [
  "You keep one person's memory tidy. It is a git repository of Markdown files that every new session",
  "of theirs reads, whichever assistant runs it. MEMORY.md at the top holds facts about the person, one",
  "per line, and links. Each spaces/<folder>/ holds one project's facts, one fact per file (a short",
  "header with name, description and type, then the fact), and its own MEMORY.md with one line per file.",
  "",
  "Propose a short plan that makes it easier to read without losing anything true:",
  "- merge files that say the same thing into one;",
  "- rewrite a fact that a newer fact contradicts, so it says what is true now;",
  "- delete a fact that is stale: finished work, a plan that was superseded, something no longer true;",
  "- shorten an index line that is longer than it needs to be, keeping its link;",
  "- remove a line of the top MEMORY.md that repeats another or is no longer true;",
  "- promote a space's fact that is about the person rather than the project — how they like to work,",
  "  who they are — so every space sees it.",
  "Never invent a fact, never merge facts that only look alike, keep the person's own words where you",
  "can, and do not delete a fact for being old — only for being wrong or useless now. Most of the time",
  "very little needs doing, and an empty plan is a good answer.",
  "",
  'Reply with exactly one JSON object and nothing else — no prose, no markdown fence: {"operations": [ ... ]}',
  "with at most 20 operations. Paths and lines must be copied exactly as shown. The operations:",
  '- {"op": "merge", "into": "<file>", "from": ["<file>", ...], "description": "<one line>", "body": "<the merged fact>"}',
  "  — `into` keeps the merged fact and the `from` files are deleted; all in the same folder;",
  '- {"op": "rewrite", "path": "<file>", "description": "<one line>", "body": "<the fact as it stands now>"};',
  '- {"op": "delete", "path": "<file>", "why": "<one line>"};',
  '- {"op": "line", "file": "<a MEMORY.md>", "line": "<an existing line>", "to": "<the new line>"} — or "to": null',
  "  to remove a line of the top MEMORY.md;",
  '- {"op": "promote", "path": "<file>", "line": "<the fact, in one line, for the top MEMORY.md>"}.',
].join("\n");

/**
 * One call proposing how to tidy a profile's memory repo, as the model wrote it. The caller validates
 * every operation against what is actually on disk and what it may touch, and applies the plan as one
 * commit. Same one-shot shape and model as the extraction.
 */
export async function generateMemoryTidyPlan(input: MemoryTidyInput, deps: { query?: QueryFn } = {}): Promise<string> {
  const show = (f: TidyFile) => `=== ${f.path}\n${f.text.trim()}`;
  const prompt = [
    `The indexes:\n\n${input.indexes.map(show).join("\n\n")}`,
    input.files.length > 0 ? `The fact files:\n\n${input.files.map(show).join("\n\n")}` : "There are no fact files.",
  ].join("\n\n");
  return oneShot(deps.query ?? sdkQuery, { prompt, model: BACKGROUND_MODEL, systemPrompt: TIDY_GUIDANCE, what: "memory tidy" });
}

/** The text of a one-shot `query()`'s result. */
async function oneShot(query: QueryFn, o: { prompt: string; model: string; systemPrompt: string; what: string }): Promise<string> {
  const q = query({ prompt: o.prompt, options: { maxTurns: 1, allowedTools: [], model: o.model, systemPrompt: o.systemPrompt } });
  let result = "";
  for await (const msg of q) {
    if (msg.type === "result") {
      if (msg.subtype !== "success") throw new Error(`${o.what} failed: ${msg.subtype}`);
      result = msg.result;
    }
  }
  if (!result.trim()) throw new Error(`${o.what} returned nothing`);
  return result;
}
