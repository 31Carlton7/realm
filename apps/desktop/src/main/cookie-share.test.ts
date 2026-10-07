import { describe, expect, it } from "vitest";
import { cookieToSet, siteCookies, siteOf, type CookieLike } from "./cookie-share";

const NOW = 1_800_000_000;
const cookie = (over: Partial<CookieLike> = {}): CookieLike => ({
  name: "session", value: "abc", domain: "app.example.com", hostOnly: true, path: "/", secure: true, httpOnly: true,
  session: false, expirationDate: NOW + 3600, sameSite: "lax", ...over,
});

describe("siteOf", () => {
  it("is the page's host and address — ports do not separate cookies", () => {
    expect(siteOf("http://127.0.0.1:8986/login?next=1")).toEqual({ host: "127.0.0.1", url: "http://127.0.0.1:8986/login?next=1" });
    expect(siteOf("https://app.example.com/inbox")).toEqual({ host: "app.example.com", url: "https://app.example.com/inbox" });
  });

  it("is nothing for a page with no site — a blank tab has no sign-in to share", () => {
    for (const url of ["", "about:blank", "data:text/html,hi", "file:///etc/hosts", "not a url"]) expect(siteOf(url), url).toBeNull();
  });
});

describe("siteCookies", () => {
  it("takes the cookies the page's requests carry and the host's own, once each", () => {
    const parent = cookie({ name: "sso", domain: ".example.com", hostOnly: false });
    const own = cookie();
    const deep = cookie({ name: "pref", path: "/settings" });
    expect(siteCookies([parent, own], [own, deep]).map((c) => c.name)).toEqual(["sso", "session", "pref"]);
  });

  it("keeps two cookies of one name that differ in path or domain — they are different cookies", () => {
    const a = cookie({ path: "/" });
    const b = cookie({ path: "/admin" });
    const c = cookie({ domain: ".example.com", hostOnly: false });
    expect(siteCookies([a], [b, c])).toHaveLength(3);
  });
});

describe("cookieToSet", () => {
  it("writes a host-only cookie with NO domain — naming one would widen it to every subdomain", () => {
    /* THE mutant: always pass the domain. `app.example.com` would become `.app.example.com`, and a
       `__Host-` cookie would be refused by Chromium outright. */
    const d = cookieToSet(cookie({ name: "__Host-id" }), NOW)!;
    expect(d).not.toHaveProperty("domain");
    expect(d.url).toBe("https://app.example.com/");
  });

  it("keeps a domain cookie's domain, so the other profile is signed in across the same subdomains", () => {
    expect(cookieToSet(cookie({ domain: ".example.com", hostOnly: false }), NOW)).toMatchObject({ domain: ".example.com", url: "https://example.com/" });
  });

  it("keeps a session cookie a session cookie, and a persistent one's expiry", () => {
    expect(cookieToSet(cookie({ session: true, expirationDate: undefined }), NOW)).not.toHaveProperty("expirationDate");
    expect(cookieToSet(cookie(), NOW)!.expirationDate).toBe(NOW + 3600);
  });

  it("drops a cookie that has already expired rather than writing one Chromium would delete", () => {
    expect(cookieToSet(cookie({ expirationDate: NOW - 1 }), NOW)).toBeNull();
  });

  it("an insecure cookie is written over http, a secure one over https, each at its own path", () => {
    expect(cookieToSet(cookie({ secure: false, domain: "127.0.0.1", path: "/app" }), NOW)).toMatchObject({ url: "http://127.0.0.1/app", path: "/app", secure: false });
    expect(cookieToSet(cookie({ path: "" }), NOW)!.path).toBe("/");
  });

  it("carries the flags that decide when the cookie is sent: HttpOnly and SameSite", () => {
    expect(cookieToSet(cookie({ httpOnly: true, sameSite: "strict" }), NOW)).toMatchObject({ httpOnly: true, sameSite: "strict", value: "abc", name: "session" });
  });
});
