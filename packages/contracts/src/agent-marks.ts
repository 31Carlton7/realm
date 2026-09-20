/**
 * How "an agent is controlling this" LOOKS, for the two implementations that have to agree.
 *
 * The mark is drawn in two places that can never share code. On a browser or simulator pane it is
 * injected INTO the page over CDP, because a `WebContentsView` composites above all DOM and nothing
 * the renderer paints beside one can reach it. On Realm's own surfaces — a terminal pane, the window
 * itself — it is an ordinary overlay in `styles.css`. Two surfaces, two transports, one appearance.
 *
 * `main/agent-cursor.ts` describes exactly this arrangement and says the appearance therefore has to
 * be "a number table both read". It could not itself be that table: it lives in `src/main`, and the
 * desktop app compiles main and renderer as separate composite projects, so a renderer file
 * importing it is a TypeScript error rather than a design decision. Contracts is the one place both
 * halves already reach.
 *
 * What belongs here is only what carries the MEANING — the ring's weight, the glow, the rate, how
 * long it outlives the last act. Geometry does not: the injected frame is flush to the page's
 * viewport because inside a page the pane's edge is somewhere else entirely, while a pane-scoped
 * overlay has a neighbour a flush ring would run into. Copying a number across a boundary that
 * changes what the number means is not parity, and `styles.css` says so beside the rule.
 */
export const AGENT_FRAME = {
  /** The ring, in CSS pixels, drawn inset so it sits inside whatever it frames rather than over the
   *  pixel next door. */
  ringPx: 2,
  /** The soft half: `box-shadow: inset 0 0 <blur>px <spread>px <accent>`. A negative spread is what
   *  keeps the wash at the edges instead of filling the middle — the frame has to leave the content
   *  it surrounds legible, which is the whole difference between a frame and a tint. */
  glowBlurPx: 48,
  glowSpreadPx: -12,
  /**
   * The pulse, in milliseconds.
   *
   * The SLOW rung of the in-flight ping family (`--ring-rate: 1.8s`, what `.status-dot[data-status=
   * "running"]` takes), not the 0.9s the `driving` dot uses. The dot is seven pixels and the frame
   * is a whole pane, and the stylesheet already writes down why that difference decides the rate.
   */
  pulseMs: 1800,
  /**
   * How long the mark stays after the last act, before fading itself out.
   *
   * Owned by whatever DRAWS it, in both implementations, and that is the point rather than an
   * implementation detail: a dead IPC, a crashed host or a lost `driving: false` must never be able
   * to leave a frame on someone's screen forever. Reset on every act, so a burst is one continuous
   * showing rather than a flicker per step.
   *
   * One number for a question with one answer — "how long after the last act does an agent stop
   * counting as driving" — which is also what `AGENT_CURSOR.idleMs` and `computer-driving.ts`'s
   * `LINGER_MS` are asking. Two answers to it is how they drift, and `agent-cursor.test.ts` holds
   * them equal.
   */
  lingerMs: 1500,
} as const;
