import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { RecordedPush } from "../shared/apns";

export type FakeApns = {
  origin: string;
  /** A fresh .p8 for the relay to sign with; the fake hands out the matching public key. */
  keyP8: string;
  close(): Promise<void>;
};

/**
 * A stand-in for APNs that records every request, for both test hosts: the Worker reaches it over
 * real HTTP through APNS_ORIGIN, and the Node relay through createApnsSender's `origin`.
 *
 * The device token picks the answer, so one server serves every test: a token starting `410` gets
 * 410 Unregistered, `400` gets 400 BadDeviceToken, anything else 200. Tests read back what arrived
 * with GET /__log?token=<token>, and the key to verify the JWT with from GET /__key.
 */
export async function startFakeApns(): Promise<FakeApns> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyP8 = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicJwk = publicKey.export({ format: "jwk" });
  const log: RecordedPush[] = [];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://apns.test");
    if (req.method === "GET" && url.pathname === "/__log") {
      const path = `/3/device/${url.searchParams.get("token")}`;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(log.filter((r) => r.path === path)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/__key") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(publicJwk));
      return;
    }
    log.push({ method: req.method ?? "", path: url.pathname, headers: flatten(req), body: await readBody(req) });
    const token = url.pathname.split("/").pop() ?? "";
    const refuse = (status: number, reason: string) =>
      res.writeHead(status, { "content-type": "application/json", "apns-id": randomUUID() }).end(JSON.stringify({ reason }));
    if (token.startsWith("410")) refuse(410, "Unregistered");
    else if (token.startsWith("400")) refuse(400, "BadDeviceToken");
    else res.writeHead(200, { "apns-id": randomUUID() }).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    keyP8,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function flatten(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) out[name] = Array.isArray(value) ? value.join(", ") : value;
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
