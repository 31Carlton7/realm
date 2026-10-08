import Foundation
import UIKit

/// What this phone says about itself to the Mac.
enum DeviceInfo {
    @MainActor static var name: String { UIDevice.current.name }

    /// The model identifier, such as `iPhone18,1`.
    static var model: String {
        #if targetEnvironment(simulator)
        return ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? "Simulator"
        #else
        var system = utsname()
        uname(&system)
        return withUnsafeBytes(of: system.machine) { bytes in
            String(decoding: bytes.prefix { $0 != 0 }, as: UTF8.self)
        }
        #endif
    }

    static var osVersion: String {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        let patch = version.patchVersion > 0 ? ".\(version.patchVersion)" : ""
        return "iOS \(version.majorVersion).\(version.minorVersion)\(patch)"
    }

    static var appVersion: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "0"
        let build = info["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }

    /// Development builds are signed for the APNs sandbox; TestFlight and the App Store for production.
    static var pushEnvironment: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }
}

/// Launch arguments for unattended runs in the Simulator:
/// `-pairLink <url>` pairs on launch; `-autoDiagnostics 1` runs Diagnostics once connected and sends
/// the results to the Mac; `-diagnosticsSession <id>` and `-diagnosticsEchoes <n>` steer that run;
/// `-openSession <id>` opens a session once connected; `-unattended 1` asks for no permission, so no
/// alert is left over the screen.
enum LaunchOptions {
    static var pairLink: String? { UserDefaults.standard.string(forKey: "pairLink") }
    static var openSession: String? { UserDefaults.standard.string(forKey: "openSession") }
    static var autoDiagnostics: Bool { UserDefaults.standard.bool(forKey: "autoDiagnostics") }
    static var unattended: Bool { autoDiagnostics || UserDefaults.standard.bool(forKey: "unattended") }
    /// The app is only the host of a unit-test bundle: it stays inert, with no keychain, network or prompt.
    static var hostingUnitTests: Bool { ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil }
    static var diagnosticsSession: String? { UserDefaults.standard.string(forKey: "diagnosticsSession") }

    static var diagnosticsEchoes: Int? {
        let count = UserDefaults.standard.integer(forKey: "diagnosticsEchoes")
        return count > 0 ? count : nil
    }
}
