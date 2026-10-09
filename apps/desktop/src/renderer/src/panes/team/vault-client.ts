import type {
  BrowserCredential, BrowserCredentialInput, VaultAllow, VaultGrant, VaultGrantInput, VaultKey, VaultKeyInput, VaultSecrets, VaultUse,
} from "@realm/contracts";
import { rpc } from "../../rpc/client";

/**
 * Everything the Vault page reads and does, in one seam — so the page has two honest sources and a
 * test can stand in for both. Secrets and allows come from Electron main over the preload (the values
 * are there and never come back); grants and uses come from realm-server, which holds no secret.
 */
export type VaultListing = { available: boolean; secrets: VaultSecrets; allows: VaultAllow[]; profileUnattended: boolean };

export type VaultClient = {
  list(profileId: string, spaceId: string): Promise<VaultListing>;
  addSignin(profileId: string, spaceId: string, input: BrowserCredentialInput): Promise<BrowserCredential>;
  addKey(profileId: string, spaceId: string, input: VaultKeyInput): Promise<VaultKey>;
  remove(profileId: string, spaceId: string, secretId: string): Promise<boolean>;
  setAllow(profileId: string, input: { spaceId: string; secretId: string; roleId: string; hosts: string[]; grantAt: number; roleName: string; secretName: string }):
    Promise<{ ok: true; allow: VaultAllow } | { ok: false; error: string }>;
  clearAllow(secretId: string, roleId: string): Promise<boolean>;
  grants(spaceId: string): Promise<VaultGrant[]>;
  grant(input: VaultGrantInput): Promise<VaultGrant>;
  revoke(spaceId: string, secretId: string, roleId: string): Promise<boolean>;
  uses(spaceId: string): Promise<VaultUse[]>;
  allowChanged(spaceId: string, secretId: string, roleId: string): Promise<{ on: boolean }>;
};

const EMPTY: VaultListing = { available: false, secrets: { signins: [], keys: [] }, allows: [], profileUnattended: false };
const bridge = () => {
  const v = window.realm?.vault;
  if (!v) throw new Error("The vault needs Realm's desktop app.");
  return v;
};

const live: VaultClient = {
  list: async (profileId, spaceId) => (window.realm?.vault ? window.realm.vault.list(profileId, spaceId) : EMPTY),
  addSignin: (p, s, input) => bridge().addSignin(p, s, input),
  addKey: (p, s, input) => bridge().addKey(p, s, input),
  remove: (p, s, id) => bridge().remove(p, s, id),
  setAllow: (p, input) => bridge().setAllow(p, input),
  clearAllow: (secretId, roleId) => bridge().clearAllow(secretId, roleId),
  grants: (spaceId) => rpc().call("team.vaultGrants", { spaceId }),
  grant: (input) => rpc().call("team.vaultGrant", input),
  revoke: async (spaceId, secretId, roleId) => (await rpc().call("team.vaultRevoke", { spaceId, secretId, roleId })).revoked,
  uses: (spaceId) => rpc().call("team.vaultUses", { spaceId, limit: 50 }),
  allowChanged: (spaceId, secretId, roleId) => rpc().call("team.vaultAllowChanged", { spaceId, secretId, roleId }),
};

let override: VaultClient | null = null;
/** Tests hand the page their own client; null puts the live one back. */
export function setVaultClient(client: VaultClient | null): void { override = client; }
export const vaultClient = (): VaultClient => override ?? live;
