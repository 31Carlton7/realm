import Foundation

/// What the phone says about its Mac: a word or two and a symbol, never colour alone.
public struct LinkStatus: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        case connected
        /// On its way. A first connection on a cold cellular radio can take seconds.
        case connecting
        /// The relay is there and the Mac is not: asleep, off its network, or Realm is closed.
        case asleep(since: Date?)
        /// The relay let the phone in and the Mac did not take the handshake.
        case notAnswering
        case relayUnreachable
        /// The relay or the Mac refused this phone; trying again will not help.
        case refused(reason: String)
        case notConnected
    }

    public let kind: Kind
    /// Short enough for the line under a title: "Asleep since 10:42".
    public let words: String
    public let symbol: String

    public init(_ kind: Kind, now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) {
        self.kind = kind
        switch kind {
        case .connected:
            words = "Connected"
            symbol = "checkmark.circle"
        case .connecting:
            words = "Connecting…"
            symbol = "arrow.triangle.2.circlepath"
        case .asleep(let since):
            words = since.map { "Asleep since \(Self.moment($0, now: now, calendar: calendar, locale: locale))" } ?? "Offline"
            symbol = "moon.zzz"
        case .notAnswering:
            words = "Not answering"
            symbol = "exclamationmark.triangle"
        case .relayUnreachable:
            words = "Can't reach the relay"
            symbol = "wifi.exclamationmark"
        case .refused:
            words = "Not allowed"
            symbol = "xmark.octagon"
        case .notConnected:
            words = "Not connected"
            symbol = "pause.circle"
        }
    }

    public var isConnected: Bool { kind == .connected }

    /// What a message or an answer that has not gone yet says while it waits.
    public var waitingNote: String {
        switch kind {
        case .connected: "Sending…"
        case .connecting: "Connecting to your Mac…"
        case .asleep: "Your Mac is asleep. This sends when it wakes."
        case .notAnswering: "Your Mac is not answering. This sends when it does."
        case .relayUnreachable: "Can't reach the relay. This sends once it can."
        case .refused(let reason): "Not sent. \(reason)"
        case .notConnected: "Not sent yet. This sends when your Mac is connected."
        }
    }

    /// A time the Mac was last seen, as short as it can be said: "10:42" today, "yesterday, 10:42",
    /// a weekday within the week, a date after that.
    public static func moment(_ date: Date, now: Date, calendar: Calendar, locale: Locale) -> String {
        let time = date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, calendar: calendar,
                                                   timeZone: calendar.timeZone))
        if calendar.isDate(date, inSameDayAs: now) { return time }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            return "yesterday, \(time)"
        }
        var style = Date.FormatStyle(locale: locale, calendar: calendar, timeZone: calendar.timeZone)
        if now.timeIntervalSince(date) < 6 * 24 * 60 * 60 {
            style = style.weekday(.wide)
        } else {
            style = style.month(.abbreviated).day()
        }
        return date.formatted(style)
    }
}

/// Follows the connection's states and remembers what the last attempt ran into, so the words do not
/// flicker back to "Connecting…" with every retry while the relay stays out of reach. Reaching the
/// relay again, or the Mac, is what clears it.
public struct LinkTracker: Sendable, Equatable {
    public private(set) var state: ConnectionState = .idle
    /// An attempt failed before the relay let it in.
    public private(set) var relayFailed = false
    /// An attempt reached the relay, and the Mac never answered the handshake.
    public private(set) var macFailed = false
    private var reachedRelay = false

    public init() {}

    public mutating func update(_ newState: ConnectionState) {
        state = newState
        switch newState {
        case .connecting:
            reachedRelay = false
        case .handshaking:
            reachedRelay = true
            relayFailed = false
        case .connected, .macOffline:
            reachedRelay = true
            relayFailed = false
            macFailed = false
        case .retrying:
            if reachedRelay {
                macFailed = true
                relayFailed = false
            } else {
                relayFailed = true
                macFailed = false
            }
        case .idle, .stopped, .refused:
            reachedRelay = false
            relayFailed = false
            macFailed = false
        }
    }

    public var kind: LinkStatus.Kind {
        switch state {
        case .connected: return .connected
        case .macOffline(let lastSeen): return .asleep(since: lastSeen.map { Date(timeIntervalSince1970: $0 / 1000) })
        case .refused(_, let reason): return .refused(reason: reason)
        case .stopped: return .notConnected
        case .idle, .connecting, .handshaking, .retrying:
            if relayFailed { return .relayUnreachable }
            if macFailed { return .notAnswering }
            return .connecting
        }
    }

    public func status(now: Date = Date(), calendar: Calendar = .current, locale: Locale = .current) -> LinkStatus {
        LinkStatus(kind, now: now, calendar: calendar, locale: locale)
    }
}
