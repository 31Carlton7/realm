import { readFileSync, statSync } from "node:fs";
import { CtlError } from "../ctl/errors";
import type { RpcServer } from "../rpc/server";
import { HandshakeLimiter } from "./limiter";
import { checkListen, listenUrl, type ListenConfig } from "./listen";
import { AccessTokens } from "./tokens";

export type AccessOptions = {
  listen: ListenConfig;
  /** Tests: the refusals' budget. */
  limiter?: HandshakeLimiter;
  /** How often a revoked token's clients are looked for (2 s), and a renewed certificate (10 min). */
  sweepMs?: number;
  tlsCheckMs?: number;
};

export type Access = { port: number; url: string; close(): Promise<void> };

/** The certificate and key, read now. Unreadable is a refusal to start, said with the path. */
export function readTls(tls: { cert: string; key: string }): { cert: Buffer; key: Buffer } {
  const read = (path: string, what: string): Buffer => {
    try { return readFileSync(path); } catch (e) {
      throw new CtlError("TLS_UNREADABLE", `can't read the TLS ${what} ${path}: ${(e as Error).message}`);
    }
  };
  return { cert: read(tls.cert, "certificate"), key: read(tls.key, "key") };
}

const stamp = (paths: string[]): string => paths.map((p) => { try { return String(statSync(p).mtimeMs); } catch { return "gone"; } }).join(":");

/**
 * The remote listener and what keeps it honest while it runs: tokens revoked with `realm token revoke`
 * lose their open connections within `sweepMs`, and a certificate renewed on disk (`tailscale cert`,
 * certbot) is picked up without a restart, so a server up for months never starts serving an expired one.
 */
export async function startAccess(o: { rpc: RpcServer; home: string; log: (line: string) => void } & AccessOptions): Promise<Access> {
  checkListen(o.listen);
  const tlsFiles = o.listen.tls;
  const tokens = new AccessTokens(o.home, o.log);
  const listener = await o.rpc.listenRemote({
    host: o.listen.host, port: o.listen.port,
    tls: tlsFiles ? readTls(tlsFiles) : null,
    authenticate: (t) => tokens.verify(t),
    limiter: o.limiter ?? new HandshakeLimiter(),
    log: o.log,
  });
  const url = listenUrl(o.listen, listener.port);
  o.log(`[realm-server] listening for remote clients on ${url}`);
  if (tokens.count() === 0) o.log("[realm-server] no access tokens yet: make one on this machine with `realm token create <name>`");
  const sweep = setInterval(() => listener.dropRevoked(tokens.ids()), o.sweepMs ?? 2_000);
  sweep.unref?.();
  let seen = tlsFiles ? stamp([tlsFiles.cert, tlsFiles.key]) : "";
  const renew = tlsFiles ? setInterval(() => {
    const now = stamp([tlsFiles.cert, tlsFiles.key]);
    if (now === seen) return;
    try {
      listener.reloadTls(readTls(tlsFiles));
      seen = now;
      o.log("[realm-server] loaded the renewed TLS certificate");
    } catch (e) {
      // Mid-write, or a renewal that went wrong: keep serving the certificate already loaded.
      o.log(`[realm-server] kept the current TLS certificate: ${(e as Error).message}`);
    }
  }, o.tlsCheckMs ?? 10 * 60_000) : null;
  renew?.unref?.();
  return {
    port: listener.port, url,
    close: async () => {
      clearInterval(sweep);
      if (renew) clearInterval(renew);
      await listener.close();
    },
  };
}
