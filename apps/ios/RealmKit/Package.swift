// swift-tools-version: 6.0
import PackageDescription

// Everything about Realm Mobile that can be tested without a simulator: Noise, frames, the relay
// client, the mobile.v1 models, pairing, the keychain and sealed pushes. CryptoKit only.
let package = Package(
    name: "RealmKit",
    platforms: [.iOS("26.0"), .macOS(.v15)],
    products: [
        .library(name: "RealmKit", targets: ["RealmKit"]),
    ],
    targets: [
        .target(name: "RealmKit"),
        .testTarget(name: "RealmKitTests", dependencies: ["RealmKit"]),
    ]
)
