// @vitest-environment node
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "@realm/test-utils";
import type { DaemonState } from "@realm/contracts";
import { appTokenSha256, liveAppTokenFile, mintAppToken, sealAppToken, sealedTokenPath, unsealAppToken } from "./app-token";
import { ensureDaemon, followDaemon, type Probe } from "./daemon";

vi.mock("electron", () => ({ app: { isPackaged: false, getAppPath: () => "/nowhere" } }));

/** safeStorage as the store sees it: reversible, and never the plaintext on disk. */
const sealer = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s: string) => Buffer.from(`sealed:${Buffer.from(s).toString("hex")}`),
  decryptString: (b: Buffer) => {
    const text = b.toString();
    if (!text.startsWith("sealed:")) throw new Error("not ours");
    return Buffer.from(text.slice("sealed:".length), "hex").toString();
  },
});

const scratch = () => tempDir("realm-app-token-");

const state = (over: Partial<DaemonState> = {}): DaemonState => ({
  version: 1, pid: 4242, bootId: "boot-a", port: 8790, token: "cli-token", home: "/tmp/realm",
  protocol: 1, bundleId: "100:200", entry: "/x/main.js", startedAt: 1, state: "running", ...over,
});

describe("the sealed copy of the app's token", () => {
  it("is sealed by safeStorage, at 0600, and never holds the token in the clear", () => {
    const home = scratch();
    const token = mintAppToken();
    expect(sealAppToken(home, token, sealer())).toBe(true);
    expect(statSync(sealedTokenPath(home)).mode & 0o777).toBe(0o600);
    expect(readFileSync(sealedTokenPath(home), "utf8")).not.toContain(token);
    expect(unsealAppToken(home, state({ appTokenSha256: appTokenSha256(token) }), sealer())).toBe(token);
  });

  it("is only handed back for the server whose state file names its hash", () => {
    const home = scratch();
    const token = mintAppToken();
    sealAppToken(home, token, sealer());
    expect(unsealAppToken(home, state({ appTokenSha256: appTokenSha256(mintAppToken()) }), sealer())).toBeNull();
    // A server from before the split, or one `realm serve` started, names no app token at all.
    expect(unsealAppToken(home, state(), sealer())).toBeNull();
  });

  it("reads as nothing when it cannot be opened, rather than throwing on the launch path", () => {
    const home = scratch();
    const token = mintAppToken();
    const named = state({ appTokenSha256: appTokenSha256(token) });
    expect(unsealAppToken(home, named, sealer())).toBeNull();
    writeFileSync(sealedTokenPath(home), "garbage");
    expect(unsealAppToken(home, named, sealer())).toBeNull();
    sealAppToken(home, token, sealer());
    expect(unsealAppToken(home, named, sealer(false))).toBeNull();
    // No Keychain, no sealed copy: a reattach then replaces the server instead.
    const bare = scratch();
    expect(sealAppToken(bare, token, sealer(false))).toBe(false);
    expect(() => statSync(sealedTokenPath(bare))).toThrow();
  });

  it("is Electron's safeStorage in main, which keeps its key in the file-based login Keychain", () => {
    // The lock-screen case: a data-protection Keychain item cannot be read while the screen is locked,
    // and an update relaunches Realm at night. safeStorage's key is a login-Keychain item, so this
    // store must go through it and never through a Keychain call of its own.
    const main = readFileSync(join(__dirname, "index.ts"), "utf8");
    expect(main).toMatch(/unsealAppToken\([^)]*safeStorage\)/);
    expect(main).toMatch(/sealAppToken\([^)]*safeStorage\)/);
    const store = readFileSync(join(__dirname, "app-token.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(store).toContain("safe.encryptString(token)");
    expect(store).not.toMatch(/kSecUseDataProtectionKeychain|SecItem|keychain-passwords|execFile|spawn/);
  });
});

describe("the live checks' copy", () => {
  it("is written only by an unpackaged build a live check asked for it", () => {
    expect(liveAppTokenFile({ packaged: false, env: "1", home: "/h" })).toBe("/h/live-app-token");
    expect(liveAppTokenFile({ packaged: true, env: "1", home: "/h" })).toBeNull();
    expect(liveAppTokenFile({ packaged: false, env: undefined, home: "/h" })).toBeNull();
    expect(liveAppTokenFile({ packaged: false, env: "0", home: "/h" })).toBeNull();
  });
});

describe("reattaching to a running server", () => {
  const deps = (file: DaemonState | null, own: (s: DaemonState) => string | null) => {
    let current = file;
    const replaced: number[] = [];
    let spawns = 0;
    return {
      replaced, spawns: () => spawns,
      deps: {
        home: "/tmp/realm", ourBundleId: "100:200",
        readState: () => current,
        probe: async (): Promise<Probe> => (current ? { bootId: current.bootId, protocol: 1 } : null),
        spawn: () => { spawns++; current = state({ pid: 5151, bootId: "boot-b", appTokenSha256: appTokenSha256("ours") }); },
        ownToken: own,
        onHandoff: async () => ({ kind: "replaced" as const }),
        replace: async (s: DaemonState) => { replaced.push(s.pid); current = null; },
        pidAlive: () => true, now: () => 0, sleep: async () => {},
      },
    };
  };

  it("drives the server with the token from the sealed copy, never the one in daemon.json", async () => {
    const w = deps(state({ appTokenSha256: appTokenSha256("sealed-app-token") }), () => "sealed-app-token");
    const handle = await ensureDaemon(w.deps);
    expect(handle).toMatchObject({ adopted: true, token: "sealed-app-token" });
    expect(w.spawns()).toBe(0);
  });

  it("replaces a server it holds no token for, instead of driving it with the CLI's", async () => {
    const w = deps(state(), (s) => (s.pid === 5151 ? "ours" : null));
    const handle = await ensureDaemon(w.deps);
    expect(w.replaced).toEqual([4242]);
    expect(w.spawns()).toBe(1);
    expect(handle.token).toBe("ours");
    expect(handle.token).not.toBe("cli-token");
  });

  it("follows a respawned server to its port and keeps the app's own token", () => {
    const known = { port: 8790, token: "ours" };
    expect(followDaemon(known, state({ pid: 5151, port: 61_234, bootId: "boot-b", appTokenSha256: appTokenSha256("ours") }), () => true))
      .toEqual({ port: 61_234, token: "ours" });
    // One that somebody else started holds a different app token: dialing it with ours would fail.
    expect(followDaemon(known, state({ pid: 5151, port: 61_234, bootId: "boot-b", appTokenSha256: appTokenSha256("theirs") }), () => true)).toBe(known);
  });
});
