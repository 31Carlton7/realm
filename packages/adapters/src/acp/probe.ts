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
): Promise<{ available: boolean; version: string | null; loggedIn: boolean | null; reason: string | null }> {
  try {
    const { stdout } = await run(bin, versionArgs, { timeout: 5000 });
    const version = stdout.trim().split("\n")[0]?.trim() || null;
    return { available: true, version, loggedIn: null, reason: "unknown until a session starts" };
  } catch (e) {
    return { available: false, version: null, loggedIn: null, reason: (e as Error).message };
  }
}

/**
 * Extracts picker rows from the DEPRECATED `models` object an ACP `session/new` answers with.
 *
 * Kept because Cursor still speaks this shape and its id vocabulary is the argument below. New code
 * should go through `acpSessionConfig`, which prefers `configOptions` and falls back to here.
 *
 * This — not `cursor-agent --list-models` — is the catalog Realm can honestly offer, because it is the
 * id vocabulary `session/set_model` actually accepts (verified live against cursor-agent 2026.09:
 * parameterized ids like `composer-2.5[fast=true]` and `default[]` are accepted; the bare
 * `--list-models` ids like `gpt-5.3-codex-high`, and the literal `auto`, are rejected with
 * "Invalid params"). Listing ids from one channel and transmitting them on another would make every
 * pick fail.
 *
 * Defensive on purpose: entries missing a string `modelId` are skipped, never invented. A missing
 * `name` falls back to the id — an ugly true label over a pretty guess.
 */
export function parseAcpModels(models: unknown): { id: string; label: string }[] {
  const list = (models as { availableModels?: unknown } | null)?.availableModels;
  const rows = Array.isArray(list) ? list : [];
  const out: { id: string; label: string }[] = [];
  for (const row of rows) {
    const m = row as { modelId?: unknown; name?: unknown } | null;
    if (!m || typeof m.modelId !== "string" || m.modelId.trim() === "") continue;
    const label = typeof m.name === "string" && m.name.trim() !== "" ? m.name.trim() : m.modelId;
    out.push({ id: m.modelId, label });
  }
  return out;
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
    const models = acpSessionConfig(session).models;
    return models.length > 0 ? [...models] : null;
  } catch {
    return null;
  } finally {
    await rpc?.dispose().catch(() => {});
  }
}
