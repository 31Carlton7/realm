/**
 * What a person chooses to put in a shared page. Its own module so the sheet that asks can load
 * without the page builder, which brings the highlighter and is only fetched once someone shares.
 */
export type ShareOptions = {
  /** Each call's input and output under its line. Off, a call is its line and nothing more. */
  tools: boolean;
  /** The agent's thinking, folded under its own line. Off unless asked for. */
  thinking: boolean;
  /** Attached and drawn pictures, inside the file. Off, a picture is its name. */
  images: boolean;
  /** What each sub-agent did, nested under the line that started it. Off, a sub-agent is its line. */
  subagents: boolean;
  /** `/Users/<name>` and its kin written as `~`, wherever a path starts. */
  hidePaths: boolean;
};

export const DEFAULT_SHARE_OPTIONS: ShareOptions = { tools: true, thinking: false, images: true, subagents: true, hidePaths: true };
