import Foundation
@testable import RealmKit
import Testing

@Suite("What the phone says about its Mac")
struct LinkStatusTests {
    static let calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/London")!
        return calendar
    }()

    static let locale = Locale(identifier: "en_GB")

    /// Wednesday 7 October 2026, 15:00 in London.
    static let now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 7, hour: 15))!

    static func at(day: Int, hour: Int, minute: Int) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute))!
    }

    static func words(_ kind: LinkStatus.Kind) -> String {
        LinkStatus(kind, now: now, calendar: calendar, locale: locale).words
    }

    @Test func aFreshStartSaysConnecting() {
        let tracker = LinkTracker()
        #expect(tracker.kind == .connecting)
        #expect(tracker.status().words == "Connecting…")
    }

    @Test func aRelayOutOfReachIsSaidOnceAndHeldWhileRetrying() {
        var tracker = LinkTracker()
        tracker.update(.connecting)
        #expect(tracker.kind == .connecting)
        tracker.update(.retrying(in: .seconds(1)))
        #expect(tracker.kind == .relayUnreachable)
        // The next attempt does not flicker back to "Connecting…".
        tracker.update(.connecting)
        #expect(tracker.kind == .relayUnreachable)
        // The relay let it in: on its way to the Mac.
        tracker.update(.handshaking)
        #expect(tracker.kind == .connecting)
        tracker.update(.connected(ConnectedMac(name: "Mac", server: "2.0", handshake: .zero, connect: .zero)))
        #expect(tracker.kind == .connected)
        #expect(tracker.status().words == "Connected")
    }

    @Test func aMacThatNeverAnswersIsNotCalledAnUnreachableRelay() {
        var tracker = LinkTracker()
        tracker.update(.connecting)
        tracker.update(.handshaking)
        tracker.update(.retrying(in: .seconds(1)))
        #expect(tracker.kind == .notAnswering)
        tracker.update(.connecting)
        tracker.update(.handshaking)
        #expect(tracker.kind == .notAnswering, "held until the Mac answers")
        tracker.update(.macOffline(lastSeen: 1_791_385_320_000))
        #expect(tracker.kind == .asleep(since: Date(timeIntervalSince1970: 1_791_385_320)))
    }

    @Test func anAsleepMacSaysSince() {
        #expect(Self.words(.asleep(since: Self.at(day: 7, hour: 10, minute: 42))) == "Asleep since 10:42")
        #expect(Self.words(.asleep(since: Self.at(day: 6, hour: 23, minute: 5))) == "Asleep since yesterday, 23:05")
        #expect(Self.words(.asleep(since: Self.at(day: 3, hour: 9, minute: 0))) == "Asleep since Saturday")
        let older = Self.words(.asleep(since: Self.at(day: 1, hour: 9, minute: 0)))
        #expect(older.replacingOccurrences(of: "\u{a0}", with: " ") == "Asleep since 1 Oct")
        #expect(Self.words(.asleep(since: nil)) == "Offline")
    }

    @Test func everyStateHasWordsAndASymbol() {
        let kinds: [LinkStatus.Kind] = [.connected, .connecting, .asleep(since: Self.now), .asleep(since: nil), .notAnswering,
                                        .relayUnreachable, .refused(reason: "Your Mac removed this iPhone."), .notConnected]
        for kind in kinds {
            let status = LinkStatus(kind, now: Self.now, calendar: Self.calendar, locale: Self.locale)
            #expect(!status.words.isEmpty)
            #expect(!status.symbol.isEmpty)
            #expect(!status.waitingNote.isEmpty)
        }
        #expect(LinkStatus(.relayUnreachable).words == "Can't reach the relay")
        #expect(LinkStatus(.asleep(since: nil)).waitingNote == "Your Mac is asleep. This sends when it wakes.")
        #expect(LinkStatus(.refused(reason: "Your Mac removed this iPhone.")).waitingNote == "Not sent. Your Mac removed this iPhone.")
    }

    @MainActor
    @Test func theStoreFollowsTheConnection() {
        let store = RealmStore()
        store.connection = .connecting
        store.connection = .retrying(in: .seconds(2))
        #expect(store.linkStatus().kind == .relayUnreachable)
        store.connection = .refused(code: 4410, reason: "Your Mac removed this iPhone.")
        #expect(store.linkStatus().kind == .refused(reason: "Your Mac removed this iPhone."))
    }
}
