import type { PolicyPressInput, RiskClass, TeamPolicies, TeamPolicyInput, TeamPolicyRow, ToolClassInput } from "@realm/contracts";
import { rpc } from "../../rpc/client";

export type PressAnswer = { ok: true } | { ok: false; error: string };

/**
 * The Policies page's reads and writes, in a seam a test can stand in for. `press` is main's: it asks
 * macOS for the person and seals exactly the row it was handed, which the write that follows spends.
 */
export type PoliciesClient = {
  view(spaceId: string): Promise<TeamPolicies>;
  set(row: TeamPolicyInput): Promise<TeamPolicyRow>;
  setToolClass(row: ToolClassInput): Promise<{ class: RiskClass; sealed: boolean }>;
  press(input: PolicyPressInput): Promise<PressAnswer>;
};

const live: PoliciesClient = {
  view: (spaceId) => rpc().call("team.policies", { spaceId }),
  set: (row) => rpc().call("team.policySet", row),
  setToolClass: (row) => rpc().call("team.toolClassSet", row),
  press: (input) => window.realm?.team?.pressPolicy(input)
    ?? Promise.resolve({ ok: false as const, error: "Only Realm's own window on this Mac can loosen a policy." }),
};

let override: PoliciesClient | null = null;
/** Tests hand the page their own client; null puts the live one back. */
export function setPoliciesClient(client: PoliciesClient | null): void { override = client; }
export const policiesClient = (): PoliciesClient => override ?? live;
