import CryptoKit
import Foundation
@testable import RealmKit
import Testing

/// Swift's half of PROTOCOL.md §9: handshakes with Realm's prologues, Realm's payloads and fixed keys,
/// in the vector format, for the TypeScript suite to replay. The file is generated, not hand-written;
/// `REALMKIT_WRITE_FIXTURES=1 swift test --package-path apps/ios/RealmKit` rewrites it.
enum SwiftFixtures {
    static func dh(_ label: String) -> Curve25519.KeyAgreement.PrivateKey {
        try! Curve25519.KeyAgreement.PrivateKey(rawRepresentation: fixed(label))
    }

    static let macDH = dh("mac dh")
    static let phoneDH = dh("phone dh")
    static let macSign = try! Curve25519.Signing.PrivateKey(rawRepresentation: fixed("mac sign"))
    static let phoneSign = try! Curve25519.Signing.PrivateKey(rawRepresentation: fixed("phone sign"))
    static let macId = deviceID(signPublicKey: macSign.publicKey.rawRepresentation)
    static let phoneId = deviceID(signPublicKey: phoneSign.publicKey.rawRepresentation)
    static let windowId = Base64URL.encode(fixed("window").prefix(16))
    static let secret = fixed("pairing secret")
    static let at = "1791234567890"
    static let session = "01JSWIFTSESSION"

    /// A §5 transport plaintext: the final-fragment flag, then the message.
    static func frame(_ json: String) -> Data { Data([0x00]) + Data(json.utf8) }

    static func file() throws -> VectorFile {
        let phoneSignB64 = Base64URL.encode(phoneSign.publicKey.rawRepresentation)
        return VectorFile(
            note: "Written by apps/ios/RealmKit/Tests/RealmKitTests/SwiftFixtureTests.swift from fixed keys: Realm's prologues and payloads, in the Noise vector format. Transport payloads are §5 plaintexts (flag byte 0x00, then the JSON). In the pairing vector, message 2 exists only so that message 3, pair.result, falls on the responder's turn. packages/remote must reproduce every message.",
            ids: ["macId": macId, "phoneId": phoneId, "windowId": windowId],
            vectors: [
                try vector(
                    name: "pairing", pattern: .IKpsk1, prologue: Prologue.pair(macId: macId, windowId: windowId),
                    initiator: (phoneDH, macDH.publicKey.rawRepresentation), responder: (macDH, nil), psk: secret,
                    payloads: [
                        Data(#"{"v":1,"name":"Swift Fixture iPhone","model":"iPhone18,2","sign":"\#(phoneSignB64)"}"#.utf8),
                        Data(#"{"v":1,"mac":"Fixture Mac Studio"}"#.utf8),
                        frame(#"{"id":0,"method":"ping","params":{}}"#),
                        frame(#"{"event":"pair.result","payload":{"ok":true,"phoneId":"\#(phoneId)"}}"#),
                    ]
                ),
                try vector(
                    name: "connection", pattern: .IK, prologue: Prologue.ik(macId: macId, phoneId: phoneId),
                    initiator: (phoneDH, macDH.publicKey.rawRepresentation), responder: (macDH, nil), psk: nil,
                    payloads: [
                        Data(#"{"v":1,"app":"0.1 (1)","os":"iOS 26.0"}"#.utf8),
                        Data(#"{"v":1,"mac":"Fixture Mac Studio","server":"1.6.0"}"#.utf8),
                        frame(#"{"id":1,"method":"home.get","params":{}}"#),
                        frame(#"{"id":1,"ok":true,"result":{"mac":{"name":"Fixture Mac Studio"},"needsYou":[],"spaces":[]}}"#),
                        frame(#"{"id":2,"method":"session.send","params":{"id":"\#(session)","text":"Run the tests again"}}"#),
                        frame(#"{"event":"session.rows","payload":{"id":"\#(session)","rows":[{"key":"u:42","seq":42,"kind":"user","text":"Run the tests again"}]}}"#),
                    ]
                ),
                try vector(
                    name: "push", pattern: .K, prologue: Prologue.push(macId: macId, phoneId: phoneId),
                    initiator: (macDH, phoneDH.publicKey.rawRepresentation), responder: (phoneDH, macDH.publicKey.rawRepresentation),
                    psk: nil,
                    payloads: [
                        Data(#"{"v":1,"id":"01JSWIFTPUSH","at":\#(at),"kind":"question","title":"Pick a database","body":"Which database should this use?","session":"\#(session)"}"#.utf8),
                    ]
                ),
            ]
        )
    }

    typealias Side = (key: Curve25519.KeyAgreement.PrivateKey, remote: Data?)

    static func vector(name: String, pattern: HandshakePattern, prologue: Data, initiator: Side, responder: Side,
                       psk: Data?, payloads: [Data]) throws -> Vector {
        let initiatorEphemeral = dh("\(name) initiator ephemeral")
        let responderEphemeral = dh("\(name) responder ephemeral")
        var i = try HandshakeState(pattern: pattern, initiator: true, prologue: prologue, localStatic: initiator.key,
                                   remoteStatic: initiator.remote, preSharedKey: psk, localEphemeral: initiatorEphemeral)
        var r = try HandshakeState(pattern: pattern, initiator: false, prologue: prologue, localStatic: responder.key,
                                   remoteStatic: responder.remote, preSharedKey: psk, localEphemeral: responderEphemeral)
        var forward: (CipherState, CipherState)?
        var backward: (CipherState, CipherState)?
        var messages: [Vector.Message] = []
        for (index, payload) in payloads.enumerated() {
            let fromInitiator = pattern.isOneWay || index.isMultiple(of: 2)
            let ciphertext: Data
            if !i.isFinished {
                ciphertext = fromInitiator ? try i.writeMessage(payload) : try r.writeMessage(payload)
                _ = fromInitiator ? try r.readMessage(ciphertext) : try i.readMessage(ciphertext)
                if i.isFinished {
                    let a = try i.split(), b = try r.split()
                    forward = (a.initiatorToResponder, b.initiatorToResponder)
                    backward = (b.responderToInitiator, a.responderToInitiator)
                }
            } else if fromInitiator, var pair = forward {
                ciphertext = try pair.0.encrypt(payload)
                _ = try pair.1.decrypt(ciphertext)
                forward = pair
            } else if var pair = backward {
                ciphertext = try pair.0.encrypt(payload)
                _ = try pair.1.decrypt(ciphertext)
                backward = pair
            } else {
                throw NoiseError.handshakeNotFinished
            }
            messages.append(Vector.Message(payload: Hex.encode(payload), ciphertext: Hex.encode(ciphertext)))
        }
        return Vector(
            source: "apps/ios/RealmKit", name: name, protocolName: pattern.protocolName,
            initPrologue: Hex.encode(prologue), initPsks: psk.map { [Hex.encode($0)] },
            initStatic: Hex.encode(initiator.key.rawRepresentation), initEphemeral: Hex.encode(initiatorEphemeral.rawRepresentation),
            initRemoteStatic: initiator.remote.map(Hex.encode),
            respPrologue: Hex.encode(prologue), respPsks: psk.map { [Hex.encode($0)] },
            respStatic: Hex.encode(responder.key.rawRepresentation),
            respEphemeral: pattern.isOneWay ? nil : Hex.encode(responderEphemeral.rawRepresentation),
            respRemoteStatic: responder.remote.map(Hex.encode),
            handshakeHash: Hex.encode(i.handshakeHash), messages: messages
        )
    }

    static func encoded(_ file: VectorFile) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(file) + Data("\n".utf8)
    }
}

@Suite("Swift cross fixtures")
struct SwiftFixtureTests {
    @Test func theCommittedFileIsWhatTheCodeWrites() throws {
        let generated = try SwiftFixtures.file()
        let url = Fixtures.swiftVectors
        if ProcessInfo.processInfo.environment["REALMKIT_WRITE_FIXTURES"] == "1" || !Fixtures.exists(url) {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try SwiftFixtures.encoded(generated).write(to: url)
        }
        let committed = try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: url))
        #expect(committed == generated,
                "swift-vectors.json is not what the code writes; rerun with REALMKIT_WRITE_FIXTURES=1 if the change is intended")
    }

    @Test func everyVectorReplays() throws {
        for vector in try SwiftFixtures.file().vectors {
            let problems = VectorRunner.run(vector)
            #expect(problems.isEmpty, "\(vector):\n\(problems.joined(separator: "\n"))")
        }
    }

    @Test func thePushVectorOpensAsAPush() throws {
        let push = try #require(try SwiftFixtures.file().vectors.first { $0.name == "push" })
        let payload = SealedPush.open(
            blob: try VectorRunner.hex(push.messages[0].ciphertext), macId: SwiftFixtures.macId, phoneId: SwiftFixtures.phoneId,
            deviceKey: SwiftFixtures.phoneDH, macKey: SwiftFixtures.macDH.publicKey.rawRepresentation,
            now: Date(timeIntervalSince1970: 1_791_234_567.890)
        )
        #expect(payload == PushPayload(id: "01JSWIFTPUSH", at: 1_791_234_567_890, kind: "question", title: "Pick a database",
                                       body: "Which database should this use?", session: SwiftFixtures.session))
    }

    @Test func thePairingResultDecodesAsAnEvent() throws {
        let pairing = try #require(try SwiftFixtures.file().vectors.first { $0.name == "pairing" })
        let plaintext = try VectorRunner.hex(pairing.messages[3].payload)
        guard case .event(.pairResult(let result)) = Envelope.classify(plaintext.dropFirst()) else {
            Issue.record("pair.result did not decode")
            return
        }
        #expect(result == PairResult(ok: true, phoneId: SwiftFixtures.phoneId, reason: nil))
    }
}
