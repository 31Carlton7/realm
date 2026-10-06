import CryptoKit
import Foundation
@testable import RealmKit
import Testing

/// PROTOCOL.md §9: what the TypeScript implementation writes, checked here. A file that is not there
/// yet skips its test with a note rather than passing silently.
@Suite("TypeScript cross fixtures")
struct TypeScriptFixtureTests {
    @Test(.enabled(if: Fixtures.typeScriptExists("ts-vectors.json"),
                   "packages/remote/test/fixtures/ts-vectors.json is not written yet (the TypeScript suite writes it)"))
    func vectors() throws {
        let file = try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: Fixtures.typeScript("ts-vectors.json")))
        #expect(Set(file.vectors.map(\.protocolName)) == [
            "Noise_IK_25519_AESGCM_SHA256", "Noise_IKpsk1_25519_AESGCM_SHA256", "Noise_K_25519_AESGCM_SHA256",
        ])
        for vector in file.vectors {
            let problems = VectorRunner.run(vector)
            #expect(problems.isEmpty, "\(vector):\n\(problems.joined(separator: "\n"))")
        }
    }

    /// The TypeScript fixtures' ids come from fixed Ed25519 seeds, so they also check `id(signPub)`.
    @Test(.enabled(if: Fixtures.typeScriptExists("ts-vectors.json"),
                   "packages/remote/test/fixtures/ts-vectors.json is not written yet (the TypeScript suite writes it)"))
    func idsDeriveTheSameWay() throws {
        let file = try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: Fixtures.typeScript("ts-vectors.json")))
        let ids = try #require(file.ids)
        func seed(_ label: String) -> Data { Data(SHA256.hash(data: Data("realm fixture: \(label)".utf8))) }
        let phoneSign = try Curve25519.Signing.PrivateKey(rawRepresentation: seed("phone sign"))
        let macSign = try Curve25519.Signing.PrivateKey(rawRepresentation: seed("mac sign"))
        #expect(deviceID(signPublicKey: phoneSign.publicKey.rawRepresentation) == ids["phoneId"])
        #expect(deviceID(signPublicKey: macSign.publicKey.rawRepresentation) == ids["macId"])
        // And the prologues they used are the ones this side builds.
        let byName = Dictionary(file.vectors.map { ($0.protocolName, $0) }, uniquingKeysWith: { first, _ in first })
        let macId = try #require(ids["macId"]), phoneId = try #require(ids["phoneId"]), windowId = try #require(ids["windowId"])
        #expect(byName["Noise_IKpsk1_25519_AESGCM_SHA256"]?.initPrologue == Hex.encode(Prologue.pair(macId: macId, windowId: windowId)))
        #expect(byName["Noise_IK_25519_AESGCM_SHA256"]?.initPrologue == Hex.encode(Prologue.ik(macId: macId, phoneId: phoneId)))
        #expect(byName["Noise_K_25519_AESGCM_SHA256"]?.initPrologue == Hex.encode(Prologue.push(macId: macId, phoneId: phoneId)))
    }

    /// The push vector, opened the way the notification extension opens one.
    @Test(.enabled(if: Fixtures.typeScriptExists("ts-vectors.json"),
                   "packages/remote/test/fixtures/ts-vectors.json is not written yet (the TypeScript suite writes it)"))
    func pushOpensThroughSealedPush() throws {
        let file = try JSONDecoder().decode(VectorFile.self, from: Data(contentsOf: Fixtures.typeScript("ts-vectors.json")))
        let ids = try #require(file.ids)
        let push = try #require(file.vectors.first { $0.protocolName == "Noise_K_25519_AESGCM_SHA256" })
        let phoneKey = try VectorRunner.privateKey(try #require(push.respStatic))
        let macKey = try VectorRunner.hex(try #require(push.respRemoteStatic))
        let blob = try VectorRunner.hex(push.messages[0].ciphertext)
        let payload = SealedPush.open(blob: blob, macId: try #require(ids["macId"]), phoneId: try #require(ids["phoneId"]),
                                      deviceKey: phoneKey, macKey: macKey, now: Date(timeIntervalSince1970: 1_790_000_000))
        #expect(payload?.kind == "permission")
        #expect(payload?.session == "01JSESSION")
    }

    struct FramesFile: Decodable {
        struct Message: Decodable {
            let json: String
            let frames: [String]
        }

        let key: String
        let messages: [Message]
    }

    @Test(.enabled(if: Fixtures.typeScriptExists("ts-frames.json"),
                   "packages/remote/test/fixtures/ts-frames.json is not written yet (the TypeScript suite writes it)"))
    func frames() throws {
        let file = try JSONDecoder().decode(FramesFile.self, from: Data(contentsOf: Fixtures.typeScript("ts-frames.json")))
        let key = try VectorRunner.hex(file.key)
        var receive = CipherState(key: key)
        var send = CipherState(key: key)
        var assembler = Frames.Assembler()
        #expect(file.messages.contains { $0.json.utf8.count > 150_000 }, "the frames fixture should cover fragmentation")
        for (index, message) in file.messages.enumerated() {
            let frames = try message.frames.map(VectorRunner.hex)
            for (position, frame) in frames.enumerated() {
                let opened = try assembler.open(frame, with: &receive)
                if position < frames.count - 1 {
                    #expect(opened == nil, "message \(index): fragment \(position) ended the message early")
                } else {
                    #expect(opened == Data(message.json.utf8), "message \(index) did not open to its JSON")
                }
            }
            let sealed = try Frames.seal(Data(message.json.utf8), with: &send)
            #expect(sealed == frames, "message \(index): sealing here gives different frames")
        }
    }

    struct LinkEntry: Decodable {
        struct Fields: Decodable {
            let relay: String
            let macId: String
            let macKey: String
            let secret: String
            let windowId: String
            let macName: String
            let expiresAt: Int64
        }

        let now: Double
        let url: String
        let fields: Fields?
        let error: String?
    }

    @Test(.enabled(if: Fixtures.typeScriptExists("ts-links.json"),
                   "packages/remote/test/fixtures/ts-links.json is not written yet (the TypeScript suite writes it)"))
    func links() throws {
        let entries = try JSONDecoder().decode([LinkEntry].self, from: Data(contentsOf: Fixtures.typeScript("ts-links.json")))
        #expect(entries.contains { $0.error == "expired" } && entries.contains { $0.error == "version" })
        for entry in entries {
            let now = Date(timeIntervalSince1970: entry.now / 1000)
            switch Result(catching: { () throws(PairingLink.ParseError) in try PairingLink.parse(entry.url, now: now) }) {
            case .success(let link):
                let fields = try #require(entry.fields, "\(entry.url) parsed, but the fixture says \(entry.error ?? "?")")
                #expect(link.relay.absoluteString == fields.relay)
                #expect(link.macId == fields.macId)
                #expect(Base64URL.encode(link.macKey) == fields.macKey)
                #expect(Base64URL.encode(link.secret) == fields.secret)
                #expect(link.windowId == fields.windowId)
                #expect(link.macName == fields.macName)
                #expect(link.expiresAt == fields.expiresAt)
            case .failure(let error):
                #expect(Self.reason(error) == entry.error, "\(entry.url)")
            }
        }
    }

    /// The TypeScript side's names for why a link is refused.
    static func reason(_ error: PairingLink.ParseError) -> String {
        switch error {
        case .expired: "expired"
        case .unknownVersion: "version"
        case .malformed, .notAPairingLink: "malformed"
        }
    }
}
