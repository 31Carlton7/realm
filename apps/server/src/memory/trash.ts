import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { RpcError } from "../store/rows";

const run = promisify(execFile);
/** macOS's own command (macOS 15 and later): the Finder's move, so Put Back knows where the file was. */
const TRASH_BIN = "/usr/bin/trash";

/**
 * Move a file to the Trash. Where the Mac has no `trash` command, the file goes into `~/.Trash` under
 * a name of its own, the way the Finder names a second file of one name — kept, but without Put Back.
 */
export async function moveToTrash(path: string, userHome: string): Promise<void> {
  if (process.platform !== "darwin") throw new RpcError("MEMORY_NO_TRASH", "Realm moves files to the Trash only on a Mac");
  if (existsSync(TRASH_BIN)) {
    await run(TRASH_BIN, [path]);
    return;
  }
  const bin = join(userHome, ".Trash");
  mkdirSync(bin, { recursive: true });
  const ext = extname(path);
  const stem = basename(path, ext);
  let to = join(bin, basename(path));
  for (let n = 2; existsSync(to); n++) to = join(bin, `${stem} ${n}${ext}`);
  renameSync(path, to);
}
