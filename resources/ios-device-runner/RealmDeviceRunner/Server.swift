import Foundation
import Network

struct Request {
    let method: String
    let path: String
    let query: [String: String]
    let body: Data
}

struct Response {
    let status: Int
    let contentType: String
    let body: Data

    static func json(_ value: Any, status: Int = 200) -> Response {
        let body = (try? JSONSerialization.data(withJSONObject: value)) ?? Data("{}".utf8)
        return Response(status: status, contentType: "application/json", body: body)
    }

    static func error(_ status: Int, _ message: String) -> Response {
        json(["error": message], status: status)
    }
}

/// A small HTTP/1.1 server: one request per connection, answered, then closed. That is all Realm's
/// side ever sends, and it is what lets this be a page of code rather than a dependency fetched from
/// the network at build time.
///
/// Bound to the LOOPBACK interface only. Nothing on the phone's Wi-Fi can reach it; Realm reaches it
/// through usbmuxd, which connects to the phone's own loopback on the Mac's behalf.
final class Server {
    private let listener: NWListener
    private let handle: (Request) async -> Response
    private let queue = DispatchQueue(label: "realm.device-runner.server")

    init(port: UInt16, handle: @escaping (Request) async -> Response) throws {
        let parameters = NWParameters.tcp
        parameters.requiredInterfaceType = .loopback
        parameters.allowLocalEndpointReuse = true
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { throw URLError(.badURL) }
        listener = try NWListener(using: parameters, on: nwPort)
        self.handle = handle
    }

    /// Serves until the test is torn down. Never returns otherwise.
    func run() async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            let once = Once(done)
            listener.stateUpdateHandler = { [listener] state in
                switch state {
                case .ready: NSLog("[realm-runner] listening on \(listener.port?.rawValue ?? 0)")
                case .failed(let error): once.finish(.failure(error))
                case .cancelled: once.finish(.success(()))
                default: break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
            listener.start(queue: queue)
        }
    }

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        read(connection, Data())
    }

    private func read(_ connection: NWConnection, _ buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, complete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = Server.parse(buffer) {
                Task { @MainActor in
                    let response = await self.handle(request)
                    self.send(response, on: connection)
                }
            } else if complete || error != nil || buffer.count > 1 << 20 {
                connection.cancel()
            } else {
                self.read(connection, buffer)
            }
        }
    }

    /// A whole request, or nil while more of it is still to come.
    static func parse(_ data: Data) -> Request? {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let head = String(data: data[data.startIndex..<end.lowerBound], encoding: .utf8) else { return nil }
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines.first?.split(separator: " ") ?? []
        guard parts.count >= 2 else { return nil }
        var length = 0
        for line in lines.dropFirst() {
            let pair = line.split(separator: ":", maxSplits: 1)
            if pair.count == 2, pair[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
                length = Int(pair[1].trimmingCharacters(in: .whitespaces)) ?? 0
            }
        }
        let body = data[end.upperBound...]
        guard body.count >= length else { return nil }
        let target = String(parts[1])
        let components = URLComponents(string: target)
        var query: [String: String] = [:]
        for item in components?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        return Request(method: String(parts[0]), path: components?.path ?? target, query: query, body: Data(body.prefix(length)))
    }

    private func send(_ response: Response, on connection: NWConnection) {
        let reason = response.status == 200 ? "OK" : "Error"
        var out = Data("HTTP/1.1 \(response.status) \(reason)\r\nContent-Type: \(response.contentType)\r\nContent-Length: \(response.body.count)\r\nConnection: close\r\n\r\n".utf8)
        out.append(response.body)
        connection.send(content: out, completion: .contentProcessed { _ in connection.cancel() })
    }
}

/// A continuation resumed once: a listener that fails is then cancelled, and both would resume it.
private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var done: CheckedContinuation<Void, Error>?
    init(_ done: CheckedContinuation<Void, Error>) { self.done = done }
    func finish(_ result: Result<Void, Error>) {
        lock.lock(); let c = done; done = nil; lock.unlock()
        c?.resume(with: result)
    }
}
