import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

/** What the person is shown: the code to type, and the page to type it on. */
export type DeviceCode = { deviceCode: string; userCode: string; verificationUri: string; expiresIn: number; interval: number };

type DeviceEndpoints = { codeUrl: string; tokenUrl: string; clientId: string; scope: string };

/** A device-flow failure the person can act on, worded for them. */
export class DeviceFlowError extends Error {
  constructor(public reason: "expired" | "denied" | "failed", message: string) { super(message); }
}

/** RFC 8628 §3.1: ask for a device code. GitHub answers form-encoded unless asked for JSON. */
export async function requestDeviceCode(ep: DeviceEndpoints, fetchFn: FetchLike = fetch): Promise<DeviceCode> {
  const body = await post(fetchFn, ep.codeUrl, { client_id: ep.clientId, scope: ep.scope });
  if (typeof body.device_code !== "string" || typeof body.user_code !== "string" || typeof body.verification_uri !== "string") {
    throw new DeviceFlowError("failed", `the sign-in server did not issue a code${typeof body.error === "string" ? ` (${body.error})` : ""}`);
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 900,
    interval: typeof body.interval === "number" ? body.interval : 5,
  };
}

/**
 * RFC 8628 §3.4–3.5: poll until the person approves, declines, or the code runs out.
 * `authorization_pending` waits another interval; `slow_down` adds five seconds to it for good, as
 * the RFC asks (GitHub also sends the new interval, which wins when present).
 */
export async function pollDeviceToken(ep: DeviceEndpoints, code: DeviceCode, d: {
  fetchFn?: FetchLike; sleep?: (ms: number) => Promise<void>; now?: () => number; signal?: AbortSignal;
} = {}): Promise<{ accessToken: string; scope?: string }> {
  const fetchFn = d.fetchFn ?? fetch;
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  const deadline = now() + code.expiresIn * 1000;
  let interval = code.interval;
  for (;;) {
    await sleep(interval * 1000);
    if (d.signal?.aborted) throw new DeviceFlowError("failed", "the sign-in was cancelled");
    if (now() >= deadline) throw expired();
    const body = await post(fetchFn, ep.tokenUrl, {
      client_id: ep.clientId, device_code: code.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (typeof body.access_token === "string" && body.access_token) {
      return { accessToken: body.access_token, scope: typeof body.scope === "string" ? body.scope : undefined };
    }
    switch (body.error) {
      case "authorization_pending": continue;
      case "slow_down": interval = typeof body.interval === "number" ? body.interval : interval + 5; continue;
      case "expired_token": throw expired();
      case "access_denied": throw new DeviceFlowError("denied", "the sign-in was declined");
      default: throw new DeviceFlowError("failed", `the sign-in server refused: ${typeof body.error === "string" ? body.error : "no token came back"}`);
    }
  }
}

const expired = () => new DeviceFlowError("expired", "the code expired before it was entered — start again for a new one");

async function post(fetchFn: FetchLike, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  // Errors come back as 200s with an `error` field on GitHub, and as 400s per the RFC: read both.
  const parsed: unknown = await res.json().catch(() => null);
  if (!parsed || typeof parsed !== "object") throw new DeviceFlowError("failed", `the sign-in server answered ${res.status} with no JSON`);
  return parsed as Record<string, unknown>;
}
