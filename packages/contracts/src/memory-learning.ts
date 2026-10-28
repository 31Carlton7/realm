/**
 * Realm learning from finished sessions (whichever engine ran them) and keeping the profile's memory
 * repo tidy. One switch per profile, on its Memory page, stored as a setting so the server and the
 * page read the same row.
 */

/** The profile's "Learn from sessions" switch. Absent means on: the profile repo is where Realm keeps
 *  memory for every engine, and learning is how an engine with no memory of its own adds to it. */
export const memoryLearningKey = (profileId: string): string => `memory.learning:${profileId}`;

/** Whether a stored value leaves learning on. Only an explicit `false` turns it off — a settings row is
 *  user-editable JSON, and a garbled one must not quietly stop a feature the user never switched off. */
export const memoryLearningOn = (stored: unknown): boolean => stored !== false;
