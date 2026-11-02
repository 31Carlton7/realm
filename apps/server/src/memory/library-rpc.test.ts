import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { createApp, type App } from "../app";
import { waitFor } from "../test-utils";

let app: App | null = null;
afterEach(async () => { await app?.close(); app = null; vi.unstubAllEnvs(); });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: Any) => void>();
  const events: Any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<Any>((res, rej) => {
    const id = String(++n);
    pending.set(id, (v) => (v.error ? rej(Object.assign(new Error(`${method}: ${v.error.message}`), { code: v.error.code })) : res(v.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  return { call, events, close: () => ws.close() };
}

describe("memory.library over RPC", () => {
  it("lists a profile's memory and the agents' own, and writes one of them only when told it may", async () => {
    const home = tempDir("realm-memlib-app-");
    const user = join(home, "user");
    mkdirSync(join(user, ".claude"), { recursive: true });
    writeFileSync(join(user, ".claude", "CLAUDE.md"), "# House rules\n");
    mkdirSync(join(user, ".gemini"), { recursive: true });
    writeFileSync(join(user, ".gemini", "GEMINI.md"), "Gemini.\n");
    mkdirSync(join(home, "realm"), { recursive: true });
    vi.stubEnv("REALM_BUNDLED_SKILLS", join(home, "no-bundle"));
    app = await createApp({ home: join(home, "realm"), port: 0, userHome: user, claudeDir: join(user, ".claude"), memoryRepoByDefault: true, claudeTemporaryRoots: [] });
    const c = await client(app.port);
    const [profile] = await c.call("profiles.list", {});
    await c.call("spaces.create", { profileId: profile.id, name: "Realm" });
    const { sources } = await c.call("memory.library.sources", { profileId: profile.id });
    expect(sources.map((s: Any) => [s.group, s.label])).toEqual([["realm", "Memory repo"], ["claude", "User memory"], ["gemini", "User memory"]]);
    const { entries } = await c.call("memory.library.list", { profileId: profile.id });
    expect(entries.map((e: Any) => e.id).sort()).toEqual(["claude-user:CLAUDE.md", "gemini-user:GEMINI.md", `realm-repo-profile-${profile.id}:MEMORY.md`]);
    const read = await c.call("memory.library.read", { id: "claude-user:CLAUDE.md", profileId: profile.id });
    expect(read).toMatchObject({ title: "House rules", external: true, readBy: [{ who: "Claude", where: "Realm", how: null }] });

    await expect(c.call("memory.library.write", { id: "claude-user:CLAUDE.md", text: "# Mine\n" })).rejects.toMatchObject({ code: "MEMORY_EXTERNAL_UNCONFIRMED" });
    await c.call("memory.library.write", { id: "claude-user:CLAUDE.md", text: "# Mine\n", confirmExternal: true });
    expect(readFileSync(join(user, ".claude", "CLAUDE.md"), "utf8")).toBe("# Mine\n");
    await waitFor(() => c.events.some((e: Any) => e.event === "memory.library.changed"));

    const made = await c.call("memory.library.create", { sourceId: `realm-repo-profile-${profile.id}`, name: "Ships Fridays", description: "When releases go out", type: "project", body: "Fridays." });
    expect(made).toMatchObject({ rel: "ships-fridays.md", title: "Ships Fridays" });
    expect((await c.call("memory.library.search", { profileId: profile.id, query: "releases" })).entries[0]).toMatchObject({ rel: "ships-fridays.md" });
    await expect(c.call("memory.library.read", { id: "claude-user:../../realm/realm.db" })).rejects.toMatchObject({ code: "MEMORY_FILE_NOT_FOUND" });
    c.close();
  });
});
