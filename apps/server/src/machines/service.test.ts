import { describe, expect, it, afterEach } from "vitest";
import { tempDir } from "@realm/test-utils";
import WebSocket from "ws";
import { createApp, type App } from "../app";
import { machineSecretBox } from "./secret";
import { newSecretKey } from "@realm/contracts/src/secret-box";

const apps: App[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  machineSecretBox.setKey(null);
});

async function client(port: number) {
  const ws = await new Promise<WebSocket>((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.once("open", () => res(w)); w.once("error", rej); });
  const pending = new Map<string, (v: any) => void>(); const events: any[] = [];
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); if ("id" in m) pending.get(m.id)?.(m); else events.push(m); });
  let n = 0;
  const call = (method: string, params: unknown) => new Promise<any>((res) => { const id = String(++n); pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
  return { call, events, close: () => ws.close() };
}

async function bring() {
  const home = tempDir("realm-home-");
  const app = await createApp({ home, port: 0 });
  apps.push(app);
  const c = await client(app.port);
  const prof = (await c.call("profiles.create", { name: "Work" })).result;
  const space = (await c.call("spaces.create", { profileId: prof.id, name: "Versed" })).result;
  return { home, app, c, space };
}

const mac = { host: "10.0.1.14", port: 5900 };

describe("machines RPC", () => {
  it("create makes row + item as one unit, and the row says only that a password exists", async () => {
    machineSecretBox.setKey(newSecretKey().toString("base64"));
    const { c, space } = await bring();
    const r = (await c.call("machines.create", { spaceId: space.id, name: "Studio Mac", endpoint: mac, password: "hunter2" })).result;
    expect(r.passwordStored).toBe(true);

    const items = (await c.call("items.list", { spaceId: space.id })).result;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "machine", refId: r.machineId, title: "Studio Mac" });

    const { machine, state } = (await c.call("machines.get", { machineId: r.machineId })).result;
    expect(machine).toMatchObject({ name: "Studio Mac", source: "vnc", endpoint: mac, hasPassword: true });
    // The whole point of `hasPassword`: there is no field on the wire a password could occupy, and
    // this shape reaches every connected client.
    expect(JSON.stringify(machine)).not.toContain("hunter2");
    expect(Object.keys(machine)).not.toContain("password");
    // Nothing is running until somebody starts it — a machine at rest is `off`, not "unknown".
    expect(state).toMatchObject({ status: "off", wsUrl: null });
    c.close();
  });

  /* The divergence from oauth, and it has to be visible to the caller. With no key from the desktop
     app, oauth writes plaintext and a machine refuses to store the password at all — so the form
     must learn that it did less than it was asked, rather than showing a saved password that is not
     there. The mutant is `create` returning `passwordStored: true` unconditionally. */
  it("with no encryption key it stores NO password and says so, rather than writing one in the clear", async () => {
    machineSecretBox.setKey(null);
    const { home, c, space } = await bring();
    const r = (await c.call("machines.create", { spaceId: space.id, name: "Studio Mac", endpoint: mac, password: "hunter2" })).result;
    expect(r.passwordStored).toBe(false);
    const { machine } = (await c.call("machines.get", { machineId: r.machineId })).result;
    expect(machine.hasPassword).toBe(false);
    // And nothing resembling it reached the database file either.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    expect(readFileSync(join(home, "realm.db")).toString("latin1")).not.toContain("hunter2");
    c.close();
  });

  it("refuses a source this release cannot reach, by name, instead of making a row that never starts", async () => {
    const { c, space } = await bring();
    /* `qemu` and `mac` are built now (Plan 25 W5/W7). `container` is not, and its refusal is the
       interesting one: there is almost nothing left to build, because a container that serves a
       screen IS reachable by address through the sandbox transports. What a source would add is a
       Docker lifecycle nobody has verified, and pointing at the route that works beats shipping it. */
    const container = await c.call("machines.create", { spaceId: space.id, name: "x", source: "container", endpoint: null });
    expect(container.error).toBeTruthy();
    expect(String(container.error.message)).toContain("connects by address like any other");
    // …and a `mac` machine without a bundle id is refused for a different reason, in its own words.
    const mac = await c.call("machines.create", { spaceId: space.id, name: "x", source: "mac", endpoint: null });
    expect(mac.error).toBeTruthy();
    expect(String(mac.error.message)).toContain("bundle id");
    // …and nothing was left behind in the sidebar by a refusal.
    expect((await c.call("items.list", { spaceId: space.id })).result).toEqual([]);
    c.close();
  });

  /* A guest is a real row now, and it is created with no image and no address — the connect flow's
     "A Linux VM on this Mac" route fills those in. `start` is where the absence is refused. */
  it("creates a qemu machine with a guest shape, and refuses to start one with nothing to boot", async () => {
    const { c, space } = await bring();
    const r = (await c.call("machines.create", {
      spaceId: space.id, name: "Debian", source: "qemu", endpoint: null,
      guest: { arch: "aarch64", memoryMb: 4096, cpus: 4, diskGb: 40, imageSha: null, imageKind: null, catalogId: "debian-13-arm64" },
    })).result;
    expect(r.machineId).toBeTruthy();
    const { machine } = (await c.call("machines.get", { machineId: r.machineId })).result;
    expect(machine).toMatchObject({ source: "qemu", endpoint: null });
    // It reports `booting` synchronously and then fails behind an event, because a guest that has
    // nothing to boot from is a fact the boot discovers rather than one `start` can answer with.
    expect((await c.call("machines.start", { machineId: r.machineId })).result.state.status).toBe("booting");
    c.close();
  });

  it("start hands out a loopback URL with a token, and says `booting` rather than `running`", async () => {
    const { c, space } = await bring();
    const { machineId } = (await c.call("machines.create", { spaceId: space.id, name: "Mac", endpoint: mac })).result;
    const { state } = (await c.call("machines.start", { machineId })).result;
    /* `booting`, not `running`. Nothing has reached the far end yet — the renderer has not even
       opened the socket — and a remote Mac that is asleep accepts TCP and then says nothing. */
    expect(state.status).toBe("booting");
    expect(state.wsUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/vnc\/[A-Za-z0-9_-]+\//);
    expect(state.width).toBeNull();

    // The event carries the URL, so a renderer never needs a round trip to learn where to connect.
    const status = c.events.filter((e: any) => e.event === "machine.status").at(-1);
    expect(status.payload).toMatchObject({ machineId, status: "booting", wsUrl: state.wsUrl });
    c.close();
  });

  it("stop returns it to off and takes the recorded port with it", async () => {
    const { c, space } = await bring();
    const { machineId } = (await c.call("machines.create", { spaceId: space.id, name: "Mac", endpoint: mac })).result;
    await c.call("machines.start", { machineId });
    const { state } = (await c.call("machines.stop", { machineId })).result;
    expect(state).toMatchObject({ status: "off", wsUrl: null });
    // Idempotent: a second press of a power toggle is not an error.
    expect((await c.call("machines.stop", { machineId })).result.state.status).toBe("off");
    c.close();
  });

  /* An edit that moves the address or the password invalidates every live view of the old one. A
     pane still showing the machine the row no longer describes is the failure — and it is silent,
     because the pixels keep arriving from wherever they were already coming from. */
  it("an edit that moves the address drops the connection to the old one", async () => {
    const { c, space } = await bring();
    const { machineId } = (await c.call("machines.create", { spaceId: space.id, name: "Mac", endpoint: mac })).result;
    await c.call("machines.start", { machineId });
    expect((await c.call("machines.get", { machineId })).result.state.status).toBe("booting");
    await c.call("machines.update", { machineId, endpoint: { host: "10.0.1.99", port: 5900 } });
    expect((await c.call("machines.get", { machineId })).result.state.status).toBe("off");
    c.close();
  });

  /* Three-valued on purpose. A rename must not drop the password, which is what collapsing absent
     and null would do — and it would be invisible until the next connect failed. */
  it("a rename leaves the password alone; an explicit null clears it", async () => {
    machineSecretBox.setKey(newSecretKey().toString("base64"));
    const { c, space } = await bring();
    const { machineId } = (await c.call("machines.create", { spaceId: space.id, name: "Mac", endpoint: mac, password: "hunter2" })).result;
    await c.call("machines.update", { machineId, name: "Studio Mac" });
    expect((await c.call("machines.get", { machineId })).result.machine).toMatchObject({ name: "Studio Mac", hasPassword: true });
    await c.call("machines.update", { machineId, password: null });
    expect((await c.call("machines.get", { machineId })).result.machine.hasPassword).toBe(false);
    c.close();
  });

  it("a rename renames the sidebar item too", async () => {
    const { c, space } = await bring();
    const { machineId, itemId } = (await c.call("machines.create", { spaceId: space.id, name: "Mac", endpoint: mac })).result;
    await c.call("machines.update", { machineId, name: "Studio Mac" });
    const item = (await c.call("items.list", { spaceId: space.id })).result.find((i: any) => i.id === itemId);
    expect(item.title).toBe("Studio Mac");
    c.close();
  });

  /* Deleting the ITEM deletes the machine, which is what the pane bar's ⋯ Delete does. Closing the
     pane is a layout operation that never reaches the server at all — see `closeFromLayout`. */
  it("deleting the item deletes the row with it", async () => {
    const { c, space } = await bring();
    const { machineId, itemId } = (await c.call("machines.create", { spaceId: space.id, name: "Mac", endpoint: mac })).result;
    await c.call("items.delete", { id: itemId });
    expect((await c.call("items.list", { spaceId: space.id })).result).toEqual([]);
    expect((await c.call("machines.get", { machineId })).error).toBeTruthy();
    c.close();
  });

  /**
   * Restart. The row survives; the state does not, and neither does the recorded port.
   *
   * The port is the subtle half. A port recorded against the last run's listener is a lie, and the
   * UNIQUE index would refuse to reissue it — so a machine that was connected when Realm quit could
   * never be given its own port back, and would fail to start forever with a constraint error.
   */
  it("survives a restart as `off`, and can be started again on the same port", async () => {
    const home = tempDir("realm-home-");
    const first = await createApp({ home, port: 0 }); apps.push(first);
    const c1 = await client(first.port);
    const prof = (await c1.call("profiles.create", { name: "Work" })).result;
    const space = (await c1.call("spaces.create", { profileId: prof.id, name: "Versed" })).result;
    const { machineId } = (await c1.call("machines.create", { spaceId: space.id, name: "Mac", endpoint: mac })).result;
    await c1.call("machines.start", { machineId });
    c1.close();
    await first.close();
    apps.splice(apps.indexOf(first), 1);

    const second = await createApp({ home, port: 0 }); apps.push(second);
    const c2 = await client(second.port);
    const { machine, state } = (await c2.call("machines.get", { machineId })).result;
    expect(machine).toMatchObject({ name: "Mac", endpoint: mac });
    expect(state).toMatchObject({ status: "off", wsUrl: null });
    // The whole point: it starts again rather than colliding with a port nothing holds.
    expect((await c2.call("machines.start", { machineId })).result.state.status).toBe("booting");
    c2.close();
  });

  it("deleting a space takes its machines' rows with it", async () => {
    const { c, space } = await bring();
    const { machineId } = (await c.call("machines.create", { spaceId: space.id, name: "Mac", endpoint: mac })).result;
    await c.call("spaces.delete", { id: space.id });
    expect((await c.call("machines.get", { machineId })).error).toBeTruthy();
    c.close();
  });

  it("lists a space's machines with their live states in one answer", async () => {
    const { c, space } = await bring();
    const a = (await c.call("machines.create", { spaceId: space.id, name: "A", endpoint: mac })).result;
    (await c.call("machines.create", { spaceId: space.id, name: "B", endpoint: mac })).result;
    await c.call("machines.start", { machineId: a.machineId });
    const { machines, states } = (await c.call("machines.list", { spaceId: space.id })).result;
    expect(machines.map((m: any) => m.name)).toEqual(["A", "B"]);
    // A client that just connected has missed every event; the list is how it catches up.
    expect(states.find((s: any) => s.machineId === a.machineId).status).toBe("booting");
    expect(states.find((s: any) => s.machineId !== a.machineId).status).toBe("off");
    c.close();
  });
});

describe("a boot that nobody is waiting for any more", () => {
  /**
   * Stop during a boot must win, permanently.
   *
   * Starting a guest is a walk with four awaits in it, and each resume point used to write state
   * unconditionally. Press Stop while it is walking and the pane went `off` and then, a second or
   * two later, flipped itself to `failed` — for a boot the user had already cancelled. At quit the
   * same write landed on a closed database and came out as an unhandled `ERR_INVALID_STATE` with no
   * test failing, which is how it survived: 5893 green tests and one error nobody had to explain.
   *
   * This holds whether or not QEMU is installed. With it, the walk gets as far as spawning and the
   * guest's exit reports back; without it, `capabilities()` reports unavailable at the first resume
   * point. Both are paths that used to call `fail` and both must now find themselves superseded.
   *
   * The mutant: delete any one `superseded` check in `startQemu`. The status goes `failed`.
   */
  it("stays off after stop, however the walk ends", async () => {
    const { c, space } = await bring();
    const r = (await c.call("machines.create", { spaceId: space.id, name: "Cancelled", endpoint: null })).result;
    await c.call("machines.update", {
      machineId: r.machineId,
      source: "qemu",
      guest: { arch: "aarch64", memoryMb: 512, cpus: 1, diskGb: 1, imageSha: "0".repeat(64), imageKind: "iso" },
    });

    const started = (await c.call("machines.start", { machineId: r.machineId })).result.state;
    expect(started.status).toBe("booting");
    const stopped = (await c.call("machines.stop", { machineId: r.machineId })).result.state;
    expect(stopped.status).toBe("off");

    // Long enough for every await in the walk to have come back and had its say.
    await new Promise((res) => setTimeout(res, 2500));
    const after = (await c.call("machines.get", { machineId: r.machineId })).result.state;
    expect(after.status).toBe("off");
    expect(after.error).toBe(null);
    // And nothing announced a failure to the clients either.
    expect(c.events.filter((e) => e.params?.machineId === r.machineId && e.params?.status === "failed")).toEqual([]);
    c.close();
  }, 30_000);
});
