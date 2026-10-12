import {
  PolicyPressInputSchema, policySealText, policyStampScope, toolClassSealText, toolClassStampScope,
} from "@realm/contracts";

/**
 * The person's press on a team's Policies page, for a write that loosens: a rule that lets a role do
 * more without asking, or a tool said to do less than Realm reads (the dynamic-Teams plan, §4.4).
 *
 * A press is made HERE, from Realm's own window, over renderer IPC — `team:press-policy`, sent by the
 * page's warning sheet, whose controls carry `data-no-agent` so an agent driving Realm's window cannot
 * press them. macOS confirms the person first (Touch ID or the login password, `SecretStore`), and the
 * seal main makes covers exactly the row the sheet showed. realm-server asks for it over the bridge
 * (`teamPolicySeal`) when the page's write arrives, and it is spent as it is given: one press, one
 * write. Without one the server refuses, so nothing holding the RPC token can loosen a rule by calling
 * the method itself.
 */
export type PolicySealer = {
  sealTeamPolicy(scope: string, text: string, reason: string): Promise<{ ok: true; seal: string } | { ok: false; error: string }>;
  teamPolicySealed(items: readonly { scope: string; text: string; seal: string }[]): boolean[];
  bumpTeamPolicy(scope: string): boolean;
};

/** Long enough for the page's write to follow its press; short enough that a press nobody spent is gone. */
export const POLICY_PRESS_TTL_MS = 60_000;

export class PolicyPresses {
  /** Seal by the exact text it covers. */
  private presses = new Map<string, { seal: string; at: number }>();

  constructor(private readonly sealer: () => PolicySealer | null, private readonly now: () => number = Date.now) {}

  /** The sheet's button was pressed. Refuses what is not a press's shape — the renderer is trusted to
   *  be Realm's, not to send well-formed input — and anything macOS does not confirm. */
  async press(input: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
    const parsed = PolicyPressInputSchema.safeParse(input);
    if (!parsed.success) return { ok: false, error: "That change is missing something, so nothing changed." };
    const sealer = this.sealer();
    if (!sealer) return { ok: false, error: "Realm is still starting up; try again in a moment." };
    const p = parsed.data;
    const { scope, text } = p.kind === "policy"
      ? { scope: policyStampScope(p.row.spaceId, p.row.scope, p.row.scopeKey), text: policySealText(p.row) }
      : { scope: toolClassStampScope(p.profileId, p.row.connector, p.row.tool), text: toolClassSealText({ profileId: p.profileId, connector: p.row.connector, tool: p.row.tool, class: p.row.class }) };
    const r = await sealer.sealTeamPolicy(scope, text, p.reason);
    if (!r.ok) return r;
    this.sweep();
    this.presses.set(text, { seal: r.seal, at: this.now() });
    return { ok: true };
  }

  /** realm-server's question: did the person press for exactly this text just now? Spent by asking. */
  consume(text: unknown): { seal: string | null } {
    this.sweep();
    if (typeof text !== "string") return { seal: null };
    const p = this.presses.get(text);
    this.presses.delete(text);
    return { seal: p?.seal ?? null };
  }

  /** realm-server's other question: does each stored seal still check out on this Mac? */
  verify(items: unknown): { sealed: boolean[] } {
    if (!Array.isArray(items)) return { sealed: [] };
    const ok = (i: unknown): i is { scope: string; text: string; seal: string } => {
      const o = (i ?? {}) as Record<string, unknown>;
      return typeof o.scope === "string" && typeof o.text === "string" && typeof o.seal === "string";
    };
    const sealer = this.sealer();
    if (!sealer) return { sealed: items.map(() => false) };
    const valid = items.filter(ok);
    const answers = sealer.teamPolicySealed(valid);
    let n = 0;
    return { sealed: items.map((i) => (ok(i) ? answers[n++] === true : false)) };
  }

  /** A tightening landed: older seals at this scope stop checking out. Only ever narrows. */
  bump(scope: unknown): { ok: boolean } {
    if (typeof scope !== "string" || !/^(team-policy|tool-class):/.test(scope)) return { ok: false };
    return { ok: this.sealer()?.bumpTeamPolicy(scope) ?? false };
  }

  private sweep(): void {
    const cutoff = this.now() - POLICY_PRESS_TTL_MS;
    for (const [k, p] of this.presses) if (p.at < cutoff) this.presses.delete(k);
  }
}
