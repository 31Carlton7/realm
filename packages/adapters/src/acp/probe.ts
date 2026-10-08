import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { acpSessionConfig } from "@realm/contracts";
import { StdioJsonRpc, withTimeout } from "../jsonrpc/stdio";

const run = promisify(execFile);

/**
 * Checks an ACP agent CLI is runnable.
 *
 * `loggedIn` is deliberately `null`: neither Cursor nor Gemini exposes a trustworthy offline login check.
 * `cursor-agent status` was observed printing "Login successful" and "unable to fetch user details" in the same
 * breath, and Gemini's credentials file can exist for a tier that no longer accepts sessions. Auth failures
 * surface at `session/new` and AcpAdapter turns them into an actionable error event.
 */
export async function probeAcp(
  bin: string,
  versionArgs: string[] = ["--version"],
  env?: Record<string, string>,
): Promise<{ available: boolean; version: string | null; loggedIn: boolean | null; reason: string | null }> {
  try {
    // The spec's `env` is applied here as well as at `start`, because for some CLIs it is what makes
    // `--version` answerable at all: openhands prints a seven-line ASCII banner ahead of the number
    // unless OPENHANDS_SUPPRESS_BANNER is set, and the first line of that is what would be reported
    // as the version.
    const { stdout } = await run(bin, versionArgs, { timeout: 5000, env: env ? { ...process.env, ...env } : undefined });
    const version = stdout.trim().split("\n")[0]?.trim() || null;
    return { available: true, version, loggedIn: null, reason: "unknown until a session starts" };
  } catch (e) {
    return { available: false, version: null, loggedIn: null, reason: (e as Error).message };
  }
}

/** `session/new` reaches the network (Cursor signs in and spins up session services); shorter than the
 *  adapter's 30s session budget because a probe is advisory — `null` is always an acceptable answer. */
const LIST_MODELS_TIMEOUT_MS = 20_000;

/**
 * Fetches the live model catalog by doing the one thing ACP offers: opening a real (throwaway) session
 * and reading `models.availableModels` off the answer. There is no lighter call — `initialize` carries
 * no catalog, and there is no `model/list` in the protocol. `null` on any failure: the picker falls
 * back to its static rows and the probe still reports availability.
 */
export async function fetchAcpModels(
  opts: { bin: string; args: string[]; cwd: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<{ id: string; label: string }[] | null> {
  return (await fetchAcpCatalog(opts))?.models ?? null;
}

/**
 * Everything the throwaway session says about what an agent can be put on: its models (null where it
 * lists none, as `fetchAcpModels` answers) and its reasoning levels off a `thought_level` option, with
 * the one it starts on — one `session/new`, read once. Null on any failure.
 */
export async function fetchAcpCatalog(
  opts: { bin: string; args: string[]; cwd: string; env?: Record<string, string>; timeoutMs?: number },
): Promise<{ models: { id: string; label: string }[] | null; efforts: { id: string; label: string }[]; defaultEffort: string | null } | null> {
  const ms = opts.timeoutMs ?? LIST_MODELS_TIMEOUT_MS;
  let rpc: StdioJsonRpc | null = null;
  try {
    const transport = new StdioJsonRpc({
      command: opts.bin,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
      onNotification: () => {},
      // The probe declares no capabilities and prompts nothing, so any server request is one it cannot
      // honour; answering (rather than ignoring) keeps the child from wedging on an unanswered frame.
      onServerRequest: (r) => transport.respondError(r.id, -32601, "not supported by the model probe"),
      onStderr: () => {},
      onExit: () => {},
    });
    rpc = transport;
    await withTimeout(rpc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    }), ms, `${opts.bin} did not answer initialize within ${ms}ms`);
    const session = await withTimeout(rpc.request("session/new", { cwd: opts.cwd, mcpServers: [] }), ms,
      `${opts.bin} did not answer session/new within ${ms}ms`);
    // Whichever shape the agent speaks: `configOptions` first (opencode reports its catalog ONLY
    // there, so reading `models` alone finds nothing and the picker silently shows one dead row),
    // falling back to the deprecated `models`. Same normalizer the adapter boots with, so the ids the
    // picker offers are exactly the ids a session start will transmit.
    const cfg = acpSessionConfig(session);
    return { models: cfg.models.length > 0 ? [...cfg.models] : null, efforts: cfg.efforts, defaultEffort: cfg.currentEffort };
  } catch {
    return null;
  } finally {
    await rpc?.dispose().catch(() => {});
  }
}
