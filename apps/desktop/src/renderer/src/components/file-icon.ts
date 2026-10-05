import type { IconName } from "@realm/ui";
import { artifactTypeOf, documentKindFor } from "@realm/contracts";
import { TYPE_ICON } from "./FileCard";

/**
 * Extensions the pack has a mark of its own for. A language it draws wears its badge (the TS and JS
 * squares Codex leads its file links with, `{ }` for JSON, the HTML and CSS shields), a format it
 * spells wears the page with its letters, and a shell script the terminal it runs in.
 */
const BY_EXT: Record<string, IconName> = {
  ts: "fileTs", mts: "fileTs", cts: "fileTs",
  js: "fileJs", mjs: "fileJs", cjs: "fileJs",
  jsx: "fileReact", tsx: "fileReact",
  json: "fileJson", jsonc: "fileJson", json5: "fileJson", webmanifest: "fileJson",
  py: "filePython", pyi: "filePython", pyw: "filePython",
  html: "fileHtml", htm: "fileHtml",
  css: "fileCss", scss: "fileCss", sass: "fileCss", less: "fileCss",
  java: "fileJava", php: "filePhp", sql: "fileSql", pdf: "filePdf",
  xml: "fileXml", plist: "fileXml", svg: "fileSvg",
  zip: "fileZip", tar: "fileZip", gz: "fileZip", tgz: "fileZip", rar: "fileZip", "7z": "fileZip",
  sh: "terminal", bash: "terminal", zsh: "terminal", fish: "terminal", command: "terminal",
};

/**
 * The mark a file wears wherever the transcript names it — a link in the prose, a row of a turn's
 * edits, the target of an edit's tool row: what KIND of file it is, before its name is read. Any
 * other source file is the page with `< >` on it, and everything else takes the Library's coarse
 * glyph for its type, so a picture named in a sentence and the same picture in the Library agree.
 */
export function fileIconFor(path: string): IconName {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  const own = BY_EXT[ext];
  if (own) return own;
  if (documentKindFor(name) === "code") return "fileCode";
  return TYPE_ICON[artifactTypeOf(ext)];
}
