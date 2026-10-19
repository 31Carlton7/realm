import CryptoKit
import Foundation

/// Noise rev 34 §5.3 for 25519 / AESGCM / SHA256, over the patterns in `HandshakePattern`.
///
/// The ephemeral key can be injected, which only test vectors and fixtures do. Everything else lets
/// the handshake generate a fresh one when it writes `e`.
public struct HandshakeState: Sendable {
    public typealias PrivateKey = Curve25519.KeyAgreement.PrivateKey

    public static let maxMessageLength = 65_535
    static let dhLength = 32

    public let pattern: HandshakePattern
    public let isInitiator: Bool
    private var symmetric: SymmetricState
    private let localStatic: PrivateKey?
    private var localEphemeral: PrivateKey?
    public private(set) var remoteStatic: Data?
    public private(set) var remoteEphemeral: Data?
    private let preSharedKey: Data?
    private var messageIndex = 0

    public init(
        pattern: HandshakePattern,
        initiator: Bool,
        prologue: Data,
        localStatic: PrivateKey?,
        remoteStatic: Data?,
        preSharedKey: Data? = nil,
        localEphemeral: PrivateKey? = nil
    ) throws {
        if pattern.usesPreSharedKey {
            guard let preSharedKey, preSharedKey.count == 32 else { throw NoiseError.missingKey("psk") }
        }
        if let remoteStatic, remoteStatic.count != Self.dhLength { throw NoiseError.invalidKey }
        self.pattern = pattern
        self.isInitiator = initiator
        self.localStatic = localStatic
        self.localEphemeral = localEphemeral
        self.remoteStatic = remoteStatic
        self.preSharedKey = preSharedKey
        symmetric = SymmetricState(protocolName: pattern.protocolName)
        symmetric.mixHash(prologue)
        for token in pattern.initiatorPreMessage {
            try mixPreMessage(token, sentByInitiator: true)
        }
        for token in pattern.responderPreMessage {
            try mixPreMessage(token, sentByInitiator: false)
        }
    }

    public var isFinished: Bool { messageIndex == pattern.messages.count }
    public var handshakeHash: Data { symmetric.handshakeHash }
    public var isMyTurnToWrite: Bool { !isFinished && (messageIndex % 2 == 0) == isInitiator }

    public mutating func writeMessage(_ payload: Data = Data()) throws -> Data {
        guard !isFinished else { throw NoiseError.handshakeFinished }
        guard isMyTurnToWrite else { throw NoiseError.notThisSidesTurn }
        var message = Data()
        for token in pattern.messages[messageIndex] {
            switch token {
            case .e:
                let ephemeral = localEphemeral ?? PrivateKey()
                localEphemeral = ephemeral
                let publicKey = ephemeral.publicKey.rawRepresentation
                message += publicKey
                symmetric.mixHash(publicKey)
                if pattern.usesPreSharedKey { symmetric.mixKey(publicKey) }
            case .s:
                guard let localStatic else { throw NoiseError.missingKey("s") }
                message += try symmetric.encryptAndHash(localStatic.publicKey.rawRepresentation)
            default:
                try mixKeyForToken(token)
            }
        }
        message += try symmetric.encryptAndHash(payload)
        guard message.count <= Self.maxMessageLength else { throw NoiseError.messageTooLong }
        messageIndex += 1
        return message
    }

    public mutating func readMessage(_ message: Data) throws -> Data {
        guard !isFinished else { throw NoiseError.handshakeFinished }
        guard !isMyTurnToWrite else { throw NoiseError.notThisSidesTurn }
        guard message.count <= Self.maxMessageLength else { throw NoiseError.messageTooLong }
        var rest = Data(message)
        for token in pattern.messages[messageIndex] {
            switch token {
            case .e:
                guard rest.count >= Self.dhLength else { throw NoiseError.messageTooShort }
                let publicKey = Data(rest.prefix(Self.dhLength))
                rest = Data(rest.dropFirst(Self.dhLength))
                remoteEphemeral = publicKey
                symmetric.mixHash(publicKey)
                if pattern.usesPreSharedKey { symmetric.mixKey(publicKey) }
            case .s:
                let length = Self.dhLength + (symmetric.hasKey ? CipherState.tagLength : 0)
                guard rest.count >= length else { throw NoiseError.messageTooShort }
                let sealed = Data(rest.prefix(length))
                rest = Data(rest.dropFirst(length))
                remoteStatic = try symmetric.decryptAndHash(sealed)
            default:
                try mixKeyForToken(token)
            }
        }
        let payload = try symmetric.decryptAndHash(rest)
        messageIndex += 1
        return payload
    }

    /// Split(): the first cipher carries initiator → responder, the second responder → initiator.
    public func split() throws -> (initiatorToResponder: CipherState, responderToInitiator: CipherState) {
        guard isFinished else { throw NoiseError.handshakeNotFinished }
        let (first, second) = symmetric.split()
        return (first, second)
    }

    // MARK: - Tokens

    private mutating func mixPreMessage(_ token: NoiseToken, sentByInitiator: Bool) throws {
        guard token == .s else { throw NoiseError.unsupportedProtocol("pre-message token \(token)") }
        if sentByInitiator == isInitiator {
            guard let localStatic else { throw NoiseError.missingKey("s") }
            symmetric.mixHash(localStatic.publicKey.rawRepresentation)
        } else {
            guard let remoteStatic else { throw NoiseError.missingKey("rs") }
            symmetric.mixHash(remoteStatic)
        }
    }

    private mutating func mixKeyForToken(_ token: NoiseToken) throws {
        switch token {
        case .ee:
            symmetric.mixKey(try Self.dh(localEphemeral, remoteEphemeral, "ee"))
        case .es:
            symmetric.mixKey(isInitiator
                ? try Self.dh(localEphemeral, remoteStatic, "es")
                : try Self.dh(localStatic, remoteEphemeral, "es"))
        case .se:
            symmetric.mixKey(isInitiator
                ? try Self.dh(localStatic, remoteEphemeral, "se")
                : try Self.dh(localEphemeral, remoteStatic, "se"))
        case .ss:
            symmetric.mixKey(try Self.dh(localStatic, remoteStatic, "ss"))
        case .psk:
            guard let preSharedKey else { throw NoiseError.missingKey("psk") }
            symmetric.mixKeyAndHash(preSharedKey)
        case .e, .s:
            preconditionFailure("e and s are handled by the caller")
        }
    }

    static func dh(_ privateKey: PrivateKey?, _ publicKey: Data?, _ token: String) throws -> Data {
        guard let privateKey, let publicKey else { throw NoiseError.missingKey(token) }
        do {
            let remote = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
            let shared = try privateKey.sharedSecretFromKeyAgreement(with: remote)
            return shared.withUnsafeBytes { Data($0) }
        } catch {
            throw NoiseError.invalidKey
        }
    }
}
