import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { tempDir } from "@realm/test-utils";
import { FakeAdapter } from "@realm/adapters";
import { createApp, type App } from "../app";
import { ProfilesStore } from "../store/profiles";
import { SpacesStore } from "../store/spaces";
import { waitFor } from "../test-utils";
import { TOOL_RESULT_KEPT_DAYS, toolResultsRoot } from "./tool-results";

/* The saved tool results through the whole server: kept while their session lives, and not past a week. */

let app: App | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const saved = (home: string, sessionId: string, name: string, ageDays = 0): string => {
  const dir = join(toolResultsRoot(home), sessionId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "x");
  const t = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  utimesSync(path, t, t);
  return path;
};

describe("saved tool results, in the running server", () => {
  it("are swept at boot once older than a week", async () => {
    const home = tempDir("realm-tool-results-app-");
    const old = saved(home, "gone-session", "old.txt", TOOL_RESULT_KEPT_DAYS + 1);
    const recent = saved(home, "live-session", "recent.txt", 1);
    app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }) } });
    await waitFor(() => !existsSync(old));
    expect(existsSync(join(toolResultsRoot(home), "gone-session"))).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("are deleted with their session", async () => {
    const home = tempDir("realm-tool-results-app-");
    app = await createApp({ home, port: 0, adapters: { fake: new FakeAdapter({ script: [] }) } });
    const profile = new ProfilesStore(app.db).create({ name: "P", icon: "home", color: "#000" });
    const space = new SpacesStore(app.db, home).create({ profileId: profile.id, name: "S", icon: "home" });
    const mine = app.sessions.create({ spaceId: space.id, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default" }).session;
    const other = app.sessions.create({ spaceId: space.id, agentKind: "fake", projectId: null, model: null, effort: null, permissionMode: "default" }).session;
    saved(home, mine.id, "a.txt");
    const kept = saved(home, other.id, "b.txt");
    await app.sessions.delete(mine.id);
    await waitFor(() => !existsSync(join(toolResultsRoot(home), mine.id)));
    expect(existsSync(kept)).toBe(true);
  });
});
