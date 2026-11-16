import AVFoundation
import ImageIO
import PhotosUI
import RealmKit
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A photo as it goes to the Mac: a JPEG at most 2048 pixels on its long edge, upright, at quality
/// 0.82, and without the metadata it carried — where it was taken among it. That keeps a photo near a
/// megabyte, under what an agent takes inline.
enum PhotoPrep {
    static let longEdge = 2048
    static let quality = 0.82

    /// From a photo's own bytes, as the library or Files gives them: HEIC, JPEG, PNG, anything the
    /// system reads. Nil for bytes that are not a picture.
    static func jpeg(_ data: Data) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: longEdge,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return jpeg(image)
    }

    /// From the camera, which hands back an image rather than bytes.
    static func jpeg(_ image: UIImage) -> Data? {
        let pixels = CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
        let factor = min(1, CGFloat(longEdge) / max(pixels.width, pixels.height, 1))
        let size = CGSize(width: (pixels.width * factor).rounded(), height: (pixels.height * factor).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        // Drawn, so the camera's orientation is turned into the pixels and nothing else comes along.
        let drawn = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        return drawn.cgImage.flatMap(jpeg)
    }

    private static func jpeg(_ image: CGImage) -> Data? {
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return output as Data
    }
}

/// A video as it goes to the Mac: H.264 in an MP4, at most 1280 by 720, and without the metadata it
/// carried — where it was filmed, and on what. The encoder lowers the bitrate to fit the Mac's limit,
/// but not below about 1.6 megabits a second for a camera's film, which fits 8 MB up to about 40 s
/// and the 100 MB that goes ahead of a message past 8 minutes.
enum VideoPrep {
    static let mime = "video/mp4"

    /// The longest video sent with its message, to a Mac that takes none ahead of it.
    static let longest: Duration = .seconds(60)
    /// The longest sent ahead of its message (`ChunkedUpload`): camera film at 8:00, 30 or 60 fps,
    /// came out at 94 MB at most.
    static let longestAhead: Duration = .seconds(480)

    /// Where a picked video is copied out of Photos and exported to, each file under a name of its own.
    /// Both go once the video is kept, refused or stopped, and the folder goes at launch: an app killed
    /// mid-export leaves its copy behind.
    static let folder = URL.temporaryDirectory.appending(path: "Videos", directoryHint: .isDirectory)

    static func sweep() {
        try? FileManager.default.removeItem(at: folder)
    }

    /// The export of `movie`, asked to come out under `maxBytes`. The encoder may still go over, a
    /// little when it lowers the bitrate and more once it cannot, so the file is measured after.
    static func session(for movie: URL, fitting maxBytes: Int) -> AVAssetExportSession? {
        guard let session = AVAssetExportSession(asset: AVURLAsset(url: movie), presetName: AVAssetExportPreset1280x720) else {
            return nil
        }
        // A tenth under: asked for 95%, a 30 s clip came out at 98% of the limit.
        session.fileLengthLimit = Int64(maxBytes) * 9 / 10
        // Left alone, an export carries where it was filmed over as an MP4 `loci` atom. Setting
        // `metadata` to none does not stop it; the filter does, and takes the phone's make and model too.
        session.metadataItemFilter = .forSharing()
        session.shouldOptimizeForNetworkUse = true
        return session
    }

    /// Exports `movie` to a new file at `destination`, telling `progress` how far along it is.
    /// Cancelling the task stops the export and leaves nothing at `destination`.
    static func export(_ movie: URL, to destination: URL, fitting maxBytes: Int, progress: @escaping @Sendable (Double) -> Void) async throws {
        guard let session = session(for: movie, fitting: maxBytes) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        // Not Sendable in the SDK, though `states` is made to be watched while `export` runs.
        nonisolated(unsafe) let watched = session
        let watching = Task {
            for await state in watched.states(updateInterval: 0.1) {
                if case .exporting(let share) = state { progress(share.fractionCompleted) }
            }
        }
        defer { watching.cancel() }
        do {
            try await session.export(to: destination, as: .mp4)
            try Task.checkCancellation()
        } catch {
            try? FileManager.default.removeItem(at: destination)
            throw error
        }
    }
}

/// A video picked from the library, copied out of Photos into `VideoPrep.folder`: what Photos hands
/// over is only there while it is being taken.
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            try FileManager.default.createDirectory(at: VideoPrep.folder, withIntermediateDirectories: true)
            let copy = VideoPrep.folder.appending(path: "\(UUID().uuidString).\(received.file.pathExtension)")
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}

/// A file from Files as it goes to the Mac: its own bytes, except a picture of a kind the Mac cannot
/// hand an agent inline (HEIC, TIFF), which goes as a photo would.
enum FilePrep {
    /// The pictures every agent takes inline, which the Mac checks a picture against.
    static let inlinePictures: Set<String> = ["image/jpeg", "image/png", "image/gif", "image/webp"]

    static func mime(of name: String) -> String {
        UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }

    static func prepared(_ data: Data, name: String) -> (data: Data, name: String, mime: String) {
        let mime = mime(of: name)
        if mime.hasPrefix("image/"), !inlinePictures.contains(mime), let jpeg = PhotoPrep.jpeg(data) {
            return (jpeg, AttachmentNames.jpeg(name), "image/jpeg")
        }
        return (data, name, mime)
    }
}

enum AttachmentNames {
    /// "Photo.jpg", then "Photo 2.jpg" and on: a photo's name that no other file of the message has.
    static func photo(besides taken: [OutgoingAttachment]) -> String {
        numbered("Photo", "jpg", besides: taken)
    }

    /// "Video.mp4", then "Video 2.mp4" and on, as a photo's.
    static func video(besides taken: [OutgoingAttachment]) -> String {
        numbered("Video", "mp4", besides: taken)
    }

    private static func numbered(_ stem: String, _ ext: String, besides taken: [OutgoingAttachment]) -> String {
        let names = Set(taken.map(\.name))
        if !names.contains("\(stem).\(ext)") { return "\(stem).\(ext)" }
        var number = 2
        while names.contains("\(stem) \(number).\(ext)") { number += 1 }
        return "\(stem) \(number).\(ext)"
    }

    /// The name a picture made a JPEG goes by: "IMG_0412.HEIC" becomes "IMG_0412.jpg".
    static func jpeg(_ name: String) -> String {
        "\((name as NSString).deletingPathExtension).jpg"
    }
}

/// What one message may take, by the Mac's limits (`session.options`), said in words where it may not.
enum AttachmentLimits {
    /// Nil when a file of `size` bytes may join `others`; else why not.
    static func refusal(_ name: String, size: Int, joining others: [OutgoingAttachment], limits: SendLimits) -> String? {
        if others.count >= limits.maxCount { return full(limits) }
        if size > limits.maxBytes { return "\(name) is over \(megabytes(limits.maxBytes)), the most your Mac takes from iPhone." }
        if others.reduce(size, { $0 + $1.size }) > limits.maxTotalBytes {
            return "\(name) would take this message over \(megabytes(limits.maxTotalBytes)), the most your Mac takes in one."
        }
        return nil
    }

    /// As `refusal`, but a video too big says how big it came out: it was made smaller already, and
    /// longer ones wait on the Mac taking more.
    static func refusal(video name: String, size: Int, joining others: [OutgoingAttachment], limits: SendLimits) -> String? {
        if others.count < limits.maxCount, size > limits.maxBytes {
            return "This video is \(megabytes(size)) after export. Realm sends up to \(megabytes(limits.maxBytes)) a file from iPhone for now."
        }
        return refusal(name, size: size, joining: others, limits: limits)
    }

    /// Why a video is too long to export at all: its length, and the most that goes. `ahead`: the Mac
    /// takes videos ahead of their message, which go up to `VideoPrep.longestAhead`.
    static func refusal(videoLasting length: Duration, ahead: Bool = false) -> String? {
        let pattern = Duration.TimeFormatStyle(pattern: .minuteSecond)
        if ahead {
            guard length > VideoPrep.longestAhead else { return nil }
            return "This video is \(length.formatted(pattern)). Realm sends videos up to \(VideoPrep.longestAhead.formatted(pattern)) from iPhone."
        }
        guard length > VideoPrep.longest else { return nil }
        return "This video is \(length.formatted(pattern)). Realm sends videos up to \(VideoPrep.longest.formatted(pattern)) from iPhone for now."
    }

    /// As `refusal(video:)`, for one going ahead of its message: only its size and the message's count
    /// of files hold it back.
    static func refusal(videoAhead size: Int, joining others: [OutgoingAttachment], limits: SendLimits) -> String? {
        if others.count >= limits.maxCount { return full(limits) }
        guard size > ChunkedUpload.maxBytes else { return nil }
        return "This video is \(megabytes(size)) after export. Realm sends up to \(megabytes(ChunkedUpload.maxBytes)) a file from iPhone."
    }

    /// Why nothing more can be added: what the `+` menu says under its items at the limit.
    static func full(_ limits: SendLimits) -> String {
        "Up to \(limits.maxCount) files in one message."
    }

    static func megabytes(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .binary)
    }
}

/// A video asking before it goes ahead over cellular or Low Data Mode: once, and only past `over`.
/// Wi-Fi never asks.
struct CostlyUpload: Identifiable, Equatable {
    static let over = 25 * 1024 * 1024

    let export: UUID
    let sessionId: String
    let size: Int
    var id: UUID { export }

    static func asks(size: Int, costly: Bool) -> Bool {
        costly && size > over
    }

    var title: String { "Send \(AttachmentLimits.megabytes(size)) over cellular?" }
    var message: String { "This video is \(AttachmentLimits.megabytes(size)), and this iPhone is on cellular or Low Data Mode. On Wi-Fi it goes without asking." }
}

/// Where something to attach comes from.
enum AttachmentSource: Sendable {
    case library(PhotosPickerItem)
    case video(PhotosPickerItem)
    case camera(UIImage)
    case file(URL)
}

/// The camera, as UIKit offers it: a photo taken comes back as an image, and nothing if it is put away.
struct CameraPicker: UIViewControllerRepresentable {
    let took: (UIImage?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(took: took) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let took: (UIImage?) -> Void

        init(took: @escaping (UIImage?) -> Void) {
            self.took = took
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            took(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            took(nil)
        }
    }
}

/// A small copy of a picture on this phone, made off the main thread: a tile's, sized for its side.
struct LocalThumbnail: View {
    let url: URL
    let side: CGFloat
    @Environment(\.displayScale) private var displayScale
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Rectangle().fill(Palette.mark)
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            }
        }
        .frame(width: side, height: side)
        .clipped()
        .animation(.easeOut(duration: 0.2), value: image != nil)
        .task(id: url) {
            let pixels = side * displayScale
            image = await Task.detached(priority: .userInitiated) { Self.thumbnail(url, pixels: pixels) }.value
        }
    }

    nonisolated static func thumbnail(_ url: URL, pixels: CGFloat) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: Int(pixels),
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
    }
}

/// A video being made ready for a message, by how far along it is: exported, then for one too big
/// to go with it, sent to the Mac ahead of it.
struct VideoExport: Identifiable, Equatable {
    let id: UUID
    var progress: Double
    var sending = false
    /// The exported video while it goes ahead, whose frame the tile shows under its ring.
    var movie: URL?
}

/// A video's tile while it is exported or sent ahead: a ring that fills as it goes, over the video's
/// frame once it goes ahead.
private struct ExportTile: View {
    let progress: Double
    let sending: Bool
    let movie: URL?
    @Environment(\.displayScale) private var displayScale
    @State private var frame: UIImage?

    var body: some View {
        // Over a frame, white on a dark disc, so the ring reads on a bright frame too.
        let ink = frame == nil ? Palette.ink2 : .white
        ZStack {
            if frame != nil {
                Circle()
                    .fill(.black.opacity(0.5))
                    .frame(width: 34, height: 34)
            }
            Circle()
                .stroke(frame == nil ? Palette.line : .white.opacity(0.35), lineWidth: 3)
                .frame(width: 24, height: 24)
            Circle()
                .trim(from: 0, to: max(0.03, progress))
                .stroke(ink, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .frame(width: 24, height: 24)
            Image(systemName: sending ? "arrow.up" : "video.fill")
                .font(.system(size: 9, weight: sending ? .bold : .regular))
                .foregroundStyle(ink)
        }
        .animation(.linear(duration: 0.1), value: progress)
        .frame(width: AttachmentStrip.side, height: AttachmentStrip.side)
        .background {
            ZStack {
                Rectangle().fill(Palette.mark)
                if let frame {
                    Image(uiImage: frame)
                        .resizable()
                        .scaledToFill()
                }
            }
            .frame(width: AttachmentStrip.side, height: AttachmentStrip.side)
            .clipShape(RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
        }
        .animation(.easeOut(duration: 0.2), value: frame != nil)
        .task(id: movie) {
            guard let movie else { return }
            frame = await GalleryCover.image(of: movie, kind: .video, side: AttachmentStrip.side, scale: displayScale)
        }
        .accessibilityElement()
        .accessibilityLabel(sending ? "Sending the video to your Mac" : "Making the video ready to send")
        .accessibilityValue(progress.formatted(.percent.precision(.fractionLength(0))))
    }
}

/// A video on this phone as a tile: a frame from it, and how long it runs.
struct VideoThumbnail: View {
    let url: URL
    let side: CGFloat
    /// Where to keep the frame once drawn, for a tile that must outlast the file.
    var poster: URL?
    @Environment(\.displayScale) private var displayScale
    @State private var frame: UIImage?
    @State private var duration: Duration?

    var body: some View {
        ZStack {
            Rectangle().fill(Palette.mark)
            if let frame {
                Image(uiImage: frame)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            }
        }
        .frame(width: side, height: side)
        .clipped()
        .videoLength(duration)
        .animation(.easeOut(duration: 0.2), value: frame != nil)
        .task(id: url) {
            let drawn = await VideoPoster.draw(url, side: side, scale: displayScale, keepingAt: poster)
            frame = drawn.frame
            duration = drawn.duration
        }
    }
}

/// A sent video's frame and how long it runs, kept beside each other so its tile reads the same once
/// the file is gone.
struct VideoPoster {
    var frame: UIImage?
    var duration: Duration?

    /// The frame and length of the video at `url`; the first drawn is kept at `file`.
    static func draw(_ url: URL, side: CGFloat, scale: CGFloat, keepingAt file: URL?) async -> VideoPoster {
        let frame = await GalleryCover.image(of: url, kind: .video, side: side, scale: scale)
        let length = try? await AVURLAsset(url: url).load(.duration)
        let drawn = VideoPoster(frame: frame, duration: length.map { .seconds($0.seconds.rounded()) })
        if let file, !FileManager.default.fileExists(atPath: file.path), let data = frame?.jpegData(compressionQuality: 0.8) {
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: file, options: .atomic)
            if let seconds = drawn.duration?.components.seconds {
                try? Data(String(seconds).utf8).write(to: lengthFile(file), options: .atomic)
            }
        }
        return drawn
    }

    /// The one kept at `file`; nil for a video whose frame was never drawn.
    static func kept(at file: URL) -> VideoPoster? {
        guard let frame = UIImage(contentsOfFile: file.path) else { return nil }
        let seconds = (try? String(contentsOf: lengthFile(file), encoding: .utf8)).flatMap { Int64($0) }
        return VideoPoster(frame: frame, duration: seconds.map { .seconds($0) })
    }

    private static func lengthFile(_ file: URL) -> URL { file.deletingPathExtension().appendingPathExtension("length") }
}

/// A sent photo's tile as first drawn, kept beside the videos' frames so its tile reads the same once
/// the file is gone.
enum PhotoPreview {
    /// The tile to draw: the one `drawn` from the Mac's copy, kept at `file` the first time; with no
    /// copy to draw from, the one kept.
    static func tile(drawn: UIImage?, keptAt file: URL) -> UIImage? {
        guard let drawn else { return UIImage(contentsOfFile: file.path) }
        if !FileManager.default.fileExists(atPath: file.path), let data = drawn.jpegData(compressionQuality: 0.8) {
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: file, options: .atomic)
        }
        return drawn
    }
}

extension View {
    /// How long a video runs, along the foot of its tile.
    func videoLength(_ duration: Duration?) -> some View {
        overlay(alignment: .bottomLeading) {
            if let duration {
                Text(duration.formatted(.time(pattern: .minuteSecond)))
                    .font(.caption2.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.white)
                    .padding(.horizontal, 5)
                    .padding(.top, 8)
                    .padding(.bottom, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(LinearGradient(colors: [.clear, .black.opacity(0.5)], startPoint: .top, endPoint: .bottom))
            }
        }
    }
}

/// A file that is not a picture, as one line: its kind's glyph, its name, and its size where known.
struct AttachmentChip: View {
    let name: String
    let size: Int?

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: FileKind.symbol(name))
                .font(.body)
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(Palette.ink2)
            VStack(alignment: .leading, spacing: 1) {
                Text(name)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Palette.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let size {
                    Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .binary))
                        .font(.caption)
                        .foregroundStyle(Palette.ink2)
                        .monospacedDigit()
                }
            }
        }
        .padding(.horizontal, 10)
        .frame(maxWidth: 200, minHeight: 44, alignment: .leading)
    }
}

/// The files a message being written takes, over its field: photos as small squares, other files as
/// chips. Each opens in Quick Look, and has its own button to take it out. The tabs it hands over
/// follow them as cards, each taken out by a tap.
struct AttachmentStrip: View {
    let attachments: [OutgoingAttachment]
    var tabs: [DraftTab] = []
    /// The quiet line of each pane the space has, for telling apart those of one name.
    var tabLines: [String: String] = [:]
    /// Picked, and still being read or made smaller: the videos being exported among them.
    let preparing: Int
    var exports: [VideoExport] = []
    let files: OutboxFiles
    let open: (OutgoingAttachment) -> Void
    let remove: (OutgoingAttachment) -> Void
    var removeTab: (DraftTab) -> Void = { _ in }
    var cancelExport: (VideoExport) -> Void = { _ in }

    static let side: CGFloat = 56

    /// Where a file is linked under its own name while Quick Look shows it.
    private static let previews = URL.temporaryDirectory.appending(path: "Preview", directoryHint: .isDirectory)

    /// Quick Look titles a preview with its file's name, so it is shown a link to the bytes under the
    /// attachment's own, which goes when the preview does (`forgetPreviews`).
    static func previewLink(_ attachment: OutgoingAttachment, files: OutboxFiles) -> URL {
        let folder = previews.appending(path: attachment.id.uuidString, directoryHint: .isDirectory)
        let link = folder.appending(path: attachment.name.replacingOccurrences(of: "/", with: "-"))
        if !FileManager.default.fileExists(atPath: link.path) {
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try? FileManager.default.linkItem(at: files.url(of: attachment), to: link)
        }
        return link
    }

    static func forgetPreviews() {
        try? FileManager.default.removeItem(at: previews)
    }

    var body: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 10) {
                ForEach(attachments) { attachment in
                    Button { open(attachment) } label: {
                        tile(attachment)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(attachment.name)
                    .accessibilityHint("Opens a preview")
                    .overlay(alignment: .topTrailing) {
                        removeButton("Remove \(attachment.name)") { remove(attachment) }
                    }
                }
                ForEach(exports) { export in
                    ExportTile(progress: export.progress, sending: export.sending, movie: export.movie)
                        .overlay(alignment: .topTrailing) {
                            removeButton("Stop adding the video") { cancelExport(export) }
                        }
                }
                ForEach(0..<max(0, preparing - exports.count), id: \.self) { _ in
                    ProgressView()
                        .frame(width: Self.side, height: Self.side)
                        .background(Palette.mark, in: RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
                        .accessibilityLabel("Adding a file")
                }
                ForEach(tabs) { tab in
                    Button { removeTab(tab) } label: {
                        TabChip(tab: tab.tab, card: tab.card, detail: tabLines[tab.id], removable: true)
                            .frame(height: Self.side)
                            .background(Palette.mark, in: RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove \(Mentions.tabName(tab.tab))")
                    .accessibilityValue(TabWords.line(tab.tab, detail: tabLines[tab.id], card: tab.card))
                }
            }
            // Room for the remove buttons over the tiles' corners.
            .padding(.top, 10)
            .padding(.trailing, 10)
        }
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
    }

    private func removeButton(_ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "xmark.circle.fill")
                .font(.system(size: 20))
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, .black.opacity(0.62))
                .frame(width: 32, height: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .offset(x: 10, y: -10)
        .accessibilityLabel(label)
    }

    @ViewBuilder
    private func tile(_ attachment: OutgoingAttachment) -> some View {
        if attachment.isImage {
            LocalThumbnail(url: files.url(of: attachment), side: Self.side)
                .pictureTile()
        } else if attachment.isVideo {
            VideoThumbnail(url: files.url(of: attachment), side: Self.side)
                .pictureTile()
        } else {
            AttachmentChip(name: attachment.name, size: attachment.size)
                .frame(height: Self.side)
                .background(Palette.mark, in: RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
        }
    }
}

/// The files that went with a message, under it: pictures as tiles the Mac sends small copies of, as
/// a turn's made files are drawn, videos as a frame and their length, and other files as chips. A tap
/// on one, or a swipe right across them, opens them all in the gallery.
struct SentFiles: View {
    let files: [SentFile]
    let sessionId: String
    @State private var opening: GalleryOpening?

    var body: some View {
        let pages = GalleryPages(files)
        let pictures = files.filter { $0.isImage || $0.isVideo }
        let others = files.filter { !$0.isImage && !$0.isVideo }
        VStack(alignment: .trailing, spacing: 6) {
            if !pictures.isEmpty {
                TrailingFlow(spacing: 6) {
                    ForEach(pictures, id: \.path) { file in
                        Button { opening = GalleryOpening(page: pages.page(of: file)) } label: {
                            if file.isVideo {
                                SentVideo(file: file, sessionId: sessionId)
                            } else {
                                SentPicture(file: file, sessionId: sessionId)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(file.name)
                        .accessibilityHint("Opens the message's files")
                    }
                }
            }
            ForEach(others, id: \.path) { file in
                Button { opening = GalleryOpening(page: pages.page(of: file)) } label: {
                    AttachmentChip(name: file.name, size: nil)
                        .background(Fill.bubble, in: RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the message's files")
            }
        }
        .gesture(GallerySwipe { opening = GalleryOpening(page: 0) })
        .accessibilityAction(named: "Show all files") { opening = GalleryOpening(page: 0) }
        .fullScreenCover(item: $opening) { opening in
            AttachmentGallery(pages: pages, source: .session(sessionId), page: opening.page)
        }
    }
}

extension SentFile: @retroactive Identifiable {
    public var id: String { path }

    var isVideo: Bool { mime.hasPrefix("video/") }
}

extension OutgoingAttachment {
    var isVideo: Bool { mime.hasPrefix("video/") }
}

/// The files of a message still on its way, under it as they will be once the Mac has it, drawn from
/// this phone's own copies.
struct OutgoingFiles: View {
    let attachments: [OutgoingAttachment]
    let files: OutboxFiles
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = SentPicture.side

    var body: some View {
        let pictures = attachments.filter { $0.isImage || $0.isVideo }
        let tile = min(side, SentPicture.largest)
        VStack(alignment: .trailing, spacing: 6) {
            if !pictures.isEmpty {
                TrailingFlow(spacing: 6) {
                    ForEach(pictures) { attachment in
                        Group {
                            if attachment.isVideo {
                                VideoThumbnail(url: files.url(of: attachment), side: tile)
                            } else {
                                LocalThumbnail(url: files.url(of: attachment), side: tile)
                            }
                        }
                        .pictureTile()
                        .accessibilityLabel(attachment.name)
                    }
                }
            }
            ForEach(attachments.filter { !$0.isImage && !$0.isVideo }) { attachment in
                AttachmentChip(name: attachment.name, size: attachment.size)
                    .background(Fill.bubble, in: RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
            }
        }
    }
}

/// A picture sent with a message, once the Mac has sent a small copy: gone from the Mac, the tile kept
/// when it was first drawn; until then, its kind's glyph.
struct SentPicture: View {
    let file: SentFile
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.displayScale) private var displayScale
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = SentPicture.side

    /// A sent picture's side at the default text size, and the most it grows to with the text: it is a
    /// picture, and a row of them has to fit the column.
    static let side: CGFloat = 88
    static let largest: CGFloat = 120

    var body: some View {
        let thumbnail = model.thumbnail(file.path, in: sessionId)
        let side = min(self.side, Self.largest)
        ZStack {
            Rectangle().fill(Fill.bubble)
            if let thumbnail {
                Image(uiImage: thumbnail)
                    .resizable()
                    .scaledToFill()
                    .transition(.opacity)
            } else {
                Image(systemName: "photo")
                    .font(.title3)
                    .foregroundStyle(Palette.ink3)
            }
        }
        .frame(width: side, height: side)
        .pictureTile()
        .animation(.easeOut(duration: 0.2), value: thumbnail != nil)
        // Asked again once the Mac is there: a transcript kept from before draws before it connects.
        .task(id: model.isConnected) { await model.loadSentPicture(file.path, in: sessionId, side: side * displayScale) }
    }
}

/// A video sent with a message: a frame from it and how long it runs, drawn from the file itself once
/// this phone has it, which is the one the gallery plays. Gone from the Mac and this phone's cache, the
/// frame kept when it was drawn; never drawn, its kind's glyph.
struct SentVideo: View {
    let file: SentFile
    let sessionId: String
    @Environment(AppModel.self) private var model
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = SentPicture.side
    @State private var kept: URL?
    @State private var poster: VideoPoster?

    var body: some View {
        let side = min(self.side, SentPicture.largest)
        let posterFile = AppModel.poster(file.path, in: sessionId)
        Group {
            if let kept {
                VideoThumbnail(url: kept, side: side, poster: posterFile)
            } else if let poster, let frame = poster.frame {
                Image(uiImage: frame)
                    .resizable()
                    .scaledToFill()
                    .frame(width: side, height: side)
                    .clipped()
                    .videoLength(poster.duration)
            } else {
                Image(systemName: "video")
                    .font(.title3)
                    .foregroundStyle(Palette.ink3)
                    .frame(width: side, height: side)
                    .background(Fill.bubble)
            }
        }
        .pictureTile()
        // Asked again once the Mac is there: a transcript kept from before draws before it connects.
        .task(id: model.isConnected) {
            guard kept == nil else { return }
            if poster == nil { poster = VideoPoster.kept(at: posterFile) }
            kept = try? await model.wholeFile(file.path, name: file.name, in: .session(sessionId)) { _ in }
        }
    }
}

/// Tiles in rows from the right, as a sent message's pictures sit under it: as many to a row as fit,
/// the rest on the rows under, so six photos never run off the column at any text size.
struct TrailingFlow: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = rows(width: proposal.width ?? .infinity, subviews: subviews)
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: rows.map(\.width).max() ?? 0, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in rows(width: bounds.width, subviews: subviews) {
            var x = bounds.maxX - row.width
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func rows(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if !row.indices.isEmpty, row.width + spacing + size.width > width {
                rows.append(row)
                row = Row()
            }
            row.width += (row.indices.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.indices.append(index)
        }
        if !row.indices.isEmpty { rows.append(row) }
        return rows
    }
}

extension View {
    /// A picture as a tile: its corner, and an edge one pixel wide so a dark one does not bleed into the
    /// ground, as a made file's tile has. A small tile takes a smaller corner.
    func pictureTile(radius: CGFloat = Radius.thumbnail) -> some View {
        modifier(PictureTile(radius: radius))
    }
}

private struct PictureTile: ViewModifier {
    let radius: CGFloat
    @Environment(\.displayScale) private var displayScale

    func body(content: Content) -> some View {
        content
            .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(Palette.line, lineWidth: 1 / displayScale)
            }
    }
}
