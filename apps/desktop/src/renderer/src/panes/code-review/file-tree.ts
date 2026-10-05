import type { PrFile } from "@realm/contracts";

export type TreeDir = { kind: "dir"; name: string; path: string; children: TreeNode[]; additions: number; deletions: number };
export type TreeFile = { kind: "file"; name: string; path: string; file: PrFile };
export type TreeNode = TreeDir | TreeFile;

const byName = (a: TreeNode, b: TreeNode) =>
  a.kind !== b.kind ? (a.kind === "dir" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/**
 * A request's changed files as a tree: folders first, each level in name order, a folder carrying the
 * lines its files changed. A run of folders that each hold only the next one is one row
 * (`src/ui/components`), as GitHub draws it — a column of single-child folders is depth with nothing
 * in it, and in a 260px column it pushes the file names off the end.
 */
export function fileTree(files: readonly PrFile[]): TreeNode[] {
  const root: TreeDir = { kind: "dir", name: "", path: "", children: [], additions: 0, deletions: 0 };
  for (const file of files) {
    const parts = file.path.split("/");
    let dir = root;
    dir.additions += file.additions; dir.deletions += file.deletions;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = dir.children.find((c): c is TreeDir => c.kind === "dir" && c.path === path);
      if (!next) { next = { kind: "dir", name: parts[i]!, path, children: [], additions: 0, deletions: 0 }; dir.children.push(next); }
      next.additions += file.additions; next.deletions += file.deletions;
      dir = next;
    }
    dir.children.push({ kind: "file", name: parts.at(-1)!, path: file.path, file });
  }
  const compact = (node: TreeNode): TreeNode => {
    if (node.kind === "file") return node;
    let dir = node;
    while (dir.children.length === 1 && dir.children[0]!.kind === "dir") {
      const only = dir.children[0] as TreeDir;
      dir = { ...only, name: `${dir.name}/${only.name}` };
    }
    return { ...dir, children: dir.children.map(compact).sort(byName) };
  };
  return root.children.map(compact).sort(byName);
}

/** The files a filter keeps: every word of it somewhere in the path, in any case — "ui view" finds
 *  `src/ui/views/article_view.dart`. */
export function filterFiles(files: readonly PrFile[], query: string): PrFile[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...files];
  return files.filter((f) => { const p = f.path.toLowerCase(); return words.every((w) => p.includes(w)); });
}

/** The tree as the rows the column draws, depth first, skipping what is under a folded folder. */
export function treeRows(nodes: readonly TreeNode[], folded: ReadonlySet<string>, depth = 0): { node: TreeNode; depth: number }[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...(node.kind === "dir" && !folded.has(node.path) ? treeRows(node.children, folded, depth + 1) : []),
  ]);
}
