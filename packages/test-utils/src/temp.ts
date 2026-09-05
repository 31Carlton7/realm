import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

/**
 * A scratch directory under $TMPDIR, removed when the calling test file finishes.
 *
 * Bare `mkdtemp` removed nothing: one full suite run left 974 `realm-*` directories behind, and the
 * accumulated pile reached 93 GB — at which point parallel vitest workers failed their scratch
 * writes and the run reported the resulting ENOSPC as ordinary test failures.
 *
 * Cleanup is `afterAll` rather than `afterEach` because most callers open theirs at module scope or
 * in `beforeAll` and share it across the file's tests. The hook is registered when this module is
 * imported, which vitest evaluates once per test file, so a file only ever removes its own
 * directories — and the hook still runs when a test throws.
 */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});
