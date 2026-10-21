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
        let names = Set(taken.map(\.name))
        if !names.contains("Photo.jpg") { return "Photo.jpg" }
        var number = 2
        while names.contains("Photo \(number).jpg") { number += 1 }
        return "Photo \(number).jpg"
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

    /// Why nothing more can be added: what the `+` menu says under its items at the limit.
    static func full(_ limits: SendLimits) -> String {
        "Up to \(limits.maxCount) files in one message."
    }

    static func megabytes(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .binary)
    }
}

/// Where something to attach comes from.
enum AttachmentSource: Sendable {
    case library(PhotosPickerItem)
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
/// chips. Each opens in Quick Look, and has its own button to take it out.
struct AttachmentStrip: View {
    let attachments: [OutgoingAttachment]
    /// Picked, and still being read or made smaller.
    let preparing: Int
    let files: OutboxFiles
    let open: (OutgoingAttachment) -> Void
    let remove: (OutgoingAttachment) -> Void

    static let side: CGFloat = 56

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
                        Button { remove(attachment) } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 20))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.62))
                                .frame(width: 32, height: 32)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .offset(x: 10, y: -10)
                        .accessibilityLabel("Remove \(attachment.name)")
                    }
                }
                ForEach(0..<preparing, id: \.self) { _ in
                    ProgressView()
                        .frame(width: Self.side, height: Self.side)
                        .background(Palette.mark, in: RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
                        .accessibilityLabel("Adding a file")
                }
            }
            // Room for the remove buttons over the tiles' corners.
            .padding(.top, 10)
            .padding(.trailing, 10)
        }
        .scrollIndicators(.hidden)
        .scrollClipDisabled()
    }

    @ViewBuilder
    private func tile(_ attachment: OutgoingAttachment) -> some View {
        if attachment.isImage {
            LocalThumbnail(url: files.url(of: attachment), side: Self.side)
                .clipShape(RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
        } else {
            AttachmentChip(name: attachment.name, size: attachment.size)
                .frame(height: Self.side)
                .background(Palette.mark, in: RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
        }
    }
}

/// The files that went with a message, under it: pictures as tiles the Mac sends small copies of, as
/// a turn's made files are drawn, and other files as chips. Each opens the Mac's preview of it.
struct SentFiles: View {
    let files: [SentFile]
    let sessionId: String
    @State private var previewing: SentFile?

    var body: some View {
        let pictures = files.filter(\.isImage)
        let others = files.filter { !$0.isImage }
        VStack(alignment: .trailing, spacing: 6) {
            if !pictures.isEmpty {
                HStack(spacing: 6) {
                    ForEach(pictures, id: \.path) { file in
                        Button { previewing = file } label: {
                            SentPicture(file: file, sessionId: sessionId)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(file.name)
                        .accessibilityHint("Opens a preview")
                    }
                }
            }
            ForEach(others, id: \.path) { file in
                Button { previewing = file } label: {
                    AttachmentChip(name: file.name, size: nil)
                        .background(Fill.bubble, in: RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens a preview")
            }
        }
        .sheet(item: $previewing) { file in
            FilePreviewSheet(path: file.path, name: file.name, sessionId: sessionId)
        }
    }
}

extension SentFile: @retroactive Identifiable {
    public var id: String { path }
}

/// The files of a message still on its way, under it as they will be once the Mac has it, drawn from
/// this phone's own copies.
struct OutgoingFiles: View {
    let attachments: [OutgoingAttachment]
    let files: OutboxFiles
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = SentPicture.side

    var body: some View {
        let pictures = attachments.filter(\.isImage)
        VStack(alignment: .trailing, spacing: 6) {
            if !pictures.isEmpty {
                HStack(spacing: 6) {
                    ForEach(pictures) { attachment in
                        LocalThumbnail(url: files.url(of: attachment), side: side)
                            .clipShape(RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
                            .accessibilityLabel(attachment.name)
                    }
                }
            }
            ForEach(attachments.filter { !$0.isImage }) { attachment in
                AttachmentChip(name: attachment.name, size: attachment.size)
                    .background(Fill.bubble, in: RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
            }
        }
    }
}

/// A picture sent with a message, once the Mac has sent a small copy: until then, its kind's glyph.
struct SentPicture: View {
    let file: SentFile
    let sessionId: String
    @Environment(AppModel.self) private var model
    @Environment(\.displayScale) private var displayScale
    @ScaledMetric(relativeTo: .body) private var side: CGFloat = SentPicture.side

    /// A sent picture's side at the default text size.
    static let side: CGFloat = 88

    var body: some View {
        let thumbnail = model.thumbnail(file.path, in: sessionId)
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
        .clipShape(RoundedRectangle(cornerRadius: Radius.thumbnail, style: .continuous))
        .animation(.easeOut(duration: 0.2), value: thumbnail != nil)
        .task(id: file.path) { await model.loadThumbnail(file.path, in: sessionId, side: side * displayScale) }
    }
}
