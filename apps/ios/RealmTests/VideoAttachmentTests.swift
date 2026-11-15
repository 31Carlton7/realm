import AVFoundation
import CoreMedia
import RealmKit
import Testing
import UIKit
@testable import Realm

/// Films made on the spot, as a phone would have filmed them: where, and on what.
enum Films {
    static let place = "+37.7749-122.4194+012.000/"
    static let phone = "iPhone 17 Pro"

    /// A 1920 by 1080 film of `seconds`, carrying `place` and `phone` in its metadata.
    static func filmed(seconds: Int) async throws -> URL {
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
        for index in 0..<(seconds * 30) {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, frames.pixelBufferPool!, &buffer)
            let frame = buffer!
            CVPixelBufferLockBaseAddress(frame, [])
            // A different grey each frame, so the encoder has something to keep.
            memset(CVPixelBufferGetBaseAddress(frame), Int32(index % 256), CVPixelBufferGetDataSize(frame))
            CVPixelBufferUnlockBaseAddress(frame, [])
            frames.append(frame, withPresentationTime: CMTime(value: CMTimeValue(index), timescale: 30))
        }
        input.markAsFinished()
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
    /// or on what: not the metadata the asset reads, and not the bytes.
    @Test func aVideoGoesAsH264At720pWithoutWhereItWasFilmed() async throws {
        let film = try await Films.filmed(seconds: 2)
        defer { try? FileManager.default.removeItem(at: film) }
        let filmed = try await AVURLAsset(url: film).load(.metadata)
        #expect(filmed.contains { $0.identifier == .quickTimeMetadataLocationISO6709 }, "the film itself says where")

        let exported = URL.temporaryDirectory.appending(path: "exported-\(UUID().uuidString).mp4")
        defer { try? FileManager.default.removeItem(at: exported) }
        try await VideoPrep.export(film, to: exported) { _ in }

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
        #expect(AttachmentLimits.refusal(video: "Video.mp4", size: 3 * 1024 * 1024, joining: [AttachmentLimitTests.file(8)], limits: Self.limits)
                == "Video.mp4 would take this message over 10 MB, the most your Mac takes in one.")
        #expect(AttachmentLimits.refusal(video: "Video.mp4", size: 3 * 1024 * 1024, joining: [], limits: Self.limits) == nil)
    }
}
