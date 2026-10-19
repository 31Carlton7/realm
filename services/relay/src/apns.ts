/**
 * Pushes through APNs (PROTOCOL.md §7). The relay never learns what a push says: the Mac seals it for
 * one phone (Noise K, §4.3), and the alert carries a placeholder plus that ciphertext, which the
 * phone's Notification Service Extension opens.
 *
 * Every failure is a result, never a throw: the Mac hears about it as `{"t":"pushed","ok":false,…}`.
 */
import { b64u } from "./core";

export type ApnsPush = {
  /** The phone's device token, hex. */
  token: string;
  env: "sandbox" | "production";
  macId: string;
  /** The sealed payload, `b64u`. Opaque here. */
  blob: string;
  urgent: boolean;
  collapse: string | null;
  badge: number | null;
};

export type ApnsResult = { ok: boolean; status: number; reason: string | null };

export type ApnsSender = { send(push: ApnsPush): Promise<ApnsResult> };

export type ApnsConfig = {
  teamId?: string;
  keyId?: string;
  /** The .p8 file's contents: a PKCS#8 PEM holding a P-256 key. */
  keyP8?: string;
  topic?: string;
  /** Sends every request here instead of to Apple. Only the tests' fake APNs sets it. */
  origin?: string;
  fetch?: typeof fetch;
  now?: () => number;
};

const ORIGIN = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" } as const;

/** Apple refuses a provider token refreshed more often than every 20 minutes and one older than an
 *  hour. 50 minutes sits between, with room for clock skew. */
const TOKEN_REUSE_MS = 50 * 60_000;

/** A request APNs has not answered by now is reported as unreachable, so the Mac always hears back. */
const REQUEST_TIMEOUT_MS = 15_000;

export function createApnsSender(config: ApnsConfig): ApnsSender {
  const { teamId, keyId, keyP8, topic } = config;
  const send = config.fetch ?? ((input, init) => fetch(input, init));
  const now = config.now ?? (() => Date.now());
  let key: Promise<CryptoKey> | null = null;
  let token: { jwt: Promise<string>; madeAt: number } | null = null;

  // The pending token itself is cached, so pushes that race at startup share one signature.
  function bearer(keyId: string, teamId: string, keyP8: string): Promise<string> {
    const at = now();
    if (token && at - token.madeAt < TOKEN_REUSE_MS) return token.jwt;
    key ??= importP8(keyP8);
    const jwt = key.then((k) => signJwt(k, keyId, teamId, Math.floor(at / 1000)));
    token = { jwt, madeAt: at };
    return jwt;
  }

  return {
    async send(push) {
      if (!teamId || !keyId || !keyP8 || !topic) return { ok: false, status: 0, reason: "apns-not-configured" };
      let jwt: string;
      try {
        jwt = await bearer(keyId, teamId, keyP8);
      } catch {
        key = null;
        token = null;
        return { ok: false, status: 0, reason: "apns-key-invalid" };
      }

      const headers: Record<string, string> = {
        authorization: `bearer ${jwt}`,
        "apns-topic": topic,
        "apns-push-type": "alert",
        "apns-priority": push.urgent ? "10" : "5",
        "content-type": "application/json",
      };
      if (push.collapse !== null) headers["apns-collapse-id"] = push.collapse;
      const aps: Record<string, unknown> = {
        alert: { title: "Realm", body: "Something on your Mac needs you" },
        "mutable-content": 1,
        sound: "default",
      };
      if (push.badge !== null) aps.badge = push.badge;
      aps["interruption-level"] = push.urgent ? "time-sensitive" : "active";
      const body = JSON.stringify({ aps, m: push.macId, r: push.blob });

      let res: Response;
      try {
        res = await send(`${config.origin ?? ORIGIN[push.env]}/3/device/${push.token}`, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, status: 0, reason: "apns-unreachable" };
      }
      if (res.ok) {
        await res.body?.cancel();
        return { ok: true, status: res.status, reason: null };
      }
      return { ok: false, status: res.status, reason: await failureReason(res) };
    },
  };
}

/** APNs explains a refusal as `{"reason":"BadDeviceToken"}` and the like. */
async function failureReason(res: Response): Promise<string | null> {
  try {
    const parsed = (await res.json()) as { reason?: unknown };
    return typeof parsed.reason === "string" ? parsed.reason : null;
  } catch {
    return null;
  }
}

async function importP8(pem: string): Promise<CryptoKey> {
  // A PEM pasted into a secret often arrives with its newlines escaped.
  const base64 = pem
    .replace(/\\n/g, "\n")
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function signJwt(key: CryptoKey, keyId: string, teamId: string, iat: number): Promise<string> {
  const text = new TextEncoder();
  const input = `${b64u(text.encode(JSON.stringify({ alg: "ES256", kid: keyId })))}.${b64u(text.encode(JSON.stringify({ iss: teamId, iat })))}`;
  // WebCrypto's ECDSA signature is already the raw r || s that a JWS wants, not DER.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, text.encode(input));
  return `${input}.${b64u(new Uint8Array(signature))}`;
}
