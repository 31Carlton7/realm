import type { ExecutionSandboxService } from "./service";

/**
 * The one decision both spawn sites make: does this space's next process go through Seatbelt?
 *
 * `TerminalService` and `SessionService` each own a `wrapFor` that is a call to this and nothing
 * else. Sharing it is not tidiness — it is what makes "a terminal and an agent in the same space are
 * confined the same way" a fact rather than a coincidence between two files that were edited on the
 * same day.
 */
export type SpawnWrap = (command: string, args: string[]) => { command: string; args: string[] };

/**
 * `undefined` when this space has no sandbox, otherwise the wrapper a spawn site applies to its argv.
 *
 * **`undefined` rather than an identity function, and that is the whole point of this function
 * existing.** Under `off` — which is what this release ships
 * (`EXECUTION_SANDBOX_DEFAULT_POSTURE`) — no wrapper is installed anywhere, so the argv that reaches
 * `pty.spawn`, `StdioJsonRpc` and the Claude SDK is not merely *equal* to what it was before this
 * feature, it is produced by the same line of code it always was. An identity wrapper would give the
 * same bytes today and would also:
 *
 *  - make `ClaudeAdapter` install `spawnClaudeCodeProcess`, replacing the SDK's own spawn (which
 *    does more than `spawn`: windowsHide, a stderr tail, an exit it holds until stderr closes) for
 *    every user who never asked for a sandbox; and
 *  - make `CodexAdapter` refuse — it keys its "one shared process cannot hold two policies" refusal
 *    on `wrap` being present, so an identity wrapper would break Codex for everybody by default.
 *
 * The posture is read here and read AGAIN inside `sandbox.wrap`; the second read is the one that
 * decides, and the one that throws when Seatbelt cannot be applied. There is no ordering of the two
 * that turns a sandboxed space into an unsandboxed spawn — the worst a posture changed in between
 * can do is confine one spawn of a space the user had just switched off.
 */
export function sandboxWrapFor(
  sandbox: ExecutionSandboxService | undefined,
  o: { spaceId: string; extraWritableRoots?: readonly string[] },
): SpawnWrap | undefined {
  if (!sandbox || sandbox.policyFor(o.spaceId).posture === "off") return undefined;
  return (command, args) => {
    const w = sandbox.wrap({ spaceId: o.spaceId, command, args, extraWritableRoots: o.extraWritableRoots });
    // Narrowed to the two fields a spawn site needs. `SandboxedCommand` is a discriminated union
    // whose `sandboxed: false` arm exists so nobody can read an argv out of it by accident; by here
    // the question has been answered, and passing the union on would only spread that check further.
    return { command: w.command, args: w.args };
  };
}
