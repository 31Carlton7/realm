import { act } from "@testing-library/react";

/**
 * Let §6's popover exit finish.
 *
 * A dismissed anchored surface stays in the DOM for `EXIT_MS` — the `--dur-press` rung, 120ms — and
 * only tells its parent at the end of it, so anything asserting that a menu is GONE has to let that
 * timer run first. The wait is deliberately longer than the exit rather than equal to it: a test
 * waking on the same tick as the timeout would pass or fail on scheduler ordering.
 *
 * One copy, because 200 is only meaningful relative to `EXIT_MS` in use-anchored-popover.ts. Five
 * files each remembering their own is five places to miss when that rung moves.
 */
export const exited = () => act(async () => { await new Promise((r) => setTimeout(r, 200)); });
