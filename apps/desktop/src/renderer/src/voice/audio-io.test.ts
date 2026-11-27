import { afterEach, describe, expect, it, vi } from "vitest";
import { WebVoiceAudio } from "./audio-io";

afterEach(() => { vi.unstubAllGlobals(); });

function fakeMicrophone() {
  const track = { onended: null as null | (() => void), stop: vi.fn() };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => stream } });
  const node = { connect: () => {}, onaudioprocess: null };
  vi.stubGlobal("AudioContext", class {
    sampleRate = 48_000;
    destination = {};
    createMediaStreamSource() { return node; }
    createScriptProcessor() { return node; }
    async close() {}
  });
  return track;
}

describe("WebVoiceAudio", () => {
  it("says when the microphone goes away while it is open", async () => {
    const track = fakeMicrophone();
    const lost = vi.fn();
    await new WebVoiceAudio().start(() => {}, lost);
    track.onended?.();
    expect(lost).toHaveBeenCalledOnce();
  });
});
