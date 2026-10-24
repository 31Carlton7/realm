import { CtlError } from "./errors";

export type Exec = (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * `realm serve --tailscale`: Tailscale Serve in front of a loopback listener.
 *
 * Tailscale terminates HTTPS with the node's own `*.ts.net` certificate and passes the WebSocket to
 * `127.0.0.1:<port>`, so only devices on the owner's tailnet can reach it, the token travels inside
 * TLS, and nothing listens on any other interface. The access token is still required: a tailnet can
 * hold devices and people that are not the owner. This is Serve, never Funnel — Funnel would put the
 * listener on the public internet.
 *
 * `--bg` keeps the proxy in tailscaled's own config rather than in a child process that could outlive
 * this server; the returned `off` takes it down again as the server exits.
 */
async function run(exec: Exec, args: string[]): Promise<string> {
  let r: Awaited<ReturnType<Exec>>;
  try { r = await exec("tailscale", args); } catch (e) {
    throw new CtlError("TAILSCALE", `can't run tailscale (${(e as Error).message}); install it and sign in with tailscale up, or use --listen with an SSH tunnel instead`);
  }
  if (r.code !== 0) throw new CtlError("TAILSCALE", `tailscale ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return r.stdout;
}

/** This machine's tailnet name (`host.tailnet.ts.net`), asked before anything boots so a machine that
 *  is not on a tailnet is told so before a server starts that nobody could reach. */
export async function tailnetName(exec: Exec): Promise<string> {
  let status: { BackendState?: string; Self?: { DNSName?: string } };
  const out = await run(exec, ["status", "--json"]);
  try { status = JSON.parse(out); } catch { throw new CtlError("TAILSCALE", "tailscale status did not answer in JSON"); }
  if (status.BackendState !== "Running") throw new CtlError("TAILSCALE", `Tailscale is ${status.BackendState ?? "not running"} on this machine; sign in with tailscale up first`);
  const name = (status.Self?.DNSName ?? "").replace(/\.$/, "");
  if (!name) throw new CtlError("TAILSCALE", "this machine has no tailnet name; turn on MagicDNS and HTTPS certificates for the tailnet");
  return name;
}

/** Points Serve's HTTPS port at the listener. `off` is the command that undoes it. */
export async function tailscaleServe(exec: Exec, o: { name: string; port: number; httpsPort: number }): Promise<{ url: string; off: string[] }> {
  await run(exec, ["serve", "--bg", `--https=${o.httpsPort}`, `http://127.0.0.1:${o.port}`]);
  return { url: `wss://${o.name}${o.httpsPort === 443 ? "" : `:${o.httpsPort}`}`, off: ["serve", `--https=${o.httpsPort}`, "off"] };
}
