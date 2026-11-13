import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_LOGIN_HINTS } from "@realm/contracts";
import { tempDir } from "@realm/test-utils";
import { createApp, defaultAdapters, type App } from "./app";
import { openDatabase } from "./db/database";
import { dbPath } from "./paths";
import { ProfilesStore } from "./store/profiles";

const FAKE_ACP = fileURLToPath(new URL("../../../packages/adapters/src/acp/fixtures/fake-acp-agent.mjs", import.meta.url));

/** Runs `fn` with REALM_GEMINI_BIN pointing at a `gemini` that answers `--version` and is otherwise the fake ACP agent. */
async function withGeminiStub<T>(fn: () => Promise<T>): Promise<T> {
  const bin = join(tempDir("realm-gemini-"), "gemini");
  writeFileSync(bin, `#!/bin/sh\n[ "$1" = --version ] && echo 0.68.0 && exit 0\nexec "${process.execPath}" "${FAKE_ACP}"\n`, { mode: 0o755 });
  const before = process.env.REALM_GEMINI_BIN;
  process.env.REALM_GEMINI_BIN = bin;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.REALM_GEMINI_BIN;
    else process.env.REALM_GEMINI_BIN = before;
  }
}

describe("defaultAdapters", () => {
  it("registers claude and codex by default", () => {
    const reg = defaultAdapters();
    expect(Object.keys(reg).sort()).toContain("codex");
    expect(reg.codex?.kind).toBe("codex");
  });
  it("only registers the fake agent behind the env flag", () => {
    const before = process.env.REALM_ENABLE_FAKE_AGENT;
    try {
      delete process.env.REALM_ENABLE_FAKE_AGENT;
      expect(defaultAdapters().fake).toBeUndefined();
      process.env.REALM_ENABLE_FAKE_AGENT = "1";
      expect(defaultAdapters().fake).toBeDefined();
    } finally {
      // A failed assertion would otherwise leave the flag set for every later test in this process.
      if (before === undefined) delete process.env.REALM_ENABLE_FAKE_AGENT;
      else process.env.REALM_ENABLE_FAKE_AGENT = before;
    }
  });

  it("registers both ACP agents with their own launch commands", () => {
    const reg = defaultAdapters();
    expect(reg["acp:cursor"]?.kind).toBe("acp:cursor");
    expect(reg["acp:gemini"]?.kind).toBe("acp:gemini");
  });

  it("probes Gemini's model list off session/new, its current model marked as the default", async () => {
    const probe = await withGeminiStub(() => defaultAdapters()["acp:gemini"]!.probe());
    expect(probe.models).toEqual([{ id: "fake-model-1", label: "Fake 1", isDefault: true }, { id: "fake-model-2", label: "Fake 2" }]);
  });

  it("ends a signed-out Gemini session with the same hint the Engines tab shows", async () => {
    const errors = await withGeminiStub(async () => {
      const handle = defaultAdapters()["acp:gemini"]!.start({ cwd: process.cwd(), mcpServers: [], env: { FAKE_ACP_AUTHFAIL: "1" } });
      const out: string[] = [];
      for await (const e of handle.events) if (e.type === "error") out.push(e.payload.message);
      return out;
    });
    expect(errors[0]).toContain(AGENT_LOGIN_HINTS["acp:gemini"]);
  });
});

describe("first-boot profile seeding", () => {
  let apps: App[] = [];
  afterEach(async () => { for (const a of apps) await a.close(); apps = []; });

  it("a fresh home boots with exactly one default Personal profile; a second boot does not add another", async () => {
    const home = tempDir("realm-home-");
    const app1 = await createApp({ home, port: 0 }); apps.push(app1);
    const first = new ProfilesStore(app1.db).list();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ name: "Personal", icon: "user", color: "#6b7280" });
    await app1.close(); apps = [];
    const app2 = await createApp({ home, port: 0 }); apps.push(app2);
    expect(new ProfilesStore(app2.db).list()).toHaveLength(1); // idempotent: seeding only when empty
  });

  it("does not seed when a profile already exists (a lone user-created profile is never joined by Personal)", async () => {
    const home = tempDir("realm-home-");
    const db = openDatabase(dbPath(home));
    new ProfilesStore(db).create({ name: "Work", icon: "briefcase", color: "#123456" });
    db.close();
    const app = await createApp({ home, port: 0 }); apps.push(app);
    expect(new ProfilesStore(app.db).list().map((p) => p.name)).toEqual(["Work"]);
  });
});
