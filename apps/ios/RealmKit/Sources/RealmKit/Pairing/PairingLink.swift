import Foundation

/// A pairing link (PROTOCOL.md §2): `https://realm.computer/pair#1.<b64u(JSON)>`, or in development
/// builds `realm-mobile://pair#1.<b64u(JSON)>`.
public struct PairingLink: Sendable, Equatable {
    public static let version = "1"

    /// `r`: the relay's base URL, with no trailing slash.
    public let relay: URL
    /// `m`
    public let macId: String
    /// `k`: the Mac's X25519 public key.
    public let macKey: Data
    /// `s`: the one-time pairing secret, the Noise PSK.
    public let secret: Data
    /// `w`, kept as the link spells it: it appears in the relay URL and the prologue.
    public let windowId: String
    /// `n`
    public let macName: String
    /// `e`, Unix milliseconds.
    public let expiresAt: Int64

    public enum ParseError: Error, Equatable, Sendable {
        case notAPairingLink
        case unknownVersion(String)
        case malformed(String)
        case expired
    }

    public var expiry: Date { Date(timeIntervalSince1970: Double(expiresAt) / 1000) }

    public func isExpired(at now: Date) -> Bool {
        Int64((now.timeIntervalSince1970 * 1000).rounded(.down)) >= expiresAt
    }

    /// Parses and checks a link, refusing an unknown version and an expired window.
    public static func parse(_ string: String, now: Date = Date()) throws(ParseError) -> PairingLink {
        let link = try decode(string)
        guard !link.isExpired(at: now) else { throw .expired }
        return link
    }

    /// Parses a link without looking at the clock.
    public static func decode(_ string: String) throws(ParseError) -> PairingLink {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed), let fragment = components.percentEncodedFragment,
              isPairingAddress(components) else { throw .notAPairingLink }
        guard let dot = fragment.firstIndex(of: ".") else { throw .malformed("no version") }
        let version = String(fragment[..<dot])
        guard version == Self.version else { throw .unknownVersion(version) }
        guard let json = Base64URL.decode(String(fragment[fragment.index(after: dot)...])) else {
            throw .malformed("data is not base64url")
        }
        guard let fields = try? JSONDecoder().decode(Fields.self, from: json) else { throw .malformed("data is not the link's JSON") }
        return try PairingLink(fields)
    }

    private static func isPairingAddress(_ components: URLComponents) -> Bool {
        switch components.scheme?.lowercased() {
        case "https": return components.host?.lowercased() == "realm.computer" && components.path == "/pair"
        case "realm-mobile": return components.host?.lowercased() == "pair" && (components.path.isEmpty || components.path == "/")
        default: return false
        }
    }

    private struct Fields: Decodable {
        let r: String
        let m: String
        let k: String
        let s: String
        let w: String
        let n: String
        let e: Double
    }

    /// A relay base as `r` is written: `wss://`, or `ws://` for a development relay on this network, a
    /// host, and no trailing slash. Nil for anything else. A Mac names its relay this way when it moves
    /// (§3.3), so the same rule holds there.
    public static func relayBase(_ text: String) -> URL? {
        guard let relay = URL(string: text), let scheme = relay.scheme?.lowercased(),
              scheme == "wss" || scheme == "ws", relay.host != nil, !text.hasSuffix("/") else { return nil }
        return relay
    }

    private init(_ fields: Fields) throws(ParseError) {
        guard let relay = Self.relayBase(fields.r) else {
            throw .malformed("r is not a WebSocket URL without a trailing slash")
        }
        guard !fields.n.isEmpty else { throw .malformed("n is empty") }
        guard Base64URL.decode(fields.m)?.count == 16 else { throw .malformed("m is not a device id") }
        guard let macKey = Base64URL.decode(fields.k), macKey.count == 32 else { throw .malformed("k is not a 32-byte key") }
        guard let secret = Base64URL.decode(fields.s), secret.count == 32 else { throw .malformed("s is not a 32-byte secret") }
        guard Base64URL.decode(fields.w)?.count == 16 else { throw .malformed("w is not a 16-byte window id") }
        guard fields.e.isFinite, fields.e > 0 else { throw .malformed("e is not a time") }
        self.relay = relay
        macId = fields.m
        self.macKey = macKey
        self.secret = secret
        windowId = fields.w
        macName = fields.n
        expiresAt = Int64(fields.e)
    }

    /// Builds a link's text, for tests and the development tools.
    public static func url(
        relay: String, macId: String, macKey: Data, secret: Data, windowId: String, macName: String, expiresAt: Int64,
        scheme: String = "https", version: String = PairingLink.version
    ) -> String {
        let object: [String: Any] = [
            "r": relay, "m": macId, "k": Base64URL.encode(macKey), "s": Base64URL.encode(secret),
            "w": windowId, "n": macName, "e": expiresAt,
        ]
        let json = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])) ?? Data()
        let base = scheme == "https" ? "https://realm.computer/pair" : "\(scheme)://pair"
        return "\(base)#\(version).\(Base64URL.encode(json))"
    }
}
