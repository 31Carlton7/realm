import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "../test-utils";
import { hashText, writeAtomic } from "./files";
import { DocumentWatcher } from "./watcher";

let dir: string;
let events: { path: string; hash: string | null }[];
let w: DocumentWatcher;
const p = (name: string) => join(dir, name);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "realm-watch-"));
  events = [];
  // 5ms debounce: the coalescing behaviour is the same, the test just does not have to wait for it.
  w = new DocumentWatcher((path, hash) => { events.push({ path, hash }); }, 5);
});
afterEach(async () => { w.close(); await rm(dir, { recursive: true, force: true }); });

const settled = async (n: number) => { await waitFor(() => events.length >= n); };
/** Give the watcher a chance to (not) fire, for the assertions that something stays silent. */
const quiet = () => new Promise((r) => setTimeout(r, 120));

describe("DocumentWatcher", () => {
  it("reports an outside edit with the new hash", async () => {
    await writeFile(p("a.md"), "v1");
    await w.watch(p("a.md"));
    await writeFile(p("a.md"), "v2");
    await settled(1);
    expect(events).toEqual([{ path: p("a.md"), hash: hashText("v2") }]);
  });

  /** Atomic rename is how agent tools and most editors save. A file-bound `fs.watch` goes deaf on the
   *  first one; this test is what pins the watch to the directory instead. */
  it("survives an atomic-rename save by another writer", async () => {
    await writeFile(p("a.md"), "v1");
    await w.watch(p("a.md"));
    await writeAtomic(p("a.md"), "written by rename");
    await settled(1);
    expect(events).toEqual([{ path: p("a.md"), hash: hashText("written by rename") }]);
  });

  it("stays silent for content Realm wrote itself", async () => {
    await writeFile(p("a.md"), "v1");
    await w.watch(p("a.md"));
    await writeAtomic(p("a.md"), "our own save");
    w.noteWrite(p("a.md"), hashText("our own save"));
    await quiet();
    expect(events).toEqual([]);
  });

  /**
   * The mutant this design exists to kill: track the last WRITTEN hash instead of the last KNOWN one
   * and this sequence silently desynchronises the pane from disk forever.
   */
  it("reports a change back to content Realm previously wrote", async () => {
    await writeFile(p("a.md"), "H");
    await w.watch(p("a.md"));
    w.noteWrite(p("a.md"), hashText("H"));      // Realm saved H

    await writeFile(p("a.md"), "X");            // an agent edits it away
    await settled(1);
    expect(events.map((e) => e.hash)).toEqual([hashText("X")]);

    await writeFile(p("a.md"), "H");            // and puts it back
    await settled(2);
    // The second event must NOT be suppressed, even though Realm itself wrote H earlier.
    expect(events.map((e) => e.hash)).toEqual([hashText("X"), hashText("H")]);
  });

  /**
   * The mutant a file-bound `fs.watch` would survive on macOS: atomic-rename saves still report, so
   * only this sequence separates the two implementations. A watcher bound to the file path goes deaf
   * the moment the path is unlinked and never recovers — which is what `git checkout`, `git stash`,
   * and any agent that rewrites rather than edits in place all do to a document.
   */
  it("keeps reporting after the file is deleted and recreated", async () => {
    await writeFile(p("a.md"), "v1");
    await w.watch(p("a.md"));

    await unlink(p("a.md"));
    await settled(1);
    expect(events.map((e) => e.hash)).toEqual([null]);

    await writeFile(p("a.md"), "reborn");
    await settled(2);
    expect(events.map((e) => e.hash)).toEqual([null, hashText("reborn")]);

    // And still hears the NEXT edit — the case a deaf watcher would also miss.
    await writeFile(p("a.md"), "after rebirth");
    await settled(3);
    expect(events.map((e) => e.hash)).toEqual([null, hashText("reborn"), hashText("after rebirth")]);
  });

  it("reports a deletion as a null hash", async () => {
    await writeFile(p("a.md"), "v1");
    await w.watch(p("a.md"));
    await unlink(p("a.md"));
    await settled(1);
    expect(events[0]).toEqual({ path: p("a.md"), hash: null });
  });

  it("says nothing when a file is touched without its content changing", async () => {
    await writeFile(p("a.md"), "same");
    await w.watch(p("a.md"));
    await writeFile(p("a.md"), "same");
    await quiet();
    expect(events).toEqual([]);
  });

  it("ignores other files in a watched directory", async () => {
    await writeFile(p("a.md"), "v1");
    await w.watch(p("a.md"));
    await writeFile(p("unrelated.md"), "noise");
    await quiet();
    expect(events).toEqual([]);
  });

  it("ignores its own atomic-save temp files", async () => {
    await writeFile(p("a.md"), "v1");
    await w.watch(p("a.md"));
    await writeFile(p(".realm-tmp-99-a.md"), "half-written");
    await quiet();
    expect(events).toEqual([]);
  });

  it("stops reporting after unwatch", async () => {
    await writeFile(p("a.md"), "v1");
    await w.watch(p("a.md"));
    w.unwatch(p("a.md"));
    await writeFile(p("a.md"), "v2");
    await quiet();
    expect(events).toEqual([]);
  });

  it("watches two files in one directory independently", async () => {
    await writeFile(p("a.md"), "a1");
    await writeFile(p("b.md"), "b1");
    await w.watch(p("a.md"));
    await w.watch(p("b.md"));
    await writeFile(p("b.md"), "b2");
    await settled(1);
    expect(events).toEqual([{ path: p("b.md"), hash: hashText("b2") }]);
  });

  it("is idempotent on repeated watch calls", async () => {
    await writeFile(p("a.md"), "v1");
    await w.watch(p("a.md"));
    await w.watch(p("a.md"));
    await writeFile(p("a.md"), "v2");
    await settled(1);
    await quiet();
    expect(events).toHaveLength(1); // not one event per watch() call
  });

  it("does not throw when asked to watch inside a directory that does not exist", async () => {
    await expect(w.watch(join(dir, "gone", "a.md"))).resolves.toBeUndefined();
  });
});
