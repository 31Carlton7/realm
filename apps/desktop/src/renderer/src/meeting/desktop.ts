import { MEETING_CONSENT_KEY, VOICE_PREFS_KEY, meetingConsentAccepted } from "@realm/contracts";
import { rpc } from "../rpc/client";
import { WebVoiceAudio } from "../voice/audio-io";
import { MeetingTranscript, desktopTranscriptHelper } from "../voice/transcript";
import { readVoicePrefs } from "../voice/voice-prefs";
import { MeetingAssistant } from "./assistant";
import { noSummary } from "./seams";

/** The assistant on this Mac's speech helper, where this build has one. */
export function desktopMeetingAssistant(): MeetingAssistant | null {
  const helper = desktopTranscriptHelper();
  const bridge = window.realm?.meetingAssistant;
  if (!helper || !bridge) return null;
  // Dictation's microphone, read once; a change in Settings reaches the next panel page.
  let microphone: string | null = null;
  void rpc().call("settings.get", { key: VOICE_PREFS_KEY }).then(({ value }) => { microphone = readVoicePrefs(value).microphone; }).catch(() => {});
  return new MeetingAssistant({
    listen: (events) => new MeetingTranscript({ helper, audio: new WebVoiceAudio(microphone), events, systemAudio: true }),
    consent: {
      read: async () => meetingConsentAccepted((await rpc().call("settings.get", { key: MEETING_CONSENT_KEY })).value),
      accept: async () => { await rpc().call("settings.set", { key: MEETING_CONSENT_KEY, value: Date.now() }); },
    },
    setListening: (on) => bridge.setListening(on),
    summary: noSummary,
    answers: null,
    now: () => Date.now(),
  });
}
