// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KlipRunNotifications",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "KlipRunNotifications", targets: ["KlipRunNotifications"])],
    targets: [
        .target(name: "NotificationCore"),
        .executableTarget(name: "KlipRunNotifications", dependencies: ["NotificationCore"]),
        .testTarget(name: "NotificationCoreTests", dependencies: ["NotificationCore"])
    ],
    swiftLanguageModes: [.v5]
)
