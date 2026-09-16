// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "RoomoteKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "RoomoteKit", targets: ["RoomoteKit"]),
    ],
    targets: [
        .target(
            name: "RoomoteKit",
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
        .testTarget(
            name: "RoomoteKitTests",
            dependencies: ["RoomoteKit"],
            swiftSettings: [.swiftLanguageMode(.v6)]
        ),
    ]
)
