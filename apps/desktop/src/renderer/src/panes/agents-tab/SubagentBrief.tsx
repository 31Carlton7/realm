import { Icon, type IconName } from "@realm/ui";
import { useMemo } from "react";
import { FileMark } from "../../components/file-icon";
import { useResolvedFiles, type FileLinkContext } from "../session/file-links";
import { Markdown } from "../session/Markdown";
import { briefSections, placeOf, readList, saysMore, type BriefFileItem, type BriefKind, type BriefPlace, type BriefSection } from "./brief-sections";

const ICON: Record<BriefKind, IconName> = {
  where: "folder", read: "book", build: "tool", rules: "shield", check: "checkCircle", report: "report", other: "note",
};

const baseOf = (p: string) => p.replace(/\/+$/, "").split("/").pop() ?? p;
const dirOf = (p: string) => { const t = p.replace(/\/+$/, ""); const at = t.lastIndexOf("/"); return at > 0 ? t.slice(0, at) : ""; };

/**
 * What a sub-agent was asked, drawn as the parts its lead wrote it in: each a head with its mark, the
 * place it works as a chip with the branch, the files to read first as chips that open them, and the
 * work itself as the prose it is — rendered Markdown at a reading measure, where it had been one
 * bubble of raw text as wide as the panel.
 *
 * `files` is the checkout the brief's paths are read against, and how a file opens; without it a
 * file is named and opens nothing. `env` is where the app knows the sub-agent works, for a "Where
 * you work" that names the place in words rather than by its path.
 */
export function SubagentBrief({ text, files, env }: { text: string; files?: FileLinkContext; env?: BriefPlace | null }) {
  const sections = useMemo(() => briefSections(text), [text]);
  const lists = useMemo(() => sections.map((s) => (s.kind === "read" ? readList(s.body) : null)), [sections]);
  const refs = useMemo(() => lists.flatMap((l) => l?.map((i) => i.file.ref) ?? []), [lists]);
  const resolved = useResolvedFiles(refs, files);
  return (
    <div className="subagent-brief">
      {sections.map((s, i) => (
        <section key={i} className="subagent-brief-part" data-kind={s.kind}>
          {s.label !== null && <h4 className="subagent-brief-head"><Icon name={ICON[s.kind]} size={14} />{s.label}</h4>}
          {s.kind === "where" ? <Where section={s} env={env ?? null} files={files} />
            : lists[i] ? <FileList items={lists[i]!} resolved={resolved} files={files} />
            : s.body && <Markdown text={s.body} className="subagent-brief-prose" files={files} />}
        </section>
      ))}
    </div>
  );
}

/** The place, as a chip: the folder's name and the branch, with the folder it sits in after it. The
 *  section's sentence follows only when it says more than the chip does ("never touch the real home"). */
function Where({ section, env, files }: { section: BriefSection; env: BriefPlace | null; files?: FileLinkContext }) {
  const named = placeOf(section.body);
  const place = named ?? env;
  const branch = place?.branch ?? (env && named && sameDir(named.path, env.path) ? env.branch : null);
  const more = place ? saysMore(section.body, [place.path, ...(branch ? [branch] : [])]) : true;
  return (
    <>
      {place && (
        <div className="subagent-brief-place">
          <span className="subagent-brief-chip" title={place.path}>
            <FileMark path={place.path} folder size={14} />
            <span className="subagent-brief-chip-name">{baseOf(place.path)}</span>
            {branch && <span className="subagent-brief-branch" title={`Branch ${branch}`}><Icon name="branch" size={12} />{branch}</span>}
          </span>
          {dirOf(place.path) && <span className="subagent-brief-dir" data-selectable title={place.path}><bdi>{dirOf(place.path)}</bdi></span>}
        </div>
      )}
      {more && section.body && <Markdown text={section.body} className="subagent-brief-prose" files={files} />}
    </>
  );
}

const sameDir = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "");

/** The files to read first, one a row: the file as a chip that opens it the way a file named in a
 *  transcript opens, beside the session, and the lead's note about it after. A file the disk has not
 *  confirmed in this checkout is named and does not pretend to open. */
function FileList({ items, resolved, files }: { items: readonly BriefFileItem[]; resolved: ReadonlyMap<string, string>; files?: FileLinkContext }) {
  return (
    <ul className="subagent-brief-files">
      {items.map(({ file, note }, i) => {
        const path = resolved.get(file.ref);
        const inner = (
          <>
            <FileMark path={file.ref} size={14} />
            <span className="subagent-brief-chip-name">{baseOf(file.label)}</span>
            {dirOf(file.label) && <span className="subagent-brief-chip-dir">{dirOf(file.label)}</span>}
            {file.line !== null && <span className="subagent-brief-chip-dir">{`:${file.line}`}</span>}
          </>
        );
        return (
          <li key={i} className="subagent-brief-file">
            {path && files
              ? <button type="button" className="subagent-brief-chip" data-file="" title={`Open ${path}`} onClick={() => files.onOpen(path, file.line)}>{inner}</button>
              : <span className="subagent-brief-chip" data-file="" title={file.ref}>{inner}</span>}
            {note && <Markdown text={note} className="subagent-brief-note" files={files} />}
          </li>
        );
      })}
    </ul>
  );
}
