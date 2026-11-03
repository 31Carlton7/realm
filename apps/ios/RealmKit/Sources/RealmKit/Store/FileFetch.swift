import Foundation

/// A file the Mac sends whole (`session.fileData`), written to disk a piece at a time as it comes, so a
/// video is never held in memory. Nothing is left at the destination until the last piece is in.
public enum FileFetch {
    public enum Problem: Error, Equatable {
        /// The file changed on the Mac between two pieces.
        case changed(name: String)
    }

    /// Asks `piece` for each piece from byte 0 until the Mac says the file is done, then moves the whole
    /// file to `destination`. `progress` hears the share of it that has arrived.
    public static func fetch(to destination: URL, progress: @Sendable (Double) -> Void = { _ in },
                             piece: @Sendable (Int) async throws -> FilePiece) async throws {
        let partial = destination.appendingPathExtension("partial")
        let manager = FileManager.default
        try manager.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? manager.removeItem(at: partial)
        guard manager.createFile(atPath: partial.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        do {
            let handle = try FileHandle(forWritingTo: partial)
            defer { try? handle.close() }
            var from = 0
            var size: Int?
            while true {
                try Task.checkCancellation()
                let next = try await piece(from)
                guard next.from == from, size == nil || next.size == size else { throw Problem.changed(name: next.name) }
                size = next.size
                try handle.write(contentsOf: next.data)
                from += next.data.count
                progress(next.size > 0 ? Double(from) / Double(next.size) : 1)
                guard let following = next.next else { break }
                guard following == from else { throw Problem.changed(name: next.name) }
            }
            guard from == size else { throw Problem.changed(name: destination.lastPathComponent) }
            try? manager.removeItem(at: destination)
            try manager.moveItem(at: partial, to: destination)
        } catch {
            try? manager.removeItem(at: partial)
            throw error
        }
    }
}
