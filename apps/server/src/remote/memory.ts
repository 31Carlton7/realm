import { basename } from "node:path";
import { isSecretPath, MEMORY_LIBRARY_GROUP_LABEL, memoryLearningKey, memoryLearningOn, type MemoryLibraryEntry, type MemoryLibraryFile, type MemoryLibraryGroup, type MemoryLibrarySource } from "@realm/contracts";
import { MEMORY_PLACE_HEAD, MEMORY_ROW_TEXT_MAX, MEMORY_TEXT_MAX, type MobileParams, type MobileResult } from "@realm/remote";
import { SPACES_DIR } from "../memory/repo";
import { secretShapeIn } from "../memory/secret-shapes";
import type { RpcPort } from "./rpc-port";

/**
 * The memory library as a phone reads it, through the desktop's own `memory.library.*` calls: the same
 * files, the same commits, the same yes for a file outside Realm. A phone is on the other side of a
 * network, so it is also held to what the rest of mobile.v1 keeps: a list is paged and its rows bounded,
 * a row does not carry the file's path, and a file that holds a secret is not sent. Memory is never meant
 * to hold a credential, but an agent's own CLAUDE.md is not Realm's to check when it is written.
 */

type Row = MobileResult<"memory.list">["entries"][number];
type Place = Omit<MobileResult<"memory.overview">["places"][number], "count" | "entries">;
type SpaceOf = { id: string; name: string; profileId: string };

/** What a phone is refused here, in words it can show. */
export class MemoryRefused extends Error {}

const AGENT_ORDER: readonly MemoryLibraryGroup[] = ["claude", "codex", "cursor", "gemini"];
const SECRET_MEMORY_REFUSAL = "That memory looks like it holds a key or a token, so Realm does not send it to a phone.";

const sourceName = (s: MemoryLibrarySource | undefined): string =>
  !s ? "" : s.group === "realm" ? s.label : `${MEMORY_LIBRARY_GROUP_LABEL[s.group]} · ${s.label}`;

const cut = (text: string): string => (text.length <= MEMORY_ROW_TEXT_MAX ? text : `${text.slice(0, MEMORY_ROW_TEXT_MAX - 1).trimEnd()}…`);

/** What a row says of a file, without what looks like a secret: a file's own lines, never read here whole. */
const said = (text: string | null): string | null => (text === null || secretShapeIn(text) ? null : cut(text));

function phoneRow(e: MemoryLibraryEntry, source: MemoryLibrarySource | undefined): Row {
  return {
    id: e.id, title: said(e.title) ?? basename(e.rel), description: said(e.description), type: e.type,
    source: sourceName(source), folder: e.folder, index: e.index, updatedAt: e.updatedAt, match: said(e.match),
  };
}

/** The place a memory belongs to: a space's where it is that space's, every space's where it is the
 *  profile's own, and its agent's where an agent keeps it for all of them. */
function placeOf(profileId: string, e: MemoryLibraryEntry, source: MemoryLibrarySource | undefined, spaces: readonly SpaceOf[]): Place {
  const everySpace: Place = { id: `every:${profileId}`, profileId, kind: "every", spaceId: null, title: "Every space" };
  const inSpace = (sp: SpaceOf | undefined): Place | null => sp ? { id: `space:${sp.id}`, profileId, kind: "space", spaceId: sp.id, title: sp.name } : null;
  if (!source) return everySpace;
  if (source.spaceId) return inSpace(spaces.find((sp) => sp.id === source.spaceId)) ?? everySpace;
  if (source.group !== "realm") return { id: `agent:${source.group}`, profileId, kind: "agent", spaceId: null, title: MEMORY_LIBRARY_GROUP_LABEL[source.group] };
  // A space's memory document is named by its id; a space's folder of the profile's repo is labelled by its name.
  const doc = e.rel.replace(/\.md$/, "");
  const owner = spaces.find((sp) => sp.id === doc)
    ?? (e.rel.startsWith(`${SPACES_DIR}/`) && e.folder ? spaces.find((sp) => e.folder === sp.name || e.folder!.startsWith(`${sp.name}/`)) : undefined);
  return inSpace(owner) ?? everySpace;
}

async function listing(rpc: RpcPort, profileId: string, query: string): Promise<{ sources: MemoryLibrarySource[]; entries: MemoryLibraryEntry[]; spaces: SpaceOf[]; byId: Map<string, MemoryLibrarySource> }> {
  const [{ sources }, { entries }, spaces] = await Promise.all([
    rpc.call("memory.library.sources", { profileId }),
    rpc.call("memory.library.list", { profileId, ...(query ? { query } : {}) }),
    rpc.call("spaces.list", {}),
  ]);
  return {
    sources, spaces: spaces.filter((sp) => sp.profileId === profileId), byId: new Map(sources.map((s) => [s.id, s])),
    entries: entries.filter((e) => !isSecretPath(e.path)),
  };
}

export async function memoryOverview(rpc: RpcPort, profileId: string): Promise<MobileResult<"memory.overview">> {
  const [{ sources, entries, spaces, byId }, learning] = await Promise.all([
    listing(rpc, profileId, ""),
    rpc.call("settings.get", { key: memoryLearningKey(profileId) }),
  ]);
  const places = new Map<string, MobileResult<"memory.overview">["places"][number]>();
  for (const e of entries) {
    const source = byId.get(e.sourceId);
    const place = placeOf(profileId, e, source, spaces);
    const held = places.get(place.id) ?? { ...place, count: 0, entries: [] };
    held.count += 1;
    if (held.entries.length < MEMORY_PLACE_HEAD) held.entries.push(phoneRow(e, source));
    places.set(place.id, held);
  }
  const homes = sources.filter((s) => s.creatable).flatMap((s) => s.spaceId !== null
    ? [{ sourceId: s.id, spaceId: null, label: s.label }]
    : [{ sourceId: s.id, spaceId: null, label: `${s.label} · every space` }, ...spaces.map((sp) => ({ sourceId: s.id, spaceId: sp.id, label: `${s.label} · ${sp.name}` }))]);
  const rank = (p: Place): number => (p.kind === "every" ? -1 : p.kind === "space" ? spaces.findIndex((sp) => sp.id === p.spaceId) : spaces.length + AGENT_ORDER.indexOf(p.id.slice("agent:".length) as MemoryLibraryGroup));
  return { places: [...places.values()].sort((a, b) => rank(a) - rank(b)), homes, learning: memoryLearningOn(learning.value) };
}

export async function memoryList(rpc: RpcPort, p: MobileParams<"memory.list">): Promise<MobileResult<"memory.list">> {
  const { entries, spaces, byId } = await listing(rpc, p.profileId, p.query);
  const shown = p.place === undefined ? entries : entries.filter((e) => placeOf(p.profileId, e, byId.get(e.sourceId), spaces).id === p.place);
  const end = p.offset + p.limit;
  return { entries: shown.slice(p.offset, end).map((e) => phoneRow(e, byId.get(e.sourceId))), total: shown.length, next: end < shown.length ? end : null };
}

function phoneFile(f: MemoryLibraryFile, source: MemoryLibrarySource | undefined): MobileResult<"memory.file"> {
  if (isSecretPath(f.path) || secretShapeIn(f.text)) throw new MemoryRefused(SECRET_MEMORY_REFUSAL);
  const tooLong = f.text.length > MEMORY_TEXT_MAX;
  return {
    ...phoneRow(f, source), displayPath: f.displayPath, text: tooLong ? "" : f.text, body: tooLong ? f.body.slice(0, MEMORY_TEXT_MAX) : f.body,
    frontmatter: f.frontmatter, links: f.links, readBy: f.readBy, external: f.external,
    writable: f.writable && !tooLong, deletable: f.deletable,
    note: tooLong ? "This file is too long to read whole or edit on a phone. The rest is on your Mac." : f.note,
  };
}

export async function memoryFile(rpc: RpcPort, id: string, profileId: string): Promise<MobileResult<"memory.file">> {
  const [file, { sources }] = await Promise.all([rpc.call("memory.library.read", { id, profileId }), rpc.call("memory.library.sources", { profileId })]);
  return phoneFile(file, sources.find((s) => s.id === file.sourceId));
}

export async function memoryWrite(rpc: RpcPort, p: MobileParams<"memory.write">): Promise<MobileResult<"memory.write">> {
  if (p.baseUpdatedAt !== undefined) {
    const held = await rpc.call("memory.library.read", { id: p.id });
    if (held.updatedAt !== p.baseUpdatedAt) throw new MemoryRefused("This memory changed on your Mac after you opened it. Open it again before you save.");
  }
  await rpc.call("memory.library.write", { id: p.id, text: p.text, confirmExternal: p.confirmExternal });
  return await memoryFile(rpc, p.id, p.profileId);
}

export async function memoryCreate(rpc: RpcPort, p: MobileParams<"memory.create">): Promise<MobileResult<"memory.create">> {
  const { profileId, ...made } = p;
  const entry = await rpc.call("memory.library.create", made);
  return await memoryFile(rpc, entry.id, profileId);
}

export async function memorySetLearning(rpc: RpcPort, profileId: string, on: boolean): Promise<MobileResult<"memory.setLearning">> {
  await rpc.call("settings.set", { key: memoryLearningKey(profileId), value: on });
  return { on };
}
