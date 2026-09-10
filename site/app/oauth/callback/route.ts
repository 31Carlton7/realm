import { NextResponse } from "next/server";

/**
 * The OAuth relay: an HTTPS callback for vendors that refuse a loopback redirect (Slack's MCP server
 * does), bounced to the Realm app listening on this Mac.
 *
 * Stateless and closed. Realm sends `state` as `<port>.<nonce>`; this page reads the port back out
 * and 302s to `http://127.0.0.1:<port>/oauth/callback` with `code`, `state` and any `error` intact.
 * Nothing else is ever a target — a state that does not name a plausible loopback port gets a plain
 * 400 — so the page cannot be used as a redirector to anywhere. Mirrors `relayTarget` in
 * `packages/contracts/src/connectors.ts`, which the app's server uses to mint the state; the site is
 * not a workspace consumer of that package, so the ten lines are repeated here on purpose.
 */
export const dynamic = "force-dynamic";

function relayTarget(state: string | null, code: string | null, error: string | null): string | null {
  const m = /^(\d{4,5})\.[A-Za-z0-9_-]{16,}$/.exec(state ?? "");
  if (!m) return null;
  const port = Number(m[1]);
  if (port < 1024 || port > 65535) return null;
  const u = new URL(`http://127.0.0.1:${port}/oauth/callback`);
  u.searchParams.set("state", state!);
  if (code) u.searchParams.set("code", code);
  if (error) u.searchParams.set("error", error);
  return u.toString();
}

export function GET(req: Request): Response {
  const q = new URL(req.url).searchParams;
  const target = relayTarget(q.get("state"), q.get("code"), q.get("error"));
  if (!target) return new NextResponse("This callback is not for a Realm on this machine.", { status: 400 });
  return NextResponse.redirect(target, 302);
}
