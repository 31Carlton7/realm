import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AccountsDeps } from "./service";
import { promisify } from "node:util";
import { ACCOUNT_DIR_ENV, type AccountKind } from "@realm/contracts";
import { claudeExecutable, spawnTarget } from "@realm/adapters";
import { agentBin } from "../cli/bins";
import { resolveInstall } from "../cli/provenance";

const run = promisify(execFile);

/** What a CLI says about one of its accounts. */
export type AccountProbe = { signedIn: boolean | null; email: string | null; plan: string | null };

const UNKNOWN: AccountProbe = { signedIn: null, email: null, plan: null };

/** The environment a CLI runs under for an account: the server's own, with the account's folder named
 *  where it has one. The default account names none, so the CLI finds its own folder as it always did. */
export function accountEnv(kind: AccountKind, configDir: string | null, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return configDir ? { ...env, [ACCOUNT_DIR_ENV[kind]]: configDir } : env;
}

/**
 * Ask the CLI about one account, in that account's folder.
 *
 * Claude Code answers `auth status --json` with the login's email and plan (`subscriptionType`), and
 * exits 1 with `loggedIn: false` when signed out, so its output is read either way. Codex says only
 * whether it is logged in; the email and plan are the claims in the ID token its login keeps in
 * `auth.json`. A CLI that will not answer is `null` — not evidence of a signed-out account.
 *
 * `codexHome` is where the default Codex account's folder is, and null where it must not be read (a
 * suite, a live check): the default account's email then stays unknown.
 */
export async function probeAccount(kind: AccountKind, configDir: string | null, o: { env?: NodeJS.ProcessEnv; codexHome?: string | null } = {}): Promise<AccountProbe> {
  const env = accountEnv(kind, configDir, o.env ?? process.env);
  if (kind === "claude") {
    const bin = await claudeExecutable({ env });
    if (!bin) return UNKNOWN;
    const out = await runFor(bin, ["auth", "status", "--json"], env);
    if (out === null) return UNKNOWN;
    try {
      const s = JSON.parse(out) as { loggedIn?: unknown; email?: unknown; subscriptionType?: unknown };
      return {
        signedIn: typeof s.loggedIn === "boolean" ? s.loggedIn : null,
        email: typeof s.email === "string" && s.email ? s.email : null,
        plan: typeof s.subscriptionType === "string" && s.subscriptionType ? s.subscriptionType : null,
      };
    } catch { return UNKNOWN; }
  }
  const found = await resolveInstall(agentBin("codex", env), env);
  if (!found) return UNKNOWN;
  const out = await runFor(found.path, ["login", "status"], env, true);
  const signedIn = out === null ? null : /not logged in/i.test(out) ? false : /logged in/i.test(out) ? true : null;
  const home = configDir ?? o.codexHome ?? null;
  return { signedIn, ...(signedIn && home ? await codexIdentity(home) : { email: null, plan: null }) };
}

/** The CLI's own logout in an account's folder: Claude's takes its Keychain item with it, Codex's its
 *  `auth.json`. */
export async function logoutAccount(kind: AccountKind, configDir: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const e = accountEnv(kind, configDir, env);
  const bin = kind === "claude" ? await claudeExecutable({ env: e }) : (await resolveInstall(agentBin("codex", e), e))?.path ?? null;
  if (bin) await runFor(bin, kind === "claude" ? ["auth", "logout"] : ["logout"], e);
}

/** What a CLI printed, on either stream and whatever its exit status — both CLIs say "signed out" with
 *  a failing exit — or null when it could not be run at all. */
async function runFor(bin: string, args: string[], env: NodeJS.ProcessEnv, stderrToo = false): Promise<string | null> {
  const t = spawnTarget(bin, args, { env });
  try {
    const { stdout, stderr } = await run(t.command, t.args, { timeout: 8000, env, ...t.options });
    return stderrToo ? `${stdout}\n${stderr}` : stdout;
  } catch (e) {
    const { stdout, stderr } = e as { stdout?: unknown; stderr?: unknown };
    if (typeof stdout !== "string" && typeof stderr !== "string") return null;
    return stderrToo ? `${stdout ?? ""}\n${stderr ?? ""}` : (typeof stdout === "string" ? stdout : null);
  }
}

/** The email and ChatGPT plan in the ID token Codex's login keeps. Read, never verified: it labels a
 *  row, and grants nothing. */
export async function codexIdentity(home: string): Promise<{ email: string | null; plan: string | null }> {
  try {
    const auth = JSON.parse(await readFile(join(home, "auth.json"), "utf8")) as { tokens?: { id_token?: unknown } };
    const token = auth.tokens?.id_token;
    if (typeof token !== "string") return { email: null, plan: null };
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const openai = claims["https://api.openai.com/auth"] as { chatgpt_plan_type?: unknown } | undefined;
    return {
      email: typeof claims.email === "string" ? claims.email : null,
      plan: typeof openai?.chatgpt_plan_type === "string" ? openai.chatgpt_plan_type : null,
    };
  } catch { return { email: null, plan: null }; }
}

/**
 * What the real server asks of the CLIs about accounts. A harness — the scripted agent on, as every
 * live check boots — asks only about the accounts it made under its own scratch home, and never reads,
 * signs out of or carries anything out of the CLIs' own folders.
 */
export function machineAccounts(env: NodeJS.ProcessEnv, userHome: string): Pick<AccountsDeps, "probe" | "logout" | "defaults"> {
  if (env.REALM_ENABLE_FAKE_AGENT === "1") return { probe: (kind, dir) => (dir ? probeAccount(kind, dir) : Promise.resolve(UNKNOWN)) };
  const defaults = { claude: env.CLAUDE_CONFIG_DIR || join(userHome, ".claude"), codex: env.CODEX_HOME || join(userHome, ".codex") };
  return { probe: (kind, dir) => probeAccount(kind, dir, { codexHome: defaults.codex }), logout: (kind, dir) => logoutAccount(kind, dir), defaults };
}
