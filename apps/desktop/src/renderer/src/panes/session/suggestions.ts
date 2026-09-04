import type { AgentKind } from "@realm/contracts";

/** Static empty-state prompt starters per agent kind. The Ara refresh (§3) renders them as a
 *  single-column list of title-only rows — `description` stays in the data but is no longer drawn.
 *  Clicking fills the composer with `prompt`, never auto-sends. */
export const SUGGESTIONS: Record<AgentKind, { title: string; description: string; prompt: string }[]> = {
  claude: [
    { title: "Explore this project", description: "Structure, entry points, how it all fits", prompt: "Give me a tour of this project: structure, entry points, and how the pieces fit together." },
    { title: "Fix a bug", description: "Describe a symptom, get a guided hunt", prompt: "Help me track down a bug. I'll describe the symptom; ask me what you need." },
    { title: "Review my changes", description: "Bugs and style in uncommitted work", prompt: "Review my uncommitted changes for bugs and style issues." },
    { title: "Write tests", description: "Cover what is not covered yet", prompt: "Find the least-covered part of this code and write tests for it." },
  ],
  codex: [
    { title: "Build a feature", description: "Plan first, then write the code", prompt: "I want to add a new feature. Let's plan it before writing code." },
    { title: "Explain code", description: "What this codebase does, and where", prompt: "Explain what this codebase does and where its core logic lives." },
    { title: "Run the tests", description: "Run the suite and summarize failures", prompt: "Run the test suite and summarize any failures." },
    { title: "Review my changes", description: "Bugs and style in uncommitted work", prompt: "Review my uncommitted changes for bugs and style issues." },
  ],
  "acp:cursor": [
    { title: "Refactor something", description: "Find the highest-value refactor", prompt: "Suggest the highest-value refactor in this codebase and carry it out." },
    { title: "Write tests", description: "Cover the least-tested critical module", prompt: "Find the least-tested critical module and add tests for it." },
  ],
  "acp:gemini": [
    { title: "Summarize this repo", description: "Purpose, stack, and layout", prompt: "Summarize this repository: purpose, stack, and layout." },
  ],
  "acp:opencode": [
    { title: "Explain code", description: "What this codebase does, and where", prompt: "Explain what this codebase does and where its core logic lives." },
    { title: "Fix a bug", description: "Find and fix the most likely bug", prompt: "Find the most likely bug in this codebase and fix it." },
  ],
  "acp:copilot": [
    { title: "Review my changes", description: "Bugs and style in uncommitted work", prompt: "Review my uncommitted changes for bugs and style issues." },
    { title: "Write tests", description: "Cover what is not covered yet", prompt: "Find the least-covered part of this code and write tests for it." },
  ],
  "acp:goose": [
    { title: "Explain code", description: "What this codebase does, and where", prompt: "Explain what this codebase does and where its core logic lives." },
    { title: "Run the tests", description: "Run the suite and summarize failures", prompt: "Run the test suite and summarize any failures." },
  ],
  "acp:qwen": [
    { title: "Summarize this repo", description: "Purpose, stack, and layout", prompt: "Summarize this repository: purpose, stack, and layout." },
    { title: "Refactor something", description: "Find the highest-value refactor", prompt: "Suggest the highest-value refactor in this codebase and carry it out." },
  ],
  "acp:grok": [
    { title: "Explain code", description: "What this codebase does, and where", prompt: "Explain what this codebase does and where its core logic lives." },
    { title: "Build a feature", description: "Plan first, then write the code", prompt: "I want to add a new feature. Let's plan it before writing code." },
  ],
  "acp:fx": [
    { title: "Summarize this repo", description: "Purpose, stack, and layout", prompt: "Summarize this repository: purpose, stack, and layout." },
    { title: "Fix a bug", description: "Find and fix the most likely bug", prompt: "Find the most likely bug in this codebase and fix it." },
  ],
  // One-shot work only, matching what the harness can actually show: dsh-acp reports a turn's answer
  // whole, with no tool activity on the wire, so a starter that invites a long exploratory run would
  // stare back at the user in silence.
  "acp:deepseek": [
    { title: "Explain code", description: "What this codebase does, and where", prompt: "Explain what this codebase does and where its core logic lives." },
    { title: "Review my changes", description: "Bugs and style in uncommitted work", prompt: "Review my uncommitted changes for bugs and style issues." },
  ],
  fake: [{ title: "Say hello", description: "A quick round trip through the fake agent", prompt: "Hello!" }],
};
