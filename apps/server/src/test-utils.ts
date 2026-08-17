/** Poll `predicate` until it returns true; rejects after `timeout` ms. */
export async function waitFor(
  predicate: () => boolean,
  { timeout = 5000, interval = 20 }: { timeout?: number; interval?: number } = {},
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(`waitFor: condition not met within ${timeout}ms`);
    await new Promise((r) => setTimeout(r, interval));
  }
}
