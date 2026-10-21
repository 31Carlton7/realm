import Foundation
import UniformTypeIdentifiers

/// The files messages take, kept on this phone until the Mac has them: one each, named by its
/// attachment's id, in a folder left out of the phone's backup. A message waiting on a sleeping Mac
/// keeps its photos through a relaunch, and each file goes once its message settles or is taken back.
public struct OutboxFiles: Sendable {
    public let directory: URL

    public init(directory: URL = OutboxFiles.defaultDirectory()) {
        self.directory = directory
    }

    /// `Library/Application Support/Outbox` on the phone: unlike the cache, nothing here can be
    /// fetched again if the system clears it.
    public static func defaultDirectory() -> URL {
        #if os(iOS)
        URL.applicationSupportDirectory.appending(path: "Outbox", directoryHint: .isDirectory)
        #else
        // Off the phone RealmKit only runs under `swift test`, which must never write into the
        // person's own Library: each store gets a folder of its own.
        URL.temporaryDirectory.appending(path: "realm-outbox-\(UUID().uuidString)", directoryHint: .isDirectory)
        #endif
    }

    public enum Problem: Error, Equatable {
        /// The file is gone: deleted, or never written.
        case missing(name: String)
    }

    /// Keeps a file's bytes for a message being written or waiting to go. Written with complete
    /// protection, as the cache is: none of it can be read while the phone is locked.
    public func keep(_ bytes: Data, name: String, mime: String) throws -> OutgoingAttachment {
        let id = UUID()
        let file = "\(id.uuidString).\(Self.fileExtension(name: name, mime: mime))"
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var folder = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try folder.setResourceValues(values)
        try bytes.write(to: directory.appending(path: file), options: RealmCache.writingOptions)
        return OutgoingAttachment(id: id, name: name, mime: mime, size: bytes.count, file: file)
    }

    /// Where an attachment's bytes are: what Quick Look and a thumbnail read.
    public func url(of attachment: OutgoingAttachment) -> URL {
        directory.appending(path: attachment.file)
    }

    public func bytes(of attachment: OutgoingAttachment) throws -> Data {
        let url = url(of: attachment)
        guard FileManager.default.fileExists(atPath: url.path) else { throw Problem.missing(name: attachment.name) }
        return try Data(contentsOf: url)
    }

    /// A message's files, as `session.send` carries them.
    public func uploads(for item: OutgoingItem) throws -> [AttachmentUpload] {
        try item.attachments.map { AttachmentUpload(name: $0.name, mime: $0.mime, bytes: try bytes(of: $0)) }
    }

    public func remove(_ attachments: some Sequence<OutgoingAttachment>) {
        for attachment in attachments { try? FileManager.default.removeItem(at: url(of: attachment)) }
    }

    /// Deletes every file but those named.
    public func removeAll(except kept: Set<String>) {
        guard let files = try? FileManager.default.contentsOfDirectory(atPath: directory.path) else { return }
        for file in files where !kept.contains(file) {
            try? FileManager.default.removeItem(at: directory.appending(path: file))
        }
    }

    /// The name's own extension where it has a plain one, else the type's: Quick Look reads a file's
    /// kind from it.
    static func fileExtension(name: String, mime: String) -> String {
        let own = (name as NSString).pathExtension.lowercased()
        if !own.isEmpty, own.count <= 10, own.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) { return own }
        return UTType(mimeType: mime)?.preferredFilenameExtension ?? "bin"
    }
}
