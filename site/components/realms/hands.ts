/**
 * The reader's hand on the page's own realms from the keyboard: a realm key (RealmKey) pressed asks
 * for its realm's doorway to be thrown open, and the field takes the request on its next frame.
 */
const opened: string[] = []

/** Throw open the doorway of the realm whose chapter is `id`. */
export function openRealm(id: string) {
  opened.push(id)
  if (opened.length > 8) opened.shift()
}

/** The requests since the last frame, oldest first. */
export const takeOpened = () => opened.splice(0)
