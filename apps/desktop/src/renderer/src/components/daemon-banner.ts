/**
 * What the banner says about the agent server, as a pure function.
 *
 * The socket being down and the server being unhealthy are two different facts, and the banner has
 * to be able to say either. "Connection lost — reconnecting…" is honest about the first and a lie
 * about the second: a server that has crashed five times in two minutes is not about to reconnect,
 * and telling somebody to wait for it is worse than telling them nothing.
 */
export type DaemonUiState =
  | { kind: "connected" }
  | { kind: "disconnected" }
  | { kind: "restarting"; attempt?: number }
  | { kind: "failed"; logPath?: string }
  | { kind: "stale"; why?: string };

export type BannerCopy = { text: string; action: "retry" | "quit-and-stop" | null; tone: "waiting" | "bad" };

/**
 * The line to show, or null for nothing at all.
 *
 * `connectionDown` is the renderer's own socket; `daemon` is what main says about the process behind
 * it. Main's answer wins where it has one, because it knows things the socket cannot report — a
 * server that is gone looks identical from here to one that is merely slow.
 */
export function bannerFor(d: { connectionDown: boolean; daemon: DaemonUiState | null }): BannerCopy | null {
  const kind = d.daemon?.kind;
  // Said even while connected: this one is not about the socket. Working against a server the app did
  // not ship is a state you stay in until you restart, and the banner is the only thing saying so.
  if (kind === "stale") {
    return { text: "Realm was updated, but the agent server running is the previous version. Quit and stop agents to finish updating.", action: "quit-and-stop", tone: "bad" };
  }
  if (kind === "failed") {
    return { text: `The agent server keeps failing to start${d.daemon && "logPath" in d.daemon && d.daemon.logPath ? ` — see ${d.daemon.logPath}` : ""}.`, action: null, tone: "bad" };
  }
  if (!d.connectionDown) return null;
  if (kind === "restarting") return { text: "The agent server stopped — restarting it…", action: null, tone: "waiting" };
  return { text: "Connection lost — reconnecting…", action: "retry", tone: "waiting" };
}
