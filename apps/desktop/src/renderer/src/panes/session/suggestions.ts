import type { AgentKind } from "@realm/contracts";

/** Static empty-state prompt starters per agent kind. The Ara refresh (§3) renders them as a
 *  The prompt each one fills is a plain sentence, not a brief: it lands in an empty composer that
 *  the user is about to edit, so it states the ask and stops. A starter that arrives pre-loaded
 *  with qualifiers is one the user has to read and delete before they can type.
 *  Ara refresh (§3) renders them as a single-column list of title-only rows — `description` stays in the data but is no longer drawn.
 *  Clicking fills the composer with `prompt`, never auto-sends. */
export const SUGGESTIONS: Record<AgentKind, { title: string; description: string; prompt: string }[]> = {
  claude: [
    { title: "Explore this project", description: "Structure, entry points, how it all fits", prompt: "Give me a tour of this project." },
    { title: "Fix a bug", description: "Describe a symptom, get a guided hunt", prompt: "Help me fix a bug." },
    { title: "Review my changes", description: "Bugs and style in uncommitted work", prompt: "Review my changes." },
    { title: "Write tests", description: "Cover what is not covered yet", prompt: "Write tests for whatever needs them most." },
  ],
  codex: [
    { title: "Build a feature", description: "Plan first, then write the code", prompt: "Help me plan a new feature." },
    { title: "Explain code", description: "What this codebase does, and where", prompt: "Explain what this codebase does." },
    { title: "Run the tests", description: "Run the suite and summarize failures", prompt: "Run the tests." },
    { title: "Review my changes", description: "Bugs and style in uncommitted work", prompt: "Review my changes." },
  ],
  "acp:cursor": [
    { title: "Refactor something", description: "Find the highest-value refactor", prompt: "Suggest a refactor worth doing." },
    { title: "Write tests", description: "Cover the least-tested critical module", prompt: "Write tests for whatever needs them most." },
  ],
  "acp:gemini": [
    { title: "Summarize this repo", description: "Purpose, stack, and layout", prompt: "Summarize this repo." },
  ],
  "acp:opencode": [
    { title: "Explain code", description: "What this codebase does, and where", prompt: "Explain what this codebase does." },
    { title: "Fix a bug", description: "Find and fix the most likely bug", prompt: "Find a bug and fix it." },
  ],
  "acp:copilot": [
    { title: "Review my changes", description: "Bugs and style in uncommitted work", prompt: "Review my changes." },
    { title: "Write tests", description: "Cover what is not covered yet", prompt: "Write tests for whatever needs them most." },
  ],
  "acp:goose": [
    { title: "Explain code", description: "What this codebase does, and where", prompt: "Explain what this codebase does." },
    { title: "Run the tests", description: "Run the suite and summarize failures", prompt: "Run the tests." },
  ],
  "acp:qwen": [
    { title: "Summarize this repo", description: "Purpose, stack, and layout", prompt: "Summarize this repo." },
    { title: "Refactor something", description: "Find the highest-value refactor", prompt: "Suggest a refactor worth doing." },
  ],
  "acp:grok": [
    { title: "Explain code", description: "What this codebase does, and where", prompt: "Explain what this codebase does." },
    { title: "Build a feature", description: "Plan first, then write the code", prompt: "Help me plan a new feature." },
  ],
  "acp:fx": [
    { title: "Summarize this repo", description: "Purpose, stack, and layout", prompt: "Summarize this repo." },
    { title: "Fix a bug", description: "Find and fix the most likely bug", prompt: "Find a bug and fix it." },
  ],
  // One-shot work only, matching what the harness can actually show: dsh-acp reports a turn's answer
  // whole, with no tool activity on the wire, so a starter that invites a long exploratory run would
  // stare back at the user in silence.
  "acp:deepseek": [
    { title: "Explain code", description: "What this codebase does, and where", prompt: "Explain what this codebase does." },
    { title: "Review my changes", description: "Bugs and style in uncommitted work", prompt: "Review my changes." },
  ],
  fake: [{ title: "Say hello", description: "A quick round trip through the fake agent", prompt: "Hello!" }],
};
