import CryptoKit
import Foundation

/// How far a video's upload has come, as the Mac counts it: `received` bytes of `size`.
public struct UploadProgress: Decodable, Sendable, Equatable {
    public let uploadId: String
    public let size: Int
    public let received: Int
    /// Whole, and checked: `session.uploadStatus` says it; `session.uploadBegin` does not.
    public let finished: Bool?

    public init(uploadId: String, size: Int, received: Int, finished: Bool? = nil) {
        self.uploadId = uploadId
        self.size = size
        self.received = received
        self.finished = finished
    }
}

/// The Mac's answer to one chunk: every byte it has of the video now.
public struct UploadReceived: Decodable, Sendable, Equatable {
    public let received: Int

    public init(received: Int) {
        self.received = received
    }
}

/// Whatever carries a video's chunks to the Mac: `MobileAPI` in the app, a script in tests.
public protocol UploadTransport: Sendable {
    func uploadBegin(size: Int, sha256: String) async throws -> UploadProgress
    /// Writes the chunk before it returns; the answer comes when `result` is awaited.
    func writeUploadChunk(uploadId: String, offset: Int, bytes: Data) async throws -> WrittenCall<UploadReceived>
    func uploadStatus(uploadId: String) async throws -> UploadProgress
    func uploadFinish(uploadId: String) async throws
}

extension MobileAPI: UploadTransport {
    /// Four chunks of 512 KB in flight at the 128 KB a second of a slow uplink.
    static let chunkTimeout: Duration = .seconds(60)

    /// A Mac from before videos went ahead of their message answers `METHOD_NOT_FOUND`.
    public func uploadBegin(size: Int, sha256: String) async throws -> UploadProgress {
        struct Params: Encodable, Sendable { let size: Int; let sha256: String; let mime: String }
        return try await connection.call("session.uploadBegin", params: Params(size: size, sha256: sha256, mime: "video/mp4"), as: UploadProgress.self)
    }

    public func writeUploadChunk(uploadId: String, offset: Int, bytes: Data) async throws -> WrittenCall<UploadReceived> {
        struct Params: Encodable, Sendable { let uploadId: String; let offset: Int; let data: String }
        return try await connection.write("session.uploadChunk", params: Params(uploadId: uploadId, offset: offset, data: bytes.base64EncodedString()),
                                          as: UploadReceived.self, timeout: Self.chunkTimeout)
    }

    public func uploadStatus(uploadId: String) async throws -> UploadProgress {
        struct Params: Encodable, Sendable { let uploadId: String }
        return try await connection.call("session.uploadStatus", params: Params(uploadId: uploadId), as: UploadProgress.self)
    }

    /// The Mac reads the whole file back to check it, so it is given longer than a call.
    public func uploadFinish(uploadId: String) async throws {
        struct Params: Encodable, Sendable { let uploadId: String }
        _ = try await connection.call("session.uploadFinish", params: Params(uploadId: uploadId), as: Acknowledged.self, timeout: .seconds(60))
    }

    public func uploadAbort(uploadId: String) async throws {
        struct Params: Encodable, Sendable { let uploadId: String }
        _ = try await connection.call("session.uploadAbort", params: Params(uploadId: uploadId), as: Acknowledged.self)
    }
}

/// A video sent to the Mac ahead of its message, a chunk at a time with a few written before the first
/// is answered. A dropped connection is waited out, and the upload goes on from what the Mac says it
/// has, never from the start. Only a refusal of the Mac's, in its words, ends it early.
public enum ChunkedUpload {
    public static let maxBytes = 100 * 1024 * 1024
    public static let chunkBytes = 512 * 1024
    public static let inFlight = 4

    /// Sends `file` and answers with its upload's id once the Mac has it whole and checked. `uploadId`
    /// goes on with an upload already begun. `connect` waits for a channel to the Mac; `begun` hears each
    /// id the Mac makes; `received` hears every count of bytes the Mac acks; `resumed` hears where each
    /// attempt after the first starts from.
    public static func send(_ file: URL, size: Int, sha256: String, uploadId: String? = nil,
                            connect: @Sendable () async throws -> any UploadTransport,
                            begun: @Sendable (String) -> Void = { _ in },
                            received: @Sendable (Int) -> Void, resumed: @Sendable (Int) -> Void = { _ in }) async throws -> String {
        var uploadId = uploadId
        var attempts = 0
        var refusedChunks = 0
        while true {
            try Task.checkCancellation()
            let transport: any UploadTransport
            do {
                transport = try await connect()
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                try await Task.sleep(for: .seconds(1))
                continue
            }
            do {
                var from = 0
                if let begun = uploadId {
                    do {
                        let status = try await transport.uploadStatus(uploadId: begun)
                        if status.finished == true { return begun }
                        from = status.received
                    } catch ChannelError.rpc(let refusal) where refusal.code == "NOT_FOUND" {
                        // Swept, or the Mac lost it: the video goes again, under a new id.
                        uploadId = nil
                    }
                }
                if uploadId == nil {
                    uploadId = try await transport.uploadBegin(size: size, sha256: sha256).uploadId
                    begun(uploadId!)
                }
                if attempts > 0 { resumed(from) }
                attempts += 1
                received(from)
                try await sendChunks(of: file, size: size, from: from, uploadId: uploadId!, via: transport, received: received)
                try await transport.uploadFinish(uploadId: uploadId!)
                return uploadId!
            } catch ChunkRefused.refused(let refusal) {
                // A chunk the Mac did not expect, or an upload it no longer has: ask again where it
                // stands. Refused over and over is the Mac's to say.
                refusedChunks += 1
                if refusedChunks > 3 { throw ChannelError.rpc(refusal) }
            } catch let error as ChannelError {
                switch error {
                case .rpc, .badResponse: throw error
                // Not connected, timed out, or the connection went with chunks in flight: wait for the next.
                case .notConnected, .timedOut, .connectionLost, .macOffline: try await Task.sleep(for: .milliseconds(500))
                }
            }
        }
    }

    private enum ChunkRefused: Error {
        case refused(RPCError)
    }

    private static func sendChunks(of file: URL, size: Int, from: Int, uploadId: String, via transport: any UploadTransport,
                                   received: @Sendable (Int) -> Void) async throws {
        let reader = try FileHandle(forReadingFrom: file)
        defer { try? reader.close() }
        var next = from
        var flying: [WrittenCall<UploadReceived>] = []
        while next < size || !flying.isEmpty {
            while flying.count < inFlight, next < size {
                try reader.seek(toOffset: UInt64(next))
                guard let bytes = try reader.read(upToCount: min(chunkBytes, size - next)), !bytes.isEmpty else {
                    throw CocoaError(.fileReadUnknown)
                }
                flying.append(try await transport.writeUploadChunk(uploadId: uploadId, offset: next, bytes: bytes))
                next += bytes.count
            }
            let answer: UploadReceived
            do {
                answer = try await flying.removeFirst().result()
            } catch ChannelError.rpc(let refusal) where refusal.code == "INVALID_PARAMS" || refusal.code == "NOT_FOUND" {
                throw ChunkRefused.refused(refusal)
            }
            received(answer.received)
        }
    }

    /// The SHA-256 the Mac checks the whole upload against, read a megabyte at a time.
    public static func sha256(of file: URL) throws -> String {
        let reader = try FileHandle(forReadingFrom: file)
        defer { try? reader.close() }
        var hash = SHA256()
        while let piece = try reader.read(upToCount: 1024 * 1024), !piece.isEmpty {
            hash.update(data: piece)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
