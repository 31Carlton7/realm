// RealmVoice — dictation's speech to text, on this Mac.
//
// The renderer owns the microphone: it captures with Chromium's echo cancellation on and sends
// 16 kHz mono PCM here. This helper never opens an audio device. It turns that PCM into words with
// SpeechAnalyzer, which macOS 26 brought; there is no older recogniser to fall back to.
//
// Protocol: one JSON object per line. Commands on stdin:
//   {"t":"listen","turn":N}                start transcribing a new utterance
//   {"t":"audio","pcm":"<base64 Int16 LE>"} the utterance's next samples, 16 kHz mono
//   {"t":"end"}                            the utterance is over: finalise it
//   {"t":"cancel"}                         drop the utterance
// Events on stdout:
//   {"t":"fetching","progress":0–1}       this Mac's speech model is being downloaded from Apple,
//                                          before its first use; no progress while it is unknown
//   {"t":"ready","stt":"analyzer"|"none"}
//   {"t":"partial","turn":N,"text":"…","settled":K}   the first K UTF-16 units of text are final
//   {"t":"final","turn":N,"text":"…"}
//   {"t":"error","message":"…"}
//
// `realmvoice continuous` is a meeting's transcript instead: one long transcription of two sources,
// "me" (the microphone, fed by the window the way dictation's is) and "them" (the other side of a
// call: this Mac's sound output, through a Core Audio process tap, or samples fed here). Each source
// has its own analyzer in this one process, and runs until stop: silence ends nothing.
// Commands on stdin:
//   {"t":"audio","source":"me"|"them","pcm":"<base64 Int16 LE>"}   that source's next samples, 16 kHz mono
//   {"t":"tap"}    hear this Mac's sound output as "them". The tap is made only when System Audio
//                  Recording is already granted; otherwise the answer says so and nothing is asked
//   {"t":"stop"}   finish every source's last line
// Events on stdout:
//   {"t":"fetching",…} as above
//   {"t":"ready","stt":"analyzer"|"none","startedAt":<epoch ms>,"systemAudio":"granted"|"denied"|"not decided"}
//   {"t":"partial","source":S,"text":"…","start":ms}            the line being heard, still open to revision
//   {"t":"line","source":S,"text":"…","start":ms,"end":ms,"at":<epoch ms>}
//                  start and end are milliseconds since startedAt; at is the wall-clock time of start
//   {"t":"tap","state":"capturing"|"needs permission"|"denied"|"failed","message":"…"}
//   {"t":"error","source":S,"message":"…"}
//   {"t":"stopped"}
//
// Build: swiftc -O -o bin/realmvoice RealmVoice.swift   (see scripts/build-native.mjs)
// Exits when stdin closes (parent gone).

import AVFoundation
import CoreAudio
import Foundation
import Speech

let output = DispatchQueue(label: "realmvoice.output")

func emit(_ event: [String: Any]) {
  output.async {
    guard var data = try? JSONSerialization.data(withJSONObject: event) else { return }
    data.append(0x0a)
    FileHandle.standardOutput.write(data)
  }
}

/// The samples the renderer sends: 16 kHz, mono, signed 16-bit.
let inputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!

func pcmBuffer(_ data: Data) -> AVAudioPCMBuffer? {
  let frames = AVAudioFrameCount(data.count / 2)
  guard frames > 0, let buffer = AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: frames) else { return nil }
  buffer.frameLength = frames
  data.withUnsafeBytes { raw in
    buffer.int16ChannelData![0].update(from: raw.bindMemory(to: Int16.self).baseAddress!, count: Int(frames))
  }
  return buffer
}

// MARK: - Speech to text

func makeTranscriber(locale: Locale) -> SpeechTranscriber {
  SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
}

/// Downloads this Mac's speech model for `locale` if it has none yet, and answers the format the
/// analyzer wants its audio in.
func installModel(locale: Locale) async -> AVAudioFormat? {
  let transcriber = makeTranscriber(locale: locale)
  do {
    if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
      emit(["t": "fetching"])
      let watch = request.progress.observe(\.fractionCompleted) { progress, _ in
        emit(["t": "fetching", "progress": progress.fractionCompleted])
      }
      defer { watch.invalidate() }
      try await request.downloadAndInstall()
    }
  } catch {
    emit(["t": "error", "message": "The speech model for \(locale.identifier) could not be installed: \(error.localizedDescription)"])
  }
  return await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
}

/// SpeechAnalyzer with a SpeechTranscriber, one analyzer per utterance. Partials carry every final
/// segment so far plus the volatile one, so the renderer only ever replaces its text.
final class Listener {
  private let locale: Locale
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var analyzer: SpeechAnalyzer?
  private var converter: AVAudioConverter?
  private var analyzerFormat: AVAudioFormat?

  init(locale: Locale) { self.locale = locale }

  func prepare() async {
    analyzerFormat = await installModel(locale: locale)
    if let format = analyzerFormat, format != inputFormat { converter = AVAudioConverter(from: inputFormat, to: format) }
  }

  func begin(turn: Int) {
    cancel()
    let transcriber = makeTranscriber(locale: locale)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
    self.analyzer = analyzer
    input = continuation
    Task {
      var finished = ""
      var volatile = ""
      do {
        try await analyzer.start(inputSequence: stream)
        for try await result in transcriber.results {
          let text = String(result.text.characters)
          if result.isFinal { finished += text; volatile = "" } else { volatile = text }
          let heard = (finished + volatile).trimmingCharacters(in: .whitespaces)
          // The final segments lead the text, so what is settled is their length less the leading
          // space the trim took off.
          let settled = finished.drop(while: { $0.isWhitespace }).utf16.count
          emit(["t": "partial", "turn": turn, "text": heard, "settled": min(settled, heard.utf16.count)])
        }
      } catch {
        emit(["t": "error", "message": "Transcription stopped: \(error.localizedDescription)"])
      }
      emit(["t": "final", "turn": turn, "text": (finished + volatile).trimmingCharacters(in: .whitespaces)])
    }
  }

  func feed(_ buffer: AVAudioPCMBuffer) {
    guard let input else { return }
    if let converter, let format = analyzerFormat {
      let ratio = format.sampleRate / inputFormat.sampleRate
      guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 1) else { return }
      var given = false
      converter.convert(to: converted, error: nil) { _, status in
        if given { status.pointee = .noDataNow; return nil }
        given = true
        status.pointee = .haveData
        return buffer
      }
      input.yield(AnalyzerInput(buffer: converted))
    } else {
      input.yield(AnalyzerInput(buffer: buffer))
    }
  }

  func end() {
    guard let analyzer, let input else { return }
    input.finish()
    self.input = nil
    self.analyzer = nil
    Task { try? await analyzer.finalizeAndFinishThroughEndOfInput() }
  }

  func cancel() {
    guard let analyzer, let input else { return }
    input.finish()
    self.input = nil
    self.analyzer = nil
    Task { await analyzer.cancelAndFinishNow() }
  }
}

// MARK: - Continuous mode

func milliseconds(_ seconds: Double) -> Int { Int((seconds * 1000).rounded()) }

/// One source of a meeting's transcript, with its own analyzer for as long as the meeting lasts.
/// `offset` is where the source's first sample fell, in seconds since the transcript started, so its
/// analyzer's audio times become the transcript's.
final class TranscriptSource {
  private let done: Task<Void, Never>
  private let input: AsyncStream<AnalyzerInput>.Continuation
  private let analyzer: SpeechAnalyzer
  private let analyzerFormat: AVAudioFormat?
  private var converter: AVAudioConverter?

  init(name: String, offset: Double, startedAt: Int, locale: Locale, format: AVAudioFormat?) {
    let transcriber = makeTranscriber(locale: locale)
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let (stream, input) = AsyncStream<AnalyzerInput>.makeStream()
    self.analyzer = analyzer
    self.input = input
    analyzerFormat = format
    done = Task {
      do {
        try await analyzer.start(inputSequence: stream)
        for try await result in transcriber.results {
          let text = String(result.text.characters).trimmingCharacters(in: .whitespaces)
          let start = offset + result.range.start.seconds
          if !result.isFinal {
            emit(["t": "partial", "source": name, "text": text, "start": milliseconds(start)])
          } else if !text.isEmpty {
            emit(["t": "line", "source": name, "text": text, "start": milliseconds(start), "end": milliseconds(offset + result.range.end.seconds),
                  "at": startedAt + milliseconds(start)])
          }
        }
      } catch {
        emit(["t": "error", "source": name, "message": "Transcription stopped: \(error.localizedDescription)"])
      }
    }
  }

  func feed(_ buffer: AVAudioPCMBuffer) {
    guard let format = analyzerFormat, buffer.format != format else { input.yield(AnalyzerInput(buffer: buffer)); return }
    if converter?.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: format) }
    guard let converter,
          let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * format.sampleRate / buffer.format.sampleRate) + 1) else { return }
    var given = false
    converter.convert(to: converted, error: nil) { _, status in
      if given { status.pointee = .noDataNow; return nil }
      given = true
      status.pointee = .haveData
      return buffer
    }
    input.yield(AnalyzerInput(buffer: converted))
  }

  func finish() async {
    input.finish()
    try? await analyzer.finalizeAndFinishThroughEndOfInput()
    await done.value
  }
}

/// System Audio Recording for the app macOS holds responsible for this helper: Realm. TCC's own
/// check, which answers and never asks. REALM_VOICE_SYSTEM_AUDIO can only make it stricter, for tests.
func systemAudioState() -> String {
  if let forced = ProcessInfo.processInfo.environment["REALM_VOICE_SYSTEM_AUDIO"], forced == "denied" || forced == "not decided" { return forced }
  typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int32
  guard let tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/TCC", RTLD_NOW),
        let preflight = dlsym(tcc, "TCCAccessPreflight") else { return "not decided" }
  switch unsafeBitCast(preflight, to: Preflight.self)("kTCCServiceAudioCapture" as CFString, nil) {
  case 0: return "granted"
  case 1: return "denied"
  default: return "not decided"
  }
}

/// This Mac's sound output, heard through a Core Audio process tap on a private aggregate device. The
/// tap leaves the sound playing: the person still hears the call.
final class SystemAudio {
  private var tap = AudioObjectID(0)
  private var device = AudioObjectID(0)
  private var proc: AudioDeviceIOProcID?

  /// Nil when the tap is made; otherwise why not.
  func start(_ deliver: @escaping (AVAudioPCMBuffer) -> Void) -> String? {
    let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    description.uuid = UUID()
    description.muteBehavior = .unmuted
    description.isPrivate = true
    var status = AudioHardwareCreateProcessTap(description, &tap)
    guard status == noErr else { return "The system audio tap was not made (\(status))." }

    var format = AudioStreamBasicDescription()
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    var formatAddress = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
    status = AudioObjectGetPropertyData(tap, &formatAddress, 0, nil, &size, &format)
    guard status == noErr, let tapFormat = AVAudioFormat(streamDescription: &format) else { stop(); return "The system audio tap has no format (\(status))." }

    let aggregate: [String: Any] = [
      kAudioAggregateDeviceNameKey: "Realm meeting transcript", kAudioAggregateDeviceUIDKey: UUID().uuidString,
      kAudioAggregateDeviceIsPrivateKey: true, kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
    ]
    status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device)
    guard status == noErr else { stop(); return "The system audio device was not made (\(status))." }

    status = AudioDeviceCreateIOProcIDWithBlock(&proc, device, DispatchQueue(label: "realmvoice.tap")) { _, input, _, _, _ in
      let frames = AVAudioFrameCount(input.pointee.mBuffers.mDataByteSize / tapFormat.streamDescription.pointee.mBytesPerFrame)
      guard frames > 0, let copy = AVAudioPCMBuffer(pcmFormat: tapFormat, frameCapacity: frames) else { return }
      copy.frameLength = frames
      let from = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
      for (target, source) in zip(UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList), from) {
        guard let to = target.mData, let data = source.mData else { continue }
        memcpy(to, data, Int(min(target.mDataByteSize, source.mDataByteSize)))
      }
      deliver(copy)
    }
    guard status == noErr, let proc else { stop(); return "The system audio device could not be read (\(status))." }
    status = AudioDeviceStart(device, proc)
    guard status == noErr else { stop(); return "The system audio device did not start (\(status))." }
    return nil
  }

  func stop() {
    if let proc { AudioDeviceStop(device, proc); AudioDeviceDestroyIOProcID(device, proc) }
    if device != 0 { AudioHardwareDestroyAggregateDevice(device) }
    if tap != 0 { AudioHardwareDestroyProcessTap(tap) }
    proc = nil; device = 0; tap = 0
  }
}

/// A meeting's transcript: a source starts with its first samples and runs until stop.
final class Transcript {
  static let sources: Set<String> = ["me", "them"]
  let startedAt = milliseconds(Date().timeIntervalSince1970)
  private let clock = DispatchTime.now()
  private let locale: Locale
  private let format: AVAudioFormat?
  private var running: [String: TranscriptSource] = [:]
  private var systemAudio: SystemAudio?
  private var stopping = false

  init(locale: Locale, format: AVAudioFormat?) {
    self.locale = locale
    self.format = format
  }

  private func elapsed() -> Double { Double(DispatchTime.now().uptimeNanoseconds - clock.uptimeNanoseconds) / 1e9 }

  func feed(_ name: String, _ buffer: AVAudioPCMBuffer) {
    guard !stopping, Transcript.sources.contains(name) else { return }
    if running[name] == nil {
      running[name] = TranscriptSource(name: name, offset: elapsed(), startedAt: startedAt, locale: locale, format: format)
    }
    running[name]?.feed(buffer)
  }

  func tap() {
    guard systemAudio == nil, !stopping else { return }
    let state = systemAudioState()
    guard state == "granted" else {
      emit(["t": "tap", "state": state == "denied" ? "denied" : "needs permission", "message": "System Audio Recording is not granted to Realm, so nothing was asked for and no tap was made."])
      return
    }
    if ProcessInfo.processInfo.environment["REALM_VOICE_TAP_DRY_RUN"] == "1" { emit(["t": "tap", "state": "dry run"]); return }
    let audio = SystemAudio()
    if let problem = audio.start({ buffer in DispatchQueue.main.async { self.feed("them", buffer) } }) {
      emit(["t": "tap", "state": "failed", "message": problem])
      return
    }
    systemAudio = audio
    emit(["t": "tap", "state": "capturing"])
  }

  func stop() {
    guard !stopping else { return }
    stopping = true
    systemAudio?.stop()
    systemAudio = nil
    let sources = Array(running.values)
    Task {
      for source in sources { await source.finish() }
      emit(["t": "stopped"])
    }
  }
}

// MARK: - Main

func transcriptionLocale() async -> Locale {
  let current = Locale.current
  let supported = await SpeechTranscriber.supportedLocales
  let tag = current.identifier(.bcp47)
  if supported.contains(where: { $0.identifier(.bcp47) == tag }) { return current }
  return Locale(identifier: "en-US")
}

var listener: Listener?
var transcript: Transcript?
let continuous = CommandLine.arguments.dropFirst().first == "continuous"

let setup = DispatchSemaphore(value: 0)
Task {
  let locale = await transcriptionLocale()
  if continuous {
    if SpeechTranscriber.isAvailable { transcript = Transcript(locale: locale, format: await installModel(locale: locale)) }
    var ready: [String: Any] = ["t": "ready", "stt": transcript == nil ? "none" : "analyzer", "systemAudio": systemAudioState()]
    ready["startedAt"] = transcript?.startedAt
    emit(ready)
  } else {
    if SpeechTranscriber.isAvailable {
      let analyzer = Listener(locale: locale)
      await analyzer.prepare()
      listener = analyzer
    }
    emit(["t": "ready", "stt": listener == nil ? "none" : "analyzer"])
  }
  setup.signal()
}

let reader = Thread {
  setup.wait()
  while let line = readLine(strippingNewline: true) {
    guard let data = line.data(using: .utf8),
          let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let type = command["t"] as? String else { continue }
    // Commands keep to the main queue, so they land in the order they came.
    DispatchQueue.main.async {
      if let transcript {
        switch type {
        case "audio":
          if let source = command["source"] as? String, let b64 = command["pcm"] as? String, let bytes = Data(base64Encoded: b64),
             let buffer = pcmBuffer(bytes) { transcript.feed(source, buffer) }
        case "tap": transcript.tap()
        case "stop": transcript.stop()
        default: break
        }
        return
      }
      switch type {
      case "listen": listener?.begin(turn: command["turn"] as? Int ?? 0)
      case "audio":
        if let b64 = command["pcm"] as? String, let bytes = Data(base64Encoded: b64), let buffer = pcmBuffer(bytes) { listener?.feed(buffer) }
      case "end": listener?.end()
      case "cancel": listener?.cancel()
      default: break
      }
    }
  }
  exit(0)
}
reader.start()
RunLoop.main.run()
