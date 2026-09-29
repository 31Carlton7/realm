import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

  /* The site's capture harness brings its own turn in a file. Its trigger has to beat the built-in
     fixture that answers the same word — otherwise the photographed transcript is the fixture's. */
  it("plays turns brought in REALM_FAKE_AGENT_SCRIPT ahead of its own", async () => {
    const saved = { enable: process.env.REALM_ENABLE_FAKE_AGENT, script: process.env.REALM_FAKE_AGENT_SCRIPT };
    const file = join(tempDir("realm-fake-script-"), "turns.json");
    writeFileSync(file, JSON.stringify([{ on: "plan", emit: [{ kind: "text", text: "Brought from the file." }] }]));
    try {
      process.env.REALM_ENABLE_FAKE_AGENT = "1";
      process.env.REALM_FAKE_AGENT_SCRIPT = file;
      const handle = defaultAdapters().fake!.start({ cwd: "/tmp", mcpServers: [] });
      const texts: string[] = [];
      let ran = false;
      const collect = (async () => {
        for await (const e of handle.events) {
          if (e.type === "assistant_text") texts.push(e.payload.text);
          if (e.type === "status" && e.payload.status === "running") ran = true;
          if (e.type === "status" && e.payload.status === "idle" && ran) break;
        }
      })();
      void handle.send({ text: "make a plan", attachments: [] });
      await collect;
      expect(texts).toEqual(["Brought from the file."]);
      await handle.dispose();
    } finally {
      for (const [key, value] of [["REALM_ENABLE_FAKE_AGENT", saved.enable], ["REALM_FAKE_AGENT_SCRIPT", saved.script]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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
