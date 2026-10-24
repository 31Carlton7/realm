/**
 * Refused handshakes, counted per source address.
 *
 * An access token is 256 random bits, so guessing one is not the attack this stops. What it stops is a
 * scanner, or a client with a stale token on a loop, making the server hash and log forever: after
 * `max` refusals inside `windowMs`, the address is refused outright — valid token or not — for `blockMs`.
 *
 * It keys on the socket's address. Behind a proxy on this machine (Tailscale Serve, an SSH tunnel)
 * every client arrives from 127.0.0.1 and shares one budget, which is the safe direction to be wrong in:
 * the clients that can reach such a proxy are the tailnet's devices, or someone with an SSH login here.
 */
export type LimiterOptions = { max?: number; windowMs?: number; blockMs?: number; now?: () => number; capacity?: number };

type Entry = { count: number; since: number; blockedUntil: number };

export class HandshakeLimiter {
  private readonly entries = new Map<string, Entry>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly blockMs: number;
  private readonly now: () => number;
  private readonly capacity: number;

  constructor(o: LimiterOptions = {}) {
    this.max = o.max ?? 10;
    this.windowMs = o.windowMs ?? 60_000;
    this.blockMs = o.blockMs ?? 60_000;
    this.now = o.now ?? Date.now;
    this.capacity = o.capacity ?? 10_000;
  }

  blocked(addr: string): boolean {
    const e = this.entries.get(addr);
    return e !== undefined && e.blockedUntil > this.now();
  }

  /** One refusal. Returns true when this one is what blocked the address, so it is logged once. */
  fail(addr: string): boolean {
    const now = this.now();
    let e = this.entries.get(addr);
    if (!e || now - e.since > this.windowMs) {
      e = { count: 0, since: now, blockedUntil: e?.blockedUntil ?? 0 };
    }
    e.count += 1;
    // Re-inserted so the map's order is least recently failed first, which is what eviction drops.
    this.entries.delete(addr);
    this.entries.set(addr, e);
    while (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
    if (e.count >= this.max && e.blockedUntil <= now) {
      e.blockedUntil = now + this.blockMs;
      e.count = 0;
      e.since = now;
      return true;
    }
    return false;
  }

  /** A good handshake clears the address's refusals. */
  succeed(addr: string): void {
    const e = this.entries.get(addr);
    if (e && e.blockedUntil <= this.now()) this.entries.delete(addr);
  }
}
