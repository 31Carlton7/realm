import { AGENT_META } from "@realm/contracts";
import { Icon, TeammateIcon } from "@realm/ui";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { StoreApi } from "zustand";
import { prefersReducedMotion } from "../reduced-motion";
import { useApp, useAppStore, type AppState } from "../state/store";
import { WebVoiceAudio, type VoiceAudio } from "./audio-io";
import { desktopSpeechHelper } from "./protocol";
import { VoiceSession, type VoiceSessionPort, type VoiceSnapshot } from "./voice-session";

/** The session voice mode talks to, read from the store as it changes. */
function sessionPort(store: StoreApi<AppState>, id: string): VoiceSessionPort {
  const get = () => store.getState();
  return {
    transcript: () => get().transcripts[id]?.t ?? null,
    busy: () => {
      const status = get().sessionStatus[id] ?? get().sessions[id]?.status;
      return status === "running" || status === "waiting_permission";
    },
    subscribe: (cb) => {
      let last = get().transcripts[id];
      return store.subscribe((s) => { if (s.transcripts[id] !== last) { last = s.transcripts[id]; cb(); } });
    },
    // Through `run`, so a failure is the window's toast like any other; voice mode goes on listening.
    send: async (text) => get().run(() => get().sendSpoken(id, text)),
    interrupt: async () => get().run(() => get().interruptSession(id)),
    decide: async (requestId, decision) => get().run(() => get().respondPermission(id, requestId, decision)),
  };
}

export const STARTING: VoiceSnapshot = { phase: "starting", partial: "", heard: null, said: null, muted: false, held: false, problem: null, microphoneDenied: false };

/** What the line under the waveforms says, by phase. */
function stateLine(s: VoiceSnapshot, handsFree: boolean, name: string): string {
  switch (s.phase) {
    case "starting": return "Starting…";
    case "hearing": return "Listening";
    case "listening": return s.muted ? "Muted. Hold Space to talk" : handsFree ? "Listening" : "Hold Space to talk";
    case "speaking": return `${name} is speaking`;
    case "working": return `${name} is working`;
    case "unavailable": return "Voice mode is off";
  }
}

/**
 * Voice mode: a conversation with one session — or a teammate, whose chat is its session — over the
 * whole window. Its words go into the session as the person's own messages, marked as spoken, and its
 * replies are read back; the transcript under it keeps all of it.
 *
 * It replaces what it covers rather than sitting on it (design.md): the browser views step aside, the
 * window's chords stand down, and Escape is its own — it stops Realm talking or the agent working, and
 * leaves only when there is nothing to stop.
 */
export function VoiceView() {
  const voice = useApp((s) => s.voice);
  if (!voice) return null;
  return <VoiceWindow key={voice.sessionId} sessionId={voice.sessionId} held={voice.held} />;
}

function VoiceWindow({ sessionId, held }: { sessionId: string; held: boolean }) {
  const store = useAppStore();
  const session = useApp((s) => s.sessions[sessionId]);
  const teammate = useApp((s) => (session ? s.teammates[session.spaceId]?.find((t) => t.homeSessionId === sessionId) ?? null : null));
  const handsFree = useApp((s) => s.voicePrefs.handsFree);
  const closeVoice = useApp((s) => s.closeVoice);
  // Who answers, in the line under the bars, and what the conversation is, in the head: a teammate is
  // both; a session is its title, answered by its agent.
  const name = teammate?.name ?? (session ? AGENT_META[session.agentKind].label : "The agent");
  const title = teammate?.name ?? (session?.title.trim() || name);
  const [snap, setSnap] = useState<VoiceSnapshot>(STARTING);
  const ctl = useRef<VoiceSession | null>(null);
  const audio = useRef<VoiceAudio | null>(null);
  const root = useRef<HTMLDivElement>(null);
  /* Down from the prompter's mic button: the press is still held, and its release ends the turn. */
  const stillHeld = useRef(held);

  useEffect(() => {
    const helper = desktopSpeechHelper();
    if (!helper) {
      setSnap({ ...STARTING, phase: "unavailable", problem: "Voice mode runs in Realm's Mac app." });
      return;
    }
    // Read from the moment voice mode opens: a session not yet loaded is loaded now, and what it held
    // before is not read aloud.
    if (!store.getState().transcripts[sessionId]) void store.getState().run(() => store.getState().openSession(sessionId));
    // The prefs are read before the microphone opens, since they say which microphone; unread, the
    // ones already held do.
    let gone = false;
    let vs: VoiceSession | null = null;
    let off = () => {};
    void store.getState().loadVoicePrefs().catch(() => {}).then(() => {
      if (gone) return;
      const io = new WebVoiceAudio(store.getState().voicePrefs.microphone);
      audio.current = io;
      const talk = new VoiceSession({ helper, audio: io, session: sessionPort(store, sessionId), agentName: name, prefs: () => store.getState().voicePrefs });
      vs = talk;
      ctl.current = talk;
      off = talk.subscribe(() => setSnap(talk.state));
      void talk.start().then(() => { if (stillHeld.current) talk.press(); });
    });
    return () => { gone = true; off(); vs?.stop(); ctl.current = null; audio.current = null; };
    // The conversation is this session's for as long as the view is up: a teammate renamed under it
    // does not restart the microphone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, sessionId]);

  useEffect(() => {
    if (!held) return;
    const up = () => { stillHeld.current = false; ctl.current?.release(); };
    window.addEventListener("pointerup", up, { once: true });
    return () => window.removeEventListener("pointerup", up);
  }, [held]);

  useEffect(() => {
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.current?.focus();
    for (const v of Array.from(document.querySelectorAll<HTMLVideoElement>(".app video"))) v.pause();
    return () => { if (back?.isConnected) back.focus(); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const vs = ctl.current;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (vs && (vs.speaking() || store.getState().sessionStatus[sessionId] === "running" || store.getState().sessionStatus[sessionId] === "waiting_permission")) void vs.interrupt();
        else closeVoice();
        return;
      }
      if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "keydown" && !e.repeat) vs?.press();
        else if (e.type === "keyup") vs?.release();
        return;
      }
      if (e.type === "keydown" && e.key.toLowerCase() === "m" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        vs?.setMuted(!vs.state.muted);
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKey, true);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener("keyup", onKey, true); };
  }, [store, sessionId, closeVoice]);

  const vs = ctl.current;
  const canStop = snap.phase === "speaking" || snap.phase === "working";
  // Whose voice the bars follow: Realm's while it talks, the person's the rest of the time.
  const side = snap.phase === "speaking" ? "realm" : "mine";
  const caption = captionOf(snap);
  return createPortal(
    <div ref={root} className="voice-view" role="dialog" aria-modal="true" aria-label={`Voice with ${title}`} tabIndex={-1} data-phase={snap.phase}>
      <div className="voice-head">
        {teammate && <TeammateIcon icon={teammate.icon} size={24} lead={teammate.lead} />}
        <span className="voice-name">{title}</span>
      </div>
      <div className="voice-stage">
        <Bars audio={audio} side={side} live={snap.phase !== "starting" && snap.phase !== "unavailable" && !(side === "mine" && snap.muted && !snap.held)} />
        <p className="voice-caption" data-selectable data-tone={caption.tone} aria-live="polite">{caption.text}</p>
        <p className="voice-state" role={snap.phase === "unavailable" ? "alert" : "status"}>
          {snap.problem && snap.phase === "unavailable" ? snap.problem : stateLine(snap, handsFree, name)}
        </p>
        {snap.microphoneDenied && (
          <button type="button" className="btn" onClick={() => void window.realm?.permissions?.openSettings("microphone")}>Open Microphone settings</button>
        )}
      </div>
      <div className="voice-controls">
        <button type="button" className="voice-control" aria-pressed={snap.muted} aria-label="Mute" disabled={!vs || snap.phase === "unavailable"}
          title={snap.muted ? "Unmute (M)" : "Mute (M)"} onClick={() => vs?.setMuted(!snap.muted)}>
          <Icon name="micOff" size={20} />
        </button>
        {canStop ? (
          <button type="button" className="voice-talk" aria-label="Stop" title="Stop (Esc)" onClick={() => void vs?.interrupt()}>
            {/* off-ladder: the one primary control, a 64-px disc, sized as the voice view's and not a row's. */}
            <Icon name="stop" size={24} />
          </button>
        ) : (
          <button type="button" className="voice-talk" aria-label="Hold to talk" data-held={snap.held || undefined} disabled={!vs || snap.phase === "unavailable"}
            title="Hold to talk (hold Space)"
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); vs?.press(); }}
            onPointerUp={() => vs?.release()} onPointerCancel={() => vs?.release()}
            onKeyDown={(e) => { if (e.key === "Enter") vs?.press(); }} onKeyUp={(e) => { if (e.key === "Enter") vs?.release(); }}>
            {/* off-ladder: the one primary control, a 64-px disc, sized as the voice view's and not a row's. */}
            <Icon name="mic" size={24} />
          </button>
        )}
        <button type="button" className="voice-control" aria-label="End voice mode" title="End voice mode" onClick={closeVoice}>
          <Icon name="close" size={20} />
        </button>
      </div>
    </div>,
    document.body,
  );
}

/** The words under the bars: what is being heard as it is heard, what was asked while the agent works
 *  on it, then the sentence Realm is saying as the speakers say it. Nothing while it only listens. */
export function captionOf(s: VoiceSnapshot): { text: string; tone: "live" | "quiet" } {
  if (s.phase === "hearing") return { text: s.partial, tone: "live" };
  if (s.phase === "speaking" && s.said) return { text: s.said, tone: "live" };
  if (s.phase === "working" || s.phase === "speaking") return { text: s.heard ?? "", tone: "quiet" };
  return { text: "", tone: "quiet" };
}

/** How many bars, and how far a bar's height follows a new reading each frame (the rest is the last
 *  frame's): enough to move with each syllable without flickering. */
const BAR_COUNT = 5;
const FOLLOW = 0.35;
const ROOM = 0.3;

/**
 * The voice that is talking, as a few bars across the speech range — the person's in ink while Realm
 * listens, Realm's in the accent while it talks. A frame loop is outside the stylesheet's motion
 * rules, so it re-applies them itself: under Reduce motion, Low power or an unfocused window it stops
 * and holds the bars at rest, and the line under it still says everything the motion did. It keeps
 * drawing in a window idle for input, because in voice mode the microphone is the input.
 */
function Bars({ audio, side, live }: { audio: { current: VoiceAudio | null }; side: "mine" | "realm"; live: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bars = Array.from(box.current?.children ?? []) as HTMLElement[];
    const levels = new Float32Array(BAR_COUNT);
    const shown = new Float32Array(BAR_COUNT);
    let frame = 0;
    const still = () => prefersReducedMotion() || ["always", "unfocused"].includes(document.documentElement.getAttribute("data-quiet") ?? "");
    const draw = () => {
      const have = live && !still() && !!audio.current?.bands(side, levels);
      for (let i = 0; i < BAR_COUNT; i++) {
        // The middle bars carry the voice's body; the outer ones its edges. Order the bands from the
        // centre out so the shape stays a voice's rather than a spectrum's slope.
        const band = [2, 1, 0, 3, 4][i]!;
        // The analyser's quietest third is the room; a bar starts to rise above it.
        const target = have ? Math.max(0, Math.min(1, (levels[band]! - ROOM) / (1 - ROOM))) : 0;
        shown[i] = shown[i]! + (target - shown[i]!) * FOLLOW;
        bars[i]?.style.setProperty("--level", shown[i]!.toFixed(3));
      }
      if (!still()) frame = requestAnimationFrame(draw);
    };
    draw();
    const resume = () => { cancelAnimationFrame(frame); draw(); };
    const quiet = new MutationObserver(resume);
    quiet.observe(document.documentElement, { attributes: true, attributeFilter: ["data-quiet"] });
    return () => { cancelAnimationFrame(frame); quiet.disconnect(); };
  }, [audio, side, live]);
  return (
    <div ref={box} className="voice-bars" data-side={side} aria-hidden="true">
      {Array.from({ length: BAR_COUNT }, (_, i) => <span key={i} />)}
    </div>
  );
}
