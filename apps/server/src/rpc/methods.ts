import { Methods, type MethodName, type MethodResult } from "@realm/contracts";
import type { z } from "zod";
import type { RpcServer } from "./server";
import type { ProfilesStore } from "../store/profiles";
import type { SpacesStore } from "../store/spaces";
import type { ProjectsStore } from "../store/projects";
import type { ItemsStore } from "../store/items";
import type { SettingsStore } from "../store/settings";
import type { TerminalService } from "../terminals/service";
import type { SessionService } from "../sessions/service";
import type { GitInfoService } from "../workspace/git-info";

/** Parsed (post-default) params, i.e. what the handler actually receives. */
type Params<M extends MethodName> = z.infer<(typeof Methods)[M]["params"]>;
type Result<M extends MethodName> = MethodResult<M> | Promise<MethodResult<M>>;

export type Deps = {
  rpc: RpcServer; home: string; version: string;
  profiles: ProfilesStore; spaces: SpacesStore; projects: ProjectsStore; items: ItemsStore; settings: SettingsStore; terminals: TerminalService; sessions: SessionService; gitInfo: GitInfoService;
};

export function registerMethods(d: Deps): void {
  const { rpc } = d;
  const reg = <M extends MethodName>(name: M, fn: (p: Params<M>) => Result<M>) =>
    rpc.register(name, Methods[name].params, async (p) => fn(p as Params<M>));

  reg("system.info", () => ({ realmHome: d.home, version: d.version }));

  reg("workspace.gitInfo", (p) => d.gitInfo.get(p.cwd));

  reg("profiles.list", () => d.profiles.list());
  reg("profiles.create", (p) => { const r = d.profiles.create(p); rpc.broadcast("profiles.changed", {}); return r; });
  reg("profiles.update", (p) => { const r = d.profiles.update(p); rpc.broadcast("profiles.changed", {}); return r; });
  reg("profiles.delete", (p) => { d.profiles.delete(p.id); rpc.broadcast("profiles.changed", {}); return { ok: true as const }; });

  reg("spaces.list", () => d.spaces.listAll());
  reg("spaces.create", (p) => { const r = d.spaces.create(p); rpc.broadcast("spaces.changed", {}); return r; });
  reg("spaces.update", (p) => { const r = d.spaces.update(p); rpc.broadcast("spaces.changed", {}); return r; });
  reg("spaces.reorder", (p) => { d.spaces.reorder(p.ids); rpc.broadcast("spaces.changed", {}); return { ok: true as const }; });
  reg("spaces.setLayout", (p) => { const r = d.spaces.setLayout(p.id, p.layout); rpc.broadcast("spaces.changed", {}); return r; });
  reg("spaces.delete", async (p) => {
    if (d.spaces.get(p.id)) { d.terminals.closeAllInSpace(p.id); await d.sessions.deleteAllInSpace(p.id); }
    d.spaces.delete(p.id);
    rpc.broadcast("spaces.changed", {});
    return { ok: true as const };
  });

  reg("settings.get", (p) => ({ value: d.settings.get(p.key) }));
  reg("settings.set", (p) => { d.settings.set(p.key, p.value); return { ok: true as const }; });

  reg("projects.list", (p) => d.projects.list(p.spaceId));
  reg("projects.create", (p) => { const r = d.projects.create(p); rpc.broadcast("items.changed", { spaceId: r.spaceId }); return r; });
  reg("projects.delete", (p) => { const pr = d.projects.get(p.id); d.projects.delete(p.id); if (pr) rpc.broadcast("items.changed", { spaceId: pr.spaceId }); return { ok: true as const }; });

  reg("items.list", (p) => d.items.list(p.spaceId));
  reg("items.listAll", () => d.items.listAll());
  reg("items.create", (p) => { const r = d.items.create(p); rpc.broadcast("items.changed", { spaceId: r.spaceId }); return r; });
  reg("items.update", (p) => { const r = d.items.update(p); rpc.broadcast("items.changed", { spaceId: r.spaceId }); return r; });
  reg("items.delete", async (p) => {
    const it = d.items.get(p.id);
    if (it?.kind === "terminal") { d.terminals.close(it.refId); return { ok: true as const }; } // closes pty + row + item, broadcasts
    if (it?.kind === "session") { await d.sessions.delete(it.refId); return { ok: true as const }; } // disposes handle + row + item, broadcasts
    d.items.delete(p.id);
    if (it) rpc.broadcast("items.changed", { spaceId: it.spaceId });
    return { ok: true as const };
  });

  reg("terminals.create", (p) => d.terminals.open(p));
  reg("terminals.write", (p) => { d.terminals.write(p.terminalId, p.data); return { ok: true as const }; });
  reg("terminals.resize", (p) => { d.terminals.resize(p.terminalId, p.cols, p.rows); return { ok: true as const }; });
  reg("terminals.close", (p) => { d.terminals.close(p.terminalId); return { ok: true as const }; });

  reg("agents.probe", () => d.sessions.probeAll());
  reg("sessions.list", (p) => d.sessions.list(p.spaceId));
  reg("sessions.listAll", () => d.sessions.listAll());
  reg("sessions.get", (p) => d.sessions.get(p.id));
  reg("sessions.create", (p) => d.sessions.create(p));
  reg("sessions.send", async (p) => { await d.sessions.send(p.id, { text: p.text, attachments: p.attachments }); return { ok: true as const }; });
  reg("sessions.interrupt", async (p) => { await d.sessions.interrupt(p.id); return { ok: true as const }; });
  reg("sessions.respondPermission", (p) => { d.sessions.respondPermission(p.id, p.requestId, p.decision); return { ok: true as const }; });
  reg("sessions.setOptions", (p) => d.sessions.setOptions(p.id, { model: p.model, effort: p.effort, permissionMode: p.permissionMode }));
  reg("sessions.setAgent", (p) => d.sessions.setAgent(p.id, p.agentKind));
  reg("sessions.events", (p) => d.sessions.events(p.id, p.afterSeq, p.limit));
  reg("sessions.openTerminal", (p) => d.sessions.openTerminal(p.id));
  reg("sessions.delete", async (p) => { await d.sessions.delete(p.id); return { ok: true as const }; });
}
