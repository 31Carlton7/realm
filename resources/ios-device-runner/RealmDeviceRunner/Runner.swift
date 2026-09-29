import XCTest

/// Realm's device runner: an XCUITest that never finishes. `xcodebuild test-without-building` keeps
/// it running for as long as Realm wants the phone; killing that xcodebuild ends the test, and iOS
/// takes the runner down with it.
///
/// The port comes from Realm as `REALM_RUNNER_PORT` (xcodebuild hands the test every
/// `TEST_RUNNER_`-prefixed variable with the prefix taken off).
final class RealmDeviceRunner: XCTestCase {
    override func setUp() {
        continueAfterFailure = true
    }

    @MainActor
    func testServe() async throws {
        let port = UInt16(ProcessInfo.processInfo.environment["REALM_RUNNER_PORT"] ?? "") ?? 7325
        let routes = Routes()
        let server = try Server(port: port) { request in await routes.handle(request) }
        try await server.run()
    }
}
