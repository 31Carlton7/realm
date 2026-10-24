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
 *  serve` on a Linux box would run with its own relay setting. */
async function headless(o: { listen?: boolean } = {}) {
  remoteSecretBox.setKey(null);
  remoteSecretBox.setHomeKey(null);
  const home = tempDir("realm-pair-home-");
  const relay = await startLocalRelay({ port: 0 }); relays.push(relay);
  const app = await createApp({ home, port: 0, token: "daemon-token",
    remote: { defaultRelay: relay.url, homeKey: { file: homeKeyFile(home), create: true } },
    ...(o.listen ? { access: { listen: { host: "127.0.0.1", port: 0, tls: null, allowPlaintext: false } } } : {}) });
  apps.push(app);
  writeFileSync(join(home, "daemon.json"), JSON.stringify({ port: app.port, token: "daemon-token" }));
  return { home, app, relay };
}

/** `realm pair` running, with its output gathered and its question answered by `answer`. */
function pairing(argv: string[], answer: (question: string) => string | null, signal?: AbortSignal) {
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
  it("draws the code in the terminal, puts the phone that scans it to the person, and pairs it on a yes", async () => {
    const h = await headless();
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
    expect(await run.done).toBe(0);
    expect(run.asked).toEqual([expect.stringContaining(`Pair "Carlton's iPhone" (iPhone18,1)?`)]);
    expect(run.out.at(-1)).toMatch(/^Paired Carlton's iPhone\./);
    // Sealed with a key of the server's own, made for it: nobody was here to hand over the keychain's.
    expect(existsSync(homeKeyFile(h.home))).toBe(true);
    // The phone it paired can now reach the server through the relay.
    expect((await phone.connect()).macOnline).toBe(true);
  });

  it("pairs nothing on a no, and tells the phone it was declined", async () => {
    const h = await headless();
    const run = pairing(["pair", "--home", h.home, "--json"], () => "n");
    const url = await run.link;
    const result = await new TestPhone().pair(url, { name: "Someone's iPhone" });
    expect(result).toEqual({ ok: false, reason: "declined" });
    expect(await run.done).toBe(1);
    expect(JSON.parse(run.out.at(-1)!).error.code).toBe("DECLINED");
    const phones = await runCtl(["phones", "--home", h.home, "--json"], { out: (s) => run.out.push(s), err: () => {}, env: {}, cwd: "/", connect, serve: async () => {} });
    expect(phones).toBe(0);
    expect(JSON.parse(run.out.at(-1)!)).toEqual([]);
  });

  it("with nobody at the terminal to answer, pairs nothing", async () => {
    const h = await headless();
    const run = pairing(["pair", "--home", h.home], () => null);
    expect(await new TestPhone().pair(await run.link)).toEqual({ ok: false, reason: "declined" });
    expect(await run.done).toBe(1);
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
