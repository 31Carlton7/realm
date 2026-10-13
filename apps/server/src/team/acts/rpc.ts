import { Methods } from "@realm/contracts";
import type { RpcServer } from "../../rpc/server";
import { NotFoundError } from "../../store/rows";
import type { ActService } from "./service";

/**
 * The act tickets' RPC methods (Teams Phase 3), in their own module as the vault's are.
 *
 * Read what is here: `team.ticketPost` is the only method that can make a ticket act, and it acts
 * only on a press main recorded from Realm's own post sheet — called by anything holding the daemon's
 * token, it is refused (`ActService.post`). Cancel and hold only ever take an act back. There is no
 * MCP tool for any of these: an agent proposes work for Review and nothing more.
 */
export function registerActMethods(rpc: Pick<RpcServer, "register">, acts: ActService, spaceExists: (id: string) => boolean): void {
  const space = (id: string): string => { if (!spaceExists(id)) throw new NotFoundError("space", id); return id; };
  rpc.register("team.tickets", Methods["team.tickets"].params, async (p) => (p.reviewId ? acts.tickets(p.reviewId).filter((t) => t.spaceId === space(p.spaceId)) : acts.ticketsForSpace(space(p.spaceId))));
  rpc.register("team.ticketPost", Methods["team.ticketPost"].params, async (p) => acts.post(p.id));
  rpc.register("team.ticketCancel", Methods["team.ticketCancel"].params, async (p) => acts.cancelTicket(p.id));
  rpc.register("team.actsHold", Methods["team.actsHold"].params, async (p) => acts.hold(space(p.spaceId), p.held));
}
