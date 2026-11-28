import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** How main talks to one of the helper's two modes: the arguments it starts with, what the renderer
 *  may tell it (audio travels on its own channel, as bytes) and where its events go. */
type HelperWire = { args: string[]; commands: Set<string>; channel: string };

const DICTATION: HelperWire = { args: [], commands: new Set(["listen", "end", "cancel"]), channel: "realm:voice" };

/** The line the helper sends once it can listen: whether this Mac has a recogniser for its language. */
export type VoiceReady = { t: "ready"; stt: "analyzer" | "none" };
export type VoiceStart = VoiceReady | { t: "unavailable"; reason: string };

/** Where the window that is dictating hears from the helper. */
export type VoiceOwner = { id: number; isDestroyed(): boolean; send(channel: string, event: unknown): void };

export function voiceHelperPath(appPath: string, resourcesPath: string): string | null {
  if (process.platform !== "darwin") return null;
  if (process.env.REALM_VOICE_BIN) return process.env.REALM_VOICE_BIN;
  const dev = join(appPath, "native", "bin", "realmvoice");
  if (existsSync(dev)) return dev;
  const packaged = join(resourcesPath, "realmvoice");
  return existsSync(packaged) ? packaged : null;
}

/**
 * The `realmvoice` helper (native/RealmVoice.swift), run while a window dictates: started on the
 * first `start`, and stopped by `stop` or when its window goes. One window at a time owns it —
 * dictation started in a second window takes it over, since there is one microphone to hear.
 */
export class VoiceHelper {
  private child: ChildProcess | null = null;
  protected ready: Promise<VoiceStart> | null = null;
  protected owner: VoiceOwner | null = null;

  constructor(private readonly bin: () => string | null, private readonly spawnHelper: typeof spawn = spawn, private readonly wire: HelperWire = DICTATION) {}

  start(owner: VoiceOwner): Promise<VoiceStart> {
    this.owner = owner;
    this.ready ??= this.launch();
    return this.ready;
  }

  command(from: VoiceOwner, command: unknown): void {
    if (from.id !== this.owner?.id || !command || typeof command !== "object") return;
    const t = (command as { t?: unknown }).t;
    if (typeof t === "string" && this.wire.commands.has(t)) this.write(command);
  }

  /** 16 kHz mono Int16 samples from the window's microphone. */
  audio(from: VoiceOwner, pcm: Uint8Array): void {
    if (from.id !== this.owner?.id || !(pcm instanceof Uint8Array)) return;
    this.write({ t: "audio", pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64") });
  }

  /** Whether this window is the one the helper is hearing right now. */
  holds(from: VoiceOwner): boolean {
    return this.ready !== null && from.id === this.owner?.id;
  }

  stop(from?: VoiceOwner): void {
    if (from && from.id !== this.owner?.id) return;
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.owner = null;
    try { child?.stdin?.end(); child?.kill(); } catch { /* already gone */ }
  }

  protected write(line: unknown): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(line)}\n`);
  }

  private launch(): Promise<VoiceStart> {
    const bin = this.bin();
    if (!bin) return Promise.resolve({ t: "unavailable", reason: "Dictation needs Realm's speech helper, which this build does not have." });
    return new Promise<VoiceStart>((resolve) => {
      let child: ChildProcess;
      try { child = this.spawnHelper(bin, this.wire.args, { stdio: ["pipe", "pipe", "pipe"] }); } catch (e) {
        this.ready = null;
        resolve({ t: "unavailable", reason: `The speech helper did not start: ${(e as Error).message}` });
        return;
      }
      this.child = child;
      let buf = "";
      child.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        for (let nl = buf.indexOf("\n"); nl !== -1; nl = buf.indexOf("\n")) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let event: { t?: unknown };
          try { event = JSON.parse(line) as { t?: unknown }; } catch { continue; }
          if (event.t === "ready") { resolve(event as VoiceReady); continue; }
          const owner = this.owner;
          if (owner && !owner.isDestroyed()) owner.send(this.wire.channel, event);
        }
      });
      child.stderr!.on("data", (d: Buffer) => { const s = d.toString().trim(); if (s) console.warn("[realmvoice]", s); });
      child.on("error", (e) => { resolve({ t: "unavailable", reason: `The speech helper did not start: ${e.message}` }); this.forget(child); });
      child.on("exit", (code) => {
        resolve({ t: "unavailable", reason: `The speech helper stopped (exit ${code ?? "signal"}).` });
        const owner = this.owner;
        if (this.child === child && owner && !owner.isDestroyed()) owner.send(this.wire.channel, { t: "error", message: "The speech helper stopped." });
        this.forget(child);
      });
    });
  }

  private forget(child: ChildProcess): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
  }
}

export type TranscriptSource = "me" | "them";
const SOURCES = new Set<unknown>(["me", "them"]);

/** System Audio Recording as the helper read it, without asking. */
export type SystemAudioGrant = "granted" | "denied" | "not decided";
export type TranscriptReady = { t: "ready"; stt: "analyzer" | "none"; startedAt: number; systemAudio: SystemAudioGrant };

/**
 * `realmvoice continuous`: a meeting's transcript, "me" from the window's microphone and "them" from
 * this Mac's sound output. Every line comes back with its source and its time (see RealmVoice.swift).
 * A second helper beside dictation's, so dictating during a meeting is dictation as it always was.
 */
export class TranscriptHelper extends VoiceHelper {
  constructor(bin: () => string | null, spawnHelper: typeof spawn = spawn) {
    super(bin, spawnHelper, { args: ["continuous"], commands: new Set(["stop"]), channel: "realm:transcript" });
  }

  /** 16 kHz mono Int16 samples for one source. "them" is the window's when the tap is not in use. */
  sourceAudio(from: VoiceOwner, source: unknown, pcm: Uint8Array): void {
    if (from.id !== this.owner?.id || !SOURCES.has(source) || !(pcm instanceof Uint8Array)) return;
    this.write({ t: "audio", source, pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64") });
  }

  /** Hear this Mac's sound output as "them". The tap is asked for only once System Audio Recording is
   *  granted, in System Settings or by an Allow on macOS's own prompt: otherwise the window is told why,
   *  and nothing that could raise macOS's prompt runs. */
  async systemAudio(from: VoiceOwner): Promise<void> {
    if (from.id !== this.owner?.id || !this.ready) return;
    const ready = await this.ready;
    if (ready.t !== "ready" || from.id !== this.owner?.id) return;
    const grant = (ready as TranscriptReady).systemAudio;
    if (grant === "granted") { this.write({ t: "tap" }); return; }
    if (!from.isDestroyed()) from.send("realm:transcript", { t: "tap", state: grant === "denied" ? "denied" : "needs permission" });
  }

  /** Main ends the window's run without it. A window that is still there is told the helper is gone,
   *  as an exit would tell it, since `stop` leaves the exit nobody to tell: its run ends and saves
   *  what it has. */
  endRun(from: VoiceOwner & { isCrashed(): boolean }): void {
    if (from.id !== this.owner?.id) return;
    if (!from.isDestroyed() && !from.isCrashed()) from.send("realm:transcript", { t: "error", message: "The speech helper stopped." });
    this.stop(from);
  }
}
