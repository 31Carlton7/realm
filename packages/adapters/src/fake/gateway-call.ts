/**
 * Just enough of an MCP client for the scripted adapter to call one of Realm's own tools for real.
 *
 * The fake is handed the session's gateway entry like every adapter (`StartOptions.mcpServers`) and
 * used to ignore it. A `call` step uses it: the same Streamable HTTP endpoint a real agent's CLI
 * talks to, so what runs behind the call — `agent_start` resolving a model, creating the child,
 * capping its permissions — is the production path, not a stand-in for it.
 *
 * One MCP session per Realm session, because the gateway keeps one transport per Realm session and a
 * second `initialize` on it is refused. Hence the connection is created once and its id reused.
 */
export type GatewayEntry = { url: string; headers: Record<string, string> };
/** `notices` counts what the gateway sent on the call's stream before it answered — its progress
 *  and "still running" messages — so a live check can see a long call being kept alive. */
export type ToolAnswer = { text: string; isError: boolean; notices?: number };

type Rpc = { id?: number; method?: string; result?: { content?: { type: string; text?: string }[]; isError?: boolean; protocolVersion?: string }; error?: { message: string } };

export function gatewayClient(entry: GatewayEntry) {
  let session: { id: string | null; version: string } | null = null;
  let n = 0;

  /** One POST, answered as JSON or as an event stream that the server closes once it has replied.
   *  `notices` is how many notifications came on that stream ahead of the answer. */
  const post = async (body: Record<string, unknown>): Promise<{ answer: Rpc | null; notices: number }> => {
    const res = await fetch(entry.url, {
      method: "POST",
      headers: {
        ...entry.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session?.id ? { "mcp-session-id": session.id } : {}),
        ...(session ? { "mcp-protocol-version": session.version } : {}),
      },
      body: JSON.stringify(body),
    });
    const id = res.headers.get("mcp-session-id");
    if (id && session) session.id = id;
    const raw = await res.text();
    if (!res.ok) throw new Error(`gateway answered ${res.status}: ${raw.slice(0, 200)}`);
    if (raw.trim() === "") return { answer: null, notices: 0 };
    const messages: Rpc[] = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)) as Rpc)
      : [JSON.parse(raw) as Rpc];
    const notices = messages.filter((m) => m.method === "notifications/progress" || m.method === "notifications/message").length;
    return { answer: messages.find((m) => m.id === body.id) ?? null, notices };
  };

  const connect = async (): Promise<void> => {
    if (session) return;
    session = { id: null, version: "2025-03-26" };
    const { answer: init } = await post({ jsonrpc: "2.0", id: ++n, method: "initialize",
      params: { protocolVersion: session.version, capabilities: {}, clientInfo: { name: "realm-fake-agent", version: "1" } } });
    if (init?.error) { session = null; throw new Error(init.error.message); }
    session.version = init?.result?.protocolVersion ?? session.version;
    await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  };

  return {
    async call(name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
      await connect();
      const { answer: r, notices } = await post({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } });
      if (!r) return { text: "the gateway sent no answer", isError: true, notices };
      if (r.error) return { text: r.error.message, isError: true, notices };
      const text = (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
      return { text, isError: r.result?.isError === true, notices };
    },
  };
}
