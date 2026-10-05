import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { AppViewServer } from "./server";

const servers: AppViewServer[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });

async function boot(): Promise<{ s: AppViewServer; port: number }> {
  const s = new AppViewServer();
  servers.push(s);
  return { s, port: await s.listen() };
}

/** A request to the loopback listener, carrying whatever Host the test names — what Chromium sends
 *  for a `*.mcp-view.localhost` address it resolved to 127.0.0.1 itself. */
function get(port: number, path: string, host: string, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const where = (url: string) => { const u = new URL(url); return { path: u.pathname, host: u.host }; };

describe("the views listener", () => {
  it("serves a view's HTML on its own host, under the CSP it was given, with no referrer and no device features", async () => {
    const { s, port } = await boot();
    const { url, origin } = s.serve({ html: "<p>chart</p>", csp: "default-src 'none'" });
    expect(origin).toMatch(new RegExp(`^http://[0-9a-f]{16}\\.mcp-view\\.localhost:${port}$`));
    expect(url.startsWith(`${origin}/v/`)).toBe(true);
    const r = await get(port, where(url).path, where(url).host);
    expect(r.status).toBe(200);
    expect(r.body).toBe("<p>chart</p>");
    expect(r.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(r.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
    expect(r.headers["permissions-policy"]).toContain("camera=()");
    expect(r.headers["set-cookie"]).toBeUndefined();
  });

  it("gives every serve an origin of its own, even of the same HTML", async () => {
    const { s } = await boot();
    const a = s.serve({ html: "x", csp: "" }), b = s.serve({ html: "x", csp: "" });
    expect(a.origin).not.toBe(b.origin);
  });

  it("answers a token only on the host it was minted with", async () => {
    // THE MUTANT: drop the host check, and any page that learns one address can load the view on
    // an origin it is not — or as 127.0.0.1, which is every other loopback listener's host too.
    const { s, port } = await boot();
    const a = s.serve({ html: "a", csp: "" }), b = s.serve({ html: "b", csp: "" });
    expect((await get(port, where(a.url).path, where(b.url).host)).status).toBe(404);
    expect((await get(port, where(a.url).path, `127.0.0.1:${port}`)).status).toBe(404);
    expect((await get(port, where(a.url).path, where(a.url).host.replace(`:${port}`, ":1"))).status).toBe(404);
  });

  it("serves nothing but the addresses it minted, and stops on release", async () => {
    const { s, port } = await boot();
    const { url } = s.serve({ html: "x", csp: "" });
    const { path, host } = where(url);
    expect((await get(port, "/v/not-a-token", host)).status).toBe(404);
    expect((await get(port, `${path}/../../etc/passwd`, host)).status).toBe(404);
    expect((await get(port, "/", host)).status).toBe(404);
    expect((await get(port, path, host, "POST")).status).toBe(405);
    expect((await get(port, path, host, "HEAD")).status).toBe(200);
    s.release(url);
    expect((await get(port, path, host)).status).toBe(404);
    expect(() => s.release("not a url")).not.toThrow();
  });
});
