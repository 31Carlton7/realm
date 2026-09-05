import { describe, it, expect, afterEach } from "vitest";
import { tempDir } from "@realm/test-utils";
import { createApp, defaultAdapters, type App } from "./app";
import { openDatabase } from "./db/database";
import { dbPath } from "./paths";
import { ProfilesStore } from "./store/profiles";

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
