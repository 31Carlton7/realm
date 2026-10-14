import { describe, expect, it } from "vitest";
import { GESTURE_PRESENCE_WINDOW_MS, SecretStore, type KeychainItem, type SecretStoreDeps } from "./secret-store";

/**
 * Realm 2.3's passwords in the store: imports, a pane's Save, edits, Show/Copy for the person, the
 * login keychain read in place, agents' "Always allow", and the window a person's own pick opens.
 *
 * The mutants this file is written against:
 *   - an import that duplicates a sign-in the profile holds, or quotes the file in its audit line;
 *   - a save offer for a password Realm already holds (every fill Realm typed would ask to be saved);
 *   - "Never for this site" not honoured;
 *   - Show/Copy let through by "Without asking" or the fill window, or with no audit line;
 *   - a keychain password read before the person answered Realm's check, or a keychain listed while off;
 *   - an "Always allow" that survives a move to another password, origin or Mac;
 *   - the person's one-minute window opened for, or used by, an agent's fill.
 */

const SECRET = "correct horse battery staple";
const P = "pPersonal";

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`kc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").slice(3),
  };
}

function makeStore(over: Partial<SecretStoreDeps> = {}) {
  const disk = { file: null as string | null, audit: [] as string[] };
  const clock = { now: 1_000_000 };
  const presence = { asked: [] as string[], owner: [] as string[], grant: true };
  let n = 0;
  const deps: SecretStoreDeps = {
    safeStorage: fakeSafeStorage(),
    readFile: () => disk.file,
    writeFile: (t) => { disk.file = t; },
    appendAudit: (l) => { disk.audit.push(l); },
    promptPresence: async (reason) => { presence.asked.push(reason); return presence.grant; },
    promptDeviceOwner: async (reason) => { presence.owner.push(reason); return presence.grant; },
    canPromptDeviceOwner: () => true,
    machineId: () => "mac-1",
    now: () => clock.now,
    newId: () => `cred-${++n}`,
    defaultProfileId: () => P,
    ...over,
  };
  return { store: new SecretStore(deps), disk, clock, presence, deps };
}

const imported = (origin: string, username: string, password: string, title = "") => ({ origin, username, password, title });

async function valueOf(store: SecretStore, id: string, how: { gesture?: boolean } = {}): Promise<string | null> {
  let got: string | null = null;
  const r = await store.withCredentialValue(P, id, async (v) => { got = v; }, {}, how);
  return r.ok ? got : null;
}

describe("importing an export", () => {
  it("adds new rows as imported, updates a changed one, and leaves the same one", () => {
    const { store, disk } = makeStore();
    const mine = store.addCredential(P, { origin: "https://a.example.com", username: "ann", label: "", value: "old" });
    store.addCredential(P, { origin: "https://b.example.com", username: "bob", label: "", value: "same" });
    const r = store.importCredentials(P, [
      imported("https://a.example.com", "ann", "new"),
      imported("https://b.example.com", "bob", "same"),
      imported("https://c.example.com", "cat", SECRET, "C site"),
    ]);
    expect(r).toEqual({ added: 1, updated: 1, unchanged: 1 });
    const rows = store.listCredentials(P);
    expect(rows).toHaveLength(3);
    expect(rows.find((c) => c.origin === "https://c.example.com")).toMatchObject({ source: "imported", label: "C site", username: "cat" });
    // The changed one is the same row, now holding the file's password.
    expect(rows.find((c) => c.id === mine.id)?.source).toBeUndefined();
    expect(disk.file).not.toContain(SECRET);
    // The audit line is counts: no site, no username, no password.
    const line = disk.audit.find((l) => l.includes('"import"'))!;
    expect(line).not.toMatch(/c\.example|cat|correct/);
  });

  it("imports into the profile it was asked for and no other", () => {
    const { store } = makeStore();
    store.importCredentials(P, [imported("https://x.example.com", "u", "p")]);
    expect(store.listCredentials("pWork")).toEqual([]);
  });
});

describe("a pane's save offer", () => {
  it("offers to save a new sign-in, and to update one whose password changed", () => {
    const { store } = makeStore();
    expect(store.saveOfferFor(P, "https://example.com", "ada", SECRET)).toEqual({ kind: "save" });
    const row = store.saveOffered(P, { origin: "https://example.com/login", username: "ada", value: SECRET })!;
    expect(row).toMatchObject({ origin: "https://example.com", username: "ada" });
    expect(store.saveOfferFor(P, "https://example.com", "ada", "changed")).toEqual({ kind: "update", id: row.id });
  });

  it("offers nothing for a password the profile already holds, under any username", () => {
    // THE MUTANT: every fill Realm typed would ask to be saved again on submit.
    const { store } = makeStore();
    store.addCredential(P, { origin: "https://example.com", username: "ada", label: "", value: SECRET });
    expect(store.saveOfferFor(P, "https://example.com", "ada", SECRET)).toBeNull();
    expect(store.saveOfferFor(P, "https://example.com", "", SECRET)).toBeNull();
  });

  it("offers nothing on a site the person said never for, until they take it back", () => {
    const { store } = makeStore();
    expect(store.setNeverSave(P, "https://example.com/x", true)).toEqual(["https://example.com"]);
    expect(store.saveOfferFor(P, "https://example.com", "ada", SECRET)).toBeNull();
    expect(store.saveOffered(P, { origin: "https://example.com", username: "ada", value: SECRET })).toBeNull();
    expect(store.listCredentials(P)).toEqual([]);
    store.setNeverSave(P, "https://example.com", false);
    expect(store.saveOfferFor(P, "https://example.com", "ada", SECRET)).toEqual({ kind: "save" });
  });

  it("updates in place, so an update keeps the row's id", async () => {
    const { store } = makeStore();
    const row = store.addCredential(P, { origin: "https://example.com", username: "ada", label: "Work", value: "old" });
    store.saveOffered(P, { origin: "https://example.com", username: "ada", value: SECRET });
    expect(store.listCredentials(P)).toHaveLength(1);
    expect(await valueOf(store, row.id)).toBe(SECRET);
  });
});

describe("editing", () => {
  it("changes the username and label, and the password only when one is given", async () => {
    const { store } = makeStore();
    const row = store.addCredential(P, { origin: "https://example.com", username: "ada", label: "", value: SECRET });
    store.updateCredential(P, row.id, { username: "ada2", label: "Work" });
    expect(store.getCredential(P, row.id)).toMatchObject({ username: "ada2", label: "Work" });
    expect(await valueOf(store, row.id)).toBe(SECRET);
    store.updateCredential(P, row.id, { username: "ada2", label: "Work", value: "new one" });
    expect(await valueOf(store, row.id)).toBe("new one");
    expect(store.updateCredential("pWork", row.id, { username: "x", label: "" })).toBeNull();
  });
});

describe("Show and Copy, for the person", () => {
  it("asks macOS every time — even under Without asking and inside the fill window", async () => {
    const { store, presence, disk } = makeStore();
    const row = store.addCredential(P, { origin: "https://example.com", username: "ada", label: "", value: SECRET });
    store.setPresenceTtlMs(300_000);
    await valueOf(store, row.id); // opens the fill window
    let shown: string | null = null;
    expect(await store.withCredentialValueForPerson(P, row.id, "show", async (v) => { shown = v; })).toEqual({ ok: true });
    expect(await store.withCredentialValueForPerson(P, row.id, "copy", async () => {})).toEqual({ ok: true });
    expect(shown).toBe(SECRET);
    // THE MUTANT: the window (or a policy) letting a reveal through unasked.
    expect(presence.owner).toHaveLength(2);
    expect(disk.audit.filter((l) => l.includes('"reveal"'))).toHaveLength(2);
    expect(disk.audit.join("")).not.toContain(SECRET);
  });

  it("refuses, and says so in the audit, when macOS does not confirm", async () => {
    const { store, presence, disk } = makeStore();
    const row = store.addCredential(P, { origin: "https://example.com", username: "ada", label: "", value: SECRET });
    presence.grant = false;
    let called = false;
    expect(await store.withCredentialValueForPerson(P, row.id, "show", async () => { called = true; })).toEqual({ ok: false, refused: "no_presence" });
    expect(called).toBe(false);
    expect(disk.audit.some((l) => l.includes('"reveal"') && l.includes('"refused"'))).toBe(true);
  });
});

describe("the login keychain", () => {
  const item: KeychainItem = { server: "example.com", account: "ada", protocol: "https", port: 0, path: "", label: "example.com", modified: 5 };
  function withKeychain(value: string | null = SECRET) {
    const reads: KeychainItem[] = [];
    const lists = { n: 0 };
    const keychain = {
      list: async () => { lists.n++; return [item, { ...item, server: "other.org", protocol: "http" as const, port: 8080 }]; },
      read: async (i: KeychainItem) => { reads.push(i); return value; },
    };
    return { ...makeStore({ keychain }), reads, lists };
  }

  it("lists nothing, and reads nothing, until the person turns it on", async () => {
    const { store, lists } = withKeychain();
    await store.refreshKeychain(true);
    expect(lists.n).toBe(0);
    expect(store.credentialsForSpace(P, null)).toEqual([]);
    expect(store.keychainStatus()).toEqual({ supported: true, enabled: false, count: null, error: null });
  });

  it("lists items as metadata rows, offered to every profile", async () => {
    const { store } = withKeychain();
    expect(await store.setKeychainEnabled(true)).toMatchObject({ enabled: true, count: 2 });
    const rows = store.credentialsForSpace("pWork", null);
    expect(rows.map((r) => [r.origin, r.username, r.source])).toEqual([["https://example.com", "ada", "keychain"], ["http://other.org:8080", "ada", "keychain"]]);
    expect(rows[0]!.id).toMatch(/^kc_/);
    expect(store.credentialsForSite(P, null, "https://login.example.com").map((r) => r.match)).toEqual(["same-site"]);
  });

  it("reads one password at fill time, only after Realm's own check passed", async () => {
    const { store, reads, presence } = withKeychain();
    await store.setKeychainEnabled(true);
    const id = store.credentialsForSpace(P, null)[0]!.id;
    presence.grant = false;
    expect(await valueOf(store, id)).toBeNull();
    // THE MUTANT: reading before the check, which would raise macOS's sheet for a refused fill.
    expect(reads).toEqual([]);
    presence.grant = true;
    expect(await valueOf(store, id)).toBe(SECRET);
    expect(reads).toEqual([item]);
  });

  it("answers no_credential when the keychain has nothing to give", async () => {
    const { store } = withKeychain(null);
    await store.setKeychainEnabled(true);
    const id = store.credentialsForSpace(P, null)[0]!.id;
    expect(await store.withCredentialValue(P, id, async () => {})).toEqual({ ok: false, refused: "no_credential" });
  });

  it("forgets the listing the moment it is turned off", async () => {
    const { store } = withKeychain();
    await store.setKeychainEnabled(true);
    const id = store.credentialsForSpace(P, null)[0]!.id;
    await store.setKeychainEnabled(false);
    expect(store.getCredential(P, id)).toBeNull();
    expect(await store.withCredentialValue(P, id, async () => {})).toEqual({ ok: false, refused: "no_credential" });
  });

  it("is unsupported with no helper", () => {
    expect(makeStore().store.keychainStatus().supported).toBe(false);
  });
});

describe("an agent's Always allow", () => {
  it("holds for one password on one exact origin on this Mac", () => {
    const { store } = makeStore();
    const a = store.addCredential(P, { origin: "https://example.com", username: "ada", label: "", value: SECRET });
    const b = store.addCredential(P, { origin: "https://example.com", username: "bob", label: "", value: SECRET });
    expect(store.setFillAllow(P, a.id, "https://example.com/login")).toBe(true);
    expect(store.fillAllowed(P, a.id, "https://example.com")).toBe(true);
    expect(store.fillAllowed(P, b.id, "https://example.com")).toBe(false);
    expect(store.fillAllowed(P, a.id, "https://login.example.com")).toBe(false);
    expect(store.fillAllowed("pWork", a.id, "https://example.com")).toBe(false);
    expect(store.fillAllows(P)).toEqual([{ credentialId: a.id, origin: "https://example.com", setAt: 1_000_000 }]);
    expect(store.credentialsForSite(P, null, "https://example.com").map((c) => [c.username, c.agentAllowed])).toEqual([["ada", true], ["bob", false]]);
  });

  it("reads as ask when copied to another Mac or moved to another password", () => {
    const { store, disk } = makeStore();
    const a = store.addCredential(P, { origin: "https://example.com", username: "ada", label: "", value: SECRET });
    const b = store.addCredential(P, { origin: "https://example.com", username: "bob", label: "", value: SECRET });
    store.setFillAllow(P, a.id, "https://example.com");
    // Moved: the sealed record names a's id, whatever key it is filed under.
    const file = JSON.parse(disk.file!) as { fillAllow: Record<string, string> };
    file.fillAllow[`${P}|${b.id}|https://example.com`] = Object.values(file.fillAllow)[0]!;
    const moved = makeStore({ readFile: () => JSON.stringify(file) }).store;
    expect(moved.fillAllowed(P, b.id, "https://example.com")).toBe(false);
    // Copied: another Mac's id.
    const other = makeStore({ readFile: () => disk.file, machineId: () => "mac-2" }).store;
    expect(other.fillAllowed(P, a.id, "https://example.com")).toBe(false);
  });

  it("goes with its password, and is one click to clear", () => {
    const { store } = makeStore();
    const a = store.addCredential(P, { origin: "https://example.com", username: "ada", label: "", value: SECRET });
    store.setFillAllow(P, a.id, "https://example.com");
    expect(store.clearFillAllow(P, a.id, "https://example.com")).toBe(true);
    expect(store.fillAllowed(P, a.id, "https://example.com")).toBe(false);
    store.setFillAllow(P, a.id, "https://example.com");
    store.removeCredential(P, a.id);
    expect(store.fillAllows(P)).toEqual([]);
  });
});

describe("a person's own pick in the pane's menu", () => {
  it("asks once, then not again inside the minute", async () => {
    const { store, presence, clock } = makeStore();
    const row = store.addCredential(P, { origin: "https://example.com", username: "ada", label: "", value: SECRET });
    expect(await valueOf(store, row.id, { gesture: true })).toBe(SECRET);
    expect(await valueOf(store, row.id, { gesture: true })).toBe(SECRET);
    expect(presence.asked).toHaveLength(1);
    clock.now += GESTURE_PRESENCE_WINDOW_MS + 1;
    await valueOf(store, row.id, { gesture: true });
    expect(presence.asked).toHaveLength(2);
  });

  it("never lets an agent's fill through on that window", async () => {
    // THE MUTANT: the gesture window shared with fills that come from an agent.
    const { store, presence } = makeStore();
    const row = store.addCredential(P, { origin: "https://example.com", username: "ada", label: "", value: SECRET });
    await valueOf(store, row.id, { gesture: true });
    await valueOf(store, row.id);
    expect(presence.asked).toHaveLength(2);
  });

  it("is the person's proof where the system has no check, and only for their pick", async () => {
    const { store, presence, disk } = makeStore({ platformPresence: () => false, promptPresence: async () => false });
    const row = store.addCredential(P, { origin: "https://example.com", username: "ada", label: "", value: SECRET });
    expect(await valueOf(store, row.id, { gesture: true })).toBe(SECRET);
    expect(disk.audit.some((l) => l.includes('"how":"gesture"'))).toBe(true);
    expect(await valueOf(store, row.id)).toBeNull();
    expect(presence.asked).toEqual([]);
  });
});
