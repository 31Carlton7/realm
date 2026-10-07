import { z } from "zod";
import { AgentKindSchema } from "./entities";

/**
 * One question card for every agent.
 *
 * Four feeds put questions to the user, and each speaks its own protocol: Claude's `AskUserQuestion`
 * tool, Codex's `item/tool/requestUserInput` and its MCP elicitation passthrough, MCP elicitation
 * from a server behind Realm's hub (and ACP's `elicitation/create`, which borrows its shapes), and
 * Realm's own `realm-ui` provider, whose `ui_ask` lets any agent ask with fields only Realm can fill.
 * Every one of them is turned into an `AskCard` HERE, or beside its adapter, before it reaches the
 * transcript — so the renderer draws one shape and never learns a protocol.
 *
 * The card rides `permission_request.ask`, and it is Realm's own: an adapter or the server writes it,
 * never an agent's tool arguments verbatim. That is what lets the renderer route on it — a field an
 * agent controls could otherwise turn a permission for a mutating tool into a "question" whose answer
 * is an Allow.
 *
 * **Data only.** Every string here is drawn as plain text. Nothing is fetched or run: a picture is a
 * path Realm resolved inside the session's workspace and main turns into pixels, and a URL is shown as
 * text and opened by the system browser only when the user clicks.
 */

/** What a masked answer is written as, wherever Realm keeps a copy: the transcript, the call log. The
 *  asker still receives the real value — it asked for it. */
export const HIDDEN_ANSWER = "••••••";

/** How many questions one `ui_ask` (and one Claude `AskUserQuestion`) may hold. A form longer than
 *  that is a page, not a question, and the card pages through them one at a time. */
export const ASK_QUESTIONS_MAX = 4;
/** An elicitation form's fields. More than this and Realm declines it rather than drawing a sheet. */
export const ASK_FORM_FIELDS_MAX = 12;

export const AskKindSchema = z.enum([
  /** One of the options, or text of your own where `allowOther`. */
  "choice",
  /** Several of the options. */
  "multi",
  "text",
  /** Yes or no; answered "yes" / "no". */
  "confirm",
  /** A model this Mac can run — options filled from Realm's catalog, never by the asker. */
  "model",
  /** A file in the session's workspace, searched the way ⌘P searches it. */
  "file",
  /** A branch of the session's checkout. */
  "branch",
  /** A date, or a date and a time. */
  "time",
  /** A page the asker wants opened (MCP's URL mode). Answered "opened" once the user clicked. */
  "link",
]);
export type AskKind = z.infer<typeof AskKindSchema>;

export const AskOptionSchema = z.object({
  /** What the answer carries. The label is what the card shows; for most askers the two are equal. */
  value: z.string().max(2000),
  label: z.string().min(1).max(500),
  description: z.string().max(2000).optional(),
  /** An absolute path Realm resolved inside the workspace and checked is an image. */
  image: z.string().max(4096).optional(),
  /** A model option's harness — whose mark its chip wears. */
  agent: AgentKindSchema.optional(),
  /** False for a model whose harness is not installed or signed in: listed, not pickable. */
  ready: z.boolean().optional(),
  /** The session's own model, which the chooser lists first. */
  own: z.boolean().optional(),
  /** A branch option that is the checkout's current branch. */
  current: z.boolean().optional(),
});
export type AskOption = z.infer<typeof AskOptionSchema>;

export const AskQuestionSchema = z.object({
  /** Claude keys its answers by the question's text, so an id can be as long as a prompt. */
  id: z.string().min(1).max(2000),
  prompt: z.string().min(1).max(2000),
  /** A short tag for the question ("Database"), drawn beside who is asking. */
  header: z.string().max(80).optional(),
  /** A line under the prompt: what a form field is for, in the asker's words. */
  detail: z.string().max(2000).optional(),
  kind: AskKindSchema,
  options: z.array(AskOptionSchema).max(400).optional(),
  /** A field for an answer of your own beside the options. */
  allowOther: z.boolean().optional(),
  /** Typed into a masked field; the answer reaches the asker and never Realm's log. */
  secret: z.boolean().optional(),
  /** Cannot be skipped on its own. */
  required: z.boolean().optional(),
  default: z.union([z.string(), z.array(z.string())]).optional(),
  /** A `model` question asked per row — "Who builds each step?" — answered as one model per row. */
  rows: z.array(z.object({ id: z.string().min(1).max(200), label: z.string().min(1).max(500) })).max(24).optional(),
  /** How a text answer is typed, and so how it is read back by a form: `number` and `integer` go back
   *  as numbers. For `time`, whether the clock is asked for too. */
  format: z.enum(["plain", "multiline", "email", "uri", "number", "integer", "date", "datetime"]).optional(),
  /** Bounds: a number's range, a text's length. */
  min: z.number().optional(),
  max: z.number().optional(),
  /** A `file` question that takes several. */
  multiple: z.boolean().optional(),
  placeholder: z.string().max(200).optional(),
  /** The page a `link` question opens. */
  url: z.string().max(8192).optional(),
});
export type AskQuestion = z.infer<typeof AskQuestionSchema>;

export const AskerSchema = z.object({
  /** `agent`: the session's own agent. `server`: an MCP server, by the name the user gave it. */
  kind: z.enum(["agent", "server"]),
  name: z.string().min(1).max(120),
  /** The harness, for an agent — whose mark the card wears. */
  agent: AgentKindSchema.optional(),
  /** The agent a server's question came through, when it is one of that agent's own servers. */
  via: z.string().max(120).optional(),
});
export type Asker = z.infer<typeof AskerSchema>;

export const AskCardSchema = z.object({
  asker: AskerSchema,
  /** What the asker said the questions are for, above them. */
  message: z.string().max(4000).optional(),
  /** Which protocol the answer goes back on, and so what dismissing is called: an agent's question is
   *  skipped, an MCP form is declined, a page to open is declined too. */
  mode: z.enum(["question", "form", "url"]),
  questions: z.array(AskQuestionSchema).min(1).max(16),
  /** The session's working directory: what a `file` question searches. */
  workspace: z.string().max(4096).optional(),
  /** Realm declined this request itself, before it reached anyone, for the reason given. The card is
   *  drawn as already answered: nothing about it is the user's to decide. */
  refused: z.string().max(1000).optional(),
}).superRefine((card, ctx) => {
  for (const [i, q] of card.questions.entries()) {
    const opts = q.options?.length ?? 0;
    // A question with no row to answer on would hold the session forever: refused here, so the
    // renderer falls back to the plain permission card instead of drawing a dead end.
    if ((q.kind === "choice" || q.kind === "multi") && opts === 0 && !q.allowOther)
      ctx.addIssue({ code: "custom", path: ["questions", i, "options"], message: "a choice needs options or a field of your own" });
    if (q.kind === "model" && opts === 0) ctx.addIssue({ code: "custom", path: ["questions", i, "options"], message: "no model to choose from" });
    if (q.kind === "link" && !q.url) ctx.addIssue({ code: "custom", path: ["questions", i, "url"], message: "a link needs its page" });
  }
});
export type AskCard = z.infer<typeof AskCardSchema>;

/** Question id → what was chosen or typed. Several (a multi-choice, a model per row) as a list. */
export const AskAnswersSchema = z.record(z.string(), z.union([z.string().max(20_000), z.array(z.string().max(20_000)).max(100)]));
export type AskAnswers = z.infer<typeof AskAnswersSchema>;

/** The question ids whose answers must never be kept. */
export function secretQuestionIds(card: AskCard): Set<string> {
  return new Set(card.questions.filter((q) => q.secret === true).map((q) => q.id));
}

/** The answers as Realm's own log may keep them: a masked one is a mark, never the value. */
export function loggableAnswers(card: AskCard, answers: AskAnswers): AskAnswers {
  const secret = secretQuestionIds(card);
  if (secret.size === 0) return answers;
  return Object.fromEntries(Object.entries(answers).map(([id, a]) => [id, secret.has(id) ? HIDDEN_ANSWER : a]));
}

/**
 * The answers worth handing back, and only those: ids the card asked, in the shape each kind takes,
 * a choice among its own options unless it offered a field of its own, a file inside the workspace.
 *
 * The renderer is the user's, but `sessions.respondPermission` is an RPC anything holding the token
 * can call, and an answer is about to become a tool result an agent acts on. So the card the
 * question was asked with — Realm's own record of it — is what an answer is held to.
 */
export function normalizeAnswers(card: AskCard, raw: AskAnswers | undefined): AskAnswers {
  const out: AskAnswers = {};
  if (!raw) return out;
  for (const q of card.questions) {
    const a = raw[q.id];
    if (a === undefined) continue;
    const values = (Array.isArray(a) ? a : [a]).map((v) => v.trim()).filter((v) => v !== "");
    const offered = new Set((q.options ?? []).map((o) => o.value));
    const among = (v: string) => offered.has(v) || q.allowOther === true;
    switch (q.kind) {
      case "choice": case "branch": { const v = values[0]; if (v !== undefined && among(v)) out[q.id] = v; break; }
      case "multi": { const vs = values.filter(among); if (vs.length) out[q.id] = vs; break; }
      case "model": {
        if (q.rows) {
          // One per row, in row order, each one of the offered models. A short or foreign list is
          // not an answer to "who builds each step", so it is not passed on as one.
          const vs = Array.isArray(a) ? a : [];
          if (vs.length === q.rows.length && vs.every((v) => offered.has(v))) out[q.id] = vs;
        } else if (values[0] !== undefined && offered.has(values[0])) out[q.id] = values[0];
        break;
      }
      case "confirm": { const v = values[0]?.toLowerCase(); if (v === "yes" || v === "no") out[q.id] = v; break; }
      case "file": {
        const vs = values.filter(isWorkspaceRelative);
        if (vs.length) out[q.id] = q.multiple ? vs : vs[0]!;
        break;
      }
      case "time": { const v = values[0]; if (v !== undefined && (q.format === "date" ? DATE.test(v) : DATETIME.test(v))) out[q.id] = v; break; }
      case "link": { if (values[0] === "opened") out[q.id] = "opened"; break; }
      case "text": {
        // Typed answers keep their whitespace: a multi-line note is the note, not its trim.
        const v = Array.isArray(a) ? a[0] : a;
        if (v !== undefined && v.trim() !== "") out[q.id] = v;
        break;
      }
    }
  }
  return out;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

/** A repo-relative path that stays inside its root: no absolute path, no `..` segment. */
export function isWorkspaceRelative(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(p)) return false;
  return !p.split(/[\\/]/).some((seg) => seg === "..");
}

/* ─────────────────────────────── Claude's AskUserQuestion ─────────────────────────────── */

/**
 * Claude's `AskUserQuestion` input as a card. Keyed by the question TEXT, because that is what the
 * SDK reads its answers by. Null for anything that is not genuinely question-shaped, so the caller
 * falls back to the permission card rather than drawing a broken one.
 *
 * `options: []` with free text is a text question, which the card draws as the field itself. Both
 * off together is a card with no row to answer on, and the session would sit on it forever — so it is
 * null like any other malformed input.
 */
export function askCardFromAskUserQuestion(input: unknown, asker: Asker): AskCard | null {
  const raw = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") return null;
    const { question, header, options, multiSelect, allowOther, secret } = q as Record<string, unknown>;
    if (typeof question !== "string" || question === "" || !Array.isArray(options)) return null;
    const free = allowOther !== false;
    if (options.length === 0 && !free) return null;
    const opts: AskOption[] = [];
    for (const o of options) {
      if (!o || typeof o !== "object") return null;
      const { label, description } = o as Record<string, unknown>;
      if (typeof label !== "string" || label === "") return null;
      opts.push({ value: label, label, ...(typeof description === "string" && description ? { description } : {}) });
    }
    questions.push({
      id: question, prompt: question, kind: opts.length === 0 ? "text" : multiSelect === true ? "multi" : "choice",
      ...(typeof header === "string" && header ? { header: header.slice(0, 80) } : {}),
      ...(opts.length ? { options: opts, allowOther: free } : {}),
      ...(secret === true ? { secret: true } : {}),
    });
  }
  const card = AskCardSchema.safeParse({ asker, mode: "question", questions });
  return card.success ? card.data : null;
}

/**
 * The answers the SDK reads back: question text → label, several comma-joined — the tool's own
 * contract, which predates a card that hands back lists.
 */
export function claudeAnswers(answers: AskAnswers): Record<string, string> {
  return Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, Array.isArray(a) ? a.join(", ") : a]));
}

/* ─────────────────────────────── MCP (and ACP) elicitation ─────────────────────────────── */

/**
 * `elicitation/create`'s params, as MCP 2025-11-25 sends them and ACP 1.7 borrows them: a form
 * (`requestedSchema`, a flat object of primitives) or a page to open (`url`). Codex forwards the same
 * pair from the servers in the user's own Codex config. Everything is read permissively — a missing
 * `mode` is a form, per the spec.
 */
export type ElicitationParams = {
  mode?: string;
  message?: unknown;
  requestedSchema?: unknown;
  url?: unknown;
};

/** What answering an elicitation sends back, in MCP's own words. */
export type ElicitationResult = { action: "accept" | "decline" | "cancel"; content?: Record<string, string | number | boolean | string[]> };

/**
 * Words that name a credential. MCP says a server MUST NOT ask for "passwords, API keys, access
 * tokens, or payment credentials" in a form, and must send the user to a page of its own instead —
 * so a form that asks anyway is declined rather than drawn. A form field cannot be masked: the
 * protocol has no way to say "secret", and a value typed into one goes into the log with every other
 * answer. Matched against a field's key and title (camelCase split), never its description, where
 * ordinary prose mentions these words all the time.
 */
const CREDENTIAL = /\b(pass ?(word|phrase|code)|pwd|api ?keys?|secrets?|client ?secret|private ?key|bearer|otp|totp|one ?time ?(code|password)|2fa|mfa|verification ?code|recovery ?codes?|cvv|cvc|card ?number|credit ?card)\b/i;
/** "Token" is a credential (an access token, a GitHub token) except where it is being COUNTED — a
 *  generation form's "Max tokens" asks for a number, not a secret. */
const TOKEN = /\btokens?\b/i;
const TOKEN_COUNT = /\b(max|min|maximum|minimum|num|number|count|total|limit)\b/i;

const words = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ");
const namesCredential = (s: string): boolean => CREDENTIAL.test(s) || (TOKEN.test(s) && !TOKEN_COUNT.test(s));

/** Whether a form field plainly asks for a credential. */
export function asksForCredential(key: string, schema: Record<string, unknown>): boolean {
  if (schema.type === "boolean") return false;
  if (schema.format === "password" || schema.writeOnly === true) return true;
  const title = typeof schema.title === "string" ? schema.title : "";
  return namesCredential(words(key)) || namesCredential(words(title));
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

/**
 * An elicitation as a card, or the reason Realm declines it.
 *
 * Declined, never drawn: a form asking for a credential (see `asksForCredential`), one longer than
 * `ASK_FORM_FIELDS_MAX`, one using a shape outside MCP's flat primitive subset, and a "page" whose
 * address is not an http(s) URL — a `javascript:` or `file:` link has no business on a consent card.
 * Every refusal still comes back as a card, `refused` set, so the transcript can say what was declined
 * and why.
 */
export function askCardFromElicitation(params: ElicitationParams, asker: Asker): AskCard {
  const message = (text(params.message) ?? "").slice(0, 4000);
  const refuse = (why: string): AskCard =>
    ({ asker, mode: params.mode === "url" ? "url" : "form", message: message || undefined, refused: why,
      questions: [{ id: "_", prompt: message || "A request Realm declined", kind: "text" }] });

  if (params.mode === "url") {
    const href = typeof params.url === "string" ? params.url : "";
    let url: URL | null = null;
    try { url = new URL(href); } catch { url = null; }
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return refuse("It asked to open something that is not a web address.");
    return { asker, mode: "url", questions: [{ id: "url", prompt: message || `Open ${url.host}?`, kind: "link", url: url.href }] };
  }
  if (params.mode !== undefined && params.mode !== "form") return refuse("It asked in a way Realm does not support.");

  const schema = (params.requestedSchema ?? {}) as { type?: unknown; properties?: unknown; required?: unknown };
  const props = schema.properties && typeof schema.properties === "object" ? Object.entries(schema.properties as Record<string, unknown>) : [];
  if (schema.type !== "object" || props.length === 0) return refuse("It sent a form with nothing to fill in.");
  if (props.length > ASK_FORM_FIELDS_MAX) return refuse(`Its form has ${props.length} fields, more than Realm draws in a card.`);
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === "string") : []);

  const questions: AskQuestion[] = [];
  for (const [key, raw] of props) {
    const field = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (asksForCredential(key, field)) return refuse("It asked for a password or a key in a form. Servers have to ask for those on a page of their own, so Realm declined it.");
    const q = fieldQuestion(key, field, required.has(key));
    if (!q) return refuse(`Its field “${text(field.title) ?? key}” is a kind of input Realm cannot draw.`);
    questions.push(q);
  }
  // A one-field form reads as one question: the message IS the prompt, and the field's own title
  // becomes its tag. Drawn the other way, the card says the same thing twice.
  const title = text((props[0]![1] as Record<string, unknown>).title);
  const card = questions.length === 1 && message
    ? { asker, mode: "form" as const, questions: [{ ...questions[0]!, prompt: message, ...(title ? { header: title.slice(0, 80) } : {}) }] }
    : { asker, mode: "form" as const, ...(message ? { message } : {}), questions };
  const parsed = AskCardSchema.safeParse(card);
  return parsed.success ? parsed.data : refuse("It sent a form Realm cannot draw.");
}

/** One form field as a question, or null for a shape MCP's subset does not have. */
function fieldQuestion(key: string, f: Record<string, unknown>, required: boolean): AskQuestion | null {
  const base = {
    id: key, prompt: text(f.title) ?? key,
    ...(text(f.description) ? { detail: text(f.description) } : {}),
    ...(required ? { required: true } : {}),
  };
  const enumOptions = (s: Record<string, unknown>): AskOption[] | null => {
    if (Array.isArray(s.oneOf) || Array.isArray(s.anyOf)) {
      const list = (Array.isArray(s.oneOf) ? s.oneOf : s.anyOf) as unknown[];
      const opts = list.map((o) => o as Record<string, unknown>).filter((o) => typeof o.const === "string")
        .map((o): AskOption => ({ value: o.const as string, label: text(o.title) ?? (o.const as string), ...(text(o.description) ? { description: text(o.description) } : {}) }));
      return opts.length ? opts : null;
    }
    if (Array.isArray(s.enum)) {
      const names = Array.isArray(s.enumNames) ? s.enumNames : [];
      const opts = s.enum.filter((v): v is string => typeof v === "string")
        .map((v, i): AskOption => ({ value: v, label: typeof names[i] === "string" && names[i] ? (names[i] as string) : v }));
      return opts.length ? opts : null;
    }
    return null;
  };
  switch (f.type) {
    case "boolean":
      return { ...base, kind: "confirm", ...(typeof f.default === "boolean" ? { default: f.default ? "yes" : "no" } : {}) };
    case "number": case "integer":
      return { ...base, kind: "text", format: f.type,
        ...(typeof f.minimum === "number" ? { min: f.minimum } : {}), ...(typeof f.maximum === "number" ? { max: f.maximum } : {}),
        ...(typeof f.default === "number" ? { default: String(f.default) } : {}) };
    case "array": {
      const items = (f.items && typeof f.items === "object" ? f.items : {}) as Record<string, unknown>;
      const options = enumOptions(items);
      if (!options) return null;
      const def = Array.isArray(f.default) ? f.default.filter((v): v is string => typeof v === "string") : undefined;
      return { ...base, kind: "multi", options, ...(def?.length ? { default: def } : {}) };
    }
    case "string": {
      const options = enumOptions(f);
      const def = typeof f.default === "string" ? { default: f.default } : {};
      if (options) return { ...base, kind: "choice", options, ...def };
      if (f.format === "date" || f.format === "date-time") return { ...base, kind: "time", format: f.format === "date" ? "date" : "datetime", ...def };
      return { ...base, kind: "text", format: f.format === "email" ? "email" : f.format === "uri" ? "uri" : "plain",
        ...(typeof f.minLength === "number" ? { min: f.minLength } : {}), ...(typeof f.maxLength === "number" ? { max: f.maxLength } : {}), ...def };
    }
    default:
      return null;
  }
}

/**
 * The card's answers as the form's own types: numbers as numbers, yes/no as booleans, a multi-select
 * as a list, a date-time as RFC 3339. Fields left unanswered are left out, which is how a form says
 * "skipped" for an optional one.
 */
export function elicitationContent(card: AskCard, answers: AskAnswers): Record<string, string | number | boolean | string[]> {
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const q of card.questions) {
    const a = answers[q.id];
    if (a === undefined) continue;
    const one = Array.isArray(a) ? a[0] : a;
    if (q.kind === "multi") { out[q.id] = Array.isArray(a) ? a : [a]; continue; }
    if (one === undefined) continue;
    if (q.kind === "confirm") { out[q.id] = one === "yes"; continue; }
    if (q.kind === "text" && (q.format === "number" || q.format === "integer")) {
      const n = Number(one);
      if (Number.isFinite(n) && (q.format === "number" || Number.isInteger(n))) out[q.id] = n;
      continue;
    }
    if (q.kind === "time" && q.format === "datetime") {
      // The field asks local time; the protocol's `date-time` is RFC 3339, which carries a zone.
      const ms = Date.parse(one);
      if (Number.isFinite(ms)) out[q.id] = new Date(ms).toISOString();
      continue;
    }
    out[q.id] = one;
  }
  return out;
}

/** Whether every field the form requires has an answer — accepting without one is not an answer. */
export function requiredAnswered(card: AskCard, answers: AskAnswers): boolean {
  return card.questions.every((q) => q.required !== true || answers[q.id] !== undefined);
}

/* ─────────────────────────────── realm-ui's ui_ask ─────────────────────────────── */

const Label = z.string().trim().min(1).max(200);

/**
 * What an agent hands `ui_ask`: the questions, in the agent's words. Strict, and smaller than a card,
 * because this is the one feed whose input an agent writes directly — Realm fills everything a field
 * offers from its own catalogs (models, branches, files) and resolves every picture itself.
 */
export const UiAskInputSchema = z.object({
  message: z.string().trim().max(1000).optional(),
  questions: z.array(z.object({
    id: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/, "letters, digits, '_', '-' or '.'"),
    prompt: z.string().trim().min(1).max(500),
    header: z.string().trim().max(40).optional(),
    kind: z.enum(["choice", "multi", "text", "confirm", "model", "file", "branch", "time"]),
    options: z.array(z.object({
      label: Label,
      description: z.string().trim().max(300).optional(),
      /** A picture of the option: a path in this session's workspace. */
      image: z.string().trim().min(1).max(1024).optional(),
    }).strict()).max(12).optional(),
    allowOther: z.boolean().optional(),
    secret: z.boolean().optional(),
    multiline: z.boolean().optional(),
    placeholder: z.string().trim().max(120).optional(),
    /** For `model`: the rows that each take a model. */
    rows: z.array(Label).min(1).max(12).optional(),
    /** For `time`: ask for the day only. */
    dateOnly: z.boolean().optional(),
    /** For `file`: several. */
    multiple: z.boolean().optional(),
    /** A pre-selected answer: an option's label, a model name, a branch, a date. */
    default: z.string().trim().max(200).optional(),
  }).strict().superRefine((q, ctx) => {
    if ((q.kind === "choice" || q.kind === "multi") && !q.options?.length && !q.allowOther)
      ctx.addIssue({ code: "custom", path: ["options"], message: `a ${q.kind} question needs options (or allowOther for an answer of the user's own)` });
    if (q.options?.length && q.kind !== "choice" && q.kind !== "multi")
      ctx.addIssue({ code: "custom", path: ["options"], message: `options belong to choice and multi questions; a ${q.kind} question is filled by Realm` });
    if (q.secret && q.kind !== "text") ctx.addIssue({ code: "custom", path: ["secret"], message: "only a text question can be secret" });
    if (q.rows && q.kind !== "model") ctx.addIssue({ code: "custom", path: ["rows"], message: "rows belong to a model question" });
    const labels = (q.options ?? []).map((o) => o.label.toLowerCase());
    if (new Set(labels).size !== labels.length) ctx.addIssue({ code: "custom", path: ["options"], message: "two options share a label" });
  })).min(1).max(ASK_QUESTIONS_MAX).superRefine((qs, ctx) => {
    const ids = qs.map((q) => q.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "two questions share an id" });
  }),
}).strict();
export type UiAskInput = z.infer<typeof UiAskInputSchema>;
