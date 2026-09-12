import { describe, expect, it } from "vitest";
import {
  AGENT_EXECUTABLE_CONFIG,
  AGENT_STATE_DIRS,
  CREDENTIAL_DIRS,
  EXECUTION_SANDBOX_COPY,
  EXECUTION_SANDBOX_DEFAULT_KEY,
  EXECUTION_SANDBOX_DEFAULT_POSTURE,
  EXECUTION_SANDBOX_ERRORS,
  EXECUTION_SANDBOX_ERROR_CODES,
  EXECUTION_SANDBOX_SECTION_COPY,
  ExecutionSandboxPolicySchema,
  ExecutionSandboxPostureSchema,
  ExecutionSandboxPrefsSchema,
  TOOLCHAIN_CACHE_DIRS,
  describeExecutionSandbox,
  executionSandboxSpaceKey,
  parseExecutionSandboxPrefs,
} from "./execution-sandbox";
import { SANDBOX_NOTES } from "./sandbox";

describe("the naming does not collide with the VNC sandbox", () => {
  // The two files are about completely different things and the only thing they share is a word.
  // This is the cheapest possible guard against someone later exporting `SandboxPolicy` from one of
  // them and shadowing the other's meaning at the index.
  it("keeps the VNC module's vocabulary out of this one", () => {
    expect(Object.keys(SANDBOX_NOTES)).toContain("e2b");
    expect(Object.keys(EXECUTION_SANDBOX_COPY).sort()).toEqual(["off", "read-only", "workspace-write"]);
  });

  it("prefixes every stored key so a settings row says which feature it belongs to", () => {
    expect(EXECUTION_SANDBOX_DEFAULT_KEY).toBe("executionSandbox.default");
    expect(executionSandboxSpaceKey("sp_1")).toBe("executionSandbox.space:sp_1");
  });
});

describe("postures", () => {
  it("ships OPT-IN: the posture nobody chose is the one that changes nothing", () => {
    // Deliberate, and documented on the constant: this is the sandbox's first release, a wrong
    // writable-root list reads as Realm breaking somebody's build, and Codex cannot run sandboxed
    // at all yet. Flipping this back to `workspace-write` is a decision with two preconditions,
    // not a tidy-up — so it fails here first, where the reason is written down.
    expect(ExecutionSandboxPostureSchema.parse(EXECUTION_SANDBOX_DEFAULT_POSTURE)).toBe("off");
  });

  it("says out loud, in the shipped copy, why the picker starts on No sandbox", () => {
    // The honesty rule again: a default that protects nothing must not be silent about it.
    expect(EXECUTION_SANDBOX_SECTION_COPY.defaultNote).toMatch(/no sandbox/i);
    // …and the Codex refusal is copy, not a release note — it is the reason a session will not start.
    expect(EXECUTION_SANDBOX_SECTION_COPY.codexNote).toMatch(/Codex/);
    expect(EXECUTION_SANDBOX_SECTION_COPY.codexNote).toMatch(/refuses to start/);
  });

  it("refuses a posture nobody implemented", () => {
    expect(ExecutionSandboxPostureSchema.safeParse("containers-please").success).toBe(false);
  });

  it("gives every posture copy, including the one that means no protection", () => {
    for (const p of ExecutionSandboxPostureSchema.options) {
      expect(EXECUTION_SANDBOX_COPY[p].label.length).toBeGreaterThan(0);
      expect(EXECUTION_SANDBOX_COPY[p].detail.length).toBeGreaterThan(0);
    }
    // The honesty rule, as an assertion: the "off" copy must not read like a milder sandbox.
    expect(EXECUTION_SANDBOX_COPY.off.detail).toMatch(/full account/);
    // And the default posture must not claim to stop exfiltration, because it does not.
    expect(EXECUTION_SANDBOX_COPY["workspace-write"].detail).toMatch(/network stays open/);
  });
});

describe("prefs round-trip through a settings row", () => {
  it("defaults an empty object to the shipped posture with network on", () => {
    expect(ExecutionSandboxPrefsSchema.parse({})).toEqual({ posture: "off", network: true });
  });

  it("reads an absent row as 'not chosen' rather than as a posture", () => {
    expect(parseExecutionSandboxPrefs(null)).toBeNull();
    expect(parseExecutionSandboxPrefs(undefined)).toBeNull();
  });

  it("reads a hand-edited nonsense row as 'not chosen' instead of throwing", () => {
    // A settings row is JSON a user can edit with a text editor. None of these may take the server
    // down, and — the part that matters — none of them may parse as a posture. The caller turns a
    // null into the INHERITED value (a space falls back to the default, the default falls back to
    // the shipped one), which is always a posture somebody wrote down, never one a mangled row
    // happened to look like.
    for (const junk of ["off", 3, [], { posture: "off " }, { posture: null }, { posture: "OFF" }]) {
      expect(parseExecutionSandboxPrefs(junk)).toBeNull();
    }
  });

  it("keeps a valid stored choice exactly", () => {
    expect(parseExecutionSandboxPrefs({ posture: "read-only", network: false }))
      .toEqual({ posture: "read-only", network: false });
  });
});

describe("the policy shape", () => {
  it("defaults every list to empty and network to allowed", () => {
    expect(ExecutionSandboxPolicySchema.parse({ posture: "read-only" })).toEqual({
      posture: "read-only", writableRoots: [], readableRoots: [], readOnlyPaths: [], protectedRoots: [], network: true,
    });
  });

  it("has no posture field it can omit — a policy with no posture is not a policy", () => {
    expect(ExecutionSandboxPolicySchema.safeParse({ writableRoots: ["/a"] }).success).toBe(false);
  });
});

describe("what the lists actually contain", () => {
  it("names the caches the task's toolchains need, and none of them absolute", () => {
    for (const d of TOOLCHAIN_CACHE_DIRS) expect(d.startsWith("/")).toBe(false);
    const joined = TOOLCHAIN_CACHE_DIRS.join(" ");
    for (const needle of [".npm", "pnpm", ".cargo", "pip", "go/pkg/mod"]) expect(joined).toContain(needle);
  });

  it("protects the credential directories that hold a token that works from anywhere", () => {
    for (const d of CREDENTIAL_DIRS) expect(d.startsWith("/")).toBe(false);
    for (const needle of [".ssh", ".aws", ".gnupg", ".config/gh", "Library/Keychains"]) {
      expect(CREDENTIAL_DIRS).toContain(needle);
    }
    // Stated so the omission stays deliberate: ~/.npmrc can hold a registry token and is NOT
    // protected, because npm reads it on every install. If someone adds it, this fails and they
    // have to update the comment in the contract that says it is a known hole.
    expect(CREDENTIAL_DIRS).not.toContain(".npmrc");
  });

  it("makes the agents' own state directories writable, because otherwise they do not start", () => {
    for (const d of AGENT_STATE_DIRS) expect(d.startsWith("/")).toBe(false);
    for (const needle of [".claude", ".codex", ".cursor"]) expect(AGENT_STATE_DIRS).toContain(needle);
  });

  it("freezes the executable configuration inside those directories", () => {
    // The hole AGENT_STATE_DIRS opens, and the specific part of it that is closed again. Each entry
    // here is a file a toolchain READS every run and can be made to EXECUTE something by.
    for (const f of AGENT_EXECUTABLE_CONFIG) expect(f.startsWith("/")).toBe(false);
    for (const needle of [".claude/settings.json", ".codex/config.toml", ".gitconfig", ".zshrc", "Library/LaunchAgents"]) {
      expect(AGENT_EXECUTABLE_CONFIG).toContain(needle);
    }
    /* The entries that matter are the ones INSIDE a writable directory: freezing a path in a
       directory nothing can write is a rule that says nothing, and an agent state dir with no frozen
       file in it is a hole with nothing clawed back. Both agent dirs Realm spawns by name have one. */
    for (const dir of [".claude", ".codex"]) {
      expect(AGENT_EXECUTABLE_CONFIG.some((f) => f.startsWith(`${dir}/`))).toBe(true);
    }
    // The rest are shell and git configuration, which are outside every writable root by default and
    // only bite when a space folder is `~`. Named here so that stays a deliberate belt-and-braces.
    const outsideAgentDirs = AGENT_EXECUTABLE_CONFIG.filter((f) => !AGENT_STATE_DIRS.some((d) => f.startsWith(`${d}/`)));
    expect(outsideAgentDirs).toEqual([
      ".gitconfig", ".config/git", ".zshrc", ".zprofile", ".zshenv", ".zlogin",
      ".bashrc", ".bash_profile", ".profile", ".config/fish", "Library/LaunchAgents",
    ]);
  });

  it("gives every error word an RPC code", () => {
    for (const e of EXECUTION_SANDBOX_ERRORS) expect(EXECUTION_SANDBOX_ERROR_CODES[e]).toMatch(/^SANDBOX_/);
  });
});

describe("describeExecutionSandbox", () => {
  it("says 'not sandboxed' for off, without hedging", () => {
    const s = describeExecutionSandbox({ posture: "off", writableRoots: [], readableRoots: [], readOnlyPaths: [], protectedRoots: [], network: true });
    expect(s).toBe("Not sandboxed — this session runs with your full account.");
  });

  it("counts the roots and states the network, both ways", () => {
    const base = { posture: "workspace-write" as const, readableRoots: [], readOnlyPaths: [], protectedRoots: ["/Users/x/.ssh"], network: true };
    expect(describeExecutionSandbox({ ...base, writableRoots: ["/a"] }))
      .toBe("Sandboxed: writes 1 allowed root, reads everything except 1 protected paths, network allowed.");
    expect(describeExecutionSandbox({ ...base, writableRoots: ["/a", "/b"], network: false }))
      .toBe("Sandboxed: writes 2 allowed roots, reads everything except 1 protected paths, network blocked.");
  });

  it("does not claim a read allowlist when the policy has none", () => {
    const s = describeExecutionSandbox({ posture: "read-only", writableRoots: ["/t"], readableRoots: [], readOnlyPaths: [], protectedRoots: [], network: false });
    expect(s).toContain("writes nothing but its own temp directory");
    expect(s).not.toContain("allowed roots,"); // the read half must not read as a whitelist
  });
});
