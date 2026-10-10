import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ActAdapterStatus, ActKind } from "@realm/contracts";

/** One act, as Realm hands it to a platform: the staged copies of exactly the approved files, the
 *  approved text, the account, and where the proof screenshot goes. */
export type ActRequest = {
  ticketId: string;
  kind: ActKind;
  channel: string;
  account: string;
  to: string | null;
  /** Absolute paths of the STAGED copies — the bytes that were hashed against the approval. */
  files: string[];
  body: string | null;
  /** Turn the platform's paid-partnership label on. */
  paidPartnershipLabel: boolean;
  /** What the record names: the device it posts from and the vault sign-in it uses, by name. */
  device: string | null;
  signin: string | null;
  /** Where the adapter writes its screenshot, proof or failure. */
  screenshotPath: string;
  signal: AbortSignal;
};

export type ActResult =
  | { ok: true; url: string; screenshot: string }
  | { ok: false; error: string; screenshot: string | null };

/**
 * A platform Realm can act on. One interface for every channel, so pacing, proof and the press are
 * the service's and never an adapter's to skip.
 */
export interface ActAdapter {
  status(channel: string, kind: ActKind): ActAdapterStatus;
  act(req: ActRequest): Promise<ActResult>;
}

const CHANNEL_NAMES: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram", email: "Email", mail: "Email" };
export const channelName = (c: string): string => CHANNEL_NAMES[c.trim().toLowerCase()] ?? c.trim();

/**
 * The real platforms, not connected yet. Posting from the lab's phones (the simulator and iPhone
 * mirroring tools, signed in through the vault's team sign-ins) and sending mail are the work that
 * remains; until then each says so, and the sheet shows it instead of a button that would fail.
 */
export class NotConnectedAdapter implements ActAdapter {
  status(channel: string, kind: ActKind): ActAdapterStatus {
    const name = channelName(channel);
    const why = kind === "email"
      ? "Realm has no mail account to send from yet. Send it yourself, then mark it sent."
      : `Realm can't ${kind === "dm" ? "send DMs on" : "post to"} ${name} yet: driving the lab's phone for it isn't built. ${kind === "dm" ? "Send it" : "Post it"} by hand for now.`;
    return { connected: false, label: name, why };
  }

  async act(req: ActRequest): Promise<ActResult> {
    return { ok: false, error: this.status(req.channel, req.kind).why ?? "not connected", screenshot: null };
  }
}

/** A 1×1 PNG, for a fake proof when the act had no picture of its own. */
const BLANK_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/**
 * A stand-in platform for tests and live checks, never for a person's accounts: it posts nowhere. It
 * writes one JSON line per act to `logPath` (so a check can count exactly what was "sent"), copies the
 * first picture as its "screenshot", and answers a made-up URL on a reserved domain. A body holding
 * `[fail]` fails, with a screenshot, so the failure path can be seen.
 */
export class FakeActAdapter implements ActAdapter {
  constructor(private readonly logPath: string) {}

  status(channel: string): ActAdapterStatus {
    return { connected: true, label: `${channelName(channel)} (fake, for testing)`, why: null };
  }

  async act(req: ActRequest): Promise<ActResult> {
    if (req.signal.aborted) return { ok: false, error: "held before it went out", screenshot: null };
    mkdirSync(dirname(req.screenshotPath), { recursive: true });
    const picture = req.files.find((f) => /\.(png|jpe?g|webp|gif)$/i.test(f));
    if (picture && /\.png$/i.test(picture)) copyFileSync(picture, req.screenshotPath); else writeFileSync(req.screenshotPath, BLANK_PNG);
    mkdirSync(dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, `${JSON.stringify({
      ticketId: req.ticketId, kind: req.kind, channel: req.channel, account: req.account, to: req.to,
      files: req.files.length, body: req.body, label: req.paidPartnershipLabel, at: Date.now(),
    })}\n`);
    if (req.body?.includes("[fail]")) return { ok: false, error: "the fake platform refused it, as asked", screenshot: req.screenshotPath };
    const slug = req.account.replace(/[^\w.@-]+/g, "");
    return { ok: true, url: `https://fake-platform.invalid/${req.channel.toLowerCase()}/${slug}/${req.ticketId}`, screenshot: req.screenshotPath };
  }
}
