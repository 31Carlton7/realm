import Foundation

public enum NoiseToken: Sendable, Equatable {
    case e, s, ee, es, se, ss, psk
}

/// The three handshake patterns Realm uses (PROTOCOL.md §4), and nothing else.
public struct HandshakePattern: Sendable, Equatable {
    public let name: String
    /// Pre-message tokens, initiator's first (`-> s`) then the responder's (`<- s`).
    public let initiatorPreMessage: [NoiseToken]
    public let responderPreMessage: [NoiseToken]
    /// Message patterns, alternating initiator → responder, responder → initiator.
    public let messages: [[NoiseToken]]

    public var protocolName: String { "Noise_\(name)_25519_AESGCM_SHA256" }
    public var isOneWay: Bool { messages.count == 1 }
    public var usesPreSharedKey: Bool { messages.contains { $0.contains(.psk) } }

    /// `<- s` / `-> e, es, s, ss` / `<- e, ee, se`
    public static let IK = HandshakePattern(
        name: "IK",
        initiatorPreMessage: [],
        responderPreMessage: [.s],
        messages: [[.e, .es, .s, .ss], [.e, .ee, .se]]
    )

    /// `<- s` / `-> e, es, s, ss, psk` / `<- e, ee, se`
    public static let IKpsk1 = HandshakePattern(
        name: "IKpsk1",
        initiatorPreMessage: [],
        responderPreMessage: [.s],
        messages: [[.e, .es, .s, .ss, .psk], [.e, .ee, .se]]
    )

    /// `-> s`, `<- s` / `-> e, es, ss`
    public static let K = HandshakePattern(
        name: "K",
        initiatorPreMessage: [.s],
        responderPreMessage: [.s],
        messages: [[.e, .es, .ss]]
    )

    public static let all: [HandshakePattern] = [.IK, .IKpsk1, .K]

    /// Finds the pattern for a full protocol name, refusing any other DH, cipher or hash.
    public static func named(_ protocolName: String) -> HandshakePattern? {
        all.first { $0.protocolName == protocolName }
    }
}
