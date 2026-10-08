// swift-tools-version: 6.0
import PackageDescription

// Everything about Realm Mobile that can be tested without a simulator: Noise, frames, the relay
// client, the mobile.v1 models, pairing, the keychain, sealed pushes, the store and its cache
// (CryptoKit only), and the transcript's Markdown as blocks (Apple's swift-markdown). The push
// extension links RealmKit alone.
let package = Package(
    name: "RealmKit",
    platforms: [.iOS("26.0"), .macOS(.v15)],
    products: [
        .library(name: "RealmKit", targets: ["RealmKit"]),
        .library(name: "RealmMarkdown", targets: ["RealmMarkdown"]),
    ],
    dependencies: [
        .package(url: "https://github.com/swiftlang/swift-markdown.git", from: "0.9.0"),
    ],
    targets: [
        .target(name: "RealmKit"),
        .target(name: "RealmMarkdown", dependencies: [.product(name: "Markdown", package: "swift-markdown")]),
        .testTarget(name: "RealmKitTests", dependencies: ["RealmKit"]),
        .testTarget(name: "RealmMarkdownTests", dependencies: ["RealmMarkdown"]),
    ]
)
