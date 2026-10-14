import Foundation
@testable import RealmKit
import Testing

@Suite("Pairing links (§2)")
struct PairingLinkTests {
    static let macKey = Data(repeating: 0xAB, count: 32)
    static let secret = Data(repeating: 0xCD, count: 32)
    static let macId = Base64URL.encode(Data(repeating: 1, count: 16))
    static let windowId = Base64URL.encode(Data(repeating: 2, count: 16))
    static let expiresAt: Int64 = 1_790_000_300_000
    static let before = Date(timeIntervalSince1970: 1_790_000_000)

    static func url(relay: String = "wss://relay.example", scheme: String = "https", version: String = "1") -> String {
        PairingLink.url(relay: relay, macId: macId, macKey: macKey, secret: secret, windowId: windowId,
                        macName: "Carlton’s MacBook Pro", expiresAt: expiresAt, scheme: scheme, version: version)
    }

    static func parse(_ string: String, now: Date = before) -> Result<PairingLink, PairingLink.ParseError> {
        Result { () throws(PairingLink.ParseError) in try PairingLink.parse(string, now: now) }
    }

    @Test func aUniversalLinkParses() throws {
        let link = try Self.parse(Self.url()).get()
        #expect(link.relay == URL(string: "wss://relay.example"))
        #expect(link.macId == Self.macId)
        #expect(link.macKey == Self.macKey)
        #expect(link.secret == Self.secret)
        #expect(link.windowId == Self.windowId)
        #expect(link.macName == "Carlton’s MacBook Pro")
        #expect(link.expiresAt == Self.expiresAt)
    }

    @Test func theDevelopmentSchemeParses() throws {
        let link = try Self.parse(Self.url(scheme: "realm-mobile")).get()
        #expect(link.macId == Self.macId)
    }

    @Test func aLocalRelayOverPlainWebSocketParses() throws {
        let link = try Self.parse(Self.url(relay: "ws://127.0.0.1:8787")).get()
        #expect(link.relay.absoluteString == "ws://127.0.0.1:8787")
    }

    @Test func surroundingWhitespaceFromAPasteIsIgnored() throws {
        _ = try Self.parse("  \(Self.url())\n").get()
    }

    @Test func anExpiredLinkIsRefused() {
        let atExpiry = Date(timeIntervalSince1970: Double(Self.expiresAt) / 1000)
        #expect(Self.parse(Self.url(), now: atExpiry) == .failure(.expired))
        #expect(Self.parse(Self.url(), now: atExpiry.addingTimeInterval(60)) == .failure(.expired))
        #expect(throws: Never.self) { try PairingLink.decode(Self.url()) }
    }

    @Test func anUnknownVersionIsRefused() {
        #expect(Self.parse(Self.url(version: "2")) == .failure(.unknownVersion("2")))
        #expect(Self.parse(Self.url().replacingOccurrences(of: "#1.", with: "#10.")) == .failure(.unknownVersion("10")))
    }

    @Test func otherAddressesAreNotPairingLinks() {
        let data = String(Self.url().split(separator: "#")[1])
        #expect(Self.parse("https://example.com/pair#\(data)") == .failure(.notAPairingLink))
        #expect(Self.parse("https://realm.computer/other#\(data)") == .failure(.notAPairingLink))
        #expect(Self.parse("https://realm.computer/pair") == .failure(.notAPairingLink))
        #expect(Self.parse("not a link") == .failure(.notAPairingLink))
    }

    @Test(arguments: [
        "https://realm.computer/pair#1.not-json",
        "https://realm.computer/pair#1.!!!",
        "https://realm.computer/pair#nodot",
    ])
    func malformedDataIsRefused(_ string: String) {
        guard case .failure(.malformed) = Self.parse(string) else {
            Issue.record("\(string) was not refused as malformed")
            return
        }
    }

    @Test func badFieldsAreRefused() {
        func link(_ fields: [String: Any]) -> String {
            var object: [String: Any] = [
                "r": "wss://relay.example", "m": Self.macId, "k": Base64URL.encode(Self.macKey), "s": Base64URL.encode(Self.secret),
                "w": Self.windowId, "n": "Mac", "e": Self.expiresAt,
            ]
            for (key, value) in fields { object[key] = value }
            let json = try! JSONSerialization.data(withJSONObject: object)
            return "https://realm.computer/pair#1.\(Base64URL.encode(json))"
        }
        for bad in [
            ["k": Base64URL.encode(Data(count: 31))], ["s": "short"], ["r": "https://relay.example"], ["r": "wss://relay.example/"],
            ["m": "not-an-id"], ["w": Base64URL.encode(Data(count: 8))], ["e": "soon"], ["n": ""],
        ] as [[String: Any]] {
            guard case .failure(.malformed) = Self.parse(link(bad)) else {
                Issue.record("\(bad) was not refused as malformed")
                continue
            }
        }
    }
}
