import type { TeamPolicies } from "@realm/contracts";
import { rpc } from "../../rpc/client";

/** The Policies page's one read, in a seam a test can stand in for. */
export type PoliciesClient = { view(spaceId: string): Promise<TeamPolicies> };

const live: PoliciesClient = { view: (spaceId) => rpc().call("team.policies", { spaceId }) };

let override: PoliciesClient | null = null;
/** Tests hand the page their own client; null puts the live one back. */
export function setPoliciesClient(client: PoliciesClient | null): void { override = client; }
export const policiesClient = (): PoliciesClient => override ?? live;
