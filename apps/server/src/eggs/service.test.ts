import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { join } from "node:path";
import { openDatabase, type Db } from "../db/database";
import { SettingsStore } from "../store/settings";
import { EggService, EGGS_UNLOCKED_KEY, eggSecretBox } from "./service";
import { sealPack } from "./seal";
import { newSecretKey } from "@realm/contracts/src/secret-box";
import type { EggPack } from "@realm/contracts";

/* Test packs, sealed here with words this file knows. The real ones ship sealed and this suite has
   no business opening them — if it could, so could anyone reading it. */
const ALPHA: EggPack = { group: "Alpha", labels: [{ present: "Asking Alice", past: "Asked Alice" }], greetings: ["hi from Alpha"] };
const BETA: EggPack = { group: "Beta", labels: [{ present: "Asking Bob", past: "Asked Bob" }, { present: "Asking Bea", past: "Asked Bea" }], greetings: [] };
const PACKS = [sealPack("alpha-word", "a", ALPHA), sealPack("beta-word", "b", BETA)];

const dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); eggSecretBox.setKey(null); });
beforeEach(() => { eggSecretBox.setKey(null); });

function bring() {
  const db = openDatabase(join(tempDir("realm-eggs-"), "realm.db"));
  dbs.push(db);
  const settings = new SettingsStore(db);
  return { settings, service: new EggService({ settings, packs: PACKS }), db };
}

describe("unlocking", () => {
  it("tries a word against every pack and opens the one it fits", () => {
    const { service } = bring();
    expect(service.unlocked()).toEqual([]);
    expect(service.unlock("beta-word")).toMatchObject({ id: "b", group: "Beta" });
    expect(service.unlocked().map((p) => p.group)).toEqual(["Beta"]);
  });

  it("says nothing at all about a word that fits nothing", () => {
    /* The answer is a pack or null, and never "close" or "that group is already open" or a count of
       how many exist. The packs are NAMED AFTER the words that open them, so anything said here
       about a group you have not unlocked is a hint at somebody else's passphrase. */
    const { service } = bring();
    for (const wrong of ["", "   ", "alpha", "Alpha-Word", "beta word"]) {
      expect(service.unlock(wrong), wrong).toBeNull();
    }
    expect(service.unlocked()).toEqual([]);
  });

  it("forgives the whitespace a typed or pasted word arrives with, and nothing else", () => {
    // A word read off a screen and typed into a field picks up a trailing space constantly; failing
    // on that is a mystery the user cannot debug. Case is a different matter — it is part of the
    // word, and forgiving it would quietly quarter the space an attacker has to search.
    const { service } = bring();
    expect(service.unlock("  alpha-word  ")).toMatchObject({ group: "Alpha" });
    expect(service.unlock("ALPHA-WORD")).toBeNull();
  });

  it("holds several groups at once, and a second word does not close the first", () => {
    const { service } = bring();
    service.unlock("alpha-word");
    service.unlock("beta-word");
    expect(service.unlocked().map((p) => p.group).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("keeps the same word from opening the same group twice over", () => {
    const { service } = bring();
    service.unlock("alpha-word");
    service.unlock("alpha-word");
    expect(service.unlocked()).toHaveLength(1);
  });
});

describe("remembering", () => {
  it("stores the WORD, never the contents", () => {
    /* THE convenient mutant: cache the opened pack in settings so restore is a read. `realm.db`
       travels — a backup, a screen share, a support bundle — and the jokes would travel with it,
       which is the thing the sealing exists to prevent. */
    const { service, settings } = bring();
    service.unlock("alpha-word");
    const stored = JSON.stringify(settings.get(EGGS_UNLOCKED_KEY));
    expect(stored).toContain("a");
    expect(stored).not.toContain("Alice");
    expect(stored).not.toContain("Alpha");
  });

  it("opens everything it was told, on the next launch", () => {
    const { service, settings } = bring();
    service.unlock("alpha-word");
    service.unlock("beta-word");
    const next = new EggService({ settings, packs: PACKS });
    expect(next.unlocked()).toEqual([]);
    expect(next.restore()).toBe(2);
    expect(next.unlocked().map((p) => p.group).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("seals the word when the desktop app has handed over a key", () => {
    eggSecretBox.setKey(newSecretKey().toString("base64"));
    const { service, settings } = bring();
    service.unlock("alpha-word");
    const stored = (settings.get(EGGS_UNLOCKED_KEY) as Record<string, string>).a!;
    expect(stored).not.toBe("alpha-word");
    // …and it still restores, which is the half that makes sealing worth doing at all.
    expect(new EggService({ settings, packs: PACKS }).restore()).toBe(1);
  });

  it("forgets a group without forgetting the pack", () => {
    const { service, settings } = bring();
    service.unlock("alpha-word");
    service.forget("a");
    expect(service.unlocked()).toEqual([]);
    expect(settings.get(EGGS_UNLOCKED_KEY)).toEqual({});
    // The same word opens it again: forgetting drops what Realm remembered, not the pack.
    expect(service.unlock("alpha-word")).toMatchObject({ group: "Alpha" });
  });

  it("drops a remembered word that no longer opens anything, rather than keeping a broken row", () => {
    // A pack re-sealed under a new word, or an id that went away. Either way the entry is dead.
    const { settings } = bring();
    settings.set(EGGS_UNLOCKED_KEY, { a: "the-old-word", gone: "whatever" });
    const service = new EggService({ settings, packs: PACKS });
    expect(service.restore()).toBe(0);
    expect(settings.get(EGGS_UNLOCKED_KEY)).toEqual({});
  });

  it("survives junk under the key rather than taking the unlock path down with it", () => {
    for (const junk of [null, 42, "a string", ["an", "array"], { a: 7 }]) {
      const { settings } = bring();
      settings.set(EGGS_UNLOCKED_KEY, junk as never);
      const service = new EggService({ settings, packs: PACKS });
      expect(() => service.restore(), JSON.stringify(junk)).not.toThrow();
      expect(service.unlock("alpha-word")).toMatchObject({ group: "Alpha" });
    }
  });
});
