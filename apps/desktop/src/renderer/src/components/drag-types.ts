export const REALM_ITEM_TYPE = "application/x-realm-item";
export const REALM_NEW_SESSION_TYPE = "application/x-realm-new-session";

/** A drag carrying files in from outside the app — the discriminator against Realm's own drags.
 *  `Files` is the type Chromium puts on a Finder drag and nothing sets it internally, so the two
 *  vocabularies cannot collide: `isRealmPaneDrag` and this are never both true. */
export function carriesFiles(e: { dataTransfer: DataTransfer | null }): boolean {
  return e.dataTransfer?.types?.includes("Files") ?? false;
}

export function isRealmPaneDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  if (!e.dataTransfer) return false;
  const types = Array.from(e.dataTransfer.types);
  return types.includes(REALM_ITEM_TYPE) || types.includes(REALM_NEW_SESSION_TYPE);
}
