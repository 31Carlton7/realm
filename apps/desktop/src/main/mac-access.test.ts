import { describe, expect, it } from "vitest";
import {
  MAC_CAPABILITIES, MAC_SETTINGS_URLS, appBundlePath, grantPlan, grantedCount, isMacCapabilityId,
  macAccessRows, macGrantArgv, macSettingsUrl, parseMacDoctor, parseMacVersion, resolveMacBin,
  settingsOnlyRows, type MacDoctorEntry,
} from "./mac-access";

const entry = (capability: string, status: string, fix: string | null = null): MacDoctorEntry => ({ capability, status, fix });
const row = (rows: ReturnType<typeof macAccessRows>, id: string) => rows.find((r) => r.id === id)!;

/** A doctor report where everything is granted; tests override only the capability under scrutiny. */
const allGranted = (over: Record<string, string> = {}): MacDoctorEntry[] =>
  Object.keys(MAC_CAPABILITIES).map((c) => entry(c, over[c] ?? "granted"));

describe("parseMacDoctor", () => {
  it("reads the documented shape, carrying each fix string through", () => {
    const parsed = parseMacDoctor('[{"capability":"calendar","status":"notRequested","fix":"Run any `mac calendar` command."}]');
    expect(parsed).toEqual([{ capability: "calendar", status: "notRequested", fix: "Run any `mac calendar` command." }]);
  });

  it("answers null — never [] — for output that is not a capability array (the named mutant: a broken CLI reading as “nothing needs anything”)", () => {
    expect(parseMacDoctor("not json")).toBeNull();
    expect(parseMacDoctor("")).toBeNull();
    expect(parseMacDoctor('{"capability":"calendar"}')).toBeNull();       // object, not array
    expect(parseMacDoctor('[{"capability":"calendar"}]')).toBeNull();      // no status
    expect(parseMacDoctor('[{"status":"granted"}]')).toBeNull();           // no capability
    expect(parseMacDoctor("[null]")).toBeNull();
    // An empty audit IS a valid answer and must survive as one.
    expect(parseMacDoctor("[]")).toEqual([]);
  });

  it("a missing fix is null, not an invented instruction", () => {
    expect(parseMacDoctor('[{"capability":"calendar","status":"granted"}]')).toEqual([{ capability: "calendar", status: "granted", fix: null }]);
  });
});

describe("macAccessRows — state", () => {
  it("keeps mac doctor's five states apart, and quotes its fix verbatim rather than paraphrasing", () => {
    const rows = macAccessRows([entry("calendar", "writeOnly", "Switch Calendar to Full Access."), entry("contacts", "denied", "Enable Realm under Contacts.")]);
    expect(row(rows, "calendar").state).toBe("writeOnly");
    expect(row(rows, "calendar").detail).toBe("Switch Calendar to Full Access.");
    expect(row(rows, "contacts").detail).toBe("Enable Realm under Contacts.");
  });

  it("a status this build has never seen degrades to unknown — not to either claim", () => {
    expect(row(macAccessRows([entry("calendar", "someFutureState")]), "calendar").state).toBe("unknown");
  });

  it("entries: null makes EVERY row unknown (the named mutant: doctor failing to run rendering as all-granted)", () => {
    const rows = macAccessRows(null);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.state === "unknown")).toBe(true);
    expect(grantedCount(rows)).toBe(0);
  });

  it("a capability doctor didn't mention reads unknown, and says so rather than going silent", () => {
    const rows = macAccessRows([entry("calendar", "granted")]);
    expect(row(rows, "automation:Mail").state).toBe("unknown");
    expect(row(rows, "automation:Mail").detail).toMatch(/didn't report on it/);
  });

  it("a capability THIS build doesn't know is still listed — read-only, never dropped", () => {
    const rows = macAccessRows([...allGranted(), entry("photos", "notRequested", "Run any `mac photos` command.")]);
    const extra = row(rows, "photos");
    expect(extra.group).toBe("other");
    expect(extra.canPrompt).toBe(false);
    expect(extra.grantCommand).toBeNull();
    expect(extra.detail).toBe("Run any `mac photos` command.");
    // Known rows keep their table order; the stranger lands after them.
    expect(rows.at(-1)!.id).toBe("photos");
  });
});

describe("macAccessRows — what each row is allowed to offer", () => {
  it("a DENIED row never offers a prompt: denials are sticky, so a Grant button there could not work", () => {
    const denied = row(macAccessRows(allGranted({ "automation:Mail": "denied" })), "automation:Mail");
    expect(denied.canPrompt).toBe(false);
    expect(denied.needsSettings).toBe(true);
  });

  it("a GRANTED row offers neither — nothing left to ask, nothing left to fix", () => {
    const granted = row(macAccessRows(allGranted()), "automation:Mail");
    expect(granted.canPrompt).toBe(false);
    expect(granted.needsSettings).toBe(false);
  });

  it("notRequested and unknown DO offer the prompt — this is the whole point of the page", () => {
    for (const status of ["notRequested", "unknown"]) {
      const r = row(macAccessRows(allGranted({ calendar: status })), "calendar");
      expect(r.canPrompt).toBe(true);
      expect(r.needsSettings).toBe(false);
    }
  });

  it("writeOnly offers BOTH — the re-prompt may not come, so System Settings is named too (the named mutant: writeOnly folded into granted)", () => {
    const wo = row(macAccessRows(allGranted({ calendar: "writeOnly" })), "calendar");
    expect(wo.state).toBe("writeOnly");
    expect(wo.canPrompt).toBe(true);
    expect(wo.needsSettings).toBe(true);
    expect(grantedCount(macAccessRows(allGranted({ calendar: "writeOnly" })))).toBe(Object.keys(MAC_CAPABILITIES).length - 1);
  });

  it("Full Disk Access can never be prompted — macOS has no dialog for it — so it is Settings-only unless already granted", () => {
    const fda = row(macAccessRows(allGranted({ fullDiskAccess: "denied" })), "fullDiskAccess");
    expect(fda.grantCommand).toBeNull();
    expect(fda.canPrompt).toBe(false);
    expect(fda.needsSettings).toBe(true);
    // Granted, it stops nagging.
    expect(row(macAccessRows(allGranted()), "fullDiskAccess").needsSettings).toBe(false);
    // Even "notRequested" cannot conjure a prompt that does not exist.
    expect(row(macAccessRows(allGranted({ fullDiskAccess: "notRequested" })), "fullDiskAccess").canPrompt).toBe(false);
  });

  it("every automation row warns that raising its prompt opens the app; the EventKit rows don't, because they don't", () => {
    const rows = macAccessRows(allGranted());
    expect(row(rows, "automation:Music").launchesApp).toBe(true);
    expect(row(rows, "calendar").launchesApp).toBe(false);
    expect(row(rows, "fullDiskAccess").launchesApp).toBe(false);
  });
});

describe("grantPlan / settingsOnlyRows", () => {
  it("attempts exactly the promptable rows — skipping granted, denied, and the prompt-less Full Disk row", () => {
    const rows = macAccessRows(allGranted({ calendar: "notRequested", reminders: "denied", "automation:Mail": "notRequested", fullDiskAccess: "denied" }));
    expect(grantPlan(rows)).toEqual(["calendar", "automation:Mail"]);
  });

  it("names what a full run will NOT have fixed — so a short run can't read as full coverage", () => {
    const rows = macAccessRows(allGranted({ reminders: "denied", fullDiskAccess: "denied" }));
    expect(settingsOnlyRows(rows).map((r) => r.id)).toEqual(["reminders", "fullDiskAccess"]);
  });

  it("everything granted means nothing to attempt and nothing left to hand-fix", () => {
    const rows = macAccessRows(allGranted());
    expect(grantPlan(rows)).toEqual([]);
    expect(settingsOnlyRows(rows)).toEqual([]);
  });
});

describe("the grant commands themselves", () => {
  it("every prompt-raising command only LISTS — the user didn't ask to send mail to find out whether Realm may", () => {
    const mutating = /^(add|send|delete|edit|complete|set-|new|trash|play|pause|run|export|append|mark-read|archive|eject|open|reveal)/;
    for (const [id, spec] of Object.entries(MAC_CAPABILITIES)) {
      if (!spec.argv) continue;
      const verb = spec.argv[1]!;
      expect(verb, `${id} runs a mutating verb`).not.toMatch(mutating);
      // `--json` keeps the output parseable and, per the CLI's contract, prints even under --quiet.
      expect(spec.argv).toContain("--json");
    }
  });

  it("argv comes from the closed table, so the renderer can name a row but never a command", () => {
    expect(macGrantArgv("automation:Mail")).toEqual(["mail", "accounts", "--json"]);
    expect(macGrantArgv("fullDiskAccess")).toBeNull();
    expect(isMacCapabilityId("automation:Mail")).toBe(true);
    expect(isMacCapabilityId("mail; rm -rf /")).toBe(false);
    expect(isMacCapabilityId("toString")).toBe(false);   // Object.prototype, not the table
    expect(isMacCapabilityId(null)).toBe(false);
  });

  it("every capability deep-links a real privacy pane, and an unrecognised id falls back to the Privacy root instead of anywhere else", () => {
    for (const id of Object.keys(MAC_CAPABILITIES)) {
      expect(macSettingsUrl(id)).toMatch(/^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy/);
    }
    expect(macSettingsUrl("https://evil.example")).toBe(MAC_SETTINGS_URLS.privacy);
    expect(macSettingsUrl("automation:Mail")).toBe(MAC_SETTINGS_URLS.automation);
    expect(macSettingsUrl("fullDiskAccess")).toBe(MAC_SETTINGS_URLS.fullDisk);
    expect(macSettingsUrl("calendar")).toBe(MAC_SETTINGS_URLS.calendars);
  });
});

describe("resolveMacBin", () => {
  const exists = (...found: string[]) => (p: string) => found.includes(p);

  it("prefers PATH order, then falls back to the Homebrew/local dirs a Finder launch would miss", () => {
    expect(resolveMacBin({ pathEnv: "/a:/b", exists: exists("/b/mac") })).toBe("/b/mac");
    expect(resolveMacBin({ pathEnv: "/a:/b", exists: exists("/a/mac", "/b/mac") })).toBe("/a/mac");
    // launchd's minimal PATH: nothing on it, but Homebrew has the binary.
    expect(resolveMacBin({ pathEnv: "/usr/bin:/bin", exists: exists("/opt/homebrew/bin/mac") })).toBe("/opt/homebrew/bin/mac");
    expect(resolveMacBin({ pathEnv: undefined, exists: exists("/usr/local/bin/mac") })).toBe("/usr/local/bin/mac");
  });

  it("answers null when the binary is genuinely absent — never a path it hasn't seen", () => {
    expect(resolveMacBin({ pathEnv: "/a:/b", exists: () => false })).toBeNull();
  });

  it("tolerates trailing slashes and empty PATH segments without probing a malformed path", () => {
    const probed: string[] = [];
    resolveMacBin({ pathEnv: "/a/:", exists: (p) => { probed.push(p); return false; } });
    expect(probed).toContain("/a/mac");
    expect(probed.every((p) => !p.includes("//"))).toBe(true);
  });
});

describe("parseMacVersion / appBundlePath", () => {
  it("takes a bare version and refuses anything else", () => {
    expect(parseMacVersion("0.6.0\n")).toBe("0.6.0");
    expect(parseMacVersion("  1.2.3  \nextra\n")).toBe("1.2.3");
    expect(parseMacVersion("mac version unknown")).toBeNull();
    expect(parseMacVersion("")).toBeNull();
  });

  it("resolves the .app the user can actually drag, not the binary buried inside it", () => {
    expect(appBundlePath("/Applications/Realm.app/Contents/MacOS/Realm")).toBe("/Applications/Realm.app");
    // A dev run of the raw Electron binary has no .app component — reveal it rather than nothing.
    expect(appBundlePath("/repo/node_modules/electron/dist/electron")).toBe("/repo/node_modules/electron/dist/electron");
  });
});
