import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("rendered evidence gate", () => {
  it.each([undefined, { head: "stale", observer: "fixture" }])("blocks missing or stale evidence: %s", input => {
    const dir = mkdtempSync(join(tmpdir(), "RealmEvidence"));
    try {
      const path = join(dir, "receipt.json");
      if (input) writeFileSync(path, JSON.stringify(input));
      const result = spawnSync(process.execPath, ["scripts/validate-sidebar.mjs", "visual"], {
        encoding: "utf8", env: { ...process.env, REALM_SIDEBAR_VISUAL_EVIDENCE: path },
      });
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).status).toBe("blocked");
    } finally { rmSync(dir, { recursive: true }); }
  });
});
