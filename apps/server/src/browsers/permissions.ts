import { randomBytes } from "node:crypto";
import { sessionEvent, type SessionEvent } from "@realm/contracts";
import type { PermissionDecision } from "@realm/adapters";

/** Distinguishes broker-owned requestIds from adapter-owned ones in `sessions.respondPermission` —
 *  the router's ONLY signal, so it must never collide with an adapter id (adapters use `newId()`
 *  ULIDs, which cannot start with this prefix). */
const REQUEST_PREFIX = "bperm_";

/** A pending prompt older than this is answered "deny" on the user's behalf. Mirrors nothing in the
 *  adapters (they wait forever), but a browser tool call is a blocking MCP request inside an agent's
 *  turn — an abandoned prompt should eventually fail the tool call rather than wedge the turn until
 *  the agent's own transport gives up at some unhelpful place. */
const PROMPT_TIMEOUT_MS = 15 * 60 * 1000;

type PendingPrompt = { sessionId: string; toolKey: string; resolve: (d: PermissionDecision) => void; timer: NodeJS.Timeout; alwaysPrompt: boolean };

/**
 * Per-call gate behaviour.
 *
 * `alwaysPrompt` makes ONE call prompt every single time: `bypassPermissions` does not skip it and
 * `allow_always` neither satisfies it nor gets recorded by it. Exactly one caller sets it —
 * `browser_fill_credential`, the only tool that puts a real secret onto a page.
 *
 * The reasoning, since this is the sole place a mode's meaning is narrowed: `bypassPermissions` means
 * "stop asking me about ordinary actions", and Realm has never treated a secret entering a page as an
 * ordinary action — `browser_act` refuses password fields in that mode too. A batched or remembered
 * approval is also the wrong shape for this specific decision: the card names an origin, and the
 * whole point of the origin gate is that the answer changes when the origin does.
 */
export type GateOptions = { alwaysPrompt?: boolean };

export type GateResult = { allowed: true } | { allowed: false; reason: string };

/**
 * The mutating browser tools' permission gate (Plan 11 W3) — Realm's NORMAL permission flow, raised
 * from the server side instead of an adapter. A mutating tool call:
 *
 *   - runs free under `bypassPermissions` (parity with every adapter: that mode's whole meaning is
 *     "no prompts") — the HARD blocks (password fields, OAuth consent URLs, downloads) are not
 *     prompts and live elsewhere (the act executor in Electron main; the URL guard in agent-tools);
 *   - is refused outright under `plan` (a read-only session must not click things);
 *   - otherwise emits a `permission_request` session event — the same event, card and
 *     `sessions.respondPermission` round trip the user already knows — and blocks the tool call on
 *     the decision. `allow_always` is remembered per session + tool for the session's lifetime.
 *
 * The broker owns its requestIds (`bperm_…`); `SessionService.respondPermission` routes those here
 * and everything else to the live adapter handle.
 */
export class BrowserPermissionBroker {
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly always = new Map<string, Set<string>>();

  constructor(private readonly d: {
    /** Fresh read of the session's CURRENT permission mode — a mid-session setOptions must count. */
    permissionMode: (sessionId: string) => string;
    /** Persist + broadcast one session event through the session's normal event path. */
    emit: (sessionId: string, ev: SessionEvent) => void;
  }) {}

  owns(requestId: string): boolean {
    return requestId.startsWith(REQUEST_PREFIX);
  }

  /** The user's answer, routed here by `SessionService.respondPermission`. Unknown ids are ignored
   *  (a stale card answered after the timeout already denied it). */
  resolve(requestId: string, decision: PermissionDecision): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    clearTimeout(p.timer);
    // An `alwaysPrompt` gate records nothing: the user answering "always" to a credential fill card
    // must not silently license the next one, on whatever origin that turns out to be.
    if (decision === "allow_always" && !p.alwaysPrompt) {
      let set = this.always.get(p.sessionId);
      if (!set) { set = new Set(); this.always.set(p.sessionId, set); }
      set.add(p.toolKey);
    }
    this.d.emit(p.sessionId, sessionEvent("permission_response", { requestId, decision }));
    this.d.emit(p.sessionId, sessionEvent("status", { status: "running" }));
    p.resolve(decision);
  }

  /** A session ended or was deleted: its prompts die with it (denied), its allow-always set is
   *  forgotten — a resumed session re-earns its grants. */
  release(sessionId: string): void {
    for (const [id, p] of this.pending) {
      if (p.sessionId !== sessionId) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve("deny");
    }
    this.always.delete(sessionId);
  }

  /**
   * Gate one mutating tool call. `toolKey` scopes `allow_always` (the tool name — "the user said
   * browser_act may always act in this session"); `title` is the human-readable line the ApprovalCard
   * shows; `input` is echoed onto the event so the card can show what the agent asked for.
   */
  async gate(sessionId: string, toolKey: string, title: string, input: Record<string, unknown>, toolName: string = toolKey, opts: GateOptions = {}): Promise<GateResult> {
    const mode = this.d.permissionMode(sessionId);
    if (mode === "plan") return { allowed: false, reason: "this session is in Plan (read-only) mode — mutating browser tools are refused; switch modes to act on pages" };
    if (!opts.alwaysPrompt) {
      if (mode === "bypassPermissions") return { allowed: true };
      if (this.always.get(sessionId)?.has(toolKey)) return { allowed: true };
    }

    const requestId = REQUEST_PREFIX + randomBytes(12).toString("base64url");
    const decision = await new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        this.d.emit(sessionId, sessionEvent("permission_response", { requestId, decision: "deny" }));
        this.d.emit(sessionId, sessionEvent("status", { status: "running" }));
        resolve("deny");
      }, PROMPT_TIMEOUT_MS);
      this.pending.set(requestId, { sessionId, toolKey, resolve, timer, alwaysPrompt: opts.alwaysPrompt === true });
      // Emitted AFTER the pending entry exists: a same-tick respondPermission must find it.
      // `toolName` is what the card SHOWS; `toolKey` is what `allow_always` remembers. They differ when
      // the grant must be narrower than the tool — Plan 20's ask keys on `agent_ask:<targetId>` so
      // approving one peer does not license interrupting every session in the space, while the card
      // still reads `agent_ask` rather than a bare ULID.
      this.d.emit(sessionId, sessionEvent("permission_request", { requestId, toolName, input, title, suggestions: [] }));
      this.d.emit(sessionId, sessionEvent("status", { status: "waiting_permission" }));
    });
    return decision === "deny"
      ? { allowed: false, reason: "the user denied this action" }
      : { allowed: true };
  }
}
