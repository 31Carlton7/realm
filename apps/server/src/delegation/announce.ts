import { IdSchema } from "@realm/contracts";
import type { RpcServer } from "../rpc/server";
import type { DelegationEngine } from "./engine";

/**
 * Publish one parent's live delegated runs, read straight back off the engine.
 *
 * The engine says only WHICH parent changed, so the payload is built here and nowhere else, and the
 * in-memory registry stays the single copy of who is waiting on what. A listener can never be handed
 * a set the registry has already moved past, because there is no set to hand — only a lookup.
 *
 * `parentSessionId` is not always a session. A reviewer the user asks for from a diff pane has no
 * delegating agent, so `review.ts` begins it under a synthetic key to keep it capped and
 * cancellable; there is no transcript for it to appear in, and announcing it would put a string no
 * session can ever match into a field typed as a session id.
 */
export function announceDelegation(
  rpc: Pick<RpcServer, "broadcast">,
  engine: Pick<DelegationEngine, "liveRuns">,
  parentSessionId: string,
): void {
  if (!IdSchema.safeParse(parentSessionId).success) return;
  rpc.broadcast("delegation.changed", { sessionId: parentSessionId, running: engine.liveRuns(parentSessionId) });
}
