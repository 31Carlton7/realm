import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RpcServer, type CallContext } from "../rpc/server";
import { NotFoundError } from "../store/rows";
import { inProcessRpc, RpcCallError } from "./rpc-port";

describe("inProcessRpc", () => {
  it("calls the handler as its principal and keeps the server's error code for the mobile API to map", async () => {
    const rpc = new RpcServer();
    const seen: CallContext[] = [];
    rpc.register("sessions.get", z.object({ id: z.string() }), async (p, ctx) => {
      seen.push(ctx);
      if (p.id === "gone") throw new NotFoundError("session", p.id);
      return { id: p.id };
    });
    const port = inProcessRpc(rpc, "phone:abc");
    expect(await port.call("sessions.get", { id: "s1" })).toEqual({ id: "s1" });
    expect(seen).toEqual([{ client: null, principal: "phone:abc" }]);
    const refused = await port.call("sessions.get", { id: "gone" }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(RpcCallError);
    expect(refused).toMatchObject({ code: "NOT_FOUND", message: "session gone not found" });
    await expect(port.call("sessions.get", {} as { id: string })).rejects.toMatchObject({ code: "INVALID_PARAMS" });
  });

  it("hears every broadcast until it stops listening", () => {
    const rpc = new RpcServer();
    const port = inProcessRpc(rpc, "local");
    const heard: string[] = [];
    const off = port.onEvent((event) => { heard.push(event); });
    rpc.broadcast("spaces.changed", { profileId: "p1" });
    off();
    rpc.broadcast("spaces.changed", { profileId: "p1" });
    expect(heard).toEqual(["spaces.changed"]);
  });
});
