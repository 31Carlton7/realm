import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { parseCodexModelPage, probeCodex } from "./probe";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

describe("probeCodex", () => {
  it("reports unavailable with a reason when the binary is missing", async () => {
    const r = await probeCodex("/definitely/not/a/binary");
    expect(r.available).toBe(false);
    expect(r.version).toBeNull();
    expect(r.reason).toBeTruthy();
  });

  it("reports unavailable when the binary exists but --version itself fails", async () => {
    // Distinguishes "missing binary" (ENOENT) from "present but broken" — both must land on available:false.
    const r = await probeCodex(FAKE_CODEX, ["--not-a-real-flag"]);
    expect(r.available).toBe(false);
    expect(r.version).toBeNull();
    expect(r.loggedIn).toBeNull();
    expect(r.reason).toBeTruthy();
  });

  it("reports the version and a login verdict when the binary runs", async () => {
    // A stub that answers both `--version` and `login status`.
    const stub = process.execPath;
    const r = await probeCodex(stub, ["-e", "console.log('codex-cli 9.9.9')"]);
    expect(r.available).toBe(true);
    expect(r.version).toBe("codex-cli 9.9.9");
  });

  it("reports loggedIn: true when login status succeeds", async () => {
    const r = await probeCodex(FAKE_CODEX, ["--version"]);
    expect(r).toMatchObject({ available: true, version: "codex-cli 1.2.3", loggedIn: true, reason: null });
  });

  it("coerces an empty --version output to a null version, not an empty string", async () => {
    const prev = process.env.FAKE_CODEX_EMPTY_VERSION;
    process.env.FAKE_CODEX_EMPTY_VERSION = "1";
    try {
      const r = await probeCodex(FAKE_CODEX, ["--version"]);
      expect(r.available).toBe(true);
      expect(r.version).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.FAKE_CODEX_EMPTY_VERSION;
      else process.env.FAKE_CODEX_EMPTY_VERSION = prev;
    }
  });

  it("reports loggedIn: false only when login status says it's actually logged out", async () => {
    const prev = process.env.FAKE_CODEX_LOGIN;
    process.env.FAKE_CODEX_LOGIN = "logged-out";
    try {
      const r = await probeCodex(FAKE_CODEX, ["--version"]);
      expect(r.available).toBe(true);
      expect(r.loggedIn).toBe(false);
      expect(r.reason).toBe("not logged in — run `codex login`");
    } finally {
      if (prev === undefined) delete process.env.FAKE_CODEX_LOGIN;
      else process.env.FAKE_CODEX_LOGIN = prev;
    }
  });

  it("does not report loggedIn: false when login status fails for an unrelated reason", async () => {
    // Mirrors a real, reproduced case: a malformed config.toml makes `codex login status` fail with a
    // config-loading error (not "Not logged in") while `--version` still succeeds. Telling an already-logged-in
    // user to re-run `codex login` here would be wrong advice, so this must land on loggedIn: null, not false.
    const prev = process.env.FAKE_CODEX_LOGIN;
    process.env.FAKE_CODEX_LOGIN = "other-error";
    try {
      const r = await probeCodex(FAKE_CODEX, ["--version"]);
      expect(r.available).toBe(true);
      expect(r.loggedIn).toBeNull();
      expect(r.reason).not.toBe("not logged in — run `codex login`");
      expect(r.reason).toMatch(/could not determine login status/);
    } finally {
      if (prev === undefined) delete process.env.FAKE_CODEX_LOGIN;
      else process.env.FAKE_CODEX_LOGIN = prev;
    }
  });
});

describe("parseCodexModelPage", () => {
  // Shape captured live from codex-cli 0.146.0's `model/list` answer.
  const live = { data: [{ id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", hidden: false, isDefault: true }], nextCursor: null };

  it("maps id and displayName from the live response shape", () => {
    expect(parseCodexModelPage(live)).toEqual({ models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }], nextCursor: null });
  });

  it("skips malformed rows rather than inventing models from them", () => {
    const page = { data: [null, 42, "gpt", { displayName: "No id" }, { id: "", displayName: "Blank id" }, { id: "  ", displayName: "Whitespace id" }, { id: "ok-model", displayName: "OK" }, { id: 7, displayName: "Numeric id" }] };
    expect(parseCodexModelPage(page).models).toEqual([{ id: "ok-model", label: "OK" }]);
  });

  it("drops only an explicit hidden:true, and falls back to the id when displayName is unusable", () => {
    const page = { data: [{ id: "shown" }, { id: "shown-2", displayName: "  " }, { id: "secret", displayName: "Secret", hidden: true }, { id: "odd", displayName: "Odd", hidden: "yes" }] };
    expect(parseCodexModelPage(page).models).toEqual([{ id: "shown", label: "shown" }, { id: "shown-2", label: "shown-2" }, { id: "odd", label: "Odd" }]);
  });

  it("yields nothing (never a throw) for a page that is not a page at all", () => {
    for (const junk of [null, undefined, "x", 3, [], { data: "nope" }]) {
      expect(parseCodexModelPage(junk)).toEqual({ models: [], nextCursor: null });
    }
  });

  it("surfaces a real nextCursor and normalizes absent or blank ones to null", () => {
    expect(parseCodexModelPage({ data: [], nextCursor: "abc" }).nextCursor).toBe("abc");
    expect(parseCodexModelPage({ data: [], nextCursor: "" }).nextCursor).toBeNull();
    expect(parseCodexModelPage({ data: [] }).nextCursor).toBeNull();
    expect(parseCodexModelPage({ data: [], nextCursor: 9 }).nextCursor).toBeNull();
  });
});
