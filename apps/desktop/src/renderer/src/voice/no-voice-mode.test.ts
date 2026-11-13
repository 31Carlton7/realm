import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Methods } from "@realm/contracts";

/** This build dictates and does not converse: voice mode (#287) is held back, and nothing a person can
 *  reach may open it. */
const renderer = join(__dirname, "..");
const read = (path: string) => readFileSync(join(renderer, path), "utf8");

describe("dictation without voice mode", () => {
  it("has no voice view, wave button or spoken send to import", () => {
    expect(readdirSync(__dirname).filter((f) => /^Voice(View|Button)\b|voice-session|reply-reader|narrator/.test(f))).toEqual([]);
    for (const file of ["panes/session/Composer.tsx", "panes/session/SessionPane.tsx", "App.tsx", "keys/commands.ts", "state/store.ts"]) {
      // THE MUTANT: the composer imports the voice view or its button again.
      expect(read(file), file).not.toMatch(/voice\/(VoiceView|VoiceButton|voice-session)|openVoice|sendSpoken/);
    }
  });

  it("gives the UI no RPC that sends a message as spoken", () => {
    expect(Object.keys(Methods).filter((m) => /voice/i.test(m))).toEqual([]);
    expect(Methods["sessions.send"].params.safeParse({ id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", text: "hi", spoken: true }).data).not.toHaveProperty("spoken");
  });
});
