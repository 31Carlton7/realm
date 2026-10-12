/** The hero concepts in the lab, in switcher order. Digit keys 0–4 go to each by its index. */
export const concepts = [
  { slug: "current", name: "Current", claim: "Today's hero: the corridor of frames receding behind the product." },
  { slug: "doorway", name: "Doorway", claim: "The way in: light from inside the realm pours out through the window into the room." },
  { slug: "hive", name: "Hive", claim: "A realm for every project: a field of spaces, lit where an agent is at work." },
  { slug: "streams", name: "Streams", claim: "Bring the agent you already use: every agent's light runs into one workspace." },
  { slug: "world", name: "World", claim: "A world to work in: the workspace above the lit edge of a planet." },
] as const

export type ConceptSlug = (typeof concepts)[number]["slug"]
