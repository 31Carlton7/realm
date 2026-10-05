import { z } from "zod";
import { basenameOf } from "./attachments";
import { CHIP_LABEL_MAX, chipLabel, elementChipToken, scanElementChips } from "./chips";

/**
 * What an `@` in the prompter names besides a skill: a file in the session's workspace, a file from
 * the Library, or an app on this Mac.
 *
 * Each rides the bracketed token the element and link chips already use — `@[auth.ts]`,
 * `@[Messages]` — because a file name and an app name both carry spaces and dots that a bare `@id`
 * cannot, and because one token grammar is one set of gestures (a click selects it, ⌫ takes it, the
 * pointer turns its mark into ×) that the composer already has. What the token STANDS FOR lives
 * beside the text, kept alive by the rule every sidecar follows: an entry lives while its token does.
 *
 * @Mac is not here. It is the `mac` skill, mentioned as `@mac` like any other — see MAC_SKILL_ID.
 */

/** The bundled skill @Mac stands for: Realm's CLI for this Mac's own apps. */
export const MAC_SKILL_ID = "mac";

/** How many named things one message may carry. A prompt that points at twelve files has stopped
 *  pointing; the cap bounds what the server stats and grants, and is checked at the schema. */
export const MAX_MENTION_REFS = 12;

/** File rows one keystroke asks the server for. The list shows a handful of each kind; past eight the
 *  answer to "too many files" is another character, not a longer list. */
export const MENTION_FILES_LIMIT = 8;

/** Reverse-DNS, the only shape a bundle identifier takes. Checked because the id is what a computer-use
 *  grant is keyed on, and a grant for a string that cannot be a bundle id is a grant for nothing. */
export const BUNDLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;

const LabelSchema = z.string().min(1).max(CHIP_LABEL_MAX);
const AbsolutePathSchema = z.string().min(2).max(4096)
  .refine((p) => p.startsWith("/") && !p.includes("\0"), { message: "an absolute path" });

export const MentionRefSchema = z.discriminatedUnion("kind", [
  /** A file in the session's own checkout, by its absolute path. */
  z.object({ kind: z.literal("file"), label: LabelSchema, path: AbsolutePathSchema }),
  /** A file from the Library — something a session wrote or was given. */
  z.object({ kind: z.literal("library"), label: LabelSchema, path: AbsolutePathSchema }),
  /** An application. The bundle id is what computer use is granted for; the path is only ever where
   *  main reads the icon from, and main checks it against its own scan before reading anything. */
  z.object({ kind: z.literal("app"), label: LabelSchema, name: z.string().min(1).max(120), bundleId: z.string().regex(BUNDLE_ID_RE), path: AbsolutePathSchema }),
]);
export type MentionRef = z.infer<typeof MentionRefSchema>;

/** An application on this Mac, as main's scan of the Applications folders found it. */
export type InstalledApp = {
  /** The name the Finder shows: the bundle's file name without `.app`. */
  name: string;
  bundleId: string;
  /** The bundle's path: where main reads the icon from, and the key the renderer caches it under. */
  path: string;
  /** Other names it answers to — `CFBundleDisplayName` and `CFBundleName` where they differ from the
   *  file name, so `@code` finds "Visual Studio Code". */
  aliases: string[];
  /** Its place in the Dock, 0 first, or null when it is not kept there. */
  dock: number | null;
};

/**
 * The apps Realm's `mac` CLI drives directly, by bundle id, with the command group that does it.
 *
 * Copied from the `mac` skill's own command table. A mention of one of these is still a computer-use
 * grant — the CLI does not reach everything an app can do — but the agent is told the CLI is the
 * straighter road: it speaks EventKit and AppleScript with stable JSON, where computer use reads a
 * window and clicks it.
 */
export const MAC_CLI_APPS: Readonly<Record<string, string>> = {
  "com.apple.iCal": "calendar",
  "com.apple.reminders": "reminders",
  "com.apple.AddressBook": "contacts",
  "com.apple.mail": "mail",
  "com.apple.MobileSMS": "messages",
  "com.apple.Notes": "notes",
  "com.apple.Music": "music",
  "com.apple.TV": "tv",
  "com.apple.shortcuts": "shortcuts",
  "com.apple.finder": "finder",
  "com.apple.iWork.Keynote": "keynote",
  "com.apple.iWork.Pages": "pages",
  "com.apple.iWork.Numbers": "numbers",
  "com.apple.FaceTime": "facetime",
};

/** The entries a draft still refers to — `keepLiveChips`'s rule, for named things. */
export function keepLiveRefs(text: string, refs: readonly MentionRef[]): MentionRef[] {
  const present = new Set(scanElementChips(text).map((c) => c.label));
  return refs.filter((r) => present.has(r.label));
}

/**
 * A label no other chip in the draft already wears, from the best name first.
 *
 * A file's candidates run from its name outwards — `auth.ts`, then `server/auth.ts` — because the
 * directory is what tells two files of one name apart, and a number would only say THAT they differ.
 * A numbered suffix is the last resort, and it is made room for rather than appended to a label
 * already at the cap, which would clip it straight back off.
 */
export function mentionRefLabel(candidates: readonly string[], taken: Iterable<string>): string {
  const used = new Set(taken);
  const names = candidates.map(chipLabel).filter((c) => c !== "");
  for (const c of names) if (!used.has(c)) return c;
  const base = names[0] ?? "file";
  for (let n = 2; n < 100; n++) {
    const suffix = ` ${n}`;
    const c = `${base.slice(0, CHIP_LABEL_MAX - suffix.length)}${suffix}`;
    if (!used.has(c)) return c;
  }
  return base;
}

/** A workspace path's chip candidates: the name, then each parent added on, innermost first. */
export function fileLabelCandidates(relPath: string): string[] {
  const parts = relPath.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) out.push(parts.slice(i).join("/"));
  return out.length > 0 ? out : [basenameOf(relPath)];
}

/**
 * Files no mention may offer, by name: the ones that exist to hold a secret.
 *
 * `.gitignore` keeps most of these out of a checkout's listing already, but not all of them — a
 * `.env` committed by mistake, or one in a repository with no ignore rule for it, is listed by git as
 * an ordinary file. A mention hands the file to the agent, and the one thing the picker must never
 * make easy is handing over the keys, so these are refused by name whatever git says. Templates
 * that hold no secret (`.env.example`) stay offered: they are documentation.
 *
 * Deliberately a list of well-known carriers rather than a guess at anything that sounds secret —
 * `secrets.ts` is usually the code that HANDLES secrets, and hiding it would be wrong.
 */
const SECRET_NAMES = new Set([
  ".env", ".envrc", ".netrc", ".npmrc", ".pypirc", ".pgpass", ".git-credentials", ".htpasswd",
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "credentials.json",
]);
const SECRET_EXTS = new Set(["pem", "key", "p12", "pfx", "jks", "keystore", "kdbx", "ppk"]);
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg"]);
const TEMPLATE_SUFFIX = /\.(example|sample|template|dist)$/;

export function isSecretPath(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  if (parts.slice(0, -1).some((p) => SECRET_DIRS.has(p))) return true;
  const name = parts[parts.length - 1] ?? "";
  if (TEMPLATE_SUFFIX.test(name)) return false;
  if (SECRET_NAMES.has(name) || name.startsWith(".env.")) return true;
  if (/^client_secret.*\.json$/.test(name)) return true;
  const dot = name.lastIndexOf(".");
  return dot > 0 && SECRET_EXTS.has(name.slice(dot + 1).toLowerCase());
}

/**
 * What the named things add to the message the agent receives, appended to the user's text at send.
 *
 * The same split `elementContext` makes: the transcript keeps what the user typed — the chips — and
 * the detail rides underneath, one line per chip, so the agent can match `@[auth.ts]` in the sentence
 * to the file it means. Files are also attached (the server does that), so an image reaches the
 * agent as an image; this block is what says which attachment each chip was.
 *
 * Apps say what the mention did: computer use is on for this session for those apps and no others,
 * the first action in each still asks, and the session's mode still holds. An app the `mac` CLI
 * drives says so — that road is straighter than reading a window and clicking it — when the CLI's
 * skill is there to say how (`macSkill`).
 */
export function mentionRefContext(refs: readonly MentionRef[], opts: { macSkill?: string | null } = {}): string {
  const files = refs.filter((r) => r.kind === "file" || r.kind === "library");
  const apps = refs.filter((r): r is Extract<MentionRef, { kind: "app" }> => r.kind === "app");
  let out = "";
  if (files.length > 0) {
    out += `\n\nFiles the user mentioned, one per chip above:\n${files.map((r) => `  ${elementChipToken(r.label)} — ${r.path}`).join("\n")}\n`;
  }
  if (apps.length > 0) {
    out += `\n\nMac apps the user mentioned, one per chip above:\n${apps.map((r) => `  ${elementChipToken(r.label)} — ${r.name}, ${r.bundleId}`).join("\n")}\n`
      + "Computer use is on for this session for these apps and no others: work in them with the realm-computer tools — "
      + "computer_snapshot with the bundle id first, then computer_do or computer_act. The first action in each app waits "
      + "for the user's approval, and the session's permission mode applies to every action.\n";
    const cli = apps.filter((a) => MAC_CLI_APPS[a.bundleId]);
    if (cli.length > 0 && opts.macSkill) {
      out += `${cli.map((a) => a.name).join(", ")} ${cli.length === 1 ? "is" : "are"} also driven directly by Realm's \`mac\` CLI `
        + `(${cli.map((a) => `\`mac ${MAC_CLI_APPS[a.bundleId]}\``).join(", ")}) — reach for it first and use computer use for what it cannot do. `
        + `Its instructions: ${opts.macSkill}\n`;
    }
  }
  return out;
}

/**
 * What @Mac adds when the `mac` skill could not be invoked natively — the space has it switched off,
 * the session's agent has no way to be handed skills, or another skill took the message's one slot.
 *
 * The skill is handed over for this session by pointing at it: its instructions are a file, and every
 * agent Realm runs can read one and run the CLI it describes. The space's switch is left as it was.
 */
export function macSkillContext(skillPath: string): string {
  return "\n\nThe user mentioned @mac: use Realm's `mac` skill for this — a CLI for this Mac's own apps (Calendar, Reminders, "
    + `Contacts, Mail, Messages, Notes and more) with JSON output. Read its instructions at ${skillPath} first, then run \`mac\` `
    + "with your shell tool.\n";
}
