import {
  VAULT_PLACEHOLDER, hostAllowed, normalizeVaultHost, type Run, type VaultGrant, type VaultGrantInput, type VaultSecretKind, type VaultSecrets, type VaultUse,
} from "@realm/contracts";
import type { BrowserHostBridge } from "../../browsers/host-bridge";
import type { RpcServer } from "../../rpc/server";
import { NotFoundError, RpcError } from "../../store/rows";
import type { RoleRow, TeamStore } from "../store";
import type { VaultStore } from "./store";

/** A secret as a use of it is checked and logged: never more than its id, kind and name. */
export type VaultSecretRef = { id: string; kind: VaultSecretKind; name: string };

/**
 * Who may use a secret, decided before anything is asked or typed.
 *
 *   - `refuse`: a role asked for a secret it holds no grant for, or for a host its grant does not name.
 *     Logged as `refused_secret`, and nothing else happens — no card, no prompt.
 *   - otherwise the use goes ahead on the session's CARD, exactly as every fill always has — unless
 *     main says a sealed allow covers this one use (`unattended`), which only the user can set, in the
 *     Vault page, confirmed by macOS, on a profile that itself unlocks without asking.
 */
export type VaultCheck =
  | { refuse: string }
  | { unattended: boolean; roleId: string | null; runId: string | null; hosts: string[] | null };

/**
 * The team vault's server half (Teams Phase 2): grants, the check every use passes, and the log.
 *
 * Holds no secret and could not: the values are in Electron main's store, and every question about
 * one — what the team has, whether an allow covers a use — is asked of main over the bridge. What lives
 * here is the grant table, which on its own only ever lets a role ASK; and nothing an agent can call
 * writes it. The tools (`agent-tools.ts`) and `browser_fill_credential` read grants; only the Vault
 * page's RPC methods change them, and every change is a line in the team's activity.
 */
export class VaultService {
  constructor(private readonly d: {
    store: VaultStore;
    team: Pick<TeamStore, "role" | "appendActivity">;
    runs: { listLive(): Run[] };
    bridge: Pick<BrowserHostBridge, "call">;
    profileOf: (spaceId: string) => string | null;
    isTeam: (spaceId: string) => boolean;
    rpc: Pick<RpcServer, "broadcast">;
  }) {}

  /** The team's secrets, from main. Metadata only. An empty vault when main is not there to ask. */
  async secrets(spaceId: string): Promise<VaultSecrets> {
    const profileId = this.d.profileOf(spaceId);
    if (!profileId) return { signins: [], keys: [] };
    try {
      const r = (await this.d.bridge.call("vaultSecrets", { profileId, spaceId })) as VaultSecrets;
      return { signins: Array.isArray(r?.signins) ? r.signins : [], keys: Array.isArray(r?.keys) ? r.keys : [], allows: Array.isArray(r?.allows) ? r.allows : [] };
    } catch {
      return { signins: [], keys: [] };
    }
  }

  /** A secret as the team holds it — the pinned hosts are what a grant may name, at most. */
  async find(spaceId: string, secretId: string): Promise<(VaultSecretRef & { pinned: string[] }) | null> {
    const s = await this.secrets(spaceId);
    const key = s.keys.find((k) => k.id === secretId);
    if (key) return { id: key.id, kind: "key", name: key.name, pinned: key.allowedHosts };
    const signin = s.signins.find((c) => c.id === secretId);
    const host = signin ? normalizeVaultHost(signin.origin) : null;
    return signin && host ? { id: signin.id, kind: "signin", name: signinName(signin.origin, signin.username), pinned: [host] } : null;
  }

  grants(spaceId: string): VaultGrant[] { return this.d.store.grants(spaceId); }
  grantsForRole(roleId: string): VaultGrant[] { return this.d.store.grantsForRole(roleId); }
  uses(spaceId: string, limit: number): VaultUse[] { return this.d.store.uses(spaceId, limit); }

  /**
   * Let a role use a secret, at the hosts named (all the secret's own when none are). A host the
   * secret is not pinned to is refused: a grant narrows what a secret reaches, never widens it.
   * Reached from the Vault page's RPC alone; there is no tool for it.
   */
  async grant(input: VaultGrantInput): Promise<VaultGrant> {
    const role = this.teamRole(input.spaceId, input.roleId);
    const secret = await this.find(input.spaceId, input.secretId);
    if (!secret) throw new RpcError("NOT_FOUND", "That secret is not in this team's vault — or Realm's window is not connected to ask.");
    const asked = input.hosts.map((h) => normalizeVaultHost(h));
    if (asked.some((h) => h === null)) throw new RpcError("BAD_REQUEST", "Each host must be a site's address, such as api.revenuecat.com.");
    const hosts = asked.length ? [...new Set(asked as string[])] : secret.pinned;
    const outside = hosts.filter((h) => !hostAllowed(h, secret.pinned));
    if (outside.length) throw new RpcError("BAD_REQUEST", `${secret.name} is locked to ${secret.pinned.join(", ")}; it cannot be granted for ${outside.join(", ")}.`);
    const before = this.d.store.grant(secret.id, role.id);
    const g = this.d.store.put({ secretId: secret.id, spaceId: input.spaceId, roleId: role.id, kind: secret.kind, name: secret.name, hosts, purpose: input.purpose });
    this.log(input.spaceId, "user", before ? "regranted_secret" : "granted_secret", secret.name, { secretId: secret.id, kind: secret.kind, roleId: role.id, role: role.name, hosts });
    return g;
  }

  /** Take a grant away, and its allow with it: main drops the sealed "without asking", so a grant made
   *  again later starts by asking. */
  async revoke(spaceId: string, secretId: string, roleId: string): Promise<boolean> {
    const g = this.d.store.grant(secretId, roleId);
    if (!g || g.spaceId !== spaceId) return false;
    this.d.store.revoke(secretId, roleId);
    await this.d.bridge.call("vaultForgetAllow", { secretId, roleId }).catch(() => undefined);
    this.log(spaceId, "user", "revoked_secret", g.name, { secretId, kind: g.kind, roleId, role: this.d.team.role(roleId)?.name ?? null });
    return true;
  }

  /**
   * The Vault page turned a grant's "use without asking" on or off over IPC, and says so here so the
   * team's log can carry it. Main is asked what is TRUE rather than the page believed: a line is
   * written only when main's allows agree, so this method cannot be used to forge one.
   */
  async allowChanged(spaceId: string, secretId: string, roleId: string): Promise<{ on: boolean }> {
    const g = this.d.store.grant(secretId, roleId);
    if (!g || g.spaceId !== spaceId) throw new NotFoundError("grant", `${secretId}/${roleId}`);
    const on = ((await this.secrets(spaceId)).allows ?? []).some((a) => a.secretId === secretId && a.roleId === roleId && a.grantAt === g.createdAt);
    this.log(spaceId, "user", on ? "allowed_unattended" : "asked_again", g.name, { secretId, kind: g.kind, roleId, role: this.d.team.role(roleId)?.name ?? null, hosts: g.hosts });
    return { on };
  }

  /** The live role run a session belongs to, if it is one. A person's own session is no role. */
  roleOf(sessionId: string): { role: RoleRow; run: Run } | null {
    const run = this.d.runs.listLive().find((r) => r.sessionId === sessionId && r.roleId);
    const role = run?.roleId ? this.d.team.role(run.roleId) : null;
    return run && role && !role.archived ? { role, run } : null;
  }

  /**
   * The check every use of a secret passes, before a card is raised or anything is typed or sent.
   * A role needs a grant naming this host; a person's own session needs none and asks on its card,
   * as it always has. A role's use skips the card only when main says a sealed allow covers it.
   */
  async check(ctx: { sessionId: string; spaceId: string }, secret: VaultSecretRef, host: string): Promise<VaultCheck> {
    const owner = this.roleOf(ctx.sessionId);
    if (!owner) return { unattended: false, roleId: null, runId: null, hosts: null };
    const { role, run } = owner;
    const g = this.d.store.grant(secret.id, role.id);
    const refuse = (reason: string, words: string): VaultCheck => {
      this.note(ctx, { secret, host, refused: reason }, { roleId: role.id, runId: run.id });
      return { refuse: words };
    };
    if (!g || g.spaceId !== ctx.spaceId) return refuse("not granted to this role", `refused: ${role.name} holds no grant for ${secret.name}. The person adds grants in the team's Vault page; you cannot.`);
    if (!hostAllowed(host, g.hosts)) return refuse(`not granted for ${host}`, `refused: ${role.name}'s grant for ${secret.name} names ${g.hosts.join(", ")}, not ${host}.`);
    const profileId = this.d.profileOf(ctx.spaceId);
    let unattended = false;
    if (profileId) {
      try {
        const r = (await this.d.bridge.call("vaultAllowed", { profileId, spaceId: ctx.spaceId, secretId: secret.id, roleId: role.id, host, grantAt: g.createdAt })) as { allowed?: unknown };
        unattended = r?.allowed === true;
      } catch { unattended = false; }
    }
    return { unattended, roleId: role.id, runId: run.id, hosts: g.hosts };
  }

  /** One use, as a line of the team's activity: who, which secret, where, how it was let through, and
   *  what came of it. Never a value — there is none here to write. */
  note(ctx: { sessionId: string; spaceId: string }, use: { secret: VaultSecretRef; host: string; how?: "card" | "unattended"; status?: number | null; refused?: string },
    who: { roleId: string | null; runId: string | null }): void {
    if (!this.d.isTeam(ctx.spaceId)) return;
    const detail: Record<string, unknown> = { secretId: use.secret.id, kind: use.secret.kind, where: use.host };
    if (use.refused) detail.reason = use.refused;
    if (use.how) detail.how = use.how;
    if (typeof use.status === "number") detail.status = use.status;
    this.d.team.appendActivity({
      spaceId: ctx.spaceId, actor: who.roleId ? `role:${who.roleId}` : "user", runId: who.runId, sessionId: ctx.sessionId,
      verb: use.refused ? "refused_secret" : "used_secret", object: use.secret.name, detail,
    });
    this.d.rpc.broadcast("team.changed", { spaceId: ctx.spaceId });
  }

  /** What a role's run is told it may use: names and hosts, never a value. Empty for a role with none. */
  preambleLines(roleId: string): string[] {
    const grants = this.d.store.grantsForRole(roleId);
    if (grants.length === 0) return [];
    const keys = grants.filter((g) => g.kind === "key").map((g) => `${g.name} (only to ${g.hosts.join(", ")})`);
    const signins = grants.filter((g) => g.kind === "signin").map((g) => g.name);
    return [
      "- The team's vault: you use these by name and never see a value. "
        + [keys.length ? `API keys, through \`vault_http\` with ${VAULT_PLACEHOLDER} where the key goes: ${keys.join("; ")}.` : null,
          signins.length ? `Sign-ins, through \`browser_fill_credential\`: ${signins.join("; ")}.` : null].filter(Boolean).join(" ")
        + " `vault_list` says what you hold. Anything else is refused.",
    ];
  }

  private teamRole(spaceId: string, roleId: string): RoleRow {
    const role = this.d.team.role(roleId);
    if (!role || role.spaceId !== spaceId || role.archived) throw new NotFoundError("role", roleId);
    return role;
  }

  private log(spaceId: string, actor: string, verb: string, object: string, detail: Record<string, unknown>): void {
    this.d.team.appendActivity({ spaceId, actor, verb, object, detail });
    this.d.rpc.broadcast("team.changed", { spaceId });
  }
}

/** A sign-in as the vault names it: "tiktok.com · nathan". */
export function signinName(origin: string, username: string): string {
  let host = origin;
  try { host = new URL(origin).host; } catch { /* keep it */ }
  return username ? `${host} · ${username}` : host;
}
