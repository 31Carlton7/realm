import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DICTATION_MACOS } from "@realm/contracts";

const script = readFileSync(join(__dirname, "build-native.mjs"), "utf8");

describe("build-native's minimum macOS", () => {
  it("builds realmvoice for the macOS dictation is offered from, and nothing older", () => {
    expect(script).toContain(`["RealmVoice.swift", "realmvoice", "${DICTATION_MACOS}"]`);
    expect(script).toContain('["-target", `${arch}-apple-macos${macos}`]');
  });
});
