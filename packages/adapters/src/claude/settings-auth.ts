import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

/** The CLI gives an apiKeyHelper no deadline; a session start cannot wait forever on one. A helper
 *  that mints a token over the network (the case this exists for) answers in seconds. */
const API_KEY_HELPER_TIMEOUT_MS = 15_000;

/** The two credentials whose presence means no key needs minting — the same pair the CLI checks
 *  before it runs the helper itself. */
const CREDENTIAL_KEYS = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/** The slice of `~/.claude/settings.json` this module acts on. The file holds much more — permissions,
 *  hooks, model — all of which `settingSources: []` is MEANT to drop; only auth is carried. */
type SettingsAuth = { env?: unknown; apiKeyHelper?: unknown };

/**
 * The auth half of the W1 carry-forward.
 *
 * A skills session runs with `settingSources: []` (claude-adapter.ts says why), which also stops the
 * CLI reading `~/.claude/settings.json` — and on some machines that file is the entire login: an
 * `env` block pointing `ANTHROPIC_BASE_URL` at a corporate gateway, plus an `apiKeyHelper` command
 * whose stdout is the API key. Dropped, the session boots with `apiKeySource: none` and every turn
 * answers "Not logged in". Enabling a skill must not silently cost the user their login, the same
 * way it must not cost them their CLAUDE.md (`memory/service.ts`), so the settings the CLI would
 * have read are re-applied here through the child environment, which `settingSources` does not gate.
 *
 * Returns the entries to lay between `process.env` and `opts.env`: the settings file's string-valued
 * `env` block, plus — when nothing in base, block or overrides already carries a credential — an
 * `ANTHROPIC_API_KEY` minted by running `apiKeyHelper`. Realm's own `opts.env` goes on top of the
 * result, so nothing carried can override what the server set deliberately.
 *
 * Never throws. A missing or unparsable settings file carries nothing — that machine authenticates
 * some other way, and the session is exactly what it was before this existed. A helper that fails,
 * times out or prints nothing is reported through `onLog` and the carry proceeds without a key: the
 * same failed login as doing nothing, but no longer a silent one.
 *
 * The helper runs fresh per session start, no caching: helpers mint short-lived tokens, and a stale
 * one is the failure mode this module exists to prevent.
 */
export async function carrySettingsAuth(o: {
  /** The environment the child would inherit anyway — `process.env` in production. The settings file
   *  is found through it (`CLAUDE_CONFIG_DIR`, then `HOME`), so the suite can point it at a scratch
   *  home instead of the user's. */
  env: Record<string, string | undefined>;
  /** Realm's own per-session values (`opts.env`). Never carried — only consulted, so a credential the
   *  server set keeps the helper from running at all. */
  overrides?: Record<string, string>;
  /** The session's working directory: the helper runs there, so a relative helper path resolves
   *  against the project rather than wherever Realm's server process happens to live. */
  cwd?: string;
  /** The adapter's diagnostic sink (its stderr tail) for a helper that could not mint a key. */
  onLog?: (line: string) => void;
  /** Seam for the suite; production passes nothing. */
  timeoutMs?: number;
}): Promise<Record<string, string>> {
  // The same resolution as the CLI's own config lookup (and `claudeUserDir` on the server side):
  // CLAUDE_CONFIG_DIR when set, else ~/.claude.
  const configDir = o.env.CLAUDE_CONFIG_DIR?.trim() ? o.env.CLAUDE_CONFIG_DIR : join(o.env.HOME ?? homedir(), ".claude");
  let settings: SettingsAuth;
  try {
    const parsed: unknown = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
    // Valid JSON that is not an object (`null`, a bare string) is as empty as no file at all.
    if (!parsed || typeof parsed !== "object") return {};
    settings = parsed as SettingsAuth;
  } catch {
    return {}; // no settings file, or not JSON: nothing the CLI would have read, nothing to carry
  }

  const carried: Record<string, string> = {};
  if (settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)) {
    // String values only: the child environment can hold nothing else, and the CLI validates this
    // block the same way.
    for (const [key, value] of Object.entries(settings.env)) if (typeof value === "string") carried[key] = value;
  }

  const helper = typeof settings.apiKeyHelper === "string" ? settings.apiKeyHelper.trim() : "";
  const merged = { ...o.env, ...carried, ...o.overrides };
  if (!helper || CREDENTIAL_KEYS.some((k) => merged[k])) return carried;
  const timeoutMs = o.timeoutMs ?? API_KEY_HELPER_TIMEOUT_MS;
  try {
    // `/bin/sh -c`, the way the CLI runs it: the setting is a shell command, not an argv. It runs in
    // the session's own cwd, under the environment the session would have had without the key — the
    // carried `env` block and Realm's overrides included, since a helper on a gateway machine may
    // well read the gateway variables it sits next to. SIGKILL at the deadline, because a helper
    // that shrugs off SIGTERM would otherwise hold every session start hostage.
    const { stdout } = await run("/bin/sh", ["-c", helper], { timeout: timeoutMs, killSignal: "SIGKILL", cwd: o.cwd, env: merged });
    const key = stdout.trim();
    // One printable line or nothing: a control character here is a helper misfiring (a banner, a
    // NUL), and an env value that embeds one comes back out of spawn failures with the key inside.
    if (key && key.length <= 16_384 && !/[^\x20-\x7e]/.test(key)) carried.ANTHROPIC_API_KEY = key;
    else o.onLog?.(`apiKeyHelper from ~/.claude/settings.json printed ${key ? "something other than one printable line" : "nothing"}; the session starts without a key`);
  } catch (e) {
    // Exit status only, never the error's message: execFile's message carries the command line and
    // the helper's stderr, and stderr is exactly where a credential could land on its way to a log.
    const err = e as { killed?: boolean; signal?: NodeJS.Signals | null; code?: number | string | null };
    const why = err.killed || err.signal ? `timed out after ${timeoutMs}ms` : `failed (exit ${err.code ?? "unknown"})`;
    o.onLog?.(`apiKeyHelper from ~/.claude/settings.json ${why}; the session starts without a key`);
  }
  return carried;
}
