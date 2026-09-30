/**
 * What an acting tool tells whoever is watching the step — today the Laya shadow (`laya/shadow.ts`),
 * which asks the local decision model what it would have done and logs that next to what the agent
 * actually did. A seam rather than a dependency on Laya: the tools only report. They never wait on an
 * observer, and never change course for what one thinks.
 */

/** One on-screen element as an observer sees it: enough to name it, never its pixels. */
export type ObservedElement = { id: string; role: string; label: string; value?: string };

export type ActObservation = {
  /** Which tool family acted. */
  surface: "simulator" | "computer" | "browser";
  spaceId: string;
  sessionId: string;
  /** The tool's own name, e.g. `simulator_tap`. */
  tool: string;
  /** What the agent said the step is for — the simulator input tools' required `intent`, the optional
   *  one `computer_act` and `browser_act` take (empty when left out), a walk's own. */
  intent: string;
  /** The elements on screen when the agent chose, as the tool read them — the live tree, or the
   *  snapshot the agent was acting from. */
  elements: readonly ObservedElement[];
  /** What the agent actually addressed: an element from `elements`, a point, or nothing (a key, a swipe). */
  chosen: { element: ObservedElement } | { point: { x: number; y: number } } | null;
  /** Who picked `chosen`: the agent (by number or point), or Laya from the agent's words in Assist.
   *  Absent means the agent — every tool but Assist's path. A step Laya chose is not the agent's
   *  choice, and must never be learned from as one. */
  chosenBy?: "agent" | "laya";
  /** The app on screen, as its tree names itself ("Instagram"); absent when the tool does not know.
   *  What a step means depends on where it is: a Like is one other people see only in an app like that. */
  app?: string;
};

/**
 * Called by an acting tool AFTER its permission gate and BEFORE it acts. It must not throw, and it
 * returns at once: an observer does its work off the action's path. The function it may return is
 * handed the elements read after the act — by a tool that re-reads the screen anyway; a tool that does
 * not simply never calls it.
 */
export type ActObserver = (o: ActObservation) => ((after: readonly ObservedElement[]) => void) | void;
