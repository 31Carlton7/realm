import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { harnessFakeScript } from "./harness-fake-script";

const file = (body: string) => { const p = join(tempDir("realm-fake-script-"), "script.json"); writeFileSync(p, body); return p; };
const entries = '[{ "on": "S3 objective", "turn": 2, "emit": [{ "kind": "idle" }] }]';

describe("harnessFakeScript", () => {
  it("reads the file only for a harness with the scripted agent on", () => {
    // THE mutant drops the flag check: an environment variable could then script a user's agent.
    const p = file(entries);
    expect(harnessFakeScript({ REALM_FAKE_SCRIPT: p })).toEqual([]);
    expect(harnessFakeScript({ REALM_ENABLE_FAKE_AGENT: "1" })).toEqual([]);
    expect(harnessFakeScript({ REALM_ENABLE_FAKE_AGENT: "1", REALM_FAKE_SCRIPT: p })).toEqual([{ on: "S3 objective", turn: 2, emit: [{ kind: "idle" }] }]);
  });

  it("stops the boot on a file that is not a script, rather than running echoes", () => {
    expect(() => harnessFakeScript({ REALM_ENABLE_FAKE_AGENT: "1", REALM_FAKE_SCRIPT: file('{"on":"x"}') })).toThrow(/not a list/);
    expect(() => harnessFakeScript({ REALM_ENABLE_FAKE_AGENT: "1", REALM_FAKE_SCRIPT: file('[{"emit":[]}]') })).toThrow(/not a list/);
    expect(() => harnessFakeScript({ REALM_ENABLE_FAKE_AGENT: "1", REALM_FAKE_SCRIPT: "/nonexistent/realm-script.json" })).toThrow();
  });
});
