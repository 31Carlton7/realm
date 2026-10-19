import CryptoKit
import Foundation
@testable import RealmKit
import Testing

@Suite("Published Noise vectors (cacophony, snow)")
struct NoiseVectorTests {
    static let published: [Vector] = (try? Vector.load(Fixtures.publishedVectors)) ?? []

    @Test func theFileCoversAllThreeProtocols() {
        #expect(!Self.published.isEmpty, "could not read \(Fixtures.publishedVectors.path)")
        #expect(Set(Self.published.map(\.protocolName)) == [
            "Noise_IK_25519_AESGCM_SHA256", "Noise_IKpsk1_25519_AESGCM_SHA256", "Noise_K_25519_AESGCM_SHA256",
        ])
    }

    @Test(arguments: published)
    func vector(_ vector: Vector) {
        let problems = VectorRunner.run(vector)
        #expect(problems.isEmpty, "\(vector):\n\(problems.joined(separator: "\n"))")
    }
}

@Suite("Noise primitives")
struct NoisePrimitiveTests {
    @Test func gcmNonceIsFourZeroBytesThenBigEndianCounter() {
        let nonce = CipherState.gcmNonce(0x0102_0304_0506_0708)
        #expect(Data(nonce) == Data([0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]))
    }

    @Test func encryptMatchesAESGCMWithTheProtocolsNonce() throws {
        let key = Data(repeating: 7, count: 32)
        var cipher = CipherState(key: key)
        _ = try cipher.encrypt(Data("first".utf8))
        let second = try cipher.encrypt(Data("second".utf8), ad: Data("ad".utf8))
        let nonce = try AES.GCM.Nonce(data: Data([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))
        let sealed = try AES.GCM.seal(Data("second".utf8), using: SymmetricKey(data: key), nonce: nonce, authenticating: Data("ad".utf8))
        #expect(second == sealed.ciphertext + sealed.tag)
        #expect(cipher.nonce == 2)
    }

    @Test func aFailedDecryptDoesNotAdvanceTheNonce() throws {
        var sender = CipherState(key: Data(repeating: 1, count: 32))
        var receiver = CipherState(key: Data(repeating: 1, count: 32))
        var frame = try sender.encrypt(Data("hello".utf8))
        frame[frame.startIndex] ^= 0x01
        #expect(throws: NoiseError.decryptFailed) { try receiver.decrypt(frame) }
        #expect(receiver.nonce == 0)
        frame[frame.startIndex] ^= 0x01
        #expect(try receiver.decrypt(frame) == Data("hello".utf8))
        #expect(receiver.nonce == 1)
    }

    @Test func withoutAKeyTheCipherPassesBytesThrough() throws {
        var cipher = CipherState()
        #expect(try cipher.encrypt(Data([1, 2, 3])) == Data([1, 2, 3]))
    }

    @Test func protocolNamesPadOrHash() {
        // 32 bytes exactly: used as h directly.
        let exact = SymmetricState(protocolName: "Noise_IKpsk1_25519_AESGCM_SHA256")
        #expect(exact.handshakeHash == Data("Noise_IKpsk1_25519_AESGCM_SHA256".utf8))
        let short = SymmetricState(protocolName: "Noise_K_25519_AESGCM_SHA256")
        #expect(short.handshakeHash == Data("Noise_K_25519_AESGCM_SHA256".utf8) + Data(count: 5))
    }

    @Test func ikRoundTripWithFreshKeys() throws {
        let phone = Curve25519.KeyAgreement.PrivateKey()
        let mac = Curve25519.KeyAgreement.PrivateKey()
        let prologue = Prologue.ik(macId: "mac", phoneId: "phone")
        var initiator = try HandshakeState(pattern: .IK, initiator: true, prologue: prologue, localStatic: phone,
                                           remoteStatic: mac.publicKey.rawRepresentation)
        var responder = try HandshakeState(pattern: .IK, initiator: false, prologue: prologue, localStatic: mac, remoteStatic: nil)
        let hello = try responder.readMessage(try initiator.writeMessage(Data("hello".utf8)))
        #expect(hello == Data("hello".utf8))
        #expect(responder.remoteStatic == phone.publicKey.rawRepresentation)
        _ = try initiator.readMessage(try responder.writeMessage(Data("hi".utf8)))
        #expect(initiator.handshakeHash == responder.handshakeHash)
        var phoneSend = try initiator.split().initiatorToResponder
        var macReceive = try responder.split().initiatorToResponder
        #expect(try macReceive.decrypt(try phoneSend.encrypt(Data("ping".utf8))) == Data("ping".utf8))
    }

    @Test func ikRefusesTheWrongPrologue() throws {
        let phone = Curve25519.KeyAgreement.PrivateKey()
        let mac = Curve25519.KeyAgreement.PrivateKey()
        var initiator = try HandshakeState(pattern: .IK, initiator: true, prologue: Prologue.ik(macId: "mac", phoneId: "phone"),
                                           localStatic: phone, remoteStatic: mac.publicKey.rawRepresentation)
        var responder = try HandshakeState(pattern: .IK, initiator: false, prologue: Prologue.ik(macId: "mac", phoneId: "other"),
                                           localStatic: mac, remoteStatic: nil)
        let message = try initiator.writeMessage(Data())
        #expect(throws: NoiseError.decryptFailed) { try responder.readMessage(message) }
    }

    @Test func ikpsk1RefusesTheWrongSecret() throws {
        let phone = Curve25519.KeyAgreement.PrivateKey()
        let mac = Curve25519.KeyAgreement.PrivateKey()
        let prologue = Prologue.pair(macId: "mac", windowId: "window")
        var initiator = try HandshakeState(pattern: .IKpsk1, initiator: true, prologue: prologue, localStatic: phone,
                                           remoteStatic: mac.publicKey.rawRepresentation, preSharedKey: Data(repeating: 1, count: 32))
        var responder = try HandshakeState(pattern: .IKpsk1, initiator: false, prologue: prologue, localStatic: mac,
                                           remoteStatic: nil, preSharedKey: Data(repeating: 2, count: 32))
        let message = try initiator.writeMessage(Data("{}".utf8))
        #expect(throws: NoiseError.decryptFailed) { try responder.readMessage(message) }
    }

    @Test func ikpsk1NeedsAPreSharedKey() {
        #expect(throws: NoiseError.missingKey("psk")) {
            try HandshakeState(pattern: .IKpsk1, initiator: true, prologue: Data(), localStatic: .init(),
                               remoteStatic: Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation)
        }
    }

    @Test func aSideCannotWriteOutOfTurn() throws {
        var responder = try HandshakeState(pattern: .IK, initiator: false, prologue: Data(), localStatic: .init(), remoteStatic: nil)
        #expect(throws: NoiseError.notThisSidesTurn) { try responder.writeMessage(Data()) }
    }

    @Test func prologuesAreLabelZeroIdZeroId() {
        #expect(Prologue.pair(macId: "M", windowId: "W") == Data("realm-pair/1\u{0}M\u{0}W".utf8))
        #expect(Prologue.ik(macId: "M", phoneId: "P") == Data("realm-mobile/1\u{0}M\u{0}P".utf8))
        #expect(Prologue.push(macId: "M", phoneId: "P") == Data("realm-push/1\u{0}M\u{0}P".utf8))
    }
}
