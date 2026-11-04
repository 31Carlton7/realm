import Foundation
@testable import RealmKit
import Testing

/// A file fetched whole from the Mac: written piece by piece, and never left half-written where the
/// app would take it for the file.
struct FileFetchTests {
    private static func folder() -> URL {
        URL.temporaryDirectory.appending(path: "realm-fetch-\(UUID().uuidString)", directoryHint: .isDirectory)
    }

    /// The Mac's answers for `bytes`, `pieceSize` at a time, as `session.fileData` makes them.
    private static func pieces(of bytes: Data, pieceSize: Int) -> @Sendable (Int) async throws -> FilePiece {
        { from in
            let end = min(bytes.count, from + pieceSize)
            return FilePiece(path: "/Users/me/clip.mov", name: "clip.mov", size: bytes.count, mime: "video/quicktime",
                             from: from, data: bytes.subdata(in: from..<end), next: end < bytes.count ? end : nil)
        }
    }

    @Test func writesEveryPieceInOrder() async throws {
        let bytes = Data((0..<2_500).map { UInt8($0 % 251) })
        let destination = Self.folder().appending(path: "clip.mov")
        let heard = Heard()
        try await FileFetch.fetch(to: destination, progress: { heard.add($0) }, piece: Self.pieces(of: bytes, pieceSize: 1_000))
        #expect(try Data(contentsOf: destination) == bytes)
        #expect(heard.values == [0.4, 0.8, 1])
        #expect(!FileManager.default.fileExists(atPath: destination.appendingPathExtension("partial").path))
    }

    @Test func anEmptyFileArrivesEmpty() async throws {
        let destination = Self.folder().appending(path: "empty.txt")
        try await FileFetch.fetch(to: destination, piece: Self.pieces(of: Data(), pieceSize: 1_000))
        #expect(try Data(contentsOf: destination).isEmpty)
    }

    @Test func aFileThatChangesOnTheMacIsGivenUp() async throws {
        let destination = Self.folder().appending(path: "clip.mov")
        let first = Self.pieces(of: Data(count: 2_000), pieceSize: 1_000)
        let grown = Self.pieces(of: Data(count: 3_000), pieceSize: 1_000)
        await #expect(throws: FileFetch.Problem.changed(name: "clip.mov")) {
            try await FileFetch.fetch(to: destination) { from in try await (from == 0 ? first : grown)(from) }
        }
        #expect(!FileManager.default.fileExists(atPath: destination.path))
        #expect(!FileManager.default.fileExists(atPath: destination.appendingPathExtension("partial").path))
    }

    @Test func aFailedFetchLeavesNothingBehind() async throws {
        struct Dropped: Error {}
        let destination = Self.folder().appending(path: "clip.mov")
        let pieces = Self.pieces(of: Data(count: 2_000), pieceSize: 1_000)
        await #expect(throws: Dropped.self) {
            try await FileFetch.fetch(to: destination) { from in
                if from > 0 { throw Dropped() }
                return try await pieces(from)
            }
        }
        #expect(!FileManager.default.fileExists(atPath: destination.appendingPathExtension("partial").path))
    }
}

private final class Heard: @unchecked Sendable {
    private let lock = NSLock()
    private var heard: [Double] = []
    var values: [Double] { lock.withLock { heard } }
    func add(_ value: Double) { lock.withLock { heard.append(value) } }
}
