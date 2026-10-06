import { parseRoute } from "./core";
import type { Env } from "./env";

export { MacRoom } from "./durable";

/** The relay's front door: it checks the route and hands the socket to the Mac's room. Every rule
 *  past that is the room's (core.ts). */
export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/health" && (request.method === "GET" || request.method === "HEAD")) return new Response("ok");
    const route = parseRoute(pathname);
    if (!route) return new Response("not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("this is a WebSocket endpoint", { status: 426, headers: { Upgrade: "websocket" } });
    }
    // One room per Mac, wherever its phones connect from.
    return env.MAC_ROOM.get(env.MAC_ROOM.idFromName(route.macId)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
