/**
 * Poll `predicate` until it returns true; rejects after `timeout` ms.
 *
 * The predicate is AWAITED. It used not to be, and an async one — `async () => (await rpc(…)) === x`
 * — returned a promise, which is truthy, so the loop exited on the first tick and the test asserted
 * against a state nothing had waited for. A silently-passing wait is worse than no wait.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeout = 5000, interval = 20 }: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (!await predicate()) {
    if (Date.now() - start > timeout) throw new Error(`waitFor: condition not met within ${timeout}ms`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
