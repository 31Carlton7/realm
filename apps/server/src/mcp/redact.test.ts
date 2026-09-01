import { describe, expect, it } from "vitest";
import { credentialValues, redactValues } from "./redact";

describe("credentialValues", () => {
  it("contributes both the whole header value and the bare credential after the scheme", () => {
    // The leak this module exists to close: only the prefixed form was ever collected, so an error
    // quoting the bare token matched nothing.
    expect(credentialValues(["Bearer at_xyz123"])).toEqual(["Bearer at_xyz123", "at_xyz123"]);
  });

  it("leaves a value with no scheme prefix alone", () => {
    expect(credentialValues(["at_xyz123"])).toEqual(["at_xyz123"]);
  });

  it("splits on the FIRST space only, so a scheme-plus-multiword value keeps its remainder intact", () => {
    expect(credentialValues(["Basic dXNlcjpwdw== extra"])).toEqual(["Basic dXNlcjpwdw== extra", "dXNlcjpwdw== extra"]);
  });

  it("adds nothing for a leading space — the whole value already covers it", () => {
    expect(credentialValues([" at_xyz123"])).toEqual([" at_xyz123"]);
  });

  it("skips empty values rather than seeding a match-everything entry", () => {
    expect(credentialValues(["", "Bearer "])).toEqual(["Bearer "]);
  });
});

describe("redactValues", () => {
  it("replaces every occurrence of every value", () => {
    expect(redactValues("token abcd used, abcd again", ["abcd"])).toBe("token [redacted] used, [redacted] again");
  });

  it("ignores values below the length floor, so ordinary words survive", () => {
    // A 3-char value inside a normal sentence would otherwise shred the diagnostic.
    expect(redactValues("the cat sat on the mat", ["cat"])).toBe("the cat sat on the mat");
  });

  it("redacts at exactly the floor", () => {
    expect(redactValues("value abcd here", ["abcd"])).toBe("value [redacted] here");
  });

  it("leaves a message with no credential in it untouched", () => {
    expect(redactValues("upstream returned 503", ["at_xyz123"])).toBe("upstream returned 503");
  });
});
