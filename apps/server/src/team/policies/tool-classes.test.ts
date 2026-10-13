import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "@realm/test-utils";
import { openDatabase } from "../../db/database";
import { ToolClassesStore, overrideFor } from "./tool-classes";

const SRC = fileURLToPath(new URL("../..", import.meta.url));

function home() {
  const db = openDatabase(join(tempDir("realm-tool-classes-"), "realm.db"));
  db.prepare("INSERT INTO profiles (id, name, icon, color, sort_order, created_at, updated_at) VALUES ('P1', 'P', 'x', '#000', 0, 1, 1), ('P2', 'Q', 'x', '#000', 1, 1, 1)").run();
  const put = db.prepare("INSERT INTO tool_classes (profile_id, connector, tool, class, verb, seal, set_at) VALUES (?, ?, ?, ?, ?, ?, 1)");
  put.run("P1", "mcp:CRM", "update_deal", "reversible-external", "update", null);
  put.run("P1", "mcp:CRM", "*", "irreversible-external", null, null);
  put.run("P1", "mcp:CRM", "sync", "read", null, "a-seal-nothing-checks");
  put.run("P1", "mcp:CRM", "odd", "risky", null, null);
  put.run("P2", "mcp:CRM", "update_deal", "read", null, null);
  return db;
}

describe("ToolClassesStore", () => {
  it("reads one profile's rows, skips a class this build does not know, and confirms no seal", () => {
    const overrides = new ToolClassesStore(home()).forProfile("P1");
    expect([...overrides.keys()].sort()).toEqual(["mcp:CRM\t*", "mcp:CRM\tsync", "mcp:CRM\tupdate_deal"]);
    expect(overrides.get("mcp:CRM\tupdate_deal")).toEqual({ class: "reversible-external", verb: "update", sealed: false });
    // THE MUTANT: a stored seal taken as checked. Nothing verifies one in this release.
    expect(overrides.get("mcp:CRM\tsync")!.sealed).toBe(false);
  });

  it("finds a tool's own row before its connector's", () => {
    const overrides = new ToolClassesStore(home()).forProfile("P1");
    expect(overrideFor(overrides, "mcp:CRM", "update_deal")!.class).toBe("reversible-external");
    expect(overrideFor(overrides, "mcp:CRM", "anything")!.class).toBe("irreversible-external");
    expect(overrideFor(overrides, "mcp:OTHER", "anything")).toBeNull();
  });

  it("goes with its profile", () => {
    const db = home();
    db.prepare("DELETE FROM profiles WHERE id = 'P2'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM tool_classes WHERE profile_id = 'P2'").get()).toEqual({ n: 0 });
  });
});

describe("who can reach tool_classes", () => {
  it("is only this store and the migration — no agent tool, RPC method or other service names the table", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { if (name !== "node_modules") walk(p); continue; }
        if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name)) continue;
        if (/\btool_classes\b/.test(readFileSync(p, "utf8"))) hits.push(relative(SRC, p));
      }
    };
    walk(SRC);
    expect(hits.sort()).toEqual(["db/migrations.ts", "team/policies/tool-classes.ts"]);
  });
});
