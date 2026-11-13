// RealmVoice — dictation's speech to text, on this Mac.
//
// The renderer owns the microphone: it captures with Chromium's echo cancellation on and sends
// 16 kHz mono PCM here. This helper never opens an audio device. It turns that PCM into words with
// SpeechAnalyzer (SFSpeechRecognizer on-device where the analyzer is unavailable).
//
// Protocol: one JSON object per line. Commands on stdin:
//   {"t":"listen","turn":N}                start transcribing a new utterance
//   {"t":"audio","pcm":"<base64 Int16 LE>"} the utterance's next samples, 16 kHz mono
//   {"t":"end"}                            the utterance is over: finalise it
//   {"t":"cancel"}                         drop the utterance
// Events on stdout:
//   {"t":"ready","stt":"analyzer"|"recognizer"|"none"}
//   {"t":"partial","turn":N,"text":"…","settled":K}   the first K UTF-16 units of text are final
//   {"t":"final","turn":N,"text":"…"}
//   {"t":"error","message":"…"}
//
// Build: swiftc -O -o bin/realmvoice RealmVoice.swift   (see scripts/build-native.mjs)
// Exits when stdin closes (parent gone).

import AVFoundation
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

protocol Listener: AnyObject {
  func begin(turn: Int)
  func feed(_ buffer: AVAudioPCMBuffer)
  func end()
  func cancel()
}

/// SpeechAnalyzer with a SpeechTranscriber, one analyzer per utterance. Partials carry every final
/// segment so far plus the volatile one, so the renderer only ever replaces its text.
final class AnalyzerListener: Listener {
  private let locale: Locale
  private var input: AsyncStream<AnalyzerInput>.Continuation?
  private var analyzer: SpeechAnalyzer?
  private var converter: AVAudioConverter?
  private var analyzerFormat: AVAudioFormat?

  init(locale: Locale) { self.locale = locale }

  func prepare() async {
    let transcriber = makeTranscriber()
    do {
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        try await request.downloadAndInstall()
      }
    } catch {
      emit(["t": "error", "message": "The speech model for \(locale.identifier) could not be installed: \(error.localizedDescription)"])
    }
    analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber])
    if let format = analyzerFormat, format != inputFormat { converter = AVAudioConverter(from: inputFormat, to: format) }
  }

  private func makeTranscriber() -> SpeechTranscriber {
    SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
  }

  func begin(turn: Int) {
    cancel()
    let transcriber = makeTranscriber()
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

/// The fallback: SFSpeechRecognizer, held on-device. It asks for the Speech Recognition grant the
/// first time it is used, which SpeechAnalyzer does not.
final class RecognizerListener: Listener {
  private let recognizer: SFSpeechRecognizer
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?

  init?(locale: Locale) {
    guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.supportsOnDeviceRecognition else { return nil }
    self.recognizer = recognizer
  }

  func begin(turn: Int) {
    cancel()
    if SFSpeechRecognizer.authorizationStatus() == .notDetermined { SFSpeechRecognizer.requestAuthorization { _ in } }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = true
    self.request = request
    var sentFinal = false
    task = recognizer.recognitionTask(with: request) { result, error in
      if let result {
        let text = result.bestTranscription.formattedString
        emit(["t": result.isFinal ? "final" : "partial", "turn": turn, "text": text])
        if result.isFinal { sentFinal = true }
      }
      if error != nil, !sentFinal { sentFinal = true; emit(["t": "final", "turn": turn, "text": result?.bestTranscription.formattedString ?? ""]) }
    }
  }

  func feed(_ buffer: AVAudioPCMBuffer) { request?.append(buffer) }

  func end() { request?.endAudio(); request = nil }

  func cancel() { task?.cancel(); task = nil; request = nil }
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

let setup = DispatchSemaphore(value: 0)
Task {
  let locale = await transcriptionLocale()
  var kind = "none"
  if SpeechTranscriber.isAvailable {
    let analyzer = AnalyzerListener(locale: locale)
    await analyzer.prepare()
    listener = analyzer
    kind = "analyzer"
  } else if let recognizer = RecognizerListener(locale: locale) {
    listener = recognizer
    kind = "recognizer"
  }
  emit(["t": "ready", "stt": kind])
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
