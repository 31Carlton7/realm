import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@realm/test-utils";
import { createApp, type App } from "../app";
import { hasOpenssl, selfSignedCert } from "../access/cert.test-fakes";
import type { ListenConfig } from "../access/listen";
import { connect, type Target } from "./client";
import { runCtl, type CtlIo, type ServeOptions } from "./commands";
import { profilesFile } from "./profiles";

const apps: App[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close().catch(() => {}); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
}
function initRepo(): string {
  const dir = tempDir("realm-remote-repo-");
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "."); git(dir, "commit", "-m", "init");
  return dir;
}

/** The "remote" machine: a real server on its own home, with a remote listener as `realm serve
 *  --listen` boots one, and the daemon token its own `daemon.json` would carry. */
async function remoteServer(listen: Partial<ListenConfig> = {}) {
  const home = tempDir("realm-remote-home-");
  const app = await createApp({ home, port: 0, token: "daemon-token", access: { listen: { host: "127.0.0.1", port: 0, tls: null, allowPlaintext: false, ...listen }, sweepMs: 50 } });
  apps.push(app);
  writeFileSync(join(home, "daemon.json"), JSON.stringify({ port: app.port, token: "daemon-token" }));
  return { home, app, url: app.access!.url };
}

/** `realm` on the "client" machine: its own scratch HOME and config, and no Realm home of its own
 *  being served, so anything that answers came over the remote listener. */
function client(o: { secret?: string | null; env?: NodeJS.ProcessEnv; serve?: CtlIo["serve"] } = {}) {
  const userHome = tempDir("realm-client-");
  const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: join(userHome, ".config"), REALM_HOME: join(userHome, "Realm"), ...o.env };
  const served: { home: string; o: ServeOptions }[] = [];
  const dialled: Target[] = [];
  const realm = async (...argv: string[]) => {
    const out: string[] = []; const err: string[] = [];
    const io: CtlIo = {
      out: (s) => out.push(s), err: (s) => err.push(s), env, cwd: userHome,
      connect: (t) => { dialled.push(t); return connect(t); },
      serve: o.serve ?? (async (home, so) => { served.push({ home, o: so }); }),
      readSecret: async () => o.secret ?? null,
    };
    const code = await runCtl(["--json", ...argv], io);
    return { code, json: out.length ? JSON.parse(out.join("\n")) : null, err: err.join("\n") };
  };
  return { realm, env, userHome, served, dialled };
}

/** A token made on the server, the way `realm token create` there makes one. */
async function tokenOn(home: string, name = "laptop"): Promise<string> {
  const out: string[] = [];
  const code = await runCtl(["token", "create", name, "--json", "--home", home], { out: (s) => out.push(s), err: () => {}, env: {}, cwd: "/", connect, serve: async () => {} });
  expect(code).toBe(0);
  return JSON.parse(out[0]!).token;
}

describe("realm --server: a server on another machine", () => {
  it("runs a command there in a new worktree, waits on it and reads what it printed, over a token", async () => {
    const srv = await remoteServer();
    const token = await tokenOn(srv.home);
    const { realm } = client({ env: { REALM_SERVER: srv.url, REALM_TOKEN: token } });
    const repo = initRepo(); // a checkout on the server's disk
    const status = await realm("status");
    expect(status.code).toBe(0);
    expect(status.json).toMatchObject({ running: true, realmHome: srv.home, remoteUrl: srv.url });
    const run = await realm("run", repo, "--worktree", "remote-1", "--", "echo RAN_REMOTELY > out.txt; echo printed");
    expect(run.code).toBe(0);
    expect(run.json.branch).toBe("realm/remote-1");
    const waited = await realm("wait", run.json.terminalId, "--timeout", "20");
    expect(waited.code).toBe(0);
    expect(readFileSync(join(run.json.path, "out.txt"), "utf8")).toBe("RAN_REMOTELY\n");
    expect((await realm("logs", run.json.terminalId)).json.output).toContain("printed");
    expect((await realm("ps")).json).toMatchObject([{ terminalId: run.json.terminalId, exitCode: 0 }]);
    expect((await realm("worktree", "list", repo)).json).toMatchObject([{ branch: "realm/remote-1" }]);
    expect((await realm("kill", run.json.terminalId)).code).toBe(0);
    expect((await realm("ps")).json).toEqual([]);
  }, 30_000);

  it("is refused with no token, a wrong one, or the server's daemon token", async () => {
    const srv = await remoteServer();
    await tokenOn(srv.home);
    const { realm } = client();
    const none = await realm("status", "--server", srv.url);
    expect(none.code).toBe(2);
    expect(none.json.error.code).toBe("USAGE");
    const wrong = await realm("status", "--server", srv.url, "--token", `rlm_${"x".repeat(43)}`);
    expect(wrong.code).toBe(1);
    expect(wrong.json.error).toMatchObject({ code: "UNAUTHORIZED", message: expect.stringMatching(/refused the access token/) });
    const daemon = await realm("status", "--server", srv.url, "--token", "daemon-token");
    expect(daemon.json.error.code).toBe("UNAUTHORIZED");
  });

  it("stops working the moment its token is revoked on the server", async () => {
    const srv = await remoteServer();
    const token = await tokenOn(srv.home);
    const { realm } = client({ env: { REALM_SERVER: srv.url, REALM_TOKEN: token } });
    expect((await realm("status")).code).toBe(0);
    const revoked = await runCtl(["token", "revoke", "laptop", "--home", srv.home], { out: () => {}, err: () => {}, env: {}, cwd: "/", connect, serve: async () => {} });
    expect(revoked).toBe(0);
    expect((await realm("status")).json.error.code).toBe("UNAUTHORIZED");
  });

  it("will not send a token over ws:// to another machine unless told the network encrypts", async () => {
    const { realm } = client();
    // 192.0.2.10 is a documentation address nothing answers on: a dial would hang, then say so. This
    // answer comes from the URL check, before any socket.
    const started = Date.now();
    const r = await realm("ps", "--server", "ws://192.0.2.10:9242", "--token", "rlm_whatever");
    expect(r.code).toBe(1);
    expect(r.json.error).toMatchObject({ code: "PLAINTEXT_REFUSED", message: expect.stringMatching(/in the clear/) });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect((await realm("ps", "--server", "ws://100.101.102.103:9242", "--token", "rlm_whatever")).json.error.code).toBe("PLAINTEXT_REFUSED");
    // A loopback ws:// is an SSH tunnel's local end, and is fine.
    const srv = await remoteServer();
    const token = await tokenOn(srv.home);
    expect((await realm("status", "--server", srv.url, "--token", token)).code).toBe(0);
  });

  it("takes paths as the server's: absolute, never resolved against this shell's directory", async () => {
    const srv = await remoteServer();
    const token = await tokenOn(srv.home);
    const { realm } = client({ env: { REALM_SERVER: srv.url, REALM_TOKEN: token } });
    const r = await realm("repo", "add", "code/app");
    expect(r.code).toBe(2);
    expect(r.json.error.message).toMatch(/paths are the server's/);
  });

  it("cannot make or revoke access tokens: those are made on the server, by someone who can read its home", async () => {
    const srv = await remoteServer();
    const token = await tokenOn(srv.home);
    const { realm } = client({ env: { REALM_SERVER: srv.url, REALM_TOKEN: token } });
    for (const argv of [["token", "create", "another"], ["token", "list"], ["token", "revoke", "laptop"]]) {
      const r = await realm(...argv);
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.json.error.message).toMatch(/made on the server itself/);
    }
    expect(JSON.parse(readFileSync(join(srv.home, "access-tokens.json"), "utf8")).tokens).toHaveLength(1);
  });

  it("can pair phones and see them, but cannot register as the browser host or vouch for presence", async () => {
    const srv = await remoteServer();
    const token = await tokenOn(srv.home);
    const c = await connect({ kind: "url", url: srv.url, token, ca: null, allowPlaintext: false });
    try {
      await expect(c.call("browserHost.register", { hasWindow: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(c.call("remote.away", { away: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await c.call("remote.status", {})).toMatchObject({ phones: [] });
    } finally { c.close(); }
  });
});

describe.skipIf(!hasOpenssl)("realm --server over TLS", () => {
  it("trusts a self-signed certificate only when given it with --ca", async () => {
    const cert = selfSignedCert();
    const srv = await remoteServer({ host: "127.0.0.1", tls: { cert: cert.cert, key: cert.key } });
    const token = await tokenOn(srv.home);
    expect(srv.url.startsWith("wss://")).toBe(true);
    const { realm } = client({ env: { REALM_SERVER: srv.url, REALM_TOKEN: token } });
    const untrusted = await realm("status");
    expect(untrusted.json.error).toMatchObject({ code: "TLS_UNTRUSTED", message: expect.stringMatching(/--ca/) });
    expect((await realm("status", "--ca", cert.cert)).code).toBe(0);
  });
});

describe("saved remotes", () => {
  it("are checked by dialling, saved 0600 with the token, listed without it, and used by name", async () => {
    const srv = await remoteServer();
    const token = await tokenOn(srv.home);
    const { realm, env } = client({ secret: token });
    const added = await realm("remote", "add", "vps", srv.url);
    expect(added.code).toBe(0);
    expect(added.json).toMatchObject({ name: "vps", url: srv.url, realmHome: srv.home });
    const file = profilesFile(env);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const listed = await realm("remote", "list");
    expect(listed.json).toEqual([{ name: "vps", url: srv.url, ca: false, allowPlaintext: false }]);
    expect(JSON.stringify(listed.json)).not.toContain(token);
    expect((await realm("--server", "vps", "status")).json).toMatchObject({ running: true, realmHome: srv.home });
    expect((await realm("remote", "remove", "vps")).code).toBe(0);
    expect((await realm("--server", "vps", "status")).json.error.code).toBe("NOT_FOUND");
  });

  it("are not saved when the token is wrong", async () => {
    const srv = await remoteServer();
    await tokenOn(srv.home);
    const { realm, env } = client({ secret: `rlm_${"y".repeat(43)}` });
    const r = await realm("remote", "add", "vps", srv.url);
    expect(r.json.error.code).toBe("UNAUTHORIZED");
    expect(existsSync(profilesFile(env))).toBe(false);
  });

  it("are refused, as ssh refuses a key, when other users can read the file", async () => {
    const srv = await remoteServer();
    const token = await tokenOn(srv.home);
    const { realm, env } = client({ secret: token });
    await realm("remote", "add", "vps", srv.url);
    chmodSync(profilesFile(env), 0o644);
    const r = await realm("--server", "vps", "status");
    expect(r.json.error).toMatchObject({ code: "INSECURE_FILE", message: expect.stringMatching(/chmod 600/) });
  });
});

describe("realm serve --listen", () => {
  it("refuses every address, or a public one, without TLS — before anything boots", async () => {
    const { realm, served } = client();
    for (const listen of ["0.0.0.0:9242", "[::]:9242", "8.8.8.8:9242"]) {
      const r = await realm("serve", "--listen", listen, "--allow-plaintext");
      expect(r.json.error.code, listen).toBe("LISTEN_REFUSED");
      expect(r.code).toBe(1);
    }
    expect(served).toEqual([]);
  });

  it("refuses a private address without TLS unless --allow-plaintext, and a name, and half a certificate", async () => {
    const { realm, served } = client();
    expect((await realm("serve", "--listen", "192.168.1.20:9242")).json.error.message).toMatch(/--allow-plaintext/);
    expect((await realm("serve", "--listen", "realm.example.com:9242")).json.error.code).toBe("USAGE");
    expect((await realm("serve", "--listen", "0.0.0.0:9242", "--tls-cert", "/c.pem")).json.error.message).toMatch(/both a certificate/);
    expect((await realm("serve", "--tls-cert", "/c.pem", "--tls-key", "/k.pem")).json.error.message).toMatch(/go with --listen/);
    expect(served).toEqual([]);
    expect(await realm("serve", "--listen", "192.168.1.20:9242", "--allow-plaintext")).toMatchObject({ code: null });
    expect(served[0]!.o.listen).toEqual({ host: "192.168.1.20", port: 9242, tls: null, allowPlaintext: true });
  });

  it("listens on loopback by default, and anywhere with TLS", async () => {
    const { realm, served, userHome } = client();
    expect(await realm("serve")).toMatchObject({ code: null });
    expect(served[0]!.o).toEqual({ port: null, listen: null });
    expect(await realm("serve", "--listen", "0.0.0.0:9242", "--tls-cert", "c.pem", "--tls-key", "k.pem")).toMatchObject({ code: null });
    expect(served[1]!.o.listen).toEqual({ host: "0.0.0.0", port: 9242, tls: { cert: join(userHome, "c.pem"), key: join(userHome, "k.pem") }, allowPlaintext: false });
  });
});
