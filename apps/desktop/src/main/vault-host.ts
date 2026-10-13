import type { VaultHttpResult, VaultSecrets } from "@realm/contracts";
import { performVaultHttp, type VaultHttpDeps } from "./vault-http";
import type { SecretStore } from "./secret-store";

/**
 * The team vault's ops on the main↔server bridge (`VAULT_HOST_OPS` in `host-bridge.ts`), answered in
 * main without a window, as the keyring ops are.
 *
 * Read what is missing: there is no op that adds a secret, sets an allow, or returns a value. The four
 * here list metadata, answer whether one use may skip its card, take an allow AWAY, and make one
 * request whose answer is already scrubbed. Adding a secret and letting a role through without asking
 * are the Vault page's alone, over renderer IPC (`vault-ipc.ts`).
 */
export type VaultHostDeps = {
  store: () => Pick<SecretStore, "vaultSecrets" | "vaultAllows" | "vaultAllowed" | "clearVaultAllow" | "getKey" | "withKeyValue" | "audit"> | null;
  fetch: typeof fetch;
  now: () => number;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export class VaultHost {
  constructor(private readonly d: VaultHostDeps) {}

  async handleOp(op: string, params: Record<string, unknown>): Promise<unknown> {
    const store = this.d.store();
    const profileId = str(params.profileId);
    const spaceId = str(params.spaceId);
    switch (op) {
      case "vaultSecrets": {
        const empty: VaultSecrets = { signins: [], keys: [] };
        return store && profileId && spaceId ? { ...store.vaultSecrets(profileId, spaceId), allows: store.vaultAllows(profileId, spaceId) } : empty;
      }
      case "vaultAllowed": {
        const grantAt = typeof params.grantAt === "number" ? params.grantAt : NaN;
        const allowed = !!store && !!profileId && !!spaceId && store.vaultAllowed(profileId, {
          spaceId, secretId: str(params.secretId), roleId: str(params.roleId), host: str(params.host), grantAt,
        });
        return { allowed };
      }
      // Only ever narrows: a revoked grant takes its allow with it, so a grant made again asks again.
      case "vaultForgetAllow":
        return { cleared: store?.clearVaultAllow(str(params.secretId), str(params.roleId)) ?? false };
      case "vaultHttp": {
        if (!store || !profileId || !spaceId) {
          return { ok: false, refused: "no_key", error: "Realm has no vault open right now" } satisfies VaultHttpResult;
        }
        const deps: VaultHttpDeps = {
          keys: store, fetch: this.d.fetch, now: this.d.now, audit: (e) => store.audit(e),
        };
        const headers: Record<string, string> = {};
        if (params.headers && typeof params.headers === "object" && !Array.isArray(params.headers)) {
          for (const [k, v] of Object.entries(params.headers as Record<string, unknown>)) headers[k] = String(v);
        }
        return performVaultHttp(deps, {
          profileId, spaceId, secretId: str(params.secretId),
          hosts: Array.isArray(params.hosts) ? params.hosts.map(String) : null,
          method: str(params.method) || "GET", url: str(params.url), headers,
          body: typeof params.body === "string" ? params.body : null,
          ...(str(params.roleId) ? { roleId: str(params.roleId) } : {}),
          ...(str(params.runId) ? { runId: str(params.runId) } : {}),
        });
      }
      default:
        throw new Error(`unknown vault op "${op}"`);
    }
  }
}
