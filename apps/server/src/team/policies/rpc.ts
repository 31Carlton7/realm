import { Methods } from "@realm/contracts";
import type { RpcServer } from "../../rpc/server";
import { NotFoundError } from "../../store/rows";
import type { PoliciesService } from "./service";

/** The Policies page's one method. It only reads: nothing in this release writes a policy or a
 *  tool's class, and no agent tool reaches either. */
export function registerPolicyMethods(rpc: Pick<RpcServer, "register">, policies: PoliciesService, spaceExists: (id: string) => boolean): void {
  rpc.register("team.policies", Methods["team.policies"].params, async (p) => {
    if (!spaceExists(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    return policies.view(p.spaceId);
  });
}
