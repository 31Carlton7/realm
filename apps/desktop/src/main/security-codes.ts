/**
 * Security codes (contracts' `security-codes.ts`): where Electron main finds the one-time code a site
 * just sent, and the switch that says whether it may look.
 *
 * ## Reading
 *
 * Every source is a `CodeSource`, asked for the messages that arrived since a moment, and only ever
 * asked by `SecurityCodes.latest` — which asks nothing while the switch is off. Main reads them
 * itself, so the grants are Realm's own: Messages' database and Mail's Envelope Index both sit behind
 * Full Disk Access. The live sources are:
 *
 *   - Messages: `~/Library/Messages/chat.db`, opened read-only, incoming rows only. A row's words are
 *     in `text`, or since macOS 13 often only in `attributedBody`, a typedstream (`textOfAttributedBody`).
 *   - Mail: the `mac` command (`mac mail list`, then `mac mail extract --codes` for a message whose
 *     subject and preview carry no code). The list is asked with an operator so it never falls back
 *     to scripting Mail.app, which is what would put an Automation prompt in front of the person.
 *
 * Tests and live checks use `fakeCodeSource`, which reads a JSON file and nothing else. The harness
 * build never constructs a live source (`codeSourcesFor`).
 *
 * ## What leaves
 *
 * Only the code, and only to the fill that asked. Nothing here logs: a read that fails is a state
 * (`no_access`, `missing`), never a message with the row in it.
 */
import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  SECURITY_CODE_WINDOW_MS,
  type SecurityCodeSourceName, type SecurityCodeSourceState, type SecurityCodesStatus,
} from "@realm/contracts";
import { fallbackExtraDirs } from "./login-shell-path";

/** One message, as a source hands it over. `code` is set when the source already found one (Mail's
 *  own extractor); otherwise `text` is searched here. */
export type CodeMessage = { source: SecurityCodeSourceName; at: number; text: string; code?: string };

export type CodeSource = {
  name: SecurityCodeSourceName;
  /** Messages that arrived at or after `since` (ms since the epoch), newest first. */
  recent(since: number): Promise<CodeMessage[]>;
  state(): Promise<SecurityCodeSourceState>;
};

/* ─────────────────────────────── finding the code ─────────────────────────────── */

const CUE = /\b(?:codes?|passcode|pass code|verification|verify|verified|otp|one[- ]?time|2fa|mfa|two[- ]?factor|security|pin|log ?in|sign ?in|authenticat\w*|authoriz\w*|confirm\w*|access)\b/gi;
/** Words that make the number beside them something else: an order, a parcel, an account, a phone. */
const NOT_A_CODE = /\b(?:order|tracking|track|account|acct|invoice|ref|reference|ticket|case|card|ending|zip|room|flight|booking|reservation|call|text|txt|reply|stop|dial|ext|phone|tel|fax|id)\b[^\n]{0,12}$/i;
const MONTHS = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
/** Spans that are never a code, blanked before the search so their digits cannot be read as one. */
const MASKS = [
  /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, // phone numbers
  /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, // 2026-11-10
  /\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b/g, // 11/10/2026
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, "gi"), // November 10, 2026
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s+\\d{4}\\b`, "gi"), // 10 November 2026
  /\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?\b/gi, // times
  /[$€£¥₹]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:usd|eur|gbp|dollars?|euros?|%)/gi, // money and percentages
];
/** A code: 4–8 digits (or two groups of three, "123 456"), or 6–8 capitals and digits with a digit in
 *  them. Not part of a longer token, a decimal, a path or a tag. */
const CANDIDATE = /(?<![\w#@/.,-])(?:\d{3}[ -]\d{3}|\d{4,8}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8})(?![\w/@]|[.,]\d)/g;
/** WebKit's origin-bound line, "@example.com #123456": the code belongs to that site alone. */
const BOUND = /^@([a-z0-9.-]+\.[a-z]{2,})\s+#([A-Za-z0-9-]{4,10})(?:\s+%[a-z0-9.-]+)?\s*$/im;
/** How far from a cue word a code may stand and still be the one it names. */
const CUE_REACH = 40;

type FoundCode = { code: string; site: string | null };

/** The one-time code in a message, or null when there is none worth offering. */
export function extractCode(text: string): FoundCode | null {
  const flat = text.replace(/[   ]/g, " ");
  const bound = BOUND.exec(flat);
  if (bound) return { code: bound[2]!.replace(/-/g, ""), site: bound[1]!.toLowerCase() };
  // Google's "G-123456": the letter and dash are a prefix, not part of the code.
  let masked = flat.replace(/\b[A-Z]-(?=\d{4,8}\b)/g, "  ");
  for (const mask of MASKS) masked = masked.replace(mask, (m) => " ".repeat(m.length));
  const cues = [...masked.matchAll(CUE)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
  if (cues.length === 0) return null;
  let best: { code: string; distance: number } | null = null;
  for (const m of masked.matchAll(CANDIDATE)) {
    const start = m.index;
    const end = start + m[0].length;
    if (NOT_A_CODE.test(masked.slice(Math.max(0, start - 24), start))) continue;
    const digits = m[0].replace(/[ -]/g, "");
    if (/^\d{4}$/.test(digits) && Number(digits) >= 1900 && Number(digits) <= 2099 && /\b(?:in|since|of|year|©)\s*$/i.test(masked.slice(Math.max(0, start - 8), start))) continue;
    const distance = Math.min(...cues.map((c) => (end <= c.start ? c.start - end : start >= c.end ? start - c.end : 0)));
    if (distance > CUE_REACH) continue;
    if (!best || distance < best.distance) best = { code: digits, distance };
  }
  return best ? { code: best.code, site: null } : null;
}

/** Whether a code bound to `site` may go into a page on `origin`: the site itself or a subdomain. */
function boundSiteMatches(site: string, origin: string): boolean {
  let host: string;
  try { host = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  return host === site || host.endsWith(`.${site}`);
}

export type LatestCode = { code: string; source: SecurityCodeSourceName };

/** The newest code among `messages` that arrived inside the window and may go to `origin`. */
export function pickLatestCode(messages: readonly CodeMessage[], now: number, origin: string, windowMs = SECURITY_CODE_WINDOW_MS): LatestCode | null {
  const fresh = messages
    // A minute of grace forward, for a clock that disagrees with the phone that relayed the text.
    .filter((m) => m.at >= now - windowMs && m.at <= now + 60_000)
    .sort((a, b) => b.at - a.at);
  for (const m of fresh) {
    const found = m.code ? { code: m.code, site: null } : extractCode(m.text);
    if (!found) continue;
    if (found.site && !boundSiteMatches(found.site, origin)) continue;
    return { code: found.code, source: m.source };
  }
  return null;
}

/* ─────────────────────────────── the switch ─────────────────────────────── */

/**
 * Settings ▸ Sign-ins ▸ Security codes, kept by main in a file of its own under REALM_HOME. Main's,
 * not realm-server's settings table, for the reason the login keychain switch is the secret store's:
 * an agent can reach the server (its RPC, `settings_set`) and cannot reach main's file, so no agent
 * can turn on the thing that reads the person's messages. Off until the person turns it on, and off
 * when the file is missing, unreadable or says anything but `true`.
 */
export class SecurityCodesSetting {
  private cached: boolean | null = null;
  constructor(private readonly file: string) {}

  enabled(): boolean {
    if (this.cached !== null) return this.cached;
    try { this.cached = (JSON.parse(readFileSync(this.file, "utf8")) as { enabled?: unknown }).enabled === true; } catch { this.cached = false; }
    return this.cached;
  }

  setEnabled(on: boolean): void {
    writeFileSync(this.file, `${JSON.stringify({ enabled: on })}\n`, { mode: 0o600 });
    this.cached = on;
  }
}

/* ─────────────────────────────── the reader ─────────────────────────────── */

export class SecurityCodes {
  constructor(private readonly d: {
    setting: { enabled(): boolean; setEnabled(on: boolean): void };
    sources: readonly CodeSource[];
    now(): number;
  }) {}

  enabled(): boolean { return this.d.setting.enabled(); }

  async status(): Promise<SecurityCodesStatus> {
    if (!this.d.setting.enabled()) return { enabled: false, sources: null };
    const sources: Record<SecurityCodeSourceName, SecurityCodeSourceState> = { Messages: "missing", Mail: "missing" };
    for (const s of this.d.sources) sources[s.name] = await s.state().catch(() => "no_access" as const);
    return { enabled: true, sources };
  }

  async setEnabled(on: boolean): Promise<SecurityCodesStatus> {
    this.d.setting.setEnabled(on);
    return this.status();
  }

  /** The code to offer on a page at `origin`, or null. Off, no source is touched. */
  async latest(origin: string): Promise<LatestCode | null> {
    if (!this.d.setting.enabled()) return null;
    const now = this.d.now();
    const since = now - SECURITY_CODE_WINDOW_MS;
    const batches = await Promise.all(this.d.sources.map((s) => s.recent(since).catch(() => [] as CodeMessage[])));
    return pickLatestCode(batches.flat(), now, origin);
  }
}

/* ─────────────────────────────── Messages ─────────────────────────────── */

/** chat.db counts nanoseconds from 2001-01-01. */
const APPLE_EPOCH_MS = 978_307_200_000;

/**
 * The plain string inside an `attributedBody` typedstream: it follows the "NSString" class name and
 * the bytes 01 94 84 01 2B, length-prefixed — one byte, or 0x81 and a 16-bit length, or 0x82 and a
 * 32-bit one, little-endian. The same reading `mac messages` does.
 */
export function textOfAttributedBody(blob: Uint8Array): string | null {
  const bytes = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const at = bytes.indexOf("NSString");
  if (at < 0) return null;
  let i = at + "NSString".length;
  if (!bytes.subarray(i, i + 5).equals(Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]))) return null;
  i += 5;
  let length = bytes[i++] ?? 0;
  if (length === 0x81) { length = bytes.readUInt16LE(i); i += 2; }
  else if (length === 0x82) { length = bytes.readUInt32LE(i); i += 4; }
  if (i + length > bytes.length) return null;
  return bytes.subarray(i, i + length).toString("utf8");
}

export function messagesSource(dbPath = join(homedir(), "Library/Messages/chat.db")): CodeSource {
  const state = async (): Promise<SecurityCodeSourceState> => {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      new DatabaseSync(dbPath, { readOnly: true }).close();
      return "ok";
    } catch {
      return deniedOrMissing(dbPath);
    }
  };
  return {
    name: "Messages",
    state,
    async recent(since) {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const query = db.prepare("SELECT text, attributedBody, date FROM message WHERE is_from_me = 0 AND date >= ? ORDER BY date DESC LIMIT 20");
        query.setReadBigInts(true);
        const rows = query.all(BigInt(since - APPLE_EPOCH_MS) * 1_000_000n) as { text: string | null; attributedBody: Uint8Array | null; date: bigint }[];
        return rows.map((r) => ({
          source: "Messages" as const,
          at: APPLE_EPOCH_MS + Number(r.date / 1_000_000n),
          text: r.text ?? (r.attributedBody ? textOfAttributedBody(r.attributedBody) ?? "" : ""),
        }));
      } finally {
        db.close();
      }
    },
  };
}

/** A path macOS hides behind Full Disk Access cannot even be stat'ed, so "missing" is believed only
 *  where the folder holding it can be read. */
function deniedOrMissing(path: string): SecurityCodeSourceState {
  try { accessSync(dirname(path), constants.R_OK); } catch { return "no_access"; }
  return existsSync(path) ? "no_access" : "missing";
}

/* ─────────────────────────────── Mail ─────────────────────────────── */

type RunMac = (args: string[]) => Promise<{ code: number; stdout: string }>;

/** The `mac` command on this Mac: on PATH (main merges the login shell's at launch), or where Homebrew puts it. */
function findMacCommand(env: Record<string, string | undefined> = process.env): string | null {
  const dirs = [...(env.PATH ?? "").split(delimiter), ...fallbackExtraDirs()].filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, "mac");
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}

function runMacCommand(bin: string): RunMac {
  return (args) => new Promise((resolve) => {
    execFile(bin, args, { timeout: 5_000, maxBuffer: 1 << 20 }, (error, stdout) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout) });
    });
  });
}

/** `mac`'s exit code for a permission macOS refused. */
const MAC_DENIED = 2;
/** At most this many recent emails are opened for `extract` per read. */
const MAIL_EXTRACTS = 3;

export function mailSource(run: RunMac | null): CodeSource {
  return {
    name: "Mail",
    async state() {
      if (!run) return "missing";
      const r = await run(["mail", "list", "newer:1d", "--limit", "1", "--json", "--quiet"]);
      return r.code === 0 ? "ok" : r.code === MAC_DENIED ? "no_access" : "missing";
    },
    async recent(since) {
      if (!run) return [];
      // `newer:` takes days at the finest; the window is cut here, by each message's own date.
      const listed = await run(["mail", "list", "newer:1d", "--limit", "10", "--json", "--quiet"]);
      if (listed.code !== 0) return [];
      const rows = parseMailList(listed.stdout).filter((m) => m.at >= since);
      const out: CodeMessage[] = [];
      let extracts = 0;
      for (const row of rows) {
        const text = `${row.subject}\n${row.summary}`;
        if (extractCode(text) || extracts >= MAIL_EXTRACTS) { out.push({ source: "Mail", at: row.at, text }); continue; }
        extracts++;
        const extracted = await run(["mail", "extract", row.id, "--codes", "--json", "--quiet"]);
        const code = extracted.code === 0 ? highConfidenceCode(extracted.stdout) : null;
        out.push({ source: "Mail", at: row.at, text, ...(code ? { code } : {}) });
      }
      return out;
    },
  };
}

type MailRow = { id: string; at: number; subject: string; summary: string };

/** `mac mail list --json`: an array (or `{ messages: [...] }`) of rows with an ISO-8601 `date`. A row
 *  whose date will not parse is left out, so the window can never be widened by a malformed one. */
export function parseMailList(stdout: string): MailRow[] {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return []; }
  const list = Array.isArray(parsed) ? parsed : (parsed as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(list)) return [];
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return list.flatMap((row) => {
    const r = row as Record<string, unknown>;
    const at = Date.parse(str(r.date));
    return str(r.id) && Number.isFinite(at) ? [{ id: str(r.id), at, subject: str(r.subject), summary: str(r.summary) }] : [];
  });
}

function highConfidenceCode(stdout: string): string | null {
  try {
    const codes = (JSON.parse(stdout) as { codes?: { code?: unknown; confidence?: unknown }[] }).codes ?? [];
    const hit = codes.find((c) => c.confidence === "high" && typeof c.code === "string" && /^[A-Za-z0-9]{4,10}$/.test(c.code));
    return hit ? (hit.code as string) : null;
  } catch {
    return null;
  }
}

/* ─────────────────────────────── the stand-in ─────────────────────────────── */

/**
 * A source that reads `[{ source, at, text }]` from a JSON file on every ask, so a live check can
 * "receive" a message mid-run by rewriting it. It reads that file and nothing else.
 */
export function fakeCodeSource(name: SecurityCodeSourceName, file: string): CodeSource {
  const read = (): CodeMessage[] => {
    try {
      const rows = JSON.parse(readFileSync(file, "utf8")) as { source?: unknown; at?: unknown; text?: unknown }[];
      return rows.filter((r) => r.source === name && typeof r.at === "number" && typeof r.text === "string")
        .map((r) => ({ source: name, at: r.at as number, text: r.text as string }));
    } catch {
      return [];
    }
  };
  return { name, state: async () => "ok", recent: async (since) => read().filter((m) => m.at >= since).sort((a, b) => b.at - a.at) };
}

/**
 * The sources this build may read. A packaged app reads the real ones; a development or harness
 * build (`REALM_ENABLE_FAKE_AGENT=1`) reads `REALM_LIVE_CODES`'s stand-in or nothing — never the
 * owner's Messages or Mail.
 */
export function codeSourcesFor(d: { packaged: boolean; env: Record<string, string | undefined> }): CodeSource[] {
  if (d.packaged || d.env.REALM_ENABLE_FAKE_AGENT !== "1") {
    const mac = findMacCommand(d.env);
    return [messagesSource(), mailSource(mac ? runMacCommand(mac) : null)];
  }
  const file = d.env.REALM_LIVE_CODES;
  return file ? [fakeCodeSource("Messages", file), fakeCodeSource("Mail", file)] : [];
}
