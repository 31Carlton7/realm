import CryptoKit
import Foundation

/// `id(signPub) = b64u(SHA-256(signPub)[0..16])`, 22 characters (PROTOCOL.md §1).
public func deviceID(signPublicKey: Data) -> String {
    Base64URL.encode(Data(SHA256.hash(data: signPublicKey)).prefix(16))
}

/// This phone's two long-lived key pairs: `dh` (X25519) for Noise and `sign` (Ed25519) for the relay.
public struct DeviceIdentity: Sendable, Equatable {
    public let dh: Curve25519.KeyAgreement.PrivateKey
    public let sign: Curve25519.Signing.PrivateKey

    public init(dh: Curve25519.KeyAgreement.PrivateKey, sign: Curve25519.Signing.PrivateKey) {
        self.dh = dh
        self.sign = sign
    }

    public static func generate() -> DeviceIdentity {
        DeviceIdentity(dh: .init(), sign: .init())
    }

    public var dhPublicKey: Data { dh.publicKey.rawRepresentation }
    public var signPublicKey: Data { sign.publicKey.rawRepresentation }
    public var id: String { deviceID(signPublicKey: signPublicKey) }

    public static func == (lhs: DeviceIdentity, rhs: DeviceIdentity) -> Bool {
        lhs.dh.rawRepresentation == rhs.dh.rawRepresentation && lhs.sign.rawRepresentation == rhs.sign.rawRepresentation
    }

    /// The bytes a relay challenge is answered over (PROTOCOL.md §3.1):
    /// `utf8("realm-relay/1\n" + role + "\n" + macId + "\n" + phoneIdOrEmpty + "\n" + nonce)`.
    public static func relayChallengeMessage(role: String, macId: String, phoneId: String, nonce: String) -> Data {
        Data("realm-relay/1\n\(role)\n\(macId)\n\(phoneId)\n\(nonce)".utf8)
    }

    /// The `auth` reply to a relay's challenge, for the phone role.
    public func relayAuth(macId: String, nonce: String) throws -> RelayAuth {
        let message = Self.relayChallengeMessage(role: "phone", macId: macId, phoneId: id, nonce: nonce)
        let signature = try sign.signature(for: message)
        return RelayAuth(key: Base64URL.encode(signPublicKey), sig: Base64URL.encode(signature))
    }
}

public struct RelayAuth: Codable, Sendable, Equatable {
    public var t = "auth"
    public let key: String
    public let sig: String
}

/// The keys as they are kept in the keychain: raw 32-byte private keys, base64url.
public struct StoredIdentity: Codable, Sendable {
    public let dh: String
    public let sign: String

    public init(_ identity: DeviceIdentity) {
        dh = Base64URL.encode(identity.dh.rawRepresentation)
        sign = Base64URL.encode(identity.sign.rawRepresentation)
    }

    public func identity() throws -> DeviceIdentity {
        guard let dhBytes = Base64URL.decode(dh), let signBytes = Base64URL.decode(sign) else { throw NoiseError.invalidKey }
        return DeviceIdentity(
            dh: try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: dhBytes),
            sign: try Curve25519.Signing.PrivateKey(rawRepresentation: signBytes)
        )
    }
}
