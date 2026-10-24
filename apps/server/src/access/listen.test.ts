import { describe, expect, it } from "vitest";
import { checkListen, classifyAddress, listenFromEnv, listenUrl, parseListenAddress, type ListenConfig } from "./listen";

const at = (host: string, over: Partial<ListenConfig> = {}): ListenConfig => ({ host, port: 7420, tls: null, allowPlaintext: false, ...over });
const tls = { cert: "/c.pem", key: "/k.pem" };

describe("--listen addresses", () => {
  it("reads a port, an IPv4 or bracketed IPv6 address, and localhost", () => {
    expect(parseListenAddress("7420")).toEqual({ host: "127.0.0.1", port: 7420 });
    expect(parseListenAddress("localhost:7420")).toEqual({ host: "127.0.0.1", port: 7420 });
    expect(parseListenAddress("100.101.102.103:9242")).toEqual({ host: "100.101.102.103", port: 9242 });
    expect(parseListenAddress("[::1]:7420")).toEqual({ host: "::1", port: 7420 });
    expect(parseListenAddress("0.0.0.0:443")).toEqual({ host: "0.0.0.0", port: 443 });
  });

  it("refuses a name, a bare IPv6 address, and a port out of range", () => {
    expect(() => parseListenAddress("myserver.example.com:7420")).toThrow(/an address, not a name/);
    expect(() => parseListenAddress("::1:7420")).toThrow(/ADDRESS:PORT/);
    expect(() => parseListenAddress("127.0.0.1:70000")).toThrow(/port/);
    expect(() => parseListenAddress("127.0.0.1:")).toThrow(/port/);
    expect(() => parseListenAddress("127.0.0.1")).toThrow(/ADDRESS:PORT/);
  });

  it("knows loopback, private, every-address and public", () => {
    expect(classifyAddress("127.0.0.1")).toBe("loopback");
    expect(classifyAddress("127.8.9.10")).toBe("loopback");
    expect(classifyAddress("::1")).toBe("loopback");
    expect(classifyAddress("::ffff:127.0.0.1")).toBe("loopback");
    for (const h of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.20", "100.101.102.103", "169.254.1.1", "fd7a:115c:a1e0::1", "fe80::1"]) {
      expect(classifyAddress(h), h).toBe("private");
    }
    expect(classifyAddress("0.0.0.0")).toBe("wildcard");
    expect(classifyAddress("::")).toBe("wildcard");
    for (const h of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:db8::1", "::ffff:8.8.8.8"]) expect(classifyAddress(h), h).toBe("public");
  });
});

describe("the listening rules", () => {
  it("allow plain ws:// on loopback, where a tunnel or Tailscale Serve encrypts", () => {
    expect(checkListen(at("127.0.0.1"))).toBe("loopback");
    expect(checkListen(at("::1"))).toBe("loopback");
  });

  it("refuse every address, or a public one, without TLS — and no flag turns that off", () => {
    expect(() => checkListen(at("0.0.0.0"))).toThrow(/refusing to listen on every address \(0\.0\.0\.0\) without TLS/);
    expect(() => checkListen(at("::"))).toThrow(/every address/);
    expect(() => checkListen(at("0.0.0.0", { allowPlaintext: true }))).toThrow(/without TLS/);
    expect(() => checkListen(at("8.8.8.8", { allowPlaintext: true }))).toThrow(/public address 8\.8\.8\.8 without TLS/);
    try { checkListen(at("0.0.0.0")); } catch (e) { expect((e as { code: string }).code).toBe("LISTEN_REFUSED"); }
  });

  it("refuse a private address without TLS unless the owner vouches for the network", () => {
    expect(() => checkListen(at("192.168.1.20"))).toThrow(/--allow-plaintext/);
    expect(checkListen(at("192.168.1.20", { allowPlaintext: true }))).toBe("private");
    expect(checkListen(at("100.101.102.103", { allowPlaintext: true }))).toBe("private");
  });

  it("allow any address with TLS", () => {
    expect(checkListen(at("0.0.0.0", { tls }))).toBe("wildcard");
    expect(checkListen(at("8.8.8.8", { tls }))).toBe("public");
    expect(checkListen(at("192.168.1.20", { tls }))).toBe("private");
  });
});

describe("the listener main.ts is handed", () => {
  it("is none without REALM_LISTEN, and reads TLS and the plaintext switch beside it", () => {
    expect(listenFromEnv({})).toBeNull();
    expect(listenFromEnv({ REALM_LISTEN: "0.0.0.0:9242", REALM_TLS_CERT: "/c.pem", REALM_TLS_KEY: "/k.pem" }))
      .toEqual({ host: "0.0.0.0", port: 9242, tls, allowPlaintext: false });
    expect(listenFromEnv({ REALM_LISTEN: "100.64.0.9:9242", REALM_ALLOW_PLAINTEXT: "1" }))
      .toEqual({ host: "100.64.0.9", port: 9242, tls: null, allowPlaintext: true });
    expect(() => listenFromEnv({ REALM_LISTEN: "0.0.0.0:9242", REALM_TLS_CERT: "/c.pem" })).toThrow(/both a certificate/);
  });

  it("names the URL a client dials", () => {
    expect(listenUrl({ host: "0.0.0.0", tls }, 9242)).toBe("wss://0.0.0.0:9242");
    expect(listenUrl({ host: "::1", tls: null }, 7420)).toBe("ws://[::1]:7420");
  });
});
