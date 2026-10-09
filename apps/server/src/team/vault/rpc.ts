import { Methods } from "@realm/contracts";
import type { RpcServer } from "../../rpc/server";
import { NotFoundError } from "../../store/rows";
import type { VaultService } from "./service";

/**
 * The Vault page's RPC methods. Registered here rather than in `rpc/methods.ts` so the vault stays in
 * its own module; the schemas are the contract's like every other method's.
 *
 * Note what is not here: a method that adds a secret, reads a value, or lets a grant through without
 * asking. Those are renderer IPC to main alone (`apps/desktop/src/main/vault-ipc.ts`). A grant made
 * here only ever lets a role ASK, on the session's card.
 */
export function registerVaultMethods(rpc: Pick<RpcServer, "register">, vault: VaultService, spaceExists: (id: string) => boolean): void {
  const space = (id: string): string => { if (!spaceExists(id)) throw new NotFoundError("space", id); return id; };
  rpc.register("team.vaultGrants", Methods["team.vaultGrants"].params, async (p) => vault.grants(space(p.spaceId)));
  rpc.register("team.vaultGrant", Methods["team.vaultGrant"].params, async (p) => vault.grant({ ...p, spaceId: space(p.spaceId) }));
  rpc.register("team.vaultRevoke", Methods["team.vaultRevoke"].params, async (p) => ({ revoked: await vault.revoke(space(p.spaceId), p.secretId, p.roleId) }));
  rpc.register("team.vaultUses", Methods["team.vaultUses"].params, async (p) => vault.uses(space(p.spaceId), p.limit));
  rpc.register("team.vaultAllowChanged", Methods["team.vaultAllowChanged"].params, async (p) => vault.allowChanged(space(p.spaceId), p.secretId, p.roleId));
}
