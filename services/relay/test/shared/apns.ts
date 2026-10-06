import { fromB64u, utf8 } from "./devices";

/** What the tests' relays push with. The team and topic are wrangler.jsonc's vars. */
export const TEST_APNS = { teamId: "FY9QB79VAP", topic: "co.charmtechnologies.realm.ios", keyId: "TESTKEY000" } as const;

/** One request as the fake APNs (test/node/fake-apns.ts) received it. */
export type RecordedPush = { method: string; path: string; headers: Record<string, string>; body: string };

export async function apnsLog(origin: string, token: string): Promise<RecordedPush[]> {
  return (await (await fetch(`${origin}/__log?token=${token}`)).json()) as RecordedPush[];
}

/** Decodes an ES256 JWT and checks its signature with the fake APNs's public key, as APNs would. */
export async function readJwt(origin: string, jwt: string): Promise<{ header: unknown; claims: unknown; verified: boolean }> {
  const [header = "", claims = "", signature = ""] = jwt.split(".");
  const jwk = (await (await fetch(`${origin}/__key`)).json()) as JsonWebKey;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, new Uint8Array(fromB64u(signature)), new Uint8Array(utf8(`${header}.${claims}`)));
  const decode = (part: string): unknown => JSON.parse(new TextDecoder().decode(fromB64u(part)));
  return { header: decode(header), claims: decode(claims), verified };
}
