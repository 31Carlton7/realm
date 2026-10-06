import Foundation

public enum WebSocketMessage: Sendable, Equatable {
    case text(String)
    case binary(Data)
}

/// Why a socket closed: the peer's close code and reason, or ours.
public struct WebSocketClose: Sendable, Equatable {
    public let code: Int
    public let reason: String?

    public init(code: Int, reason: String?) {
        self.code = code
        self.reason = reason
    }
}

/// One WebSocket. `URLSessionWebSocketConnection` in the app; a fake in tests.
public protocol WebSocketConnection: AnyObject, Sendable {
    func resume()
    func send(_ message: WebSocketMessage) async throws
    /// Throws once the socket has closed; `closeInfo` then says why, when anyone said.
    func receive() async throws -> WebSocketMessage
    func close(code: Int, reason: String?)
    var closeInfo: WebSocketClose? { get }
}

public protocol WebSocketFactory: Sendable {
    func makeConnection(url: URL) -> any WebSocketConnection
}

public struct URLSessionWebSocketFactory: WebSocketFactory {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func makeConnection(url: URL) -> any WebSocketConnection {
        URLSessionWebSocketConnection(task: session.webSocketTask(with: url))
    }
}

final class URLSessionWebSocketConnection: WebSocketConnection, @unchecked Sendable {
    private let task: URLSessionWebSocketTask

    init(task: URLSessionWebSocketTask) {
        self.task = task
    }

    func resume() {
        task.resume()
    }

    func send(_ message: WebSocketMessage) async throws {
        switch message {
        case .text(let text): try await task.send(.string(text))
        case .binary(let data): try await task.send(.data(data))
        }
    }

    func receive() async throws -> WebSocketMessage {
        switch try await task.receive() {
        case .string(let text): return .text(text)
        case .data(let data): return .binary(data)
        @unknown default: throw URLError(.cannotParseResponse)
        }
    }

    func close(code: Int, reason: String?) {
        let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure
        task.cancel(with: closeCode, reason: reason.map { Data($0.utf8) })
    }

    var closeInfo: WebSocketClose? {
        let code = task.closeCode.rawValue
        guard code != URLSessionWebSocketTask.CloseCode.invalid.rawValue else { return nil }
        return WebSocketClose(code: code, reason: task.closeReason.flatMap { String(data: $0, encoding: .utf8) })
    }
}
