import { Methods } from "@realm/contracts";
import type { RpcServer } from "../../rpc/server";
import { NotFoundError } from "../../store/rows";
import type { PoliciesService } from "./service";

/**
 * The Policies page's methods: one read and two writes. A write that tightens holds as it is; one that
 * loosens anything holds only with the person's press on the page in Realm's own window, confirmed by
 * macOS and sealed by Electron main — the service asks main for that seal and refuses without one, so
 * holding the RPC token is not enough to loosen a rule. No agent tool reaches either write.
 */
export function registerPolicyMethods(rpc: Pick<RpcServer, "register">, policies: PoliciesService, spaceExists: (id: string) => boolean): void {
  rpc.register("team.policies", Methods["team.policies"].params, async (p) => {
    if (!spaceExists(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    return policies.view(p.spaceId);
  });
  rpc.register("team.policySet", Methods["team.policySet"].params, async (p) => {
    if (!spaceExists(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    return policies.set(p);
  });
  rpc.register("team.toolClassSet", Methods["team.toolClassSet"].params, async (p) => {
    if (!spaceExists(p.spaceId)) throw new NotFoundError("space", p.spaceId);
    return policies.setToolClass(p);
  });
}
