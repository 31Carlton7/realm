import CryptoKit
import Foundation
@testable import RealmKit
import Testing

@Suite("Sealed pushes (§4.3, §7)")
struct PushTests {
    let macKey = Curve25519.KeyAgreement.PrivateKey()
    let phone = DeviceIdentity.generate()
    let macId = Base64URL.encode(Data(repeating: 9, count: 16))
    let now = Date(timeIntervalSince1970: 1_790_000_000)

    var mac: PairedMac {
        PairedMac(macId: macId, macName: "MacBook Pro", relay: URL(string: "wss://relay.example")!,
                  macKey: macKey.publicKey.rawRepresentation, phoneId: phone.id, windowId: "w", pairedAt: now)
    }

    var payload: PushPayload {
        PushPayload(id: "push-1", at: now.timeIntervalSince1970 * 1000 - 5_000, kind: "permission",
                    title: "Fix the flaky test", body: "Wants to run pnpm test", session: "s1")
    }

    func seal(_ payload: PushPayload? = nil, macId: String? = nil, phoneId: String? = nil,
              prologue: Data? = nil, from sender: Curve25519.KeyAgreement.PrivateKey? = nil) throws -> Data {
        let plaintext = try JSONEncoder().encode(payload ?? self.payload)
        if let prologue {
            var handshake = try HandshakeState(pattern: .K, initiator: true, prologue: prologue, localStatic: sender ?? macKey,
                                               remoteStatic: phone.dhPublicKey)
            return try handshake.writeMessage(plaintext)
        }
        return try SealedPush.seal(plaintext, macId: macId ?? self.macId, phoneId: phoneId ?? phone.id,
                                   macKey: sender ?? macKey, phoneKey: phone.dhPublicKey)
    }

    func open(_ blob: Data, storedMacKey: Data? = nil) -> PushPayload? {
        SealedPush.open(blob: blob, macId: macId, phoneId: phone.id, deviceKey: phone.dh,
                        macKey: storedMacKey ?? macKey.publicKey.rawRepresentation, now: now)
    }

    @Test func aGoodBlobOpensToItsPayload() throws {
        #expect(open(try seal()) == payload)
    }

    @Test func theNotificationsUserInfoOpens() throws {
        let userInfo: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Realm", "body": "Something on your Mac needs you"], "mutable-content": 1],
            "m": macId,
            "r": Base64URL.encode(try seal()),
        ]
        let mac = self.mac
        #expect(SealedPush.open(userInfo: userInfo, deviceKey: phone.dh, pairedMac: { $0 == mac.macId ? mac : nil }, now: now) == payload)
    }

    @Test(arguments: [0, 31, 32, 60, -17, -1])
    func aTamperedBlobDoesNotOpen(at offset: Int) throws {
        var blob = try seal()
        let index = offset >= 0 ? blob.startIndex + offset : blob.endIndex + offset
        blob[index] ^= 0x01
        #expect(open(blob) == nil)
    }

    @Test func aTruncatedBlobDoesNotOpen() throws {
        #expect(open(try seal().dropLast(1)) == nil)
        #expect(open(Data()) == nil)
    }

    @Test func theWrongMacKeyDoesNotOpen() throws {
        // Sealed by some other key than the one pinned at pairing.
        #expect(open(try seal(from: Curve25519.KeyAgreement.PrivateKey())) == nil)
        // Or the pinned key is not the sender's.
        #expect(open(try seal(), storedMacKey: Curve25519.KeyAgreement.PrivateKey().publicKey.rawRepresentation) == nil)
    }

    @Test func aPushSealedForAnotherPhoneDoesNotOpen() throws {
        let otherPhone = DeviceIdentity.generate().id
        #expect(open(try seal(phoneId: otherPhone)) == nil)
    }

    @Test func aPushSealedForAnotherMacDoesNotOpen() throws {
        #expect(open(try seal(macId: Base64URL.encode(Data(repeating: 8, count: 16)))) == nil)
    }

    @Test func aPushSealedWithAnotherPrologueDoesNotOpen() throws {
        #expect(open(try seal(prologue: Prologue.ik(macId: macId, phoneId: phone.id))) == nil)
        #expect(open(try seal(prologue: Data())) == nil)
        // The right prologue, built by hand, does open: the test above fails for the reason it says.
        #expect(open(try seal(prologue: Data("realm-push/1\u{0}\(macId)\u{0}\(phone.id)".utf8))) == payload)
    }

    @Test func aPushOlderThanADayIsDropped() throws {
        let old = PushPayload(id: "old", at: now.timeIntervalSince1970 * 1000 - 24 * 3_600_000 - 1, kind: "finished",
                              title: "Done", body: "", session: nil)
        #expect(open(try seal(old)) == nil)
    }

    @Test func anUnknownPayloadVersionIsDropped() throws {
        let future = PushPayload(v: 2, id: "v2", at: now.timeIntervalSince1970 * 1000, kind: "test", title: "", body: "", session: nil)
        #expect(open(try seal(future)) == nil)
    }

    @Test func userInfoWithoutAPairedMacOrBlobIsNil() throws {
        let blob = Base64URL.encode(try seal())
        let mac = self.mac
        #expect(SealedPush.open(userInfo: ["r": blob], deviceKey: phone.dh, pairedMac: { _ in mac }, now: now) == nil)
        #expect(SealedPush.open(userInfo: ["m": macId], deviceKey: phone.dh, pairedMac: { _ in mac }, now: now) == nil)
        #expect(SealedPush.open(userInfo: ["m": macId, "r": blob], deviceKey: phone.dh, pairedMac: { _ in nil }, now: now) == nil)
        #expect(SealedPush.open(userInfo: ["m": macId, "r": "not base64url!"], deviceKey: phone.dh, pairedMac: { _ in mac }, now: now) == nil)
    }

    @Test func aRepeatedPushIdIsSeenOnce() throws {
        let vault = Vault(store: InMemorySecureStore())
        #expect(try vault.firstSighting(ofPush: "a", at: now))
        #expect(try !vault.firstSighting(ofPush: "a", at: now.addingTimeInterval(60)))
        #expect(try vault.firstSighting(ofPush: "b", at: now))
        // A day later the id has been forgotten, and the payload's own age check drops a replay then.
        #expect(try vault.firstSighting(ofPush: "a", at: now.addingTimeInterval(25 * 3600)))
    }
}

@Suite("Device identity (§1, §3.1)")
struct IdentityTests {
    @Test func anIdIsTheFirst16BytesOfTheKeysHashInBase64URL() {
        let key = Data(repeating: 0x11, count: 32)
        let id = deviceID(signPublicKey: key)
        #expect(id.count == 22)
        #expect(Base64URL.decode(id) == Data(SHA256.hash(data: key)).prefix(16))
    }

    @Test func theChallengeIsSignedOverTheSpecifiedString() throws {
        let identity = DeviceIdentity.generate()
        let auth = try identity.relayAuth(macId: "MAC", nonce: "NONCE")
        #expect(auth.t == "auth")
        #expect(auth.key == Base64URL.encode(identity.signPublicKey))
        let expected = Data("realm-relay/1\nphone\nMAC\n\(identity.id)\nNONCE".utf8)
        #expect(DeviceIdentity.relayChallengeMessage(role: "phone", macId: "MAC", phoneId: identity.id, nonce: "NONCE") == expected)
        let signature = try #require(Base64URL.decode(auth.sig))
        #expect(identity.sign.publicKey.isValidSignature(signature, for: expected))
        #expect(!identity.sign.publicKey.isValidSignature(signature, for: Data("realm-relay/1\nmac\nMAC\n\(identity.id)\nNONCE".utf8)))
    }

    @Test func theAuthMessageIsTheProtocolsJSON() throws {
        let auth = try DeviceIdentity.generate().relayAuth(macId: "M", nonce: "N")
        let object = try #require(try JSONSerialization.jsonObject(with: try JSONEncoder().encode(auth)) as? [String: String])
        #expect(Set(object.keys) == ["t", "key", "sig"])
    }

    @Test func keysSurviveTheKeychainFormat() throws {
        let vault = Vault(store: InMemorySecureStore())
        #expect(try vault.identity() == nil)
        let made = try vault.loadOrCreateIdentity()
        #expect(try vault.loadOrCreateIdentity() == made)
        #expect(try vault.identity()?.id == made.id)
    }

    @Test func pairingsAreKeptByMac() throws {
        let vault = Vault(store: InMemorySecureStore())
        let first = PairedMac(macId: "m1", macName: "One", relay: URL(string: "wss://r")!, macKey: Data(count: 32), phoneId: "p",
                              windowId: "w1", pairedAt: Date(timeIntervalSince1970: 1))
        try vault.save(first)
        var again = first
        again.macName = "One, renamed"
        try vault.save(again)
        try vault.save(PairedMac(macId: "m2", macName: "Two", relay: URL(string: "wss://r")!, macKey: Data(count: 32), phoneId: "p",
                                 windowId: "w2", pairedAt: Date(timeIntervalSince1970: 2)))
        #expect(try vault.pairedMacs().map(\.macName) == ["One, renamed", "Two"])
        try vault.removeMac(id: "m1")
        #expect(try vault.pairedMac(id: "m1") == nil)
        #expect(try vault.pairedMac(id: "m2")?.macName == "Two")
    }
}
