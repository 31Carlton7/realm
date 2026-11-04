import { AGENT_META } from "@realm/contracts";
import { Icon, TeammateIcon } from "@realm/ui";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { StoreApi } from "zustand";
import { emptyTranscript } from "../panes/session/transcript-model";
import { prefersReducedMotion } from "../reduced-motion";
import { useApp, useAppStore, type AppState } from "../state/store";
import { WebVoiceAudio, type VoiceAudio } from "./audio-io";
import { desktopSpeechHelper } from "./protocol";
import { VoiceSession, type VoiceSessionPort, type VoiceSnapshot } from "./voice-session";

/** The session voice mode talks to, read from the store as it changes. */
function sessionPort(store: StoreApi<AppState>, id: string): VoiceSessionPort {
  const get = () => store.getState();
  return {
    transcript: () => get().transcripts[id]?.t ?? emptyTranscript(),
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

const STARTING: VoiceSnapshot = { phase: "starting", partial: "", heard: null, said: null, muted: false, held: false, problem: null, microphoneDenied: false };

/** What the line under the waveforms says, by phase. */
function stateLine(s: VoiceSnapshot, handsFree: boolean, name: string): string {
  switch (s.phase) {
    case "starting": return "Starting…";
    case "hearing": return "Listening";
    case "speaking": return `${name} is answering`;
    case "working": return `${name} is working`;
    case "unavailable": return "Voice mode is off";
    default: return s.muted || !handsFree ? "Hold Space to talk" : "Go ahead, I'm listening";
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
  const name = teammate?.name ?? (session ? AGENT_META[session.agentKind].label : "The agent");
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
    const io = new WebVoiceAudio();
    audio.current = io;
    const vs = new VoiceSession({ helper, audio: io, session: sessionPort(store, sessionId), agentName: name, prefs: () => store.getState().voicePrefs });
    ctl.current = vs;
    const off = vs.subscribe(() => setSnap(vs.state));
    void vs.start().then(() => { if (stillHeld.current) vs.press(); });
    return () => { off(); vs.stop(); ctl.current = null; audio.current = null; };
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
  const live = snap.phase === "hearing" ? snap.partial : "";
  const canStop = snap.phase === "speaking" || snap.phase === "working";
  return createPortal(
    <div ref={root} className="voice-view" role="dialog" aria-modal="true" aria-label={`Voice with ${name}`} tabIndex={-1} data-phase={snap.phase}>
      <div className="voice-head">
        {teammate && <TeammateIcon icon={teammate.icon} size={24} lead={teammate.lead} />}
        <span className="voice-name">{name}</span>
        {!teammate && session && <span className="voice-title">{session.title}</span>}
      </div>
      <div className="voice-stage">
        <section className="voice-side" data-side="realm" aria-label={name}>
          <Wave audio={audio} side="realm" active={snap.phase === "speaking"} />
          <p className="voice-words" data-selectable aria-live="polite">{snap.said ?? ""}</p>
        </section>
        <section className="voice-side" data-side="mine" aria-label="You">
          <Wave audio={audio} side="mine" active={!snap.muted || snap.held} />
          <p className="voice-words" data-selectable data-live={live ? "" : undefined} aria-live="polite">{live || snap.heard || ""}</p>
        </section>
        <p className="voice-state" role={snap.phase === "unavailable" ? "alert" : "status"}>
          {snap.problem && snap.phase === "unavailable" ? snap.problem : stateLine(snap, handsFree, name)}
        </p>
        {snap.microphoneDenied && (
          <button type="button" className="btn" onClick={() => void window.realm?.permissions?.openSettings("microphone")}>Open Microphone settings</button>
        )}
      </div>
      <div className="voice-controls">
        <button type="button" className="voice-control" aria-pressed={snap.muted} disabled={!vs || snap.phase === "unavailable"}
          title={snap.muted ? "Unmute (M)" : "Mute (M)"} onClick={() => vs?.setMuted(!snap.muted)}>
          <Icon name={snap.muted ? "micOff" : "mic"} size={20} />
          <span>{snap.muted ? "Muted" : "Mute"}</span>
        </button>
        <button type="button" className="voice-talk" data-held={snap.held || undefined} disabled={!vs || snap.phase === "unavailable"}
          title="Hold to talk (hold Space)"
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); vs?.press(); }}
          onPointerUp={() => vs?.release()} onPointerCancel={() => vs?.release()}
          onKeyDown={(e) => { if (e.key === "Enter") vs?.press(); }} onKeyUp={(e) => { if (e.key === "Enter") vs?.release(); }}>
          <Icon name="mic" size={24} />
          <span>{snap.held ? "Talking" : "Hold to talk"}</span>
        </button>
        <button type="button" className="voice-control" disabled={!vs || !canStop} title="Stop (Esc)" onClick={() => void vs?.interrupt()}>
          <Icon name="stop" size={20} />
          <span>Stop</span>
        </button>
        <button type="button" className="voice-control" title="End voice mode" onClick={closeVoice}>
          <Icon name="close" size={20} />
          <span>End</span>
        </button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * One side's waveform, drawn from the audio graph's analyser. A frame loop is outside the stylesheet's
 * motion rules, so it re-applies them itself: under Reduce motion, Low power or an unfocused window it
 * stops and holds a flat line, and the state line still says everything the motion did. It keeps
 * drawing in a window idle for input, because in voice mode the microphone is the input.
 */
function Wave({ audio, side, active }: { audio: { current: VoiceAudio | null }; side: "mine" | "realm"; active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext("2d");
    if (!el || !g) return;
    const samples = new Float32Array(1024);
    let frame = 0;
    const still = () => prefersReducedMotion() || ["always", "unfocused"].includes(document.documentElement.getAttribute("data-quiet") ?? "");
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth, h = el.clientHeight;
      if (el.width !== Math.round(w * dpr)) { el.width = Math.round(w * dpr); el.height = Math.round(h * dpr); }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const color = getComputedStyle(el).color;
      const have = active && !still() && audio.current?.wave(side, samples);
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.lineJoin = "round";
      g.beginPath();
      const step = samples.length / Math.max(1, w);
      for (let x = 0; x <= w; x++) {
        const v = have ? samples[Math.min(samples.length - 1, Math.floor(x * step))]! : 0;
        const y = h / 2 - Math.max(-1, Math.min(1, v * 4)) * (h / 2 - 2);
        if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      if (!still()) frame = requestAnimationFrame(draw);
    };
    draw();
    const resume = () => { cancelAnimationFrame(frame); draw(); };
    const quiet = new MutationObserver(resume);
    quiet.observe(document.documentElement, { attributes: true, attributeFilter: ["data-quiet"] });
    return () => { cancelAnimationFrame(frame); quiet.disconnect(); };
  }, [audio, side, active]);
  return <canvas ref={canvas} className="voice-wave" data-side={side} aria-hidden="true" />;
}
