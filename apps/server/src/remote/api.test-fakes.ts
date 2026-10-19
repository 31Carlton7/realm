import type { Item, MethodName, MethodParams, MethodResult, Session, Space } from "@realm/contracts";
import type { ChannelContext } from "./api";
import type { RpcPort } from "./rpc-port";

/** Rows and a fake of the desktop's RPC, for the mobile API's tests. */

export const space = (id: string, profileId = "p1"): Space =>
  ({ id, profileId, name: `Space ${id}`, icon: "folder", color: "#7c6cff", sortOrder: 0, folderPath: "/tmp", groups: null, layout: null, activeItemId: null, createdAt: 0, updatedAt: 0 });
export const item = (refId: string, spaceId: string, title: string, extra: Partial<Item> = {}): Item =>
  ({ id: `i-${refId}`, spaceId, kind: "session", title, sortOrder: 0, pinned: false, archived: false, refId, createdAt: 0, updatedAt: 0, ...extra });
export const session = (id: string, spaceId: string, extra: Partial<Session> = {}): Session =>
  ({ id, spaceId, projectId: null, agentKind: "fake", model: null, effort: null, fastMode: false, permissionMode: "default", environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", cwd: "/tmp", status: "idle",
    providerSessionId: null, title: `${id} (session)`, lastEventSeq: 0, seenSeq: 0, terminalItemId: null, dispatchedBy: null, activityAt: 0, createdAt: 0, updatedAt: 0, ...extra });

export type Lists = { spaces?: Space[]; sessions: Session[]; items: Item[]; settings?: Record<string, unknown> };

/** The desktop's RPC as `home.get` reads it: `items.listAll` leaves archived rows out, as the store does. */
export function fakeRpc(h: Lists, more: Partial<Record<MethodName, (p: never) => unknown>> = {}): RpcPort & { calls: string[] } {
  const calls: string[] = [];
  const answer = (method: MethodName, params: unknown): unknown => {
    const extra = more[method];
    if (extra) return extra(params as never);
    switch (method) {
      case "spaces.list": return h.spaces ?? [space("s1"), space("s2", "p2")];
      case "sessions.listAll": return h.sessions;
      case "items.listAll": return h.items.filter((i) => !i.archived);
      case "settings.get": return { value: h.settings?.[(params as { key: string }).key] ?? null };
      case "sessions.get": {
        const found = h.sessions.find((s) => s.id === (params as { id: string }).id);
        if (!found) throw new Error(`no session ${(params as { id: string }).id}`);
        return found;
      }
      case "sessions.events": return [];
      default: throw new Error(`the fake has no ${method}`);
    }
  };
  return {
    calls,
    call: async <M extends MethodName>(method: M, params: MethodParams<M>) => { calls.push(method); return answer(method, params) as MethodResult<M>; },
    onEvent: () => () => {},
    close: () => {},
  };
}

export const channel = (rpc: RpcPort): ChannelContext => ({ phoneId: "phone", rpc, sessions: new Map() });
