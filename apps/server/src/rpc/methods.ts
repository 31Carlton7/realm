import { Methods } from "@realm/contracts";
import type { RpcServer } from "./server";
import type { ProfilesStore } from "../store/profiles";
import type { SpacesStore } from "../store/spaces";
import type { ProjectsStore } from "../store/projects";
import type { ItemsStore } from "../store/items";
import type { TerminalManager } from "../terminals/manager";
import type { Db } from "../db/database";
import { newId } from "@realm/contracts";

export type Deps = {
  rpc: RpcServer; db: Db; home: string; version: string;
  profiles: ProfilesStore; spaces: SpacesStore; projects: ProjectsStore; items: ItemsStore; terminals: TerminalManager;
};

export function registerMethods(d: Deps): void {
  const { rpc } = d;
  const reg = <M extends keyof typeof Methods>(name: M, fn: (p: import("zod").infer<(typeof Methods)[M]["params"]>) => Promise<import("zod").infer<(typeof Methods)[M]["result"]>> | import("zod").infer<(typeof Methods)[M]["result"]>) =>
    rpc.register(name, Methods[name].params, async (p) => fn(p as never));

  reg("system.info", () => ({ realmHome: d.home, version: d.version }));

  reg("profiles.list", () => d.profiles.list());
  reg("profiles.create", (p) => { const r = d.profiles.create(p); rpc.broadcast("profiles.changed", {}); return r; });
  reg("profiles.update", (p) => { const r = d.profiles.update(p); rpc.broadcast("profiles.changed", {}); return r; });
  reg("profiles.delete", (p) => { d.profiles.delete(p.id); rpc.broadcast("profiles.changed", {}); return { ok: true as const }; });

  reg("spaces.list", (p) => d.spaces.list(p.profileId));
  reg("spaces.create", (p) => { const r = d.spaces.create(p); rpc.broadcast("spaces.changed", { profileId: r.profileId }); return r; });
  reg("spaces.update", (p) => { const r = d.spaces.update(p); rpc.broadcast("spaces.changed", { profileId: r.profileId }); return r; });
  reg("spaces.setLayout", (p) => { const r = d.spaces.setLayout(p.id, p.layout); rpc.broadcast("spaces.changed", { profileId: r.profileId }); return r; });
  reg("spaces.delete", (p) => { const s = d.spaces.get(p.id); d.spaces.delete(p.id); if (s) rpc.broadcast("spaces.changed", { profileId: s.profileId }); return { ok: true as const }; });

  reg("projects.list", (p) => d.projects.list(p.spaceId));
  reg("projects.create", (p) => { const r = d.projects.create(p); rpc.broadcast("items.changed", { spaceId: r.spaceId }); return r; });
  reg("projects.delete", (p) => { const pr = d.projects.get(p.id); d.projects.delete(p.id); if (pr) rpc.broadcast("items.changed", { spaceId: pr.spaceId }); return { ok: true as const }; });

  reg("items.list", (p) => d.items.list(p.spaceId));
  reg("items.create", (p) => { const r = d.items.create(p); rpc.broadcast("items.changed", { spaceId: r.spaceId }); return r; });
  reg("items.update", (p) => { const r = d.items.update(p); rpc.broadcast("items.changed", { spaceId: r.spaceId }); return r; });
  reg("items.delete", (p) => { const it = d.items.get(p.id); d.items.delete(p.id); if (it) rpc.broadcast("items.changed", { spaceId: it.spaceId }); return { ok: true as const }; });

  reg("terminals.create", (p) => {
    const space = d.spaces.get(p.spaceId); if (!space) throw Object.assign(new Error("space not found"), { code: "NOT_FOUND" });
    const cwd = p.cwd ?? space.folderPath;
    const terminalId = d.terminals.create({ cwd, cols: p.cols, rows: p.rows });
    const t = Date.now();
    d.db.prepare("INSERT INTO terminals (id, space_id, cwd, shell, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(terminalId, p.spaceId, cwd, process.env.SHELL ?? "/bin/zsh", t, t);
    const item = d.items.create({ spaceId: p.spaceId, kind: "terminal", title: "Terminal", refId: terminalId });
    rpc.broadcast("items.changed", { spaceId: p.spaceId });
    return { terminalId, itemId: item.id };
  });
  reg("terminals.write", (p) => { d.terminals.write(p.terminalId, p.data); return { ok: true as const }; });
  reg("terminals.resize", (p) => { d.terminals.resize(p.terminalId, p.cols, p.rows); return { ok: true as const }; });
  reg("terminals.close", (p) => { d.terminals.close(p.terminalId); d.db.prepare("DELETE FROM terminals WHERE id = ?").run(p.terminalId); return { ok: true as const }; });
  void newId;
}
