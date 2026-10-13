/**
 * `vault_http`'s far side: the one HTTP request a team's API key goes into, made by Electron main so
 * the key never leaves this process.
 *
 * Electron-free, like `secret-store.ts`: the store and `fetch` arrive as dependencies, so the rules
 * that matter die in unit tests — a host the key is not locked to is refused before anyone is asked,
 * the value is substituted only where the agent wrote the placeholder, redirects are never followed,
 * and what comes back has every form of the value scrubbed out of it before it crosses the bridge.
 *
 * What it cannot promise, and the Vault page says: the host the key is locked to receives the key —
 * that is the point — and a host that echoes back a transformed copy (hashed, split, reversed) would
 * get past a scrub that only knows the value's ordinary spellings. Lock a key only to the API it is for.
 */
import {
  VAULT_HTTP_BODY_MAX, VAULT_HTTP_METHODS, VAULT_HTTP_READ_MAX, VAULT_HTTP_RESPONSE_MAX, VAULT_HTTP_TIMEOUT_MS, VAULT_PLACEHOLDER,
  hostAllowed, vaultUrlHost, type VaultHttpResult, type VaultKey,
} from "@realm/contracts";
import type { VaultHttpAuditEntry } from "./secret-store";

export const REDACTED = "[redacted]";
/** Shorter than this, a value is a fragment of ordinary text, and scrubbing it would shred the body. */
const SCRUB_MIN = 4;
const HEADERS_MAX = 30;

export type VaultHttpRequest = {
  profileId: string;
  spaceId: string;
  secretId: string;
  /** The grant's hosts when a role asks: a subset of the key's own. Null for a person's own session,
   *  which may reach every host the key is locked to. */
  hosts: string[] | null;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  roleId?: string;
  runId?: string;
};

export type VaultHttpDeps = {
  keys: {
    getKey(profileId: string, spaceId: string, id: string): VaultKey | null;
    withKeyValue(profileId: string, spaceId: string, id: string, use: (value: string, key: VaultKey) => Promise<void>):
      Promise<{ ok: true } | { ok: false; refused: "no_key" | "no_presence" }>;
  };
  fetch: typeof fetch;
  audit(entry: VaultHttpAuditEntry): void;
  now(): number;
  timeoutMs?: number;
};

/** The spellings of one string a response is likely to quote it in: as sent, URL-encoded, inside a
 *  JSON string, base64 (padded, bare and URL-safe) and hex. */
function spellings(s: string): string[] {
  const b64 = Buffer.from(s, "utf8").toString("base64");
  return [
    s, encodeURIComponent(s), JSON.stringify(s).slice(1, -1),
    b64, b64.replace(/=+$/, ""), Buffer.from(s, "utf8").toString("base64url"),
    Buffer.from(s, "utf8").toString("hex"), Buffer.from(s, "utf8").toString("hex").toUpperCase(),
  ];
}

/**
 * Every spelling of `value`, and of every string it was sent inside (`carriers`: a header's value
 * after substitution, the body). The second half is not decoration: base64 of "Bearer <key>" does
 * not contain base64 of the key — the alignment moves — so an API that echoes the whole header
 * base64'd would pass a scrub that only knew the key. Longest first, so a longer form is replaced
 * whole before a shorter one inside it could leave half of it behind.
 */
export function secretForms(value: string, carriers: readonly string[] = []): string[] {
  const forms = [value, ...carriers.filter((c) => c.includes(value))].flatMap(spellings);
  return [...new Set(forms)].filter((f) => f.length >= SCRUB_MIN).sort((a, b) => b.length - a.length);
}

/** `text` with every form of `value` (and of the strings it was sent in) replaced. Case-sensitive
 *  except hex, which `secretForms` gives in both cases. */
export function scrubSecret(text: string, value: string, carriers: readonly string[] = []): string {
  let out = text;
  for (const form of secretForms(value, carriers)) out = out.split(form).join(REDACTED);
  return out;
}

/** Where the placeholder may stand: a header's value or the body — checked before anything is asked. */
function placeholderUsed(headers: Record<string, string>, body: string | null): boolean {
  return Object.values(headers).some((v) => v.includes(VAULT_PLACEHOLDER)) || (body?.includes(VAULT_PLACEHOLDER) ?? false);
}

export async function performVaultHttp(d: VaultHttpDeps, req: VaultHttpRequest): Promise<VaultHttpResult> {
  const method = req.method.toUpperCase();
  const target = vaultUrlHost(req.url);
  const host = "host" in target ? target.host : "";
  const line = (outcome: VaultHttpAuditEntry["outcome"], status?: number) => d.audit({
    ts: d.now(), kind: "vault-http", secretId: req.secretId, host, method, outcome,
    ...(status !== undefined ? { status } : {}), spaceId: req.spaceId,
    ...(req.roleId ? { roleId: req.roleId } : {}), ...(req.runId ? { runId: req.runId } : {}),
  });

  if ("error" in target) { line("host_refused"); return { ok: false, refused: "host", error: target.error }; }
  const key = d.keys.getKey(req.profileId, req.spaceId, req.secretId);
  if (!key) { line("no_key"); return { ok: false, refused: "no_key", error: "this team has no key with that id" }; }
  // The host gate comes BEFORE presence, as the origin gate does for a fill: a prompt for a request
  // that could never be allowed teaches the person to approve without reading.
  const allowed = req.hosts === null ? key.allowedHosts : key.allowedHosts.filter((h) => hostAllowed(h, req.hosts!));
  if (!hostAllowed(host, allowed)) {
    line("host_refused");
    return { ok: false, refused: "host", error: `${key.name} is locked to ${allowed.join(", ") || "no host this role may reach"}, not ${host}` };
  }
  if (!(VAULT_HTTP_METHODS as readonly string[]).includes(method)) {
    line("error");
    return { ok: false, refused: "error", error: `method must be one of ${VAULT_HTTP_METHODS.join(", ")}` };
  }
  const headerEntries = Object.entries(req.headers ?? {});
  if (headerEntries.length > HEADERS_MAX || headerEntries.some(([k, v]) => typeof k !== "string" || typeof v !== "string" || /[\r\n]/.test(k + v))) {
    line("error");
    return { ok: false, refused: "error", error: `headers must be at most ${HEADERS_MAX} plain name: value pairs` };
  }
  if (!placeholderUsed(req.headers ?? {}, req.body)) {
    line("error");
    return { ok: false, refused: "error", error: `write ${VAULT_PLACEHOLDER} where the key goes — in a header's value or the body` };
  }

  let result = { ok: false, refused: "error", error: "the request was not made" } as VaultHttpResult;
  const opened = await d.keys.withKeyValue(req.profileId, req.spaceId, req.secretId, async (value) => {
    const put = (s: string) => s.split(VAULT_PLACEHOLDER).join(value);
    const body = req.body === null ? null : put(req.body);
    const sentHeaders = headerEntries.map(([k, v]) => [k, put(v)] as const);
    // What the key travelled inside, so a response quoting a whole header or body is scrubbed too.
    const carriers = [...sentHeaders.map(([, v]) => v), ...(body !== null ? [body] : [])];
    const scrub = (t: string) => scrubSecret(t, value, carriers);
    if (body !== null && Buffer.byteLength(body, "utf8") > VAULT_HTTP_BODY_MAX) {
      result = { ok: false, refused: "error", error: `the body is over ${VAULT_HTTP_BODY_MAX} bytes` };
      return;
    }
    try {
      const res = await d.fetch(req.url, {
        method,
        headers: Object.fromEntries(sentHeaders),
        ...(body !== null && method !== "GET" && method !== "HEAD" ? { body } : {}),
        // Never followed: a redirect is a host the gate above never saw. The agent is shown where it
        // points and may ask again, through the same gate.
        redirect: "manual",
        signal: AbortSignal.timeout(d.timeoutMs ?? VAULT_HTTP_TIMEOUT_MS),
      });
      const { text, cut } = await readCapped(res, VAULT_HTTP_READ_MAX);
      const scrubbed = scrub(text);
      const truncated = cut || scrubbed.length > VAULT_HTTP_RESPONSE_MAX;
      const location = res.headers.get("location");
      const contentType = res.headers.get("content-type");
      result = {
        ok: true, status: res.status,
        contentType: contentType === null ? null : scrub(contentType),
        location: location === null ? null : scrub(location),
        body: scrubbed.slice(0, VAULT_HTTP_RESPONSE_MAX), truncated,
      };
    } catch (e) {
      // The cause's code says what went wrong (refused, timed out, no such host) without quoting the
      // request, and even that is scrubbed: an error is a string something else wrote.
      const cause = (e as { cause?: { code?: unknown } })?.cause?.code;
      const why = e instanceof Error && e.name === "TimeoutError" ? "it timed out" : typeof cause === "string" ? cause : "the connection failed";
      result = { ok: false, refused: "error", error: scrub(`the request to ${host} failed: ${why}`) };
    }
  });
  if (!opened.ok) {
    line(opened.refused);
    return opened.refused === "no_key"
      ? { ok: false, refused: "no_key", error: "this team has no key with that id" }
      : { ok: false, refused: "no_presence", error: "nobody confirmed this use on this Mac (Touch ID or the login password)" };
  }
  line(result.ok ? "used" : "error", result.ok ? result.status : undefined);
  return result;
}

/** The body as text, read no further than `max` bytes so a huge response cannot fill main's memory. */
async function readCapped(res: Response, max: number): Promise<{ text: string; cut: boolean }> {
  if (!res.body) return { text: "", cut: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= max) { cut = true; await reader.cancel().catch(() => undefined); break; }
  }
  return { text: Buffer.concat(chunks).subarray(0, max).toString("utf8"), cut };
}
