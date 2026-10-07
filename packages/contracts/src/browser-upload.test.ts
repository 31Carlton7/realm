import { describe, expect, it } from "vitest";
import { acceptsUpload, formatUploadSize, isUnderRoot, uploadPathRefusal } from "./browser-upload";

describe("uploadPathRefusal", () => {
  it("refuses an ssh key and names the path", () => {
    const r = uploadPathRefusal("/Users/me/.ssh/id_rsa");
    expect(r).toContain("/Users/me/.ssh/id_rsa");
    expect(r).toContain(".ssh/");
  });

  it("refuses every secret directory as a path segment", () => {
    for (const p of [
      "/Users/me/.aws/credentials",
      "/Users/me/.gnupg/secring.gpg",
      "/Users/me/Library/Keychains/login.keychain-db",
      "/Users/me/.kube/config",
      "/Users/me/.docker/config.json",
      "/Users/me/.config/gcloud/application_default_credentials.json",
    ]) {
      expect(uploadPathRefusal(p), p).not.toBeNull();
    }
  });

  it("refuses by suffix wherever the file sits", () => {
    for (const p of [
      "/Users/me/Desktop/cert.pem",
      "/Users/me/Desktop/deploy.key",
      "/Users/me/Desktop/apple.p12",
      "/Users/me/Desktop/vault.kdbx",
    ]) {
      expect(uploadPathRefusal(p), p).not.toBeNull();
    }
  });

  it("refuses .env and its variants", () => {
    expect(uploadPathRefusal("/w/.env")).not.toBeNull();
    expect(uploadPathRefusal("/w/.env.production")).not.toBeNull();
    expect(uploadPathRefusal("/w/.netrc")).not.toBeNull();
  });

  it("refuses a key copied out of its directory, by name", () => {
    expect(uploadPathRefusal("/Users/me/Desktop/id_ed25519")).not.toBeNull();
  });

  it("lets ordinary files through, including ones whose names merely mention a secret", () => {
    for (const p of [
      "/Users/me/Realm/space/hero.png",
      "/Users/me/Realm/space/ssh-notes.md",
      "/Users/me/Realm/space/environment.md",
      "/Users/me/Realm/space/demo.mp4",
      "/Users/me/Realm/space/keychain-setup.txt",
    ]) {
      expect(uploadPathRefusal(p), p).toBeNull();
    }
  });

  it("is case-insensitive about the directory and the suffix", () => {
    expect(uploadPathRefusal("/Users/me/.SSH/id_rsa")).not.toBeNull();
    expect(uploadPathRefusal("/Users/me/Desktop/CERT.PEM")).not.toBeNull();
  });
});

describe("isUnderRoot", () => {
  it("accepts the root itself and anything beneath it", () => {
    expect(isUnderRoot("/Users/me/space", "/Users/me/space")).toBe(true);
    expect(isUnderRoot("/Users/me/space", "/Users/me/space/a/b.png")).toBe(true);
  });

  it("rejects a sibling whose name merely starts with the root", () => {
    expect(isUnderRoot("/Users/me/space", "/Users/me/space-secrets/a.png")).toBe(false);
  });

  it("rejects anything outside", () => {
    expect(isUnderRoot("/Users/me/space", "/Users/me/Documents/a.png")).toBe(false);
    expect(isUnderRoot("/Users/me/space", "/etc/passwd")).toBe(false);
  });

  it("tolerates a trailing slash on either side", () => {
    expect(isUnderRoot("/Users/me/space/", "/Users/me/space/a.png")).toBe(true);
    expect(isUnderRoot("/Users/me/space", "/Users/me/space/")).toBe(true);
  });
});

describe("acceptsUpload", () => {
  it("accepts everything when the attribute is absent or empty", () => {
    expect(acceptsUpload(null, "a.mov", "video/quicktime")).toBe(true);
    expect(acceptsUpload("  ", "a.mov", "video/quicktime")).toBe(true);
  });

  it("matches an extension entry", () => {
    expect(acceptsUpload(".png,.jpg", "hero.PNG", "image/png")).toBe(true);
    expect(acceptsUpload(".png,.jpg", "demo.mov", "video/quicktime")).toBe(false);
  });

  it("matches a wildcard mime group", () => {
    expect(acceptsUpload("image/*", "hero.png", "image/png")).toBe(true);
    expect(acceptsUpload("image/*", "demo.mp4", "video/mp4")).toBe(false);
  });

  it("matches an exact mime", () => {
    expect(acceptsUpload("video/mp4", "demo.mp4", "video/mp4")).toBe(true);
    expect(acceptsUpload("video/mp4", "demo.mov", "video/quicktime")).toBe(false);
  });

  it("passes when ANY entry matches", () => {
    expect(acceptsUpload("image/*,video/mp4", "demo.mp4", "video/mp4")).toBe(true);
  });

  it("does not treat an unparseable entry as a free pass", () => {
    expect(acceptsUpload("audio/", "hero.png", "image/png")).toBe(false);
  });
});

describe("formatUploadSize", () => {
  it("reads at a glance at each scale", () => {
    expect(formatUploadSize(512)).toBe("512 B");
    expect(formatUploadSize(900 * 1024)).toBe("900 KB");
    expect(formatUploadSize(1_300_000)).toBe("1.2 MB");
    expect(formatUploadSize(3 * 1024 * 1024 * 1024)).toBe("3.0 GB");
  });
});
