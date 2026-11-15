import CryptoKit
import Foundation
@testable import RealmKit
import Testing

/// A Mac taking a video's chunks as `apps/server/src/remote/chunked-uploads.ts` does: each one must
/// start where its bytes end. It can be told to drop the connection after so many chunks, having
/// written them, as a relay going away mid-upload does.
final class FakeUploadMac: UploadTransport, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var bytes = Data()
    private var declared: (size: Int, sha256: String)?
    private var begun = 0
    /// The offset of every chunk written, refused or not.
    private(set) var offsets: [Int] = []
    /// After this many more chunks are written, every answer still to come fails as a dropped link.
    var dropAfter: Int?
    private var dropped = false
    var swept = false
    var beginRefusal: RPCError?

    var begins: Int { lock.withLock { begun } }

    func uploadBegin(size: Int, sha256: String) async throws -> UploadProgress {
        try lock.withLock {
            if let beginRefusal { throw ChannelError.rpc(beginRefusal) }
            begun += 1
            declared = (size, sha256)
            bytes = Data()
            swept = false
            return UploadProgress(uploadId: "upload-\(begun)", size: size, received: 0)
        }
    }

    func writeUploadChunk(uploadId: String, offset: Int, bytes chunk: Data) async throws -> WrittenCall<UploadReceived> {
        let answer: Result<UploadReceived, any Error> = lock.withLock {
            if dropped { return .failure(ChannelError.connectionLost) }
            offsets.append(offset)
            if swept || uploadId != "upload-\(begun)" { return .failure(ChannelError.rpc(RPCError(code: "NOT_FOUND", message: "gone"))) }
            guard offset == bytes.count else { return .failure(ChannelError.rpc(RPCError(code: "INVALID_PARAMS", message: "not contiguous"))) }
            bytes.append(chunk)
            if let left = dropAfter {
                dropAfter = left - 1
                if left - 1 <= 0 { dropped = true; dropAfter = nil }
            }
            return .success(UploadReceived(received: bytes.count))
        }
        let isDropped = lock.withLock { dropped }
        return WrittenCall { if isDropped { throw ChannelError.connectionLost }; return try answer.get() }
    }

    func uploadStatus(uploadId: String) async throws -> UploadProgress {
        try lock.withLock {
            if swept || uploadId != "upload-\(begun)" { throw ChannelError.rpc(RPCError(code: "NOT_FOUND", message: "gone")) }
            return UploadProgress(uploadId: uploadId, size: declared!.size, received: bytes.count, finished: false)
        }
    }

    func uploadFinish(uploadId: String) async throws {
        try lock.withLock {
            guard bytes.count == declared?.size, ChunkedUploadTests.hex(bytes) == declared?.sha256 else {
                throw ChannelError.rpc(RPCError(code: "INVALID_PARAMS", message: "not whole"))
            }
        }
    }

    /// The link comes back.
    func reconnect() { lock.withLock { dropped = false } }
}

@Suite("A video sent ahead of its message")
struct ChunkedUploadTests {
    static func hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    /// A file of `size` bytes that differ from chunk to chunk.
    static func video(_ size: Int) throws -> (URL, Data) {
        var data = Data(count: size)
        for i in stride(from: 0, to: size, by: 997) { data[i] = UInt8(i % 251) }
        let url = FileManager.default.temporaryDirectory.appending(path: "realm-upload-\(UUID().uuidString).mp4")
        try data.write(to: url)
        return (url, data)
    }

    @Test func theFileGoesWholeInOrderAndItsHashIsTheMacs() async throws {
        let (url, data) = try Self.video(5 * ChunkedUpload.chunkBytes + 77)
        let mac = FakeUploadMac()
        #expect(try ChunkedUpload.sha256(of: url) == Self.hex(data))
        let acked = Acked()
        let id = try await ChunkedUpload.send(url, size: data.count, sha256: Self.hex(data), connect: { mac }, received: { acked.add($0) })
        #expect(id == "upload-1")
        #expect(mac.bytes == data)
        #expect(mac.offsets == (0..<6).map { $0 * ChunkedUpload.chunkBytes })
        #expect(acked.all.last == data.count)
    }

    /// THE MUTANT: start again from zero after a drop, and a 3-minute video on a weak signal never ends.
    @Test func aDroppedConnectionResumesFromWhatTheMacAcked() async throws {
        let (url, data) = try Self.video(10 * ChunkedUpload.chunkBytes)
        let mac = FakeUploadMac()
        mac.dropAfter = 3
        let resumes = Acked()
        let id = try await ChunkedUpload.send(url, size: data.count, sha256: Self.hex(data), connect: {
            mac.reconnect()
            return mac
        }, received: { _ in }, resumed: { resumes.add($0) })
        #expect(id == "upload-1")
        #expect(mac.begins == 1)
        #expect(resumes.all == [3 * ChunkedUpload.chunkBytes])
        #expect(mac.bytes == data)
        #expect(mac.offsets.filter { $0 == 0 }.count == 1, "nothing the Mac had was sent again")
    }

    @Test func anUploadTheMacNoLongerHasGoesAgainUnderANewId() async throws {
        let (url, data) = try Self.video(3 * ChunkedUpload.chunkBytes)
        let mac = FakeUploadMac()
        _ = try await mac.uploadBegin(size: data.count, sha256: Self.hex(data))
        mac.swept = true
        let id = try await ChunkedUpload.send(url, size: data.count, sha256: Self.hex(data), uploadId: "upload-1", connect: { mac }, received: { _ in })
        #expect(id == "upload-2")
        #expect(mac.bytes == data)
    }

    @Test func aRefusalIsTheMacsToSay() async throws {
        let (url, data) = try Self.video(100)
        let mac = FakeUploadMac()
        mac.beginRefusal = RPCError(code: "INVALID_PARAMS", message: "This Mac has 900 MB free, and needs 1224 MB to take this video.")
        await #expect(throws: ChannelError.rpc(mac.beginRefusal!)) {
            _ = try await ChunkedUpload.send(url, size: data.count, sha256: Self.hex(data), connect: { mac }, received: { _ in })
        }
    }
}

/// Counts the Mac acked, from whichever task heard them.
final class Acked: @unchecked Sendable {
    private let lock = NSLock()
    private var counts: [Int] = []
    func add(_ count: Int) { lock.withLock { counts.append(count) } }
    var all: [Int] { lock.withLock { counts } }
}
