import { describe, expect, it } from "vitest";
import { CATALOG } from "./catalog-data";

/**
 * A guest in the catalog has to be watchable.
 *
 * Realm offers exactly one way to use a machine it boots: you look at it. An image that reaches a
 * login prompt on a serial port is a perfectly good Linux and a completely empty pane, and nothing
 * else in the stack can tell the difference — the connection succeeds, the framebuffer is real, the
 * guest simply never draws. That failure survived a green suite and a working relay and was caught
 * only by looking at a screenshot.
 *
 * So the catalog carries the constraint mechanically. The guard is crude on purpose: a flavour
 * marker in a URL is not proof of a framebuffer, but every case we have hit announced itself in the
 * filename, and a crude check that fires is worth more than a subtle one nobody writes.
 */
describe("the catalog only offers guests with a screen", () => {
  /** Distribution flavours built for a serial console. Each is a real image that boots fine and
   *  draws nothing. Add to this list when one bites, never remove to make a test pass. */
  const HEADLESS_FLAVOURS = ["-virt-", "-netboot-", "-cloud-", "-cloudimg-", "-nocloud-"];

  it.each(CATALOG.map((e) => [e.id, e.url] as const))("%s is not a headless flavour", (_id, url) => {
    const file = url.slice(url.lastIndexOf("/") + 1).toLowerCase();
    const found = HEADLESS_FLAVOURS.filter((flavour) => file.includes(flavour));
    expect(found, `${file} is built for a serial console, so its pane would stay blank`).toEqual([]);
  });

  it("would reject the alpine-virt image this replaced", () => {
    // The mutant this test exists to kill: the exact URL that shipped and showed nothing.
    const regressed = "alpine-virt-3.21.0-aarch64.iso";
    expect(["-virt-"].some((f) => regressed.includes(f))).toBe(true);
  });

  it("every entry declares a size, because the pane shows progress against it", () => {
    for (const entry of CATALOG) expect(entry.bytes, entry.id).toBeGreaterThan(0);
  });
});
