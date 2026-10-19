import CryptoKit
import Foundation
import RealmKit

/// Files the tests read and write, found from this file's place in the repository.
enum Fixtures {
    /// `apps/ios/RealmKit/Tests/RealmKitTests/Support/Fixtures.swift` → the repository root.
    static let repoRoot: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // Support
        .deletingLastPathComponent()  // RealmKitTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // RealmKit
        .deletingLastPathComponent()  // ios
        .deletingLastPathComponent()  // apps
        .deletingLastPathComponent()

    static let publishedVectors = repoRoot.appending(path: "packages/remote/test/noise-vectors.json")
    static let typeScriptDirectory = repoRoot.appending(path: "packages/remote/test/fixtures")
    static let swiftVectors = repoRoot.appending(path: "apps/ios/RealmKit/Tests/Fixtures/swift-vectors.json")

    static func typeScript(_ name: String) -> URL {
        typeScriptDirectory.appending(path: name)
    }

    static func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    static func typeScriptExists(_ name: String) -> Bool {
        exists(typeScript(name))
    }
}

/// The cacophony/snow vector format (PROTOCOL.md §9), which Realm's cross fixtures use too.
struct VectorFile: Codable, Equatable {
    var note: String?
    var ids: [String: String]?
    var vectors: [Vector]
}

struct Vector: Codable, Equatable, Sendable, CustomStringConvertible {
    struct Message: Codable, Equatable, Sendable {
        var payload: String
        var ciphertext: String
    }

    var source: String?
    var name: String?
    var protocolName: String
    var initPrologue: String
    var initPsks: [String]?
    var initStatic: String?
    var initEphemeral: String
    var initRemoteStatic: String?
    var respPrologue: String
    var respPsks: [String]?
    var respStatic: String?
    var respEphemeral: String?
    var respRemoteStatic: String?
    var handshakeHash: String?
    var messages: [Message]

    enum CodingKeys: String, CodingKey {
        case source, name
        case protocolName = "protocol_name"
        case initPrologue = "init_prologue"
        case initPsks = "init_psks"
        case initStatic = "init_static"
        case initEphemeral = "init_ephemeral"
        case initRemoteStatic = "init_remote_static"
        case respPrologue = "resp_prologue"
        case respPsks = "resp_psks"
        case respStatic = "resp_static"
        case respEphemeral = "resp_ephemeral"
        case respRemoteStatic = "resp_remote_static"
        case handshakeHash = "handshake_hash"
        case messages
    }

    var description: String {
        [name, protocolName, source.map { URL(string: $0)?.host ?? $0 }].compactMap { $0 }.joined(separator: " · ")
    }

    static func load(_ url: URL) throws -> [Vector] {
        try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url)).vectors
    }
}

/// Plays a vector through both sides. Every message one side writes must equal the vector's ciphertext
/// byte for byte, and the other side must read the vector's ciphertext back to the payload. Returns
/// every difference, so one failing vector reports all it got wrong.
enum VectorRunner {
    static func run(_ vector: Vector) -> [String] {
        var problems: [String] = []
        do {
            guard let pattern = HandshakePattern.named(vector.protocolName) else {
                return ["no pattern for \(vector.protocolName)"]
            }
            var initiator = try HandshakeState(
                pattern: pattern, initiator: true,
                prologue: try hex(vector.initPrologue),
                localStatic: try vector.initStatic.map(privateKey),
                remoteStatic: try vector.initRemoteStatic.map(hex),
                preSharedKey: try vector.initPsks?.first.map(hex),
                localEphemeral: try privateKey(vector.initEphemeral)
            )
            var responder = try HandshakeState(
                pattern: pattern, initiator: false,
                prologue: try hex(vector.respPrologue),
                localStatic: try vector.respStatic.map(privateKey),
                remoteStatic: try vector.respRemoteStatic.map(hex),
                preSharedKey: try vector.respPsks?.first.map(hex),
                localEphemeral: try vector.respEphemeral.map(privateKey)
            )
            // initiator → responder and responder → initiator, once the handshake has split.
            var forward: (send: CipherState, receive: CipherState)?
            var backward: (send: CipherState, receive: CipherState)?

            for (index, message) in vector.messages.enumerated() {
                let payload = try hex(message.payload)
                let expected = try hex(message.ciphertext)
                let fromInitiator = pattern.isOneWay || index.isMultiple(of: 2)
                let label = "message \(index) (\(fromInitiator ? "initiator" : "responder") → \(fromInitiator ? "responder" : "initiator"))"
                if !initiator.isFinished {
                    let written = fromInitiator ? try initiator.writeMessage(payload) : try responder.writeMessage(payload)
                    if written != expected { problems.append("\(label): wrote \(Hex.encode(written)), want \(message.ciphertext)") }
                    let read = fromInitiator ? try responder.readMessage(expected) : try initiator.readMessage(expected)
                    if read != payload { problems.append("\(label): read back \(Hex.encode(read))") }
                    if initiator.isFinished != responder.isFinished { problems.append("\(label): only one side finished") }
                    if initiator.isFinished {
                        if let hash = vector.handshakeHash {
                            if Hex.encode(initiator.handshakeHash) != hash { problems.append("initiator's handshake hash \(Hex.encode(initiator.handshakeHash)), want \(hash)") }
                            if Hex.encode(responder.handshakeHash) != hash { problems.append("responder's handshake hash \(Hex.encode(responder.handshakeHash)), want \(hash)") }
                        }
                        let i = try initiator.split()
                        let r = try responder.split()
                        forward = (i.initiatorToResponder, r.initiatorToResponder)
                        backward = (r.responderToInitiator, i.responderToInitiator)
                    }
                } else if fromInitiator {
                    guard var pair = forward else { problems.append("\(label): no transport"); break }
                    let written = try pair.send.encrypt(payload)
                    if written != expected { problems.append("\(label): wrote \(Hex.encode(written)), want \(message.ciphertext)") }
                    let read = try pair.receive.decrypt(expected)
                    if read != payload { problems.append("\(label): read back \(Hex.encode(read))") }
                    forward = pair
                } else {
                    guard var pair = backward else { problems.append("\(label): no transport"); break }
                    let written = try pair.send.encrypt(payload)
                    if written != expected { problems.append("\(label): wrote \(Hex.encode(written)), want \(message.ciphertext)") }
                    let read = try pair.receive.decrypt(expected)
                    if read != payload { problems.append("\(label): read back \(Hex.encode(read))") }
                    backward = pair
                }
            }
            if vector.handshakeHash != nil && !initiator.isFinished {
                problems.append("the vector has a handshake hash but its handshake never finished")
            }
        } catch {
            problems.append("threw \(error)")
        }
        return problems
    }

    struct BadHex: Error {}

    static func hex(_ string: String) throws -> Data {
        guard let data = Hex.decode(string) else { throw BadHex() }
        return data
    }

    static func privateKey(_ string: String) throws -> Curve25519.KeyAgreement.PrivateKey {
        try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(string))
    }
}

/// A fixed 32-byte value from a label, so every key in the Swift fixtures is reproducible.
func fixed(_ label: String) -> Data {
    Data(SHA256.hash(data: Data("realm swift fixture: \(label)".utf8)))
}
