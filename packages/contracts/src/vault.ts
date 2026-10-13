import { z } from "zod";
import { isLoopbackHost } from "./browser-load-error";
import { IdSchema } from "./ids";

/**
 * The team vault (Teams, Phase 2): Realm's Keychain-sealed secret store, given a team's scope.
 *
 * Two kinds of secret live in it. A **sign-in** is the store's existing credential, typed into a page
 * by Realm. A **key** is new: an API key Realm puts into ONE HTTP request it makes itself
 * (`vault_http`), to a host the key is locked to. Either way the agent names the secret and never
 * receives its value — no type below has a field one could travel in, except the two enrollment
 * inputs, which run renderer → main once and never back.
 *
 * A **grant** says which role of the team may use which secret, and where. It lives in realm.db
 * (`vault_grants`), holds no secret material, and on its own changes nothing about asking: a granted
 * role's fill still waits on the session's card, as every fill does. What removes the card is an
 * **allow**: a per-grant "use without asking" the user sets in the Vault page, confirmed by macOS, and
 * sealed in main's store under its own key — so no RPC method, tool or file edit can write one. An
 * allow only matters on a profile whose unlock policy is also "without asking" (Settings ▸ Sign-ins):
 * unattended needs both.
 */

export const VAULT_PROVIDER_NAME = "realm-vault";

/** Where `vault_http` puts the key: written literally in a header value or the body. Never the URL —
 *  a URL is what proxies and servers log. */
export const VAULT_PLACEHOLDER = "{{secret}}";
/** The most `vault_http` sends: a request body, after substitution. */
export const VAULT_HTTP_BODY_MAX = 256_000;
/** The most of a response the agent is shown, in characters. Past it the body is cut and says so. */
export const VAULT_HTTP_RESPONSE_MAX = 64_000;
/** The most Realm reads off the wire before it stops, so a huge download cannot fill main's memory. */
export const VAULT_HTTP_READ_MAX = 1_000_000;
export const VAULT_HTTP_TIMEOUT_MS = 30_000;
export const VAULT_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;
/** The hosts one key or grant may name. A key for every host is a key for no host in particular. */
export const VAULT_HOSTS_MAX = 8;

/** How a key is named: what an engineer would export it as. */
export const VAULT_KEY_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export type VaultSecretKind = "signin" | "key";

/**
 * A host as a key is locked to it: lowercased `host[:port]`, no scheme, no path, no wildcard. Accepts
 * a pasted URL ("https://api.revenuecat.com/v1") and keeps only its host. Null for anything that is
 * not a host Realm can compare exactly — a wildcard, a bare word with no dot (other than localhost),
 * a username in the authority.
 */
export function normalizeVaultHost(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw || raw.includes("*") || /\s/.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw.includes("://") ? raw : `https://${raw}`); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || !url.hostname) return null;
  if (!url.hostname.includes(".") && !isLoopbackHost(url.hostname)) return null;
  return url.host;
}

/**
 * The host a `vault_http` URL would reach, or why it may not be called. https only, except a loopback
 * host, which never leaves the Mac. The URL may not carry the placeholder or a username: the key goes
 * in a header or the body, where it is substituted and scrubbed, and nowhere a log line would keep it.
 */
export function vaultUrlHost(input: string): { host: string } | { error: string } {
  if (input.includes(VAULT_PLACEHOLDER)) return { error: `the URL may not hold ${VAULT_PLACEHOLDER} — put the key in a header or the body` };
  let url: URL;
  try { url = new URL(input); } catch { return { error: "that is not a full URL — give https://host/path" }; }
  if (url.username || url.password) return { error: "the URL may not carry a username or password" };
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) return { error: "only https is allowed (plain http only to this Mac)" };
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "only https URLs can be called" };
  return { host: url.host.toLowerCase() };
}

/** Whether `host` is one of `allowed`, exactly. No suffix matching: `api.x.com` does not admit
 *  `evil.api.x.com`, and a port is part of the host. */
export const hostAllowed = (host: string, allowed: readonly string[]): boolean =>
  allowed.some((h) => h.toLowerCase() === host.toLowerCase());

/** An API key's metadata — what every list shows. No field for the value. */
export type VaultKey = {
  id: string;
  /** "REVENUECAT_SECRET_KEY" — what agents call it by. */
  name: string;
  label: string;
  allowedHosts: string[];
  /** The team space it belongs to. Keys are always a team's. */
  spaceId: string;
  createdAt: number;
};

/** Enrollment of a key. `value` is here and in no read shape, as `BrowserCredentialInputSchema`'s is. */
export const VaultKeyInputSchema = z.object({
  name: z.string().regex(VAULT_KEY_NAME, "a key's name is letters, digits, _ . and -, starting with a letter"),
  label: z.string().max(255).default(""),
  allowedHosts: z.array(z.string().min(1).max(255)).min(1).max(VAULT_HOSTS_MAX),
  value: z.string().min(1).max(8192),
});
export type VaultKeyInput = z.infer<typeof VaultKeyInputSchema>;

/** What main lists for one team: its profile's sign-ins (the profile's own and this team's) and the
 *  team's keys. Metadata only, like everything that crosses a process. */
export type VaultSecrets = {
  signins: { id: string; origin: string; username: string; label: string; generated: boolean; spaceId: string | null; createdAt: number }[];
  keys: VaultKey[];
  /** The team's allows, when realm-server asks (so the log can say a switch really moved). */
  allows?: VaultAllow[];
};

/* ────────────────────────────── grants ────────────────────────────── */

export const VaultSecretKindSchema = z.enum(["signin", "key"]);

/**
 * A role may use a secret. `hosts` is where: for a key, a subset of the key's own hosts; for a
 * sign-in, its one origin's host. `name` is the secret's name when it was granted, kept so a role's
 * preamble and `vault_list` can name it without asking main. `createdAt` is part of the grant's
 * identity: an allow is sealed against it, so a grant revoked and made again starts asking again.
 */
export const VaultGrantSchema = z.object({
  secretId: z.string(),
  spaceId: IdSchema,
  roleId: IdSchema,
  kind: VaultSecretKindSchema,
  name: z.string(),
  hosts: z.array(z.string()),
  purpose: z.string().nullable(),
  createdAt: z.number(),
});
export type VaultGrant = z.infer<typeof VaultGrantSchema>;

export const VaultGrantInputSchema = z.object({
  spaceId: IdSchema,
  secretId: z.string().min(1).max(64),
  roleId: IdSchema,
  hosts: z.array(z.string().min(1).max(255)).max(VAULT_HOSTS_MAX).default([]),
  purpose: z.string().trim().max(200).nullable().default(null),
});
export type VaultGrantInput = z.infer<typeof VaultGrantInputSchema>;

/**
 * "Use without asking" on one grant, as main holds it: sealed, and true only for that secret, that
 * role, that team, those hosts, this Mac and that grant. The renderer sees this to draw the switch;
 * nothing an agent can call returns or writes it.
 */
export type VaultAllow = { secretId: string; roleId: string; spaceId: string; hosts: string[]; grantAt: number; setAt: number };

/* ────────────────────────────── use ────────────────────────────── */

/** One use of a secret, read back off the team's activity log (verbs `used_secret`, `refused_secret`). */
export const VaultUseSchema = z.object({
  id: z.string(),
  ts: z.number(),
  actor: z.string(),
  roleId: z.string().nullable(),
  sessionId: z.string().nullable(),
  runId: z.string().nullable(),
  outcome: z.enum(["filled", "used", "refused"]),
  secretId: z.string().nullable(),
  secretName: z.string(),
  kind: VaultSecretKindSchema,
  /** The host it went to, or for a refusal the reason in words. */
  where: z.string(),
  /** `card`: a person allowed this use on the session's card. `unattended`: the grant's allow did. */
  how: z.enum(["card", "unattended"]).nullable(),
  status: z.number().nullable(),
});
export type VaultUse = z.infer<typeof VaultUseSchema>;

/** What main answers a `vaultHttp` op with. The body is already scrubbed of every form of the value. */
export type VaultHttpResult =
  | { ok: true; status: number; contentType: string | null; location: string | null; body: string; truncated: boolean }
  | { ok: false; refused: "no_key" | "host" | "no_presence" | "error"; error: string };
