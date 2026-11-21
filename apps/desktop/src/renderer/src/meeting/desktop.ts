import {
  HOLD_KEY_DEFAULT, KEYS_ASSISTANT_DEFAULT, KEYS_ASSISTANT_KEY, KEYS_HOLD_KEY, MEETING_AUTO_ANSWERS_DEFAULT, MEETING_AUTO_ANSWERS_KEY, MEETING_CONSENT_KEY,
  VOICE_PREFS_KEY, isHoldKey, meetingConsentAccepted, newId,
} from "@realm/contracts";
import { rpc } from "../rpc/client";
import { WebVoiceAudio } from "../voice/audio-io";
import { desktopLiveAnswers } from "../voice/live-answers";
import { MeetingTranscript, desktopTranscriptHelper } from "../voice/transcript";
import { readVoicePrefs } from "../voice/voice-prefs";
import { MeetingAssistant } from "./assistant";

/** The assistant on this Mac's speech helper, where this build has one. `spaceId` names the space a
 *  stopped meeting's notes are saved in. */
export function desktopMeetingAssistant(spaceId: () => string | null): MeetingAssistant | null {
  const helper = desktopTranscriptHelper();
  const bridge = window.realm?.meetingAssistant;
  const panel = window.realm?.quickChatPanel;
  if (!helper || !bridge || !panel) return null;
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
    answers: desktopLiveAnswers(),
    notes: {
      save: (params) => rpc().call("meetings.saveNotes", params),
      cancel: (meetingId) => rpc().call("meetings.cancelSummary", { meetingId }),
      onProgress: (cb) => rpc().on("meetings.notesProgress", cb),
    },
    spaceId,
    openFile: (space, path) => panel.openDocument({ spaceId: space, path }),
    now: () => Date.now(),
    newId,
    autoAnswers: {
      read: async () => {
        const { value } = await rpc().call("settings.get", { key: MEETING_AUTO_ANSWERS_KEY });
        return typeof value === "boolean" ? value : MEETING_AUTO_ANSWERS_DEFAULT;
      },
      write: async (on) => { await rpc().call("settings.set", { key: MEETING_AUTO_ANSWERS_KEY, value: on }); },
    },
    chords: {
      read: async () => {
        const [on, hold] = await Promise.all([KEYS_ASSISTANT_KEY, KEYS_HOLD_KEY].map(async (key) => (await rpc().call("settings.get", { key })).value));
        if (!(typeof on === "boolean" ? on : KEYS_ASSISTANT_DEFAULT)) return null;
        return isHoldKey(hold) ? hold : HOLD_KEY_DEFAULT;
      },
    },
    onShown: (on) => bridge.setShown?.(on),
  });
}
