import { afterEach, describe, expect, it } from "vitest";
import { newSecretKey, seal } from "@realm/contracts/src/secret-box";
import { remoteSecretBox } from "./secret";

afterEach(() => { remoteSecretBox.setKey(null); });

describe("remoteSecretBox", () => {
  it("with no key seals nothing — a private key is never handed back to be written in the clear", () => {
    expect(remoteSecretBox.available).toBe(false);
    expect(remoteSecretBox.seal("the Mac's private keys")).toBeNull();
  });

  it("seals and opens with the key Electron main hands over, and nothing it did not seal", () => {
    const key = newSecretKey();
    remoteSecretBox.setKey(key.toString("base64"));
    const blob = remoteSecretBox.seal("the Mac's private keys")!;
    expect(blob).not.toContain("private");
    expect(remoteSecretBox.open(blob)).toBe("the Mac's private keys");
    // Another domain's blob under the very same key does not open: the domain is bound in as AAD.
    expect(remoteSecretBox.open(seal(key, "machine", "a VNC password"))).toBeNull();
    // Nor does a value that was never sealed — this domain has never written one.
    expect(remoteSecretBox.open('{"v":1,"dh":"x","sign":"y"}')).toBeNull();
    // A different key opens nothing it sealed.
    remoteSecretBox.setKey(newSecretKey().toString("base64"));
    expect(remoteSecretBox.open(blob)).toBeNull();
  });

  it("refuses a malformed key rather than half-configuring", () => {
    remoteSecretBox.setKey(Buffer.alloc(16).toString("base64"));
    expect(remoteSecretBox.available).toBe(false);
    remoteSecretBox.setKey(null);
    expect(remoteSecretBox.available).toBe(false);
  });
});
