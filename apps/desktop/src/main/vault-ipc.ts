import {
  BrowserCredentialInputSchema, VaultKeyInputSchema,
  type BrowserCredential, type VaultAllow, type VaultKey, type VaultSecrets,
} from "@realm/contracts";
import { SecretStoreError, type SecretStore } from "./secret-store";

/**
 * A team's Vault page, over renderer IPC — the ONLY way a team's secret is enrolled and the ONLY way a
 * grant is let through without asking.
 *
 * Renderer IPC on purpose, as Settings ▸ Sign-ins is: a page cannot reach the renderer, and an agent
 * cannot call it — there is no RPC method, MCP tool, bridge op or setting key beside any of these. The
 * controls that send them carry `data-no-agent`, so an agent driving Realm's own window cannot press
 * them either; and turning an allow on asks macOS for Touch ID or the login password, which no agent
 * can answer. Values travel renderer → main once, at enrollment, and never back.
 */
export type VaultIpcDeps = {
  handle(channel: string, fn: (...args: unknown[]) => unknown): void;
  secrets(): SecretStore | null;
  /** The profile, if it still exists — a secret saved under an id nobody holds is offered to nobody. */
  resolveProfile(id: string): Promise<{ id: string } | null>;
};

export type VaultListing = {
  available: boolean;
  secrets: VaultSecrets;
  allows: VaultAllow[];
  /** The profile's own unlock policy is "without asking" — an allow does something only then. */
  profileUnattended: boolean;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function registerVaultIpc(d: VaultIpcDeps): void {
  d.handle("vault:list", async (profileId, spaceId): Promise<VaultListing> => {
    const store = d.secrets();
    const owner = await d.resolveProfile(str(profileId));
    const empty: VaultListing = { available: false, secrets: { signins: [], keys: [] }, allows: [], profileUnattended: false };
    if (!store || !owner || !str(spaceId)) return empty;
    return {
      available: store.available,
      secrets: store.vaultSecrets(owner.id, str(spaceId)),
      allows: store.vaultAllows(owner.id, str(spaceId)),
      profileUnattended: store.unlockPolicy({ kind: "profile", id: owner.id }).kind === "unattended",
    };
  });

  d.handle("vault:add-signin", async (profileId, spaceId, input): Promise<BrowserCredential> => {
    const { store, owner } = await ready(d, profileId);
    const parsed = BrowserCredentialInputSchema.safeParse(input);
    // Never the zod error: it echoes the parsed input, and the input is the password.
    if (!parsed.success || !str(spaceId)) throw new Error("That sign-in is missing something — check the address and password fields.");
    try { return store.addCredential(owner.id, parsed.data, str(spaceId)); } catch (e) { throw person(e, "That sign-in could not be saved."); }
  });

  d.handle("vault:add-key", async (profileId, spaceId, input): Promise<VaultKey> => {
    const { store, owner } = await ready(d, profileId);
    const parsed = VaultKeyInputSchema.safeParse(input);
    if (!parsed.success || !str(spaceId)) {
      const name = parsed.success ? null : parsed.error.issues.find((i) => i.path[0] === "name");
      throw new Error(name ? name.message : "That key is missing something — its name, a host, or the key itself.");
    }
    try { return store.addKey(owner.id, str(spaceId), parsed.data); } catch (e) { throw person(e, "That key could not be saved."); }
  });

  /** Remove one of the TEAM's secrets: its keys, and the sign-ins saved for it. A profile's own sign-in
   *  is Settings' to remove — taken out of the team here only by revoking its grants. */
  d.handle("vault:remove", async (profileId, spaceId, secretId): Promise<boolean> => {
    const store = d.secrets();
    const owner = await d.resolveProfile(str(profileId));
    if (!store || !owner) return false;
    const mine = store.vaultSecrets(owner.id, str(spaceId));
    if (mine.keys.some((k) => k.id === secretId)) return store.removeKey(owner.id, str(secretId));
    if (mine.signins.some((s) => s.id === secretId && s.spaceId === str(spaceId))) return store.removeCredential(owner.id, str(secretId));
    return false;
  });

  d.handle("vault:set-allow", async (profileId, input) => {
    const store = d.secrets();
    if (!store) return { ok: false as const, error: "Realm is still starting up; try again in a moment." };
    const owner = await d.resolveProfile(str(profileId));
    if (!owner) return { ok: false as const, error: "That profile no longer exists." };
    const a = (input ?? {}) as Record<string, unknown>;
    return store.setVaultAllow(owner.id, {
      spaceId: str(a.spaceId), secretId: str(a.secretId), roleId: str(a.roleId),
      hosts: Array.isArray(a.hosts) ? a.hosts.map(String) : [],
      grantAt: typeof a.grantAt === "number" ? a.grantAt : NaN,
      roleName: str(a.roleName) || "this role", secretName: str(a.secretName) || "this secret",
    });
  });

  d.handle("vault:clear-allow", (secretId, roleId): boolean => d.secrets()?.clearVaultAllow(str(secretId), str(roleId)) ?? false);
}

async function ready(d: VaultIpcDeps, profileId: unknown): Promise<{ store: SecretStore; owner: { id: string } }> {
  const store = d.secrets();
  if (!store) throw new Error("Realm is still starting up; try saving again in a moment");
  const owner = await d.resolveProfile(str(profileId));
  if (!owner) throw new Error("That profile no longer exists, so nothing was saved.");
  return { store, owner };
}

/** A store refusal is written for a person and carries no input; anything else is replaced wholesale. */
const person = (e: unknown, fallback: string): Error => new Error(e instanceof SecretStoreError ? e.message : fallback);

