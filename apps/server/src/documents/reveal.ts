import { execFile } from "node:child_process";
import { dirname } from "node:path";

/**
 * A file selected in the system's file manager, for `docs_reveal`. The server runs as its own process
 * beside the window, and `open -R` is the Finder's own "reveal" — the same thing Reveal in Finder does
 * from a menu in the app. Elsewhere the folder it is in is opened, which is as near as those file
 * managers come. Never a shell: the path is whatever the agent named.
 */
export function revealInFinder(abs: string, platform: NodeJS.Platform = process.platform,
  run: (bin: string, args: string[]) => Promise<void> = execOnce): Promise<void> {
  if (platform === "darwin") return run("open", ["-R", "--", abs]);
  if (platform === "win32") return run("explorer.exe", [`/select,${abs}`]);
  return run("xdg-open", [dirname(abs)]);
}

const execOnce = (bin: string, args: string[]): Promise<void> => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: 10_000 }, (err) => (err ? reject(err) : resolve()));
});
