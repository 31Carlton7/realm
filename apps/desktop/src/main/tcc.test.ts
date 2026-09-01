import { describe, expect, it } from "vitest";
import { FULL_DISK_PROBE_PATH, TCC_SETTINGS_URLS, isTccPermissionId, probeTcc, type TccProbeDeps } from "./tcc";

/** A deps fake that answers happily everywhere; tests override the leg under scrutiny. Every probe
 *  is an injected function — nothing in this suite can touch real TCC, so nothing can prompt. */
const deps = (over: Partial<TccProbeDeps> = {}): TccProbeDeps => ({
  screenStatus: () => "granted",
  accessibilityTrusted: () => true,
  openForRead: () => {},
  ...over,
});

const row = (rows: ReturnType<typeof probeTcc>, id: string) => rows.find((r) => r.id === id)!;

describe("probeTcc (Plan 12 W6 — TCC honesty)", () => {
  it("Files & Folders and Automation are ALWAYS unknown — no probe basis exists without prompting (the named mutant: a granted state nobody earned)", () => {
    // Even with every probing leg answering "yes", these two rows must not borrow that answer.
    const rows = probeTcc(deps());
    expect(row(rows, "filesAndFolders").state).toBe("unknown");
    expect(row(rows, "filesAndFolders").detail).toMatch(/Can't be checked until used/);
    expect(row(rows, "automation").state).toBe("unknown");
    expect(row(rows, "automation").detail).toMatch(/Can't be checked until used/);
  });

  it("Screen Recording maps the status read: granted → granted, denied/restricted → denied, not-determined → unknown (never a denial that never happened)", () => {
    expect(row(probeTcc(deps({ screenStatus: () => "granted" })), "screenRecording").state).toBe("granted");
    expect(row(probeTcc(deps({ screenStatus: () => "denied" })), "screenRecording").state).toBe("denied");
    expect(row(probeTcc(deps({ screenStatus: () => "restricted" })), "screenRecording").state).toBe("denied");
    const notAsked = row(probeTcc(deps({ screenStatus: () => "not-determined" })), "screenRecording");
    expect(notAsked.state).toBe("unknown");
    expect(notAsked.detail).toMatch(/Not asked yet/);
    // An unrecognised status (a future Electron) degrades to unknown, not to either claim.
    expect(row(probeTcc(deps({ screenStatus: () => "unknown" })), "screenRecording").state).toBe("unknown");
  });

  it("Accessibility: trusted → granted; untrusted → denied, with the denied-vs-never-asked caveat stated", () => {
    expect(row(probeTcc(deps({ accessibilityTrusted: () => true })), "accessibility").state).toBe("granted");
    const no = row(probeTcc(deps({ accessibilityTrusted: () => false })), "accessibility");
    expect(no.state).toBe("denied");
    expect(no.detail).toMatch(/never asked/);
  });

  it("Full Disk: a successful open of the protected path is granted; EPERM/EACCES is denied; anything else is unknown", () => {
    const opened: string[] = [];
    const ok = probeTcc(deps({ openForRead: (p) => { opened.push(p); } }));
    expect(row(ok, "fullDisk").state).toBe("granted");
    // The probe opened THE protected-but-existing path, not something incidentally readable.
    expect(opened).toEqual([FULL_DISK_PROBE_PATH]);

    const eperm = () => { throw Object.assign(new Error("operation not permitted"), { code: "EPERM" }); };
    expect(row(probeTcc(deps({ openForRead: eperm })), "fullDisk").state).toBe("denied");
    const eacces = () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); };
    expect(row(probeTcc(deps({ openForRead: eacces })), "fullDisk").state).toBe("denied");
    // ENOENT means the basis itself is gone — the row must say "can't check", not guess either way.
    const enoent = () => { throw Object.assign(new Error("no such file"), { code: "ENOENT" }); };
    expect(row(probeTcc(deps({ openForRead: enoent })), "fullDisk").state).toBe("unknown");
  });

  it("a throwing status query degrades that ONE row to unknown; the others keep their own basis", () => {
    const rows = probeTcc(deps({ screenStatus: () => { throw new Error("no api"); } }));
    expect(row(rows, "screenRecording").state).toBe("unknown");
    expect(row(rows, "accessibility").state).toBe("granted");
    expect(row(rows, "fullDisk").state).toBe("granted");
  });

  it("every row has a deep-link target, and only row ids pass the IPC gate — the renderer can never supply a URL", () => {
    for (const r of probeTcc(deps())) {
      expect(isTccPermissionId(r.id)).toBe(true);
      expect(TCC_SETTINGS_URLS[r.id]).toMatch(/^x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_/);
    }
    expect(isTccPermissionId("https://evil.example")).toBe(false);
    expect(isTccPermissionId("")).toBe(false);
    expect(isTccPermissionId(null)).toBe(false);
  });
});
