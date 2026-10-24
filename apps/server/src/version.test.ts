import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import tsup from "../tsup.config";
import { appVersion } from "../tsup.config";
import { SERVER_VERSION } from "./app";

describe("the version a server reports", () => {
  it("is baked into the bundle from the desktop app, which is the release", () => {
    const desktop = JSON.parse(readFileSync(new URL("../../desktop/package.json", import.meta.url), "utf8")) as { version: string };
    expect(appVersion).toBe(desktop.version);
    // The mutant: no define, and every packaged server says the source tree's fallback instead of its release.
    expect((tsup as { define?: Record<string, string> }).define).toEqual({ __REALM_VERSION__: JSON.stringify(desktop.version) });
  });

  it("says it is a development tree when nothing baked a release in", () => {
    expect(SERVER_VERSION).toBe("0.0.0-dev");
  });
});
