import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve, sep } from "node:path";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { AGENT_META, ASK_QUESTIONS_MAX, AskCardSchema, UiAskInputSchema, type AgentKind, type AskAnswers, type AskCard, type AskOption, type AskQuestion, type DelegableModel, type Session, type UiAskInput } from "@realm/contracts";
import type { ProviderCallContext, RealmToolProvider } from "../mcp/gateway";
import { err, parseArgs } from "../mcp/tool-result";
import type { AskOutcome } from "../browsers/permissions";
import { gitCapture } from "../workspace/git-exec";

export const UI_PROVIDER_NAME = "realm-ui";

/**
 * `realm-ui`: one tool, `ui_ask`, that puts a question in front of the user on Realm's own card and
 * hands back the answers as data.
 *
 * Every agent can already ask in prose, and two can ask natively (Claude's `AskUserQuestion`, Codex's
 * `request_user_input`). What none of them can offer is a field only Realm can fill: a model from the
 * ones this Mac can run, a file from this workspace, a branch of this checkout. Those are why this
 * exists — "who builds each step?" answered with model ids `agent_start` takes, rather than with a
 * sentence the agent has to parse back into a guess.
 *
 * **It can only ask.** Nothing it does changes a file, a page or a setting, so it is on by default,
 * allowed in every permission mode, and never needs an approval of its own. The answer is the user's
 * click, and nothing reaches the agent without one.
 *
 * **Realm fills everything a field offers.** The agent names the KIND of field; the options for a
 * model, a branch or a file come from Realm's catalog, git and the workspace, never from the agent —
 * so a model the user is offered is one this Mac can run, and a "file" cannot be a path outside the
 * session's folder. A picture is a path in the workspace, resolved and checked here, and drawn by
 * main's thumbnailer; a URL is refused.
 */
export type UiAgentToolsDeps = {
  mcp: { providerEnabled(spaceId: string, name: string): boolean };
  broker: { ask(sessionId: string, card: AskCard, o: { toolName: string; title: string; input?: Record<string, unknown> }): Promise<AskOutcome> };
  session: (id: string) => Pick<Session, "agentKind" | "cwd" | "model">;
  /** What a model field offers: `delegation.models`' answer for this session. */
  models: (sessionId: string) => Promise<{ models: DelegableModel[]; own: { kind: AgentKind; label: string } }>;
  /** The checkout's branches, most recently committed first, and the one checked out. Null when the
   *  folder is not a repository. */
  branches: (cwd: string) => Promise<{ branches: string[]; current: string | null } | null>;
};

/** A picture an option may wear: a raster, so that drawing it can never mean running or fetching
 *  anything — an SVG can reference the network, and QuickLook would follow it. */
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".tif", ".tiff", ".bmp"]);
const IMAGE_MAX_BYTES = 50 * 1024 * 1024;
/** A catalog runs to a hundred and more models on some harnesses; the chooser is searched, but a
 *  card is persisted with the session, so it carries a bounded list. */
const MODEL_OPTIONS_MAX = 200;
const BRANCH_OPTIONS_MAX = 100;

const TOOL: Tool = {
  name: "ui_ask",
  description: [
    `Ask the user up to ${ASK_QUESTIONS_MAX} questions on Realm's own question card, and wait for the answers. Ask once, with every question you need, rather than in a series.`,
    "Kinds: `choice` (one option), `multi` (several), `text` (`secret: true` masks the field and keeps the answer out of Realm's records; `multiline` for a note), `confirm` (yes or no), and fields only Realm can fill:",
    "`model` — the models this Mac can run, defaulted to this session's own; give `rows` to ask one model per row, as in \"Who builds each step?\" with a row per plan step. Each answer is a model id that `agent_start` and `agent_run` take as `constraints.model`.",
    "`file` — a file in this session's workspace (`multiple: true` for several), answered as repo-relative paths. `branch` — a branch of this checkout. `time` — a date and time (`dateOnly: true` for a day).",
    "A `choice` or `multi` option may carry `image`: a path to a picture in this workspace, drawn as a tile — for picking between mockups or screenshots. `allowOther: true` adds a field for an answer of the user's own.",
    "Ask only what is genuinely the user's to decide and cannot be found in the repository, the conversation or a quick look. Every question can be skipped; a skip comes back as `skipped`.",
  ].join(" "),
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "optional: one line above the questions saying what they are for" },
      questions: {
        type: "array", minItems: 1, maxItems: ASK_QUESTIONS_MAX,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "your key for the answer: letters, digits, '_', '-' or '.'" },
            prompt: { type: "string", description: "the question, as the user should read it" },
            header: { type: "string", description: "optional: a tag of a word or two, e.g. \"Database\"" },
            kind: { type: "string", enum: ["choice", "multi", "text", "confirm", "model", "file", "branch", "time"] },
            options: {
              type: "array", maxItems: 12, description: "choice and multi only",
              items: { type: "object", properties: {
                label: { type: "string" }, description: { type: "string" },
                image: { type: "string", description: "a picture of this option: a path in this session's workspace (png, jpg, gif, webp, heic)" },
              }, required: ["label"], additionalProperties: false },
            },
            allowOther: { type: "boolean", description: "choice and multi: offer a field for an answer of the user's own" },
            secret: { type: "boolean", description: "text: mask the field; the answer reaches you and is kept out of Realm's records" },
            multiline: { type: "boolean", description: "text: a note rather than a line" },
            placeholder: { type: "string" },
            rows: { type: "array", items: { type: "string" }, maxItems: 12, description: "model: ask one model per row (each row's label, e.g. a plan step)" },
            dateOnly: { type: "boolean", description: "time: ask for a day only" },
            multiple: { type: "boolean", description: "file: allow several" },
            default: { type: "string", description: "optional pre-selected answer: an option's label, a model's name, a branch, or a date (YYYY-MM-DD or YYYY-MM-DDTHH:MM)" },
          },
          required: ["id", "prompt", "kind"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
};

export function createUiAgentProvider(d: UiAgentToolsDeps): RealmToolProvider {
  return {
    name: UI_PROVIDER_NAME,
    async tools(ctx: ProviderCallContext): Promise<Tool[]> {
      return d.mcp.providerEnabled(ctx.spaceId, UI_PROVIDER_NAME) ? [TOOL] : [];
    },
    async call(ctx: ProviderCallContext, tool: string, args: unknown): Promise<CallToolResult> {
      if (!d.mcp.providerEnabled(ctx.spaceId, UI_PROVIDER_NAME))
        return err(`the ${UI_PROVIDER_NAME} tools are disabled for this space — mcp.setProviderEnabled turns them back on.`);
      if (tool !== TOOL.name) return err(`unknown tool "${tool}" — this provider has: ${TOOL.name}`);
      const parsed = parseArgs(UiAskInputSchema, args ?? {});
      if ("error" in parsed) return parsed.error;
      let card: AskCard;
      try { card = await cardFor(d, ctx.sessionId, parsed.value); }
      catch (e) { return err(e instanceof Error ? e.message : String(e)); }
      const outcome = await d.broker.ask(ctx.sessionId, card, { toolName: TOOL.name, title: card.questions[0]!.prompt, input: args as Record<string, unknown> });
      return resultOf(card, outcome);
    },
  };
}

/** An agent's questions as the card Realm draws, with every field filled from Realm's own sources. */
async function cardFor(d: UiAgentToolsDeps, sessionId: string, input: UiAskInput): Promise<AskCard> {
  const session = d.session(sessionId);
  const questions: AskQuestion[] = [];
  for (const q of input.questions) {
    const base = { id: q.id, prompt: q.prompt, ...(q.header ? { header: q.header } : {}) };
    switch (q.kind) {
      case "choice": case "multi": {
        const options: AskOption[] = [];
        for (const [i, o] of (q.options ?? []).entries()) {
          options.push({ value: o.label, label: o.label, ...(o.description ? { description: o.description } : {}),
            ...(o.image ? { image: await pictureIn(session.cwd, o.image, `questions.${q.id}.options[${i}].image`) } : {}) });
        }
        const def = q.default && options.find((o) => o.label.toLowerCase() === q.default!.toLowerCase())?.value;
        questions.push({ ...base, kind: q.kind, options, ...(q.allowOther ? { allowOther: true } : {}), ...(def ? { default: def } : {}) });
        break;
      }
      case "text":
        questions.push({ ...base, kind: "text", format: q.multiline ? "multiline" : "plain",
          ...(q.secret ? { secret: true } : {}), ...(q.placeholder ? { placeholder: q.placeholder } : {}), ...(q.default && !q.secret ? { default: q.default } : {}) });
        break;
      case "confirm":
        questions.push({ ...base, kind: "confirm", ...(q.default && /^(yes|no)$/i.test(q.default) ? { default: q.default.toLowerCase() } : {}) });
        break;
      case "model": {
        const options = await modelOptions(d, sessionId, session);
        const def = q.default ? modelNamed(options, q.default) : undefined;
        questions.push({ ...base, kind: "model", options, ...(q.rows ? { rows: q.rows.map((label, i) => ({ id: String(i + 1), label })) } : {}), ...(def ? { default: def } : {}) });
        break;
      }
      case "file":
        questions.push({ ...base, kind: "file", ...(q.multiple ? { multiple: true } : {}) });
        break;
      case "branch": {
        const git = await d.branches(session.cwd);
        if (!git || git.branches.length === 0) throw new Error(`questions.${q.id}: this session's folder is not a git repository with branches, so there is no branch to ask about.`);
        const options = git.branches.slice(0, BRANCH_OPTIONS_MAX).map((b): AskOption => ({ value: b, label: b, ...(b === git.current ? { current: true } : {}) }));
        const def = q.default && options.some((o) => o.value === q.default) ? q.default : git.current ?? undefined;
        questions.push({ ...base, kind: "branch", options, ...(def ? { default: def } : {}) });
        break;
      }
      case "time": {
        const format = q.dateOnly ? "date" : "datetime";
        const ok = q.default && (format === "date" ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).test(q.default);
        questions.push({ ...base, kind: "time", format, ...(ok ? { default: q.default } : {}) });
        break;
      }
    }
  }
  const card = AskCardSchema.safeParse({ asker: { kind: "agent", name: AGENT_META[session.agentKind].label, agent: session.agentKind }, mode: "question",
    ...(input.message ? { message: input.message } : {}), questions, workspace: session.cwd });
  if (!card.success) throw new Error(`Realm cannot draw these questions: ${card.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return card.data;
}

/** A checkout's branches for a branch field, most recently committed first, and the current one.
 *  Through `gitCapture`, so the hardening every git call Realm makes carries applies here too. */
export async function listBranches(cwd: string): Promise<{ branches: string[]; current: string | null } | null> {
  const refs = await gitCapture(cwd, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/heads"]).catch(() => null);
  if (!refs || refs.code !== 0) return null;
  const head = await gitCapture(cwd, ["branch", "--show-current"]).catch(() => null);
  const current = head && head.code === 0 ? head.stdout.trim() || null : null;
  return { branches: refs.stdout.split("\n").map((b) => b.trim()).filter(Boolean), current };
}

/**
 * The models a model field offers: this session's own first — its value the id it is pinned to, or
 * the name its harness default goes by, both of which `constraints.model` resolves — then every model
 * a sub-agent could be put on, by the id its route takes.
 */
async function modelOptions(d: UiAgentToolsDeps, sessionId: string, session: Pick<Session, "agentKind" | "model">): Promise<AskOption[]> {
  const { models, own } = await d.models(sessionId);
  const ownValue = session.model ?? own.label;
  const options: AskOption[] = [{ value: ownValue, label: own.label, agent: own.kind, own: true }];
  for (const m of models) {
    if (options.length >= MODEL_OPTIONS_MAX) break;
    if (m.id === ownValue || (m.kind === own.kind && m.label === own.label)) continue;
    options.push({ value: m.id, label: m.label, agent: m.kind, ...(m.ready ? {} : { ready: false }) });
  }
  return options;
}

/** The option a model name means — an id, or a label as a person says it. */
const modelNamed = (options: AskOption[], name: string): string | undefined => {
  const n = name.trim().toLowerCase();
  return options.find((o) => o.value.toLowerCase() === n || o.label.toLowerCase() === n)?.value;
};

/** A picture of an option, as an absolute path Realm checked is a raster image inside the workspace —
 *  or a refusal that tells the agent what to fix. */
async function pictureIn(cwd: string, path: string, where: string): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) throw new Error(`${where}: a picture is a path to a file in this workspace, not a URL (${path}).`);
  const root = await realpath(cwd);
  let real: string;
  try { real = await realpath(isAbsolute(path) ? path : resolve(root, path)); }
  catch { throw new Error(`${where}: there is no file at ${path} in this workspace.`); }
  if (real !== root && !real.startsWith(root + sep)) throw new Error(`${where}: ${path} is outside this session's workspace.`);
  if (!IMAGE_EXTS.has(extname(real).toLowerCase())) throw new Error(`${where}: ${path} is not a picture Realm draws (png, jpg, gif, webp or heic).`);
  const s = await stat(real);
  if (!s.isFile() || s.size > IMAGE_MAX_BYTES) throw new Error(`${where}: ${path} is not a picture file Realm can show.`);
  return real;
}

/** How the agent is told what happened: words it can read, and the same answers as data. */
function resultOf(card: AskCard, outcome: AskOutcome): CallToolResult {
  if (outcome.outcome !== "answered") {
    const why = outcome.outcome === "timeout" ? "No answer came within 15 minutes, so the question was withdrawn."
      : outcome.outcome === "cancelled" ? "The question was withdrawn before it was answered."
        : "The user skipped the question.";
    return { content: [{ type: "text", text: `${why} Carry on without it, or ask in your reply if you cannot.` }],
      structuredContent: { skipped: true, ...(outcome.outcome === "skipped" ? {} : { reason: outcome.outcome }) }, isError: false };
  }
  const { answers } = outcome;
  const lines = ["The user answered:"];
  for (const q of card.questions) lines.push(...answerLines(q, answers));
  if (card.questions.some((q) => q.kind === "model" && answers[q.id] !== undefined))
    lines.push("", "Each model answer is an id `agent_start` and `agent_run` take as `constraints.model`.");
  return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { answers }, isError: false };
}

function answerLines(q: AskQuestion, answers: AskAnswers): string[] {
  const a = answers[q.id];
  const head = `- ${q.id} (${q.prompt})`;
  if (a === undefined) return [`${head}: not answered`];
  if (q.kind === "model") {
    const named = (v: string) => {
      const o = q.options?.find((x) => x.value === v);
      return o ? `${v} (${o.label}${o.agent ? `, on ${AGENT_META[o.agent].label}` : ""}${o.own ? ", this session's own model" : ""})` : v;
    };
    if (q.rows && Array.isArray(a)) return [`${head}:`, ...q.rows.map((r, i) => `  ${i + 1}. ${r.label}: ${named(a[i] ?? "")}`)];
    return [`${head}: ${named(Array.isArray(a) ? a[0] ?? "" : a)}`];
  }
  return [`${head}: ${Array.isArray(a) ? a.join(", ") : a}`];
}
