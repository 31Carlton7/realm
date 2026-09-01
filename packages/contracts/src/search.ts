import { z } from "zod";
import { IdSchema } from "./ids";
import { ItemKindSchema } from "./entities";

/** Longest query the wire accepts. Anything a person types in a palette fits; anything longer is a
 *  paste that FTS would only choke on. */
export const SEARCH_QUERY_MAX = 256;
/** Default and ceiling for per-group result counts. The palette appends below its instant rows, so a
 *  group is a glance, not a page. */
export const SEARCH_GROUP_LIMIT = 8;
export const SEARCH_GROUP_LIMIT_MAX = 20;

/**
 * A snippet as alternating runs of plain and matched text. Sent as segments rather than a marked-up
 * string so the renderer never parses markers out of user content (transcript text can contain any
 * bytes, including whatever marker we might have chosen).
 */
export const SearchSnippetSchema = z.array(z.object({ text: z.string(), match: z.boolean() }));
export type SearchSnippet = z.infer<typeof SearchSnippetSchema>;

/** One transcript hit: a user/assistant event whose text matched. `seq` names the exact event, should
 *  a future transcript learn to scroll to it; today Enter opens the session. */
export const SessionSearchHitSchema = z.object({
  sessionId: IdSchema,
  spaceId: IdSchema,
  /** The session's current title — display, not match material. */
  title: z.string(),
  seq: z.number().int(),
  snippet: SearchSnippetSchema,
});
export type SessionSearchHit = z.infer<typeof SessionSearchHitSchema>;

export const ItemSearchHitSchema = z.object({
  itemId: IdSchema,
  spaceId: IdSchema,
  itemKind: ItemKindSchema,
  title: z.string(),
  snippet: SearchSnippetSchema,
});
export type ItemSearchHit = z.infer<typeof ItemSearchHitSchema>;

export const SkillSearchHitSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  snippet: SearchSnippetSchema,
});
export type SkillSearchHit = z.infer<typeof SkillSearchHitSchema>;

/** A memory-document hit: this profile's own doc, or one of its spaces' docs. Exactly one of
 *  `profileId`/`spaceId` is set — it is where Enter navigates. */
export const MemorySearchHitSchema = z.object({
  scope: z.enum(["profile", "space"]),
  profileId: IdSchema.nullable(),
  spaceId: IdSchema.nullable(),
  /** What to call the document: the space's name, or the profile's. */
  title: z.string(),
  snippet: SearchSnippetSchema,
});
export type MemorySearchHit = z.infer<typeof MemorySearchHitSchema>;

/**
 * `search.query`'s answer, grouped the way the palette renders it. Every group is scoped to the ONE
 * profile the caller named — a Work search never carries a School transcript, and the scoping is
 * enforced server-side at query time (the space→profile join), never by the client filtering.
 */
export const SearchResultsSchema = z.object({
  sessions: z.array(SessionSearchHitSchema),
  items: z.array(ItemSearchHitSchema),
  skills: z.array(SkillSearchHitSchema),
  memory: z.array(MemorySearchHitSchema),
});
export type SearchResults = z.infer<typeof SearchResultsSchema>;
