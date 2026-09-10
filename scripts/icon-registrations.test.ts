import { describe, expect, it } from "vitest";
import { INSTALLED_APP, bundleIdFrom, competing, parseRegistrations } from "./icon-registrations.mjs";

/** A cut of the real `lsregister -dump` shape: stanzas separated by a rule of dashes. */
const RULE = "--------------------------------------------------------";
const stanza = (id: string, path: string, version = "1.1") =>
  ["bundle id:                  Realm (0x123)", `path:                       ${path} (0x456)`,
   `identifier:                 ${id}`, `version:                    ${version} ({length = 32, bytes = 0x00 })`].join("\n");
const dump = (...blocks: string[]) => blocks.join(`\n${RULE}\n`);

describe("bundleIdFrom", () => {
  it("reads the id out of the packaging config rather than repeating it", () => {
    // The mutant is a literal in this script. It would keep passing while the app shipped under a
    // different id, and report a clean database for a bundle nobody has.
    expect(bundleIdFrom("appId: co.charmtechnologies.realm\nproductName: Realm\n")).toBe("co.charmtechnologies.realm");
  });
  it("fails loudly rather than guessing when the config has no appId", () => {
    expect(() => bundleIdFrom("productName: Realm\n")).toThrow(/appId/);
  });
});

describe("parseRegistrations", () => {
  it("collects every bundle claiming the id, and no others", () => {
    const d = dump(
      stanza("co.charmtechnologies.realm", "/Applications/Realm.app", "1.1"),
      stanza("com.github.Electron", "/somewhere/Electron.app", "37"),
      stanza("co.charmtechnologies.realm", "/build/out/Realm.app", "0.6"),
    );
    expect(parseRegistrations(d, "co.charmtechnologies.realm")).toEqual([
      { path: "/Applications/Realm.app", version: "1.1" },
      { path: "/build/out/Realm.app", version: "0.6" },
    ]);
  });

  it("leaves the helper sub-bundles alone", () => {
    // The GPU and renderer helpers carry SUFFIXED ids. They are not what an icon lookup resolves,
    // and unregistering them only means the next launch registers them again.
    const d = dump(
      stanza("co.charmtechnologies.realm", "/Applications/Realm.app"),
      stanza("co.charmtechnologies.realm.helper.GPU", "/Applications/Realm.app/Contents/Frameworks/H.app"),
    );
    expect(parseRegistrations(d, "co.charmtechnologies.realm").map((r) => r.path)).toEqual(["/Applications/Realm.app"]);
  });

  it("counts a path once however many stanzas mention it", () => {
    // The dump repeats a bundle across stanzas; the thing being registered is the PATH, and
    // unregistering it twice would report a number nobody can reconcile with the list above it.
    const d = dump(
      stanza("co.charmtechnologies.realm", "/Applications/Realm.app"),
      stanza("co.charmtechnologies.realm", "/Applications/Realm.app"),
    );
    expect(parseRegistrations(d, "co.charmtechnologies.realm")).toHaveLength(1);
  });

  it("survives a stanza with no version", () => {
    const d = dump(["path:                       /x/Realm.app (0x1)", "identifier:                 co.charmtechnologies.realm"].join("\n"));
    expect(parseRegistrations(d, "co.charmtechnologies.realm")).toEqual([{ path: "/x/Realm.app", version: "?" }]);
  });
});

describe("competing", () => {
  it("counts everything that is not the installed app, including paths that are gone", () => {
    // A bundle that has been deleted still has a ROW, and resolution reads rows. Skipping the
    // missing ones is the tempting mutant and it leaves the database exactly as confused as it was.
    const regs = [
      { path: INSTALLED_APP, version: "1.1" },
      { path: "/build/out/Realm.app", version: "0.6" },
      { path: "/Volumes/Realm 0.2.0-arm64/Realm.app", version: "0.2" },
    ];
    expect(competing(regs).map((r) => r.version)).toEqual(["0.6", "0.2"]);
  });

  it("never counts the installed app itself, however the path is spelled", () => {
    // `-u` on /Applications/Realm.app would unregister the very bundle this exists to protect.
    expect(competing([{ path: `${INSTALLED_APP}/`, version: "1.1" }])).toEqual([]);
    expect(competing([{ path: "/Applications/./Realm.app", version: "1.1" }])).toEqual([]);
  });

  it("reports a clean database as clean", () => {
    expect(competing([{ path: INSTALLED_APP, version: "1.1" }])).toEqual([]);
  });
});
