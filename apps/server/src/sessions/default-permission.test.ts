import { describe, expect, it } from "vitest";
import { PERMISSION_MODES } from "@realm/contracts";
import { resolveDefaultPermissionMode } from "./service";

/** The pure half of Plan 12 W6's default-permission seam; the create-time consumption is proven
 *  rpc-level in service.test.ts ("default permission mode for new sessions"). */
describe("resolveDefaultPermissionMode", () => {
  it("resolveDefaultPermissionMode: every real PERMISSION_MODES id passes for a supported agent", () => {
    for (const m of PERMISSION_MODES) expect(resolveDefaultPermissionMode("claude", m.id)).toBe(m.id);
  });

  it("resolveDefaultPermissionMode refuses junk, plan, and unset — all land on \"default\"", () => {
    // "plan" is a mode AXIS, not a permission (PERMISSION_MODES excludes it): a stored "plan" must
    // not start every new session in Plan.
    for (const raw of ["plan", "yolo", "", null, undefined, 7, { id: "bypassPermissions" }]) {
      expect(resolveDefaultPermissionMode("claude", raw)).toBe("default");
    }
  });

  it("an agent Realm has no permission lever on ignores the stored default (per-agent honesty)", () => {
    // AcpAdapter.start() never reads permissionMode; a row claiming bypassPermissions would be a lie.
    expect(resolveDefaultPermissionMode("acp:cursor", "bypassPermissions")).toBe("default");
    expect(resolveDefaultPermissionMode("acp:gemini", "acceptEdits")).toBe("default");
  });
});
