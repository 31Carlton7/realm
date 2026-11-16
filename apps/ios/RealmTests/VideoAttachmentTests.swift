import AVFoundation
import CoreMedia
import RealmKit
import Synchronization
import Testing
import UIKit
import UserNotifications
@testable import Realm

/// Films made on the spot, as a phone would have filmed them: where, and on what.
enum Films {
    static let place = "+37.7749-122.4194+012.000/"
    static let phone = "iPhone 17 Pro"

    /// A 1920 by 1080 film of `seconds`, carrying `place` and `phone` in its metadata.
    static func filmed(seconds: Int, framesPerSecond: Int = 30) async throws -> URL {
        let url = URL.temporaryDirectory.appending(path: "filmed-\(UUID().uuidString).mov")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        writer.metadata = [
            item(.quickTimeMetadataLocationISO6709, place),
            item(.quickTimeMetadataMake, "Apple"),
            item(.quickTimeMetadataModel, phone),
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 1_920, AVVideoHeightKey: 1_080,
        ])
        let frames = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 1_920,
            kCVPixelBufferHeightKey as String: 1_080,
        ])
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        for index in 0..<(seconds * framesPerSecond) {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, frames.pixelBufferPool!, &buffer)
            let frame = buffer!
            CVPixelBufferLockBaseAddress(frame, [])
            // A different grey each frame, so the encoder has something to keep.
            memset(CVPixelBufferGetBaseAddress(frame), Int32(index % 256), CVPixelBufferGetDataSize(frame))
            CVPixelBufferUnlockBaseAddress(frame, [])
            frames.append(frame, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: CMTimeScale(framesPerSecond)))
        }
        input.markAsFinished()
        writer.endSession(atSourceTime: CMTime(value: CMTimeValue(seconds), timescale: 1))
        await writer.finishWriting()
        return url
    }

    private static func item(_ identifier: AVMetadataIdentifier, _ value: String) -> AVMetadataItem {
        let item = AVMutableMetadataItem()
        item.identifier = identifier
        item.value = value as NSString
        item.dataType = kCMMetadataBaseDataType_UTF8 as String
        return item
    }

    @MainActor static func outbox(_ model: AppModel) -> Set<String> {
        Set((try? FileManager.default.contentsOfDirectory(atPath: model.store.files.directory.path)) ?? [])
    }

    static func working() -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: VideoPrep.folder.path)) ?? []
    }
}

@Suite("A video, made ready for the Mac", .serialized)
@MainActor
struct VideoPrepTests {
    static let limits = SendLimits(maxCount: 6, maxBytes: 8 * 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024)

    /// A film comes down to H.264 at 1280 by 720, and nothing in the file says where it was filmed
    /// or on what: not the metadata the asset reads, and not the bytes. By hand too, as where the
    /// system offers no such export (the iOS 27.0 simulator).
    @Test(arguments: [false, true]) func aVideoGoesAsH264At720pWithoutWhereItWasFilmed(byHand: Bool) async throws {
        let film = try await Films.filmed(seconds: 2)
        defer { try? FileManager.default.removeItem(at: film) }
        let filmed = try await AVURLAsset(url: film).load(.metadata)
        #expect(filmed.contains { $0.identifier == .quickTimeMetadataLocationISO6709 }, "the film itself says where")

        let exported = URL.temporaryDirectory.appending(path: "exported-\(UUID().uuidString).mp4")
        defer { try? FileManager.default.removeItem(at: exported) }
        if byHand {
            try await VideoPrep.transcode(film, to: exported, fitting: Self.limits.maxBytes) { _ in }
        } else {
            try await VideoPrep.export(film, to: exported, fitting: Self.limits.maxBytes) { _ in }
        }

        let asset = AVURLAsset(url: exported)
        let track = try #require(try await asset.loadTracks(withMediaType: .video).first)
        let format = try #require(try await track.load(.formatDescriptions).first)
        #expect(CMFormatDescriptionGetMediaSubType(format) == kCMVideoCodecType_H264)
        #expect(try await track.load(.naturalSize) == CGSize(width: 1_280, height: 720))

        var items = try await asset.load(.metadata)
        for format in try await asset.load(.availableMetadataFormats) { items += try await asset.loadMetadata(for: format) }
        for track in try await asset.load(.tracks) { items += try await track.load(.metadata) }
        // Not one item: an export left alone writes the place as `uiso/loci`, which names no "location".
        #expect(items.isEmpty, "\(items.compactMap { $0.identifier?.rawValue })")
        #expect(try await asset.loadTracks(withMediaType: .metadata).isEmpty)

        let bytes = try Data(contentsOf: exported)
        #expect(bytes.range(of: Data(Films.place.prefix(9).utf8)) == nil, "the place is in the file")
        #expect(bytes.range(of: Data("loci".utf8)) == nil, "the place is in the file as a 3GPP location")
        #expect(bytes.range(of: Data(Films.phone.utf8)) == nil, "the phone is in the file")
    }

    /// A video still over the Mac's limit once exported is refused by its size, and nothing of it is
    /// kept: no draft file, nothing in the outbox to send, nothing left over.
    @Test func aVideoTooBigIsRefusedBeforeAnyOfItIsKept() async throws {
        let model = AppModel()
        let film = try await Films.filmed(seconds: 2)
        let outbox = Films.outbox(model)
        let small = SendLimits(maxCount: 6, maxBytes: 2_000, maxTotalBytes: 10 * 1024 * 1024)

        await model.attachVideo(at: film, to: "video-tests", limits: small)

        let words = try #require(model.toast?.text)
        #expect(words.hasPrefix("This video is ") && words.hasSuffix(" after export. Realm sends up to 2 KB a file from iPhone for now."), "\(words)")
        #expect(model.draftAttachments["video-tests"] == nil)
        #expect(model.store.outbox.items.isEmpty)
        #expect(Films.outbox(model) == outbox)
        #expect(Films.working().isEmpty, "\(Films.working())")
        #expect(!FileManager.default.fileExists(atPath: film.path))
    }

    /// The export is asked to come out under the Mac's limit, so the encoder lowers the bitrate to fit:
    /// the system's by its length limit, where it offers a 1280 by 720 export, and the one by hand by
    /// a bitrate that spreads the limit over the film.
    @Test func theExportIsAskedToFitTheLimit() async throws {
        let film = try await Films.filmed(seconds: 1)
        defer { try? FileManager.default.removeItem(at: film) }
        if let session = VideoPrep.session(for: film, fitting: Self.limits.maxBytes) {
            #expect(session.fileLengthLimit > 0 && session.fileLengthLimit < Int64(Self.limits.maxBytes), "\(session.fileLengthLimit)")
        }
        let limit = Self.limits.maxBytes
        for seconds in [10.0, 25, 35] {
            let bits = Double(VideoPrep.bitRate(lasting: seconds, fitting: limit) + VideoPrep.soundBitRate) * seconds
            #expect(bits / 8 < Double(limit), "\(seconds) s")
        }
        #expect(VideoPrep.bitRate(lasting: 2, fitting: limit) == 5_000_000, "a short film is not blown up to fill the limit")
        #expect(VideoPrep.bitRate(lasting: 120, fitting: limit) == 1_600_000, "a long one is not starved to fit")
    }

    /// Stopping an export by hand leaves nothing where it was writing, not even the writer's working copy.
    @Test func aCancelledTranscodeLeavesNothing() async throws {
        let film = try await Films.filmed(seconds: 20)
        defer { try? FileManager.default.removeItem(at: film) }
        let exported = VideoPrep.folder.appending(path: "\(UUID().uuidString).mp4")
        let moved = Mutex(0.0)
        let transcoding = Task { try await VideoPrep.transcode(film, to: exported, fitting: Self.limits.maxBytes) { share in moved.withLock { $0 = share } } }
        let deadline = ContinuousClock.now + .seconds(30)
        while moved.withLock({ $0 }) == 0, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        transcoding.cancel()
        await #expect(throws: CancellationError.self) { try await transcoding.value }
        #expect(Films.working().isEmpty, "\(Films.working())")
    }

    /// A video over a minute is refused by its length before any export starts: no export, nothing in
    /// the folder exports are written in, nothing kept.
    @Test func aVideoTooLongIsRefusedBeforeAnyExport() async throws {
        let model = AppModel()
        let film = try await Films.filmed(seconds: 61, framesPerSecond: 1)
        let outbox = Films.outbox(model)
        // An export makes the folder; none starting leaves it unmade.
        VideoPrep.sweep()
        let exportStarted = Mutex(false)
        withObservationTracking { _ = model.videoExports } onChange: { exportStarted.withLock { $0 = true } }

        await model.attachVideo(at: film, to: "video-tests", limits: Self.limits)

        #expect(model.toast?.text == "This video is 1:01. Realm sends videos up to 1:00 from iPhone for now.")
        #expect(!exportStarted.withLock { $0 })
        #expect(!FileManager.default.fileExists(atPath: VideoPrep.folder.path), "\(Films.working())")
        #expect(model.draftAttachments["video-tests"] == nil)
        #expect(Films.outbox(model) == outbox)
        #expect(!FileManager.default.fileExists(atPath: film.path))
    }

    /// Launch clears what an export killed with the app left in its folder, and nothing beside it: not
    /// the rest of the temporary folder, not the outbox.
    @Test func launchClearsWhatAKilledExportLeft() async throws {
        let model = AppModel()
        try FileManager.default.createDirectory(at: VideoPrep.folder, withIntermediateDirectories: true)
        try Data("picked".utf8).write(to: VideoPrep.folder.appending(path: "\(UUID().uuidString).mov"))
        let beside = URL.temporaryDirectory.appending(path: "beside-\(UUID().uuidString).txt")
        try Data("kept".utf8).write(to: beside)
        defer { try? FileManager.default.removeItem(at: beside) }
        let queued = try model.store.files.keep(Data("queued".utf8), name: "Notes.txt", mime: "text/plain")
        defer { model.store.files.remove([queued]) }

        let center = UNUserNotificationCenter.current()
        let answering = center.delegate
        defer { center.delegate = answering }
        _ = AppDelegate().application(UIApplication.shared, didFinishLaunchingWithOptions: nil)

        #expect(!FileManager.default.fileExists(atPath: VideoPrep.folder.path), "\(Films.working())")
        #expect(FileManager.default.fileExists(atPath: beside.path))
        // Only its own file: suites running beside this one keep theirs in the same outbox.
        #expect(FileManager.default.fileExists(atPath: model.store.files.url(of: queued).path))
    }

    /// One that fits goes into the draft as a photo would: an MP4 in the outbox, named for a video.
    @Test func aVideoThatFitsIsKeptForTheMessage() async throws {
        let model = AppModel()
        let film = try await Films.filmed(seconds: 2)
        let outbox = Films.outbox(model)

        await model.attachVideo(at: film, to: "video-tests", limits: Self.limits)

        let kept = try #require(model.draftAttachments["video-tests"]?.first, "\(model.toast?.text ?? "no toast")")
        defer { model.removeAttachment(kept, from: "video-tests") }
        #expect(kept.name == "Video.mp4" && kept.mime == "video/mp4" && kept.size > 0)
        #expect(Films.outbox(model) == outbox.union([kept.file]))
        #expect(Films.working().isEmpty, "\(Films.working())")
        #expect(model.toast == nil)
    }

    /// Taking out a video's tile while it exports stops the export, and leaves nothing behind: no
    /// file in the outbox, none in the folder it was exported in, and no toast.
    @Test func aCancelledExportLeavesNothing() async throws {
        let model = AppModel()
        let film = try await Films.filmed(seconds: 20)
        let outbox = Films.outbox(model)

        let attaching = Task { await model.attachVideo(at: film, to: "video-tests", limits: Self.limits) }
        let deadline = ContinuousClock.now + .seconds(30)
        while model.videoExports["video-tests"]?.first.map({ $0.progress > 0 }) != true, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        model.cancelExport(try #require(model.videoExports["video-tests"]?.first))
        await attaching.value
        #expect(model.videoExports["video-tests"] == nil)

        #expect(model.draftAttachments["video-tests"] == nil)
        #expect(Films.outbox(model) == outbox)
        #expect(Films.working().isEmpty, "\(Films.working())")
        #expect(!FileManager.default.fileExists(atPath: film.path))
        #expect(model.toast == nil)
    }

    @Test func videosAreNamedApartAndTooBigSaysItsSize() {
        let video = OutgoingAttachment(id: UUID(), name: "Video.mp4", mime: "video/mp4", size: 1, file: "x.mp4")
        #expect(AttachmentNames.video(besides: []) == "Video.mp4")
        #expect(AttachmentNames.video(besides: [video]) == "Video 2.mp4")
        #expect(AttachmentLimits.refusal(video: "Video.mp4", size: 23 * 1024 * 1024, joining: [], limits: Self.limits)
                == "This video is 23 MB after export. Realm sends up to 8 MB a file from iPhone for now.")
        #expect(AttachmentLimits.refusal(videoLasting: .seconds(102)) == "This video is 1:42. Realm sends videos up to 1:00 from iPhone for now.")
        #expect(AttachmentLimits.refusal(videoLasting: .seconds(60)) == nil)
        #expect(AttachmentLimits.refusal(video: "Video.mp4", size: 3 * 1024 * 1024, joining: [AttachmentLimitTests.file(8)], limits: Self.limits)
                == "Video.mp4 would take this message over 10 MB, the most your Mac takes in one.")
        #expect(AttachmentLimits.refusal(video: "Video.mp4", size: 3 * 1024 * 1024, joining: [], limits: Self.limits) == nil)
    }
}

@Suite("A video sent ahead of its message", .serialized)
@MainActor
struct VideoAheadTests {
    /// To a Mac that takes videos ahead, one over 8:00 is refused by its length before any export
    /// starts, in PR 1's words with the longer limit.
    @Test func aVideoOverEightMinutesIsRefusedBeforeAnyExport() async throws {
        let model = AppModel()
        model.macTakesVideosAhead = true
        let film = try await Films.filmed(seconds: 481, framesPerSecond: 1)
        let outbox = Films.outbox(model)
        VideoPrep.sweep()
        let exportStarted = Mutex(false)
        withObservationTracking { _ = model.videoExports } onChange: { exportStarted.withLock { $0 = true } }

        await model.attachVideo(at: film, to: "video-tests", limits: VideoPrepTests.limits)

        // THE MUTANT: check the length after the export, and an hour of film is exported to be refused.
        #expect(model.toast?.text == "This video is 8:01. Realm sends videos up to 8:00 from iPhone.")
        #expect(!exportStarted.withLock { $0 })
        #expect(!FileManager.default.fileExists(atPath: VideoPrep.folder.path), "\(Films.working())")
        #expect(model.draftAttachments["video-tests"] == nil)
        #expect(Films.outbox(model) == outbox)
        #expect(!FileManager.default.fileExists(atPath: film.path))
    }

    /// A new session's first message goes by `session.create`, which takes no uploads: a minute still holds.
    @Test func aNewSessionsVideoKeepsToAMinute() async throws {
        let model = AppModel()
        model.macTakesVideosAhead = true
        let film = try await Films.filmed(seconds: 61, framesPerSecond: 1)
        await model.attachVideo(at: film, to: NewSessionDefaults.draft, limits: VideoPrepTests.limits)
        #expect(model.toast?.text == "This video is 1:01. Realm sends videos up to 1:00 from iPhone for now.")
        #expect(model.videoExports[NewSessionDefaults.draft] == nil)
    }

    @Test func theLengthAndSizeAheadAreEightMinutesAndAHundredMegabytes() {
        #expect(AttachmentLimits.refusal(videoLasting: .seconds(480), ahead: true) == nil)
        #expect(AttachmentLimits.refusal(videoLasting: .seconds(61), ahead: true) == nil)
        #expect(AttachmentLimits.refusal(videoLasting: .seconds(552), ahead: true) == "This video is 9:12. Realm sends videos up to 8:00 from iPhone.")
        #expect(AttachmentLimits.refusal(videoLasting: .seconds(61), ahead: false) == "This video is 1:01. Realm sends videos up to 1:00 from iPhone for now.")
        let limits = VideoPrepTests.limits
        #expect(AttachmentLimits.refusal(videoAhead: ChunkedUpload.maxBytes, joining: [], limits: limits) == nil)
        #expect(AttachmentLimits.refusal(videoAhead: 104 * 1024 * 1024, joining: [], limits: limits)
                == "This video is 104 MB after export. Realm sends up to 100 MB a file from iPhone.")
        let full = (0..<limits.maxCount).map { _ in AttachmentLimitTests.file(1) }
        #expect(AttachmentLimits.refusal(videoAhead: 20 * 1024 * 1024, joining: full, limits: limits) == "Up to 6 files in one message.")
    }

    /// THE MUTANT: keep only the frame, and a sent video's tile loses its length once the Mac sweeps the file.
    @Test func aTileFromAKeptFrameSaysHowLongTheVideoRuns() async throws {
        let film = try await Films.filmed(seconds: 3)
        let file = URL.temporaryDirectory.appending(path: "poster-\(UUID().uuidString)/poster.jpg")
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let drawn = await VideoPoster.draw(film, side: 64, scale: 3, keepingAt: file)
        try FileManager.default.removeItem(at: film)

        let kept = try #require(VideoPoster.kept(at: file))
        #expect(kept.frame != nil)
        #expect(drawn.duration == .seconds(3))
        #expect(kept.duration == drawn.duration)
    }

    /// THE MUTANTS: ask on Wi-Fi, ask at 25 MB, or never ask.
    @Test func cellularAsksOnlyPastTwentyFiveMegabytesAndWiFiNever() {
        let over = CostlyUpload.over
        #expect(over == 25 * 1024 * 1024)
        #expect(CostlyUpload.asks(size: over + 1, costly: true))
        #expect(CostlyUpload.asks(size: ChunkedUpload.maxBytes, costly: true))
        #expect(!CostlyUpload.asks(size: over, costly: true))
        #expect(!CostlyUpload.asks(size: 9 * 1024 * 1024, costly: true))
        #expect(!CostlyUpload.asks(size: over + 1, costly: false))
        #expect(!CostlyUpload.asks(size: ChunkedUpload.maxBytes, costly: false))
        let question = CostlyUpload(export: UUID(), sessionId: "s1", size: 48 * 1024 * 1024)
        #expect(question.title == "Send 48 MB over cellular?")
        #expect(question.message.contains("48 MB"))
    }
}
