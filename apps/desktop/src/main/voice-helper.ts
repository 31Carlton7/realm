import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const VOICE_CHANNEL = "realm:voice";

/** What the renderer may tell the helper. Audio travels on its own channel, as bytes. */
const COMMANDS = new Set(["listen", "end", "cancel"]);

/** The helper's first line: which recogniser it found. */
export type VoiceReady = { t: "ready"; stt: "analyzer" | "recognizer" | "none" };
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
  private ready: Promise<VoiceStart> | null = null;
  private owner: VoiceOwner | null = null;

  constructor(private readonly bin: () => string | null, private readonly spawnHelper: typeof spawn = spawn) {}

  start(owner: VoiceOwner): Promise<VoiceStart> {
    this.owner = owner;
    this.ready ??= this.launch();
    return this.ready;
  }

  command(from: VoiceOwner, command: unknown): void {
    if (from.id !== this.owner?.id || !command || typeof command !== "object") return;
    const t = (command as { t?: unknown }).t;
    if (typeof t === "string" && COMMANDS.has(t)) this.write(command);
  }

  /** 16 kHz mono Int16 samples from the window's microphone. */
  audio(from: VoiceOwner, pcm: Uint8Array): void {
    if (from.id !== this.owner?.id || !(pcm instanceof Uint8Array)) return;
    this.write({ t: "audio", pcm: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64") });
  }

  stop(from?: VoiceOwner): void {
    if (from && from.id !== this.owner?.id) return;
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.owner = null;
    try { child?.stdin?.end(); child?.kill(); } catch { /* already gone */ }
  }

  private write(line: unknown): void {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify(line)}\n`);
  }

  private launch(): Promise<VoiceStart> {
    const bin = this.bin();
    if (!bin) return Promise.resolve({ t: "unavailable", reason: "Dictation needs Realm's speech helper, which this build does not have." });
    return new Promise<VoiceStart>((resolve) => {
      let child: ChildProcess;
      try { child = this.spawnHelper(bin, [], { stdio: ["pipe", "pipe", "pipe"] }); } catch (e) {
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
          if (owner && !owner.isDestroyed()) owner.send(VOICE_CHANNEL, event);
        }
      });
      child.stderr!.on("data", (d: Buffer) => { const s = d.toString().trim(); if (s) console.warn("[realmvoice]", s); });
      child.on("error", (e) => { resolve({ t: "unavailable", reason: `The speech helper did not start: ${e.message}` }); this.forget(child); });
      child.on("exit", (code) => {
        resolve({ t: "unavailable", reason: `The speech helper stopped (exit ${code ?? "signal"}).` });
        const owner = this.owner;
        if (this.child === child && owner && !owner.isDestroyed()) owner.send(VOICE_CHANNEL, { t: "error", message: "The speech helper stopped." });
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
