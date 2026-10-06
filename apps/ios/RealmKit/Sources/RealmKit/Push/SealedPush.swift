import CryptoKit
import Foundation

/// A push's sealed payload (PROTOCOL.md §4.3).
public struct PushPayload: Codable, Sendable, Equatable {
    public let v: Int
    public let id: String
    public let at: Millis
    public let kind: String
    public let title: String
    public let body: String
    public let session: String?

    public init(v: Int = 1, id: String, at: Millis, kind: String, title: String, body: String, session: String?) {
        self.v = v
        self.id = id
        self.at = at
        self.kind = kind
        self.title = title
        self.body = body
        self.session = session
    }
}

/// Pushes are Noise K messages from the Mac to one phone, with the `push` prologue: one handshake
/// message that carries the payload, and nothing after it.
public enum SealedPush {
    /// Anything older is dropped.
    public static let maxAge: TimeInterval = 24 * 60 * 60

    /// Opens the `r` of a push whose `m` names a paired Mac. Nil when anything is missing or wrong:
    /// the caller then leaves the notification's placeholder as it is.
    public static func open(
        userInfo: [AnyHashable: Any],
        deviceKey: Curve25519.KeyAgreement.PrivateKey,
        pairedMac: (String) -> PairedMac?,
        now: Date = Date()
    ) -> PushPayload? {
        guard let macId = userInfo["m"] as? String, let sealed = userInfo["r"] as? String,
              let blob = Base64URL.decode(sealed), let mac = pairedMac(macId) else { return nil }
        return open(blob: blob, macId: mac.macId, phoneId: mac.phoneId, deviceKey: deviceKey, macKey: mac.macKey, now: now)
    }

    public static func open(
        blob: Data,
        macId: String,
        phoneId: String,
        deviceKey: Curve25519.KeyAgreement.PrivateKey,
        macKey: Data,
        now: Date = Date()
    ) -> PushPayload? {
        guard var handshake = try? HandshakeState(
            pattern: .K, initiator: false,
            prologue: Prologue.push(macId: macId, phoneId: phoneId),
            localStatic: deviceKey, remoteStatic: macKey
        ), let plaintext = try? handshake.readMessage(blob),
              let payload = try? JSONDecoder().decode(PushPayload.self, from: plaintext) else { return nil }
        guard payload.v == 1, now.timeIntervalSince1970 * 1000 - payload.at <= maxAge * 1000 else { return nil }
        return payload
    }

    /// The Mac's side, for tests and fixtures.
    public static func seal(
        _ plaintext: Data,
        macId: String,
        phoneId: String,
        macKey: Curve25519.KeyAgreement.PrivateKey,
        phoneKey: Data,
        ephemeral: Curve25519.KeyAgreement.PrivateKey? = nil
    ) throws -> Data {
        var handshake = try HandshakeState(
            pattern: .K, initiator: true,
            prologue: Prologue.push(macId: macId, phoneId: phoneId),
            localStatic: macKey, remoteStatic: phoneKey, localEphemeral: ephemeral
        )
        return try handshake.writeMessage(plaintext)
    }
}
