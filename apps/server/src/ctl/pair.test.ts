import { afterEach, describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { startLocalRelay, type LocalRelay } from "@realm/relay/src/node";
import { createApp, type App } from "../app";
import { createToken } from "../access/tokens";
import { homeKeyFile } from "../remote/home-key";
import { remoteSecretBox } from "../remote/secret";
import { TestPhone } from "../remote/test-phone";
import { connect } from "./client";
import { runCtl, type CtlIo } from "./commands";

const apps: App[] = [];
const relays: LocalRelay[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close().catch(() => {});
  for (const r of relays.splice(0)) await r.close();
  remoteSecretBox.setKey(null);
  remoteSecretBox.setHomeKey(null);
});

/** A headless server — no Realm window, so no keychain key — with a relay on loopback, as `realm
 *  serve` on a Linux box would run with its own relay setting. `daemon.json` carries the CLI's token,
 *  as `main.ts` writes it; the app's own token is held only here, standing in for Realm's window. */
async function headless(o: { listen?: boolean } = {}) {
  remoteSecretBox.setKey(null);
  remoteSecretBox.setHomeKey(null);
  const home = tempDir("realm-pair-home-");
  const relay = await startLocalRelay({ port: 0 }); relays.push(relay);
  const app = await createApp({ home, port: 0, token: "app-token", cliToken: "daemon-token",
    remote: { defaultRelay: relay.url, homeKey: { file: homeKeyFile(home), create: true } },
    ...(o.listen ? { access: { listen: { host: "127.0.0.1", port: 0, tls: null, allowPlaintext: false } } } : {}) });
  apps.push(app);
  writeFileSync(join(home, "daemon.json"), JSON.stringify({ port: app.port, token: "daemon-token" }));
  return { home, app, relay };
}

/** Settings ▸ Devices: Realm's own window hears each phone that scans the code and answers it. */
function realmWindowSays(app: App, accept: boolean): () => void {
  return app.rpc.onBroadcast((event, payload) => {
    if (event === "remote.pairRequest") void app.rpc.call("remote.pair.answer", { requestId: (payload as { requestId: string }).requestId, accept });
  });
}

/** `realm pair` running, with its output gathered and its question answered by `answer`. */
function pairing(argv: string[], answer: (question: string) => string | null | Promise<string | null>, signal?: AbortSignal) {
  const out: string[] = []; const err: string[] = []; const asked: string[] = [];
  const io: CtlIo = {
    out: (s) => out.push(s), err: (s) => err.push(s), env: {}, cwd: "/", connect, serve: async () => {},
    prompt: async (q) => { asked.push(q); return answer(q); }, signal, columns: 100, tty: true,
  };
  const done = runCtl(argv, io);
  const link = (async () => {
    for (let i = 0; i < 200; i++) {
      const line = [...out, ...err].join("\n").split("\n").find((l) => l.startsWith("https://realm.computer/pair#"));
      if (line) return line.trim();
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no link printed:\n${out.join("\n")}\n${err.join("\n")}`);
  })();
  return { out, err, asked, done, link };
}

describe("realm pair", () => {
  it("draws the code in the terminal, sends the person to Realm to accept the phone, and reports it paired", async () => {
    const h = await headless();
    const off = realmWindowSays(h.app, true);
    const run = pairing(["pair", "--home", h.home], () => "y");
    const url = await run.link;
    const text = run.out.join("\n");
    expect(text).toContain("Open Realm on your iPhone and scan this");
    // The code: black on white, two modules to a row, every row the same width.
    const rows = text.split("\n").filter((l) => l.startsWith("\x1b[38;5;16;48;5;231m"));
    expect(rows.length).toBeGreaterThan(30);
    expect(new Set(rows.map((r) => r.length)).size).toBe(1);
    const phone = new TestPhone();
    expect(await phone.pair(url, { name: "Carlton's iPhone", model: "iPhone18,1" })).toEqual({ ok: true });
    off();
    expect(await run.done).toBe(0);
    // The terminal never asks: the daemon.json token cannot answer, so only Realm's window can.
    expect(run.asked).toEqual([]);
    expect(run.out.join("\n")).toContain(`"Carlton's iPhone" wants to pair. Accept it in Realm`);
    expect(run.out.at(-1)).toMatch(/^Paired Carlton's iPhone\./);
    // Sealed with a key of the server's own, made for it: nobody was here to hand over the keychain's.
    expect(existsSync(homeKeyFile(h.home))).toBe(true);
    // The phone it paired can now reach the server through the relay.
    expect((await phone.connect()).macOnline).toBe(true);
  });

  it("pairs nothing when Realm's window says no, whatever the terminal would have said", async () => {
    const h = await headless();
    const off = realmWindowSays(h.app, false);
    const stop = new AbortController();
    const run = pairing(["pair", "--home", h.home, "--json"], () => "y", stop.signal);
    expect(await new TestPhone().pair(await run.link, { name: "Someone's iPhone" })).toEqual({ ok: false, reason: "declined" });
    off();
    stop.abort();
    expect(await run.done).toBe(130);
    expect(run.asked).toEqual([]);
    expect(await h.app.rpc.call("remote.status", {})).toMatchObject({ phones: [] });
  });

  it("cannot accept a phone itself: the token in daemon.json opens a window but cannot answer one", async () => {
    const h = await headless();
    const c = await connect({ kind: "home", home: h.home });
    try {
      await expect(c.call("remote.pair.start")).resolves.toMatchObject({ url: expect.stringContaining("https://realm.computer/pair#") });
      await expect(c.call("remote.pair.answer", { requestId: "any", accept: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally { c.close(); }
  });

  it("closes the window on Ctrl-C, so the code on the screen stops working", async () => {
    const h = await headless();
    const stop = new AbortController();
    const run = pairing(["pair", "--home", h.home], () => "y", stop.signal);
    const url = await run.link;
    stop.abort();
    expect(await run.done).toBe(130);
    expect(await h.app.rpc.call("remote.status", {})).toMatchObject({ pairing: null });
    const late = await new TestPhone().pair(url, { timeoutMs: 3_000 }).catch((e: Error) => ({ ok: false, reason: e.message }));
    expect(late.ok).toBe(false);
  });

  it("works from another machine, over an access token, and the phone can be removed from there too", async () => {
    const h = await headless({ listen: true });
    const { token } = createToken(h.home, "laptop");
    const run = pairing(["pair", "--server", h.app.access!.url, "--token", token], () => "yes");
    expect(await new TestPhone().pair(await run.link, { name: "Carlton's iPhone" })).toEqual({ ok: true });
    expect(await run.done).toBe(0);
    const out: string[] = [];
    const io: CtlIo = { out: (s) => out.push(s), err: () => {}, env: { REALM_SERVER: h.app.access!.url, REALM_TOKEN: token }, cwd: "/", connect, serve: async () => {} };
    expect(await runCtl(["phones", "--json"], io)).toBe(0);
    const [phone] = JSON.parse(out.at(-1)!);
    expect(phone).toMatchObject({ name: "Carlton's iPhone" });
    expect(await runCtl(["phones", "remove", "Carlton's iPhone", "--json"], io)).toBe(0);
    expect(await runCtl(["phones", "--json"], io)).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toEqual([]);
  });
});
