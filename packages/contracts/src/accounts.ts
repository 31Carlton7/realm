import { z } from "zod";
import { AgentKindSchema, type AgentKind } from "./entities";

/**
 * Accounts: more than one login per agent CLI on one Mac.
 *
 * Claude Code and Codex each keep everything about a login — its credentials, its settings, its
 * transcripts — under one folder the CLI reads from an environment variable, and the CLI's own login
 * signs in whatever folder that variable names. So an account is a folder Realm makes and hands the
 * CLI, and a session runs on one by being started with it. The CLI's own folder (`~/.claude`,
 * `~/.codex`) is the default account, which every session ran on before there were others.
 *
 * Measured against Claude Code 2.1.316 before anything here was built on it: with `CLAUDE_CONFIG_DIR`
 * set, its macOS Keychain item is `Claude Code-credentials-<first 8 hex of sha256(the folder)>` under
 * the user's name, beside the default folder's `Claude Code-credentials` — so two accounts never share
 * a credential, and the folder's path is the whole of the account's identity. Codex keeps its login in
 * `$CODEX_HOME/auth.json`, and refuses a `CODEX_HOME` that does not exist yet.
 */
export const ACCOUNT_KINDS = ["claude", "codex"] as const satisfies readonly AgentKind[];
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
export const hasAccounts = (kind: AgentKind): kind is AccountKind => (ACCOUNT_KINDS as readonly AgentKind[]).includes(kind);

/** The variable each CLI reads its whole folder from. */
export const ACCOUNT_DIR_ENV = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" } as const satisfies Record<AccountKind, string>;

/** The CLI's own account: its default folder, the one every session used before Realm had accounts. */
export const defaultAccountId = (kind: AccountKind): string => `default-${kind}`;

export const AccountSchema = z.object({
  id: z.string(),
  kind: AgentKindSchema,
  /** The person's name for it. */
  label: z.string(),
  /** The folder the CLI keeps this account in; null for the default account, which is wherever the
   *  CLI keeps its own. */
  configDir: z.string().nullable(),
  /** What the CLI last said: signed in or not, and null before it has been asked or when it could
   *  not tell. Never stored — a credential can expire between two reads. */
  signedIn: z.boolean().nullable(),
  /** The email and plan the CLI reports for the login, kept from the last time it said. */
  email: z.string().nullable(),
  plan: z.string().nullable(),
  createdAt: z.number(),
});
export type Account = z.infer<typeof AccountSchema>;

/** "Work · you@example.com" — how a list names an account: the label, and the email where it adds one. */
export const accountName = (a: Pick<Account, "label" | "email">): string =>
  a.email && a.email !== a.label ? `${a.label} · ${a.email}` : a.label;
