import type { AgentKind } from "@realm/contracts";

/** Static empty-state prompt starters per agent kind (spec §3): fill the composer, never auto-send. */
export const SUGGESTIONS: Record<AgentKind, { title: string; prompt: string }[]> = {
  claude: [
    { title: "Explore this project", prompt: "Give me a tour of this project: structure, entry points, and how the pieces fit together." },
    { title: "Fix a bug", prompt: "Help me track down a bug. I'll describe the symptom; ask me what you need." },
    { title: "Review my changes", prompt: "Review my uncommitted changes for bugs and style issues." },
  ],
  codex: [
    { title: "Build a feature", prompt: "I want to add a new feature. Let's plan it before writing code." },
    { title: "Explain code", prompt: "Explain what this codebase does and where its core logic lives." },
    { title: "Run the tests", prompt: "Run the test suite and summarize any failures." },
  ],
  "acp:cursor": [
    { title: "Refactor something", prompt: "Suggest the highest-value refactor in this codebase and carry it out." },
    { title: "Write tests", prompt: "Find the least-tested critical module and add tests for it." },
  ],
  "acp:gemini": [
    { title: "Summarize this repo", prompt: "Summarize this repository: purpose, stack, and layout." },
  ],
  fake: [{ title: "Say hello", prompt: "Hello!" }],
};
