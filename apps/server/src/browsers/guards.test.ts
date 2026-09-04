import { describe, expect, it } from "vitest";
import { fenceUntrusted } from "@realm/contracts";
import { isOAuthConsentUrl } from "./guards";

describe("isOAuthConsentUrl", () => {
  it.each([
    "https://github.com/login/oauth/authorize?client_id=x",
    "https://accounts.google.com/o/oauth2/auth",
    "https://accounts.google.com/o/oauth2/v2/auth",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    "https://appleid.apple.com/auth/authorize",
    "https://www.facebook.com/dialog/oauth",
    "https://dev-x.okta.com/oauth2/v1/authorize",
    "https://tenant.auth0.com/authorize",
    "https://sso.corp.example/protocol/openid-connect/auth",
    "https://anything.example/oauth/authorize",
    // The protocol fingerprint on an unrecognized path: client_id + redirect_uri together.
    "https://idp.example/custom/consent?client_id=abc&redirect_uri=https%3A%2F%2Fapp%2Fcb&response_type=code",
  ])("flags %s", (url) => {
    expect(isOAuthConsentUrl(url)).toBe(true);
  });

  it.each([
    "https://example.com/",
    "https://example.com/blog/oauth-explained",     // path mentions oauth but is not an authorize endpoint
    "https://example.com/authorized",               // not /authorize
    "https://example.com/search?client_id=widget",  // client_id without redirect_uri
    "https://github.com/settings/applications",     // managing OAuth apps ≠ a consent screen
    "not a url",
  ])("does not flag %s", (url) => {
    expect(isOAuthConsentUrl(url)).toBe(false);
  });
});

describe("fenceUntrusted", () => {
  it("labels the content as untrusted page data and wraps it in matching fence markers", () => {
    const out = fenceUntrusted("hello page");
    expect(out).toContain("WEB PAGE CONTENT");
    expect(out).toContain("hello page");
    const open = out.match(/<<<(untrusted-[0-9a-f]{16})/);
    expect(open).not.toBeNull();
    expect(out).toContain(`${open![1]}>>>`);
  });

  it("uses a fresh random fence per call, so page text cannot pre-close a known delimiter", () => {
    const a = fenceUntrusted("x").match(/untrusted-[0-9a-f]{16}/)![0];
    const b = fenceUntrusted("x").match(/untrusted-[0-9a-f]{16}/)![0];
    expect(a).not.toBe(b);
  });
});
