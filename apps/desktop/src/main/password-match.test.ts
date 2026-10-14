import { describe, expect, it } from "vitest";
import type { BrowserCredential } from "@realm/contracts";
import { credentialSiteMatch, credentialsForPage } from "./password-match";

describe("credentialSiteMatch", () => {
  it("is exact for the same origin, however it is spelled", () => {
    expect(credentialSiteMatch("https://Example.com:443/login", "https://example.com")).toBe("exact");
  });

  it("offers a sibling or parent host of the same registrable domain", () => {
    expect(credentialSiteMatch("https://www.example.com", "https://login.example.com")).toBe("same-site");
    expect(credentialSiteMatch("https://example.com", "https://accounts.example.com")).toBe("same-site");
    expect(credentialSiteMatch("https://www.bbc.co.uk", "https://account.bbc.co.uk")).toBe("same-site");
  });

  it("keeps two sites on one public suffix apart, private suffixes included", () => {
    // THE MUTANT: matching on the last two labels makes these one site.
    expect(credentialSiteMatch("https://alice.github.io", "https://bob.github.io")).toBeNull();
    expect(credentialSiteMatch("https://a.myshopify.com", "https://b.myshopify.com")).toBeNull();
    expect(credentialSiteMatch("https://example.co.uk", "https://other.co.uk")).toBeNull();
  });

  it("never offers a lookalike", () => {
    expect(credentialSiteMatch("https://example.com", "https://example.com.evil.net")).toBeNull();
    expect(credentialSiteMatch("https://example.com", "https://notexample.com")).toBeNull();
  });

  it("never offers an https password on http, and does offer an http one on https", () => {
    expect(credentialSiteMatch("https://example.com", "http://example.com")).toBeNull();
    expect(credentialSiteMatch("https://www.example.com", "http://login.example.com")).toBeNull();
    expect(credentialSiteMatch("http://example.com", "https://example.com")).toBe("same-site");
  });

  it("keeps ports apart, and IPs and localhost to themselves", () => {
    expect(credentialSiteMatch("https://example.com:8443", "https://example.com")).toBeNull();
    expect(credentialSiteMatch("http://example.com:8080", "https://example.com")).toBeNull();
    expect(credentialSiteMatch("http://127.0.0.1:5000", "http://127.0.0.1:5001")).toBeNull();
    expect(credentialSiteMatch("http://127.0.0.1:5000", "http://127.0.0.1:5000")).toBe("exact");
    expect(credentialSiteMatch("http://localhost:3000", "http://app.localhost:3000")).toBeNull();
  });

  it("matches nothing that is not an http(s) origin", () => {
    expect(credentialSiteMatch("https://example.com", "about:blank")).toBeNull();
    expect(credentialSiteMatch("file:///x", "file:///x")).toBeNull();
  });
});

describe("credentialsForPage", () => {
  const row = (id: string, origin: string, username: string): BrowserCredential =>
    ({ id, origin, username, label: "", createdAt: 0, generated: false });

  it("lists exact matches first, then the site, and drops the rest", () => {
    const rows = [
      row("a", "https://www.example.com", "ann"),
      row("b", "https://login.example.com", "zed"),
      row("c", "https://other.org", "bob"),
      row("d", "https://login.example.com", "amy"),
    ];
    const out = credentialsForPage(rows, "https://login.example.com");
    expect(out.map((r) => [r.id, r.match])).toEqual([["d", "exact"], ["b", "exact"], ["a", "same-site"]]);
  });
});
