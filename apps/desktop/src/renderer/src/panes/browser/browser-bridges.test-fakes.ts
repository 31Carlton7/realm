import type { BrowserBridges, BrowserHostBridge, BrowserServerBridge } from "./browser-client";

/**
 * Inert defaults for the browser pane's two bridges, so a test only writes the members it is
 * actually about.
 *
 * This exists because three separate test files each hand-rolled a complete `BrowserBridges`, and
 * every new member on either bridge broke all three at once — for tests that had no opinion about
 * the new member. The defaults do nothing and record nothing; anything a test cares about it passes
 * in and overrides.
 */
export function fakeBrowserBridges(over: {
  host?: Partial<BrowserHostBridge>;
  server?: Partial<BrowserServerBridge>;
} = {}): BrowserBridges {
  const host: BrowserHostBridge = {
    create: async () => {},
    destroy: async () => {},
    navigate: async () => null,
    nav: async () => {},
    setAllowlist: async () => {},
    setBounds: () => {},
    onState: () => () => {},
    blockedDownloads: async () => [],
    saveDownload: async () => ({ ok: false, error: "no download bridge in this test" }),
    dismissDownload: async () => {},
    onDownloadBlocked: () => () => {},
    ...over.host,
  };
  const server: BrowserServerBridge = {
    get: async (browserId) => ({ id: browserId, spaceId: "s1", url: "", title: "Browser", createdAt: 0, updatedAt: 0 }),
    update: async () => {},
    allowlist: async () => null,
    downloadDir: async () => null,
    ...over.server,
  };
  return { host, server };
}
