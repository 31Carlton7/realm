import { describe, expect, it } from "vitest";
import { Presence, PRESENCE_STALE_MS } from "./presence";

function rig() {
  let attached = true;
  let now = 1_000;
  const presence = new Presence({ attached: () => attached, now: () => now });
  return { presence, detach: () => { attached = false; }, tick: (ms: number) => { now += ms; } };
}

describe("whether the owner is at the Mac", () => {
  it("is away until Electron main says otherwise: no report is nobody vouching for them", () => {
    const r = rig();
    expect(r.presence.away()).toBe(true);
    r.presence.set(false);
    expect(r.presence.away()).toBe(false);
    r.presence.set(true);
    expect(r.presence.away()).toBe(true);
  });

  it("goes back to away when the report goes stale, so a main that stopped reporting cannot hold pushes forever", () => {
    const r = rig();
    r.presence.set(false);
    r.tick(PRESENCE_STALE_MS);
    expect(r.presence.away()).toBe(false);
    r.tick(1);
    expect(r.presence.away()).toBe(true);
    // A fresh report — main's refresh — is believed again.
    r.presence.set(false);
    expect(r.presence.away()).toBe(false);
  });

  it("is away with no Electron attached at all, whatever was last reported: a headless daemon has nobody at it", () => {
    const r = rig();
    r.presence.set(false);
    r.detach();
    expect(r.presence.away()).toBe(true);
  });

  it("tells its listeners only when the answer changes", () => {
    const r = rig();
    let heard = 0;
    const off = r.presence.onChange(() => { heard += 1; });
    r.presence.set(true); // away already: no change
    r.presence.set(false);
    r.presence.set(false);
    r.presence.set(true);
    expect(heard).toBe(2);
    off();
    r.presence.set(false);
    expect(heard).toBe(2);
  });
});
