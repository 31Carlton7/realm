export const REALM_ITEM_TYPE = "application/x-realm-item";
export const REALM_NEW_SESSION_TYPE = "application/x-realm-new-session";

export function isRealmPaneDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  if (!e.dataTransfer) return false;
  const types = Array.from(e.dataTransfer.types);
  return types.includes(REALM_ITEM_TYPE) || types.includes(REALM_NEW_SESSION_TYPE);
}
