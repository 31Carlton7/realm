import type { MachineTransport, VncEndpoint } from "./machine";

/**
 * Turning what a sandbox provider gave you into somewhere Realm can dial (Plan 25 W3).
 *
 * The shape of this is a decision worth stating, because the obvious alternative is worse. Realm
 * does NOT call anybody's API: there is no `@e2b/desktop` dependency, no Modal token in the keyring,
 * no per-provider SDK to keep in step with four release cadences. What a person has after running
 * their own tooling is a URL or a host and port, and that is what this takes.
 *
 * What "native support" means here is therefore precise, and it is the part that is actually hard:
 * every provider's endpoint is a DIFFERENT transport, and each one is recognised so nobody has to
 * know which. Paste an E2B stream URL and Realm connects to that sandbox's websockify rather than
 * to an HTML page; paste a Modal `tls_socket` and it dials TLS rather than plaintext.
 *
 * Verified against each provider's own documentation and SDK, September 2026 — every port and path
 * below is theirs, not a guess:
 *
 *   - **E2B Desktop** runs x11vnc on 5900 and `novnc_proxy` (websockify + the noVNC web app) on
 *     6080, and publishes it at `https://<port>-<sandboxId>.<domain>/vnc.html` — the host shape is
 *     `getHost()` in the core SDK, the ports are `Stream`'s own defaults in `@e2b/desktop`.
 *   - **Modal** exposes `Sandbox.tunnels()[port]` with `.tls_socket` (a host/port pair behind TLS)
 *     and, for `unencrypted_ports`, `.tcp_socket`. Both are raw RFB — no websockify involved.
 *   - **Namespace** offers an HTTP ingress (HTTPS terminating to plain HTTP in the container) and a
 *     TCP ingress by TLS passthrough. The HTTP one is a websockify target; the TCP one wants a
 *     Namespace-issued CLIENT certificate, which Realm does not do — see `SANDBOX_NOTES`.
 *   - **Vercel Sandbox** gives an exposed port a public HTTPS domain via `sandbox.domain(port)`.
 *     Its documentation says NOTHING about WebSocket upgrade through that proxy, so Realm treats it
 *     as a websockify target and says out loud that it is unverified rather than promising it works.
 */

export type SandboxProvider = "e2b" | "modal" | "namespace" | "vercel" | "screen-sharing" | "generic";

/** What websockify serves, and therefore what every sandbox that embeds noVNC serves. */
export const WEBSOCKIFY_PATH = "/websockify";

/** E2B Desktop's own port for the noVNC/websockify proxy — `Stream`'s default in `@e2b/desktop`. */
export const E2B_STREAM_PORT = 6080;

/**
 * A sentence per provider, for the connect flow to show beside what it resolved.
 *
 * Each one names the thing a person has to have DONE, because a URL that reaches a sandbox with no
 * VNC server in it fails in a way that looks like Realm's fault. The Vercel and Namespace notes each
 * carry a limit rather than a reassurance — an honest "this may not work, here is why" beats a
 * confident connect that dead-ends.
 */
export const SANDBOX_NOTES: Record<SandboxProvider, string> = {
  e2b: "Start the desktop stream first — `desktop.stream.start()`. If you turned on `requireAuth`, the key it returns is the password.",
  modal: "Use the `tls_socket` from `sandbox.tunnels()`, with a VNC server on the port you forwarded.",
  namespace: "Reached through an HTTP ingress. A TCP ingress uses TLS passthrough with a client certificate, which Realm cannot present.",
  vercel: "Vercel's docs do not say whether an exposed port passes WebSocket upgrades through. Run websockify inside the sandbox; if the proxy refuses the upgrade, this will not connect.",
  "screen-sharing": "Turn on Screen Sharing in System Settings ▸ General ▸ Sharing, and set a VNC password under Computer Settings.",
  generic: "Anything serving RFB — over a port, over TLS, or through websockify.",
};

export type ParsedAddress = {
  endpoint: VncEndpoint;
  provider: SandboxProvider;
  /** What Realm inferred and could be wrong about, for the form to show. Null when there is nothing
   *  worth saying — a bare `host:port` is not a guess, it is what was typed. */
  inferred: string | null;
};

const clean = (s: string): string => s.trim().replace(/^[<"']+|[>"',]+$/g, "");

/** `wss` on 443, `ws` on 80, and never mind what the URL wrote — a URL with no port has one. */
const defaultPort = (transport: MachineTransport): number =>
  transport === "wss" ? 443 : transport === "ws" ? 80 : 5900;

/**
 * Anything a person is likely to paste → somewhere to dial, or a sentence about why not.
 *
 * Deliberately forgiving about the INPUT and exact about the OUTPUT: it accepts a stream URL, a
 * bare host, a host and port, a `wss://` endpoint or an `https://` origin, and it always reports
 * what it decided so the form can show it and the user can correct it. Nothing here silently picks
 * a transport and hides it — an endpoint dialled over the wrong one fails with a protocol error
 * that reads like the sandbox is broken.
 */
export function parseMachineAddress(input: string): ParsedAddress | { error: string } {
  const raw = clean(input);
  if (!raw) return { error: "Paste an address, or the URL your sandbox gave you." };

  // A URL, of any of the four schemes anybody hands out.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let u: URL;
    try { u = new URL(raw); } catch { return { error: "That does not parse as a URL." }; }
    const scheme = u.protocol.replace(":", "").toLowerCase();
    if (!["ws", "wss", "http", "https"].includes(scheme)) {
      return { error: `Realm cannot connect over ${scheme}:. Paste a wss:// or https:// URL, or a host and port.` };
    }
    const transport: MachineTransport = scheme === "ws" || scheme === "http" ? "ws" : "wss";
    const provider = providerOfHost(u.hostname);
    /* An E2B stream URL points at `vnc.html`, which is the noVNC WEB APP — a page, not a socket.
       Following it would hand the renderer's RFB client a lump of HTML and produce "not an RFB
       version line", which is true and unhelpable. websockify is on the same origin, at its own
       path, and that is what to dial. Any `.html` is treated the same way for the same reason. */
    const looksLikePage = /\.html?$/i.test(u.pathname) || u.pathname === "/" || u.pathname === "";
    const path = looksLikePage ? WEBSOCKIFY_PATH : u.pathname;
    return {
      endpoint: {
        transport,
        host: u.hostname,
        port: u.port ? Number(u.port) : defaultPort(transport),
        path,
      },
      provider,
      inferred: looksLikePage
        ? `${transport}://${u.host}${WEBSOCKIFY_PATH} — the URL points at noVNC's own page, so Realm will connect to websockify beside it`
        : null,
    };
  }

  // `host:port`, `host`, or an IPv6 literal in brackets.
  const m = /^(\[[0-9a-f:]+\]|[^:\s/]+)(?::(\d+))?$/i.exec(raw);
  if (!m) return { error: "That is not an address Realm recognises. Try a host, a host and port, or a wss:// URL." };
  const host = m[1]!.replace(/^\[|\]$/g, "");
  const port = m[2] ? Number(m[2]) : 5900;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "That port is not a number between 1 and 65535." };
  const provider = providerOfHost(host);
  /* Modal's `tls_socket` is a host and a port with TLS in front of it and nothing in the name to
     say so — dialled as plaintext it sends an RFB version line into a TLS handshake and gets
     silence. The host tells us, so the host is what decides, and the form shows the decision. */
  const transport: MachineTransport = provider === "modal" ? "tls" : "tcp";
  return {
    endpoint: { transport, host, port, path: WEBSOCKIFY_PATH },
    provider,
    inferred: transport === "tls" ? `TLS, because ${host} is a Modal tunnel — its \`tls_socket\` is not plaintext` : null,
  };
}

/** Which provider a hostname belongs to, by its own published domain. Unknown is `generic`, which
 *  is not a lesser case: a self-hosted x11vnc behind nginx is the same shape as any of these. */
export function providerOfHost(host: string): SandboxProvider {
  const h = host.toLowerCase();
  if (/(^|\.)e2b\.(app|dev)$/.test(h)) return "e2b";
  if (/(^|\.)modal\.host$/.test(h)) return "modal";
  if (/(^|\.)(nscluster\.cloud|namespace\.so)$/.test(h)) return "namespace";
  if (/(^|\.)vercel\.(run|app|sh)$/.test(h)) return "vercel";
  if (h === "localhost" || h === "127.0.0.1" || h.endsWith(".local")) return "screen-sharing";
  return "generic";
}

/**
 * An E2B sandbox id → the endpoint its desktop stream is on.
 *
 * Separate from `parseMachineAddress` because a bare sandbox id is not an address and cannot be
 * told apart from a hostname by looking at it. The form asks for it under E2B's own name, and the
 * port and host shape below are E2B's own — `<port>-<sandboxId>.<domain>`, `getHost()` in their SDK.
 */
export function e2bEndpoint(sandboxId: string, domain = "e2b.app"): VncEndpoint {
  return { transport: "wss", host: `${E2B_STREAM_PORT}-${clean(sandboxId)}.${domain}`, port: 443, path: WEBSOCKIFY_PATH };
}

/** How an endpoint reads back to a person, in the form and in the pane's resting body. */
export function describeEndpoint(e: VncEndpoint): string {
  if (e.transport === "ws" || e.transport === "wss") {
    const showPort = (e.transport === "wss" && e.port !== 443) || (e.transport === "ws" && e.port !== 80);
    return `${e.transport}://${e.host}${showPort ? `:${e.port}` : ""}${e.path}`;
  }
  return `${e.host}:${e.port}${e.transport === "tls" ? " over TLS" : ""}`;
}
