import { describe, expect, it } from "vitest";
import { policySealText, policyStampScope, type TeamPolicyInput } from "@realm/contracts";
import type { PolicyStamp } from "./policy-stamp";
import { PolicyPresses, POLICY_PRESS_TTL_MS } from "./policy-presses";
import { SecretStore, type SecretStoreDeps } from "./secret-store";

/**
 * A team's Policies page press, through the REAL secret store (keyring, `team-policy` domain, the
 * Keychain stamp and the device-owner check stood in for). The mutants this file is for:
 *   - a seal made without macOS confirming the person, or with no stamp to tie it to;
 *   - a seal that checks out for a row someone edited in realm.db, for another scope, on another Mac,
 *     or after a tightening moved its scope's stamp on (an older sealed row put back);
 *   - a press spent twice, or kept past its moment;
 *   - a policy seal opening as any other secret, or another secret's blob opening as one.
 */

const MAC = "11111111-2222-3333-4444-555555555555";

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`kc:${s}`, "utf8"),
    decryptString: (b: Buffer) => {
      const s = b.toString("utf8");
      if (!s.startsWith("kc:")) throw new Error("not ours");
      return s.slice(3);
    },
  };
}

type Disk = { file: string | null; audit: string[]; keychain: Map<string, number> };

function makeStore(o: { disk?: Disk; machine?: string; stamp?: boolean; grant?: boolean } = {}) {
  const disk: Disk = o.disk ?? { file: null, audit: [], keychain: new Map() };
  const asked: string[] = [];
  const stamp: PolicyStamp = {
    read: (scope) => disk.keychain.get(scope) ?? null,
    bump: (scope) => { const next = (disk.keychain.get(scope) ?? 1_000) + 1; disk.keychain.set(scope, next); return next; },
  };
  const deps: SecretStoreDeps = {
    safeStorage: fakeSafeStorage(),
    readFile: () => disk.file,
    writeFile: (t) => { disk.file = t; },
    appendAudit: (l) => { disk.audit.push(l); },
    promptPresence: async (reason) => { asked.push(`touch:${reason}`); return o.grant ?? true; },
    promptDeviceOwner: async (reason) => { asked.push(`owner:${reason}`); return o.grant ?? true; },
    canPromptDeviceOwner: () => true,
    canPromptTouchID: () => true,
    machineId: () => o.machine ?? MAC,
    policyStamp: o.stamp === false ? null : stamp,
    now: () => 5_000,
    newId: () => "id",
    defaultProfileId: () => "P1",
  };
  return { store: new SecretStore(deps), disk, asked };
}

const ROW: TeamPolicyInput = { spaceId: "S1", scope: "tool", scopeKey: "mcp:CRM#send_thing", decision: "auto", caps: { perDay: 20, gapMs: 60_000 }, checks: [] };
const SCOPE = policyStampScope(ROW.spaceId, ROW.scope, ROW.scopeKey);
const TEXT = policySealText(ROW);
const press = { kind: "policy", row: ROW, reason: "let Versed's roles run acme-crm's send thing without asking, up to 20 a day" };

describe("PolicyPresses", () => {
  it("asks macOS, seals exactly the row the sheet showed, and hands the seal over once", async () => {
    const { store, asked, disk } = makeStore();
    const presses = new PolicyPresses(() => store);
    expect(await presses.press(press)).toEqual({ ok: true });
    expect(asked).toEqual([`owner:${press.reason}`]);
    // THE MUTANT: a press for one row spent on another — the seal is keyed by exactly the row's text.
    expect(presses.consume(policySealText({ ...ROW, caps: { perDay: 21 } }))).toEqual({ seal: null });
    const { seal } = presses.consume(TEXT);
    expect(typeof seal).toBe("string");
    // Spent by asking: a second ask gets nothing.
    expect(presses.consume(TEXT)).toEqual({ seal: null });
    expect(presses.verify([{ scope: SCOPE, text: TEXT, seal }])).toEqual({ sealed: [true] });
    expect(disk.audit.some((l) => l.includes('"kind":"team-policy"') && l.includes('"outcome":"sealed"'))).toBe(true);
  });

  it("makes no seal when macOS does not confirm the person", async () => {
    const { store } = makeStore({ grant: false });
    const presses = new PolicyPresses(() => store);
    // THE MUTANT: the confirm skipped — anything that reached the handler could loosen a rule.
    expect(await presses.press(press)).toEqual({ ok: false, error: "macOS did not confirm it was you, so nothing changed." });
    expect(presses.consume(TEXT)).toEqual({ seal: null });
  });

  it("makes no seal where no Keychain stamp can be kept", async () => {
    const { store } = makeStore({ stamp: false });
    expect(await new PolicyPresses(() => store).press(press)).toMatchObject({ ok: false });
  });

  it("refuses what is not a press's shape, and a whole-class press it cannot seal for a missing row", async () => {
    const { store, asked } = makeStore();
    const presses = new PolicyPresses(() => store);
    expect(await presses.press({ kind: "policy", row: { ...ROW, decision: "maybe" }, reason: "x" })).toMatchObject({ ok: false });
    expect(await presses.press(null)).toMatchObject({ ok: false });
    expect(asked).toEqual([]);
  });

  it("forgets a press nobody spent", async () => {
    let t = 1_000;
    const { store } = makeStore();
    const presses = new PolicyPresses(() => store, () => t);
    await presses.press(press);
    t += POLICY_PRESS_TTL_MS + 1;
    expect(presses.consume(TEXT)).toEqual({ seal: null });
  });

  it("says a seal no longer checks out once the row is edited, moved, put back after a tightening, or carried to another Mac", async () => {
    const disk: Disk = { file: null, audit: [], keychain: new Map() };
    const { store } = makeStore({ disk });
    const presses = new PolicyPresses(() => store);
    await presses.press(press);
    const { seal } = presses.consume(TEXT);
    const item = { scope: SCOPE, text: TEXT, seal: seal! };
    // THE MUTANT: the text left out of the comparison — a cap raised in sqlite3 under the old seal.
    expect(presses.verify([{ ...item, text: policySealText({ ...ROW, caps: { perDay: 500 } }) }])).toEqual({ sealed: [false] });
    expect(presses.verify([{ ...item, scope: policyStampScope("S2", ROW.scope, ROW.scopeKey) }])).toEqual({ sealed: [false] });
    expect(presses.verify([{ ...item, seal: "garbage" }, item])).toEqual({ sealed: [false, true] });
    // Another Mac, same files and keyring.
    expect(new PolicyPresses(() => makeStore({ disk, machine: "99999999-2222-3333-4444-555555555555" }).store).verify([item])).toEqual({ sealed: [false] });
    // A tightening moves the stamp on: the older sealed row, put back, no longer checks out.
    expect(presses.bump(SCOPE)).toEqual({ ok: true });
    expect(presses.verify([item])).toEqual({ sealed: [false] });
    // …and only scopes of this kind move.
    expect(presses.bump("profile:P1")).toEqual({ ok: false });
  });

  it("takes no seal another keyring made, nor a blob of another domain", async () => {
    const disk: Disk = { file: null, audit: [], keychain: new Map() };
    const { store } = makeStore({ disk });
    const presses = new PolicyPresses(() => store);
    await presses.press(press);
    const { seal } = presses.consume(TEXT);
    // Same Mac, same stamps, a fresh keyring — what a copied realm.db meets after the keyring was reset.
    const other = makeStore({ disk: { file: null, audit: [], keychain: disk.keychain } }).store;
    expect(other.teamPolicySealed([{ scope: SCOPE, text: TEXT, seal: seal! }])).toEqual([false]);
    // The domain byte flipped to `unlock` (6): GCM's AAD no longer matches, so it never opens.
    const raw = Buffer.from(seal!, "base64");
    raw[1] = 6;
    expect(store.teamPolicySealed([{ scope: SCOPE, text: TEXT, seal: raw.toString("base64") }])).toEqual([false]);
  });
});
