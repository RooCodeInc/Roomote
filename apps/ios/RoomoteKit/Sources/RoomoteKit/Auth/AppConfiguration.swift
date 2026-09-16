import Foundation

/// Deployment values baked into Info.plist by scripts/configure.sh.
public struct AppConfiguration: Sendable {
    public var deploymentURL: URL
    public var displayName: String
    public var bundleID: String
    public var keychainAccessGroup: String?
    public var appGroup: String?

    public init(
        deploymentURL: URL,
        displayName: String,
        bundleID: String,
        keychainAccessGroup: String? = nil,
        appGroup: String? = nil
    ) {
        self.deploymentURL = deploymentURL
        self.displayName = displayName
        self.bundleID = bundleID
        self.keychainAccessGroup = keychainAccessGroup
        self.appGroup = appGroup
    }

    public static let fallbackURL = URL(string: "http://localhost:3000")!

    public static func load(from bundle: Bundle = .main) -> AppConfiguration {
        let info = bundle.infoDictionary ?? [:]
        let urlString = (info["RoomoteDeploymentURL"] as? String)?.trimmingCharacters(in: .whitespaces) ?? ""
        let url = URL(string: urlString).flatMap { $0.scheme == nil ? nil : $0 } ?? fallbackURL
        let bundleID = (info["RoomoteBundleID"] as? String).flatMap { $0.isEmpty ? nil : $0 }
            ?? bundle.bundleIdentifier ?? "dev.roomote.app"
        // `$(AppIdentifierPrefix)` expands to an empty string when the build is
        // unsigned (simulator), leaving a group that starts with the bundle id
        // and no team prefix. Treat that as "no explicit group".
        let group = (info["RoomoteKeychainAccessGroup"] as? String).flatMap { value -> String? in
            guard !value.isEmpty, !value.hasPrefix("."), value.contains(".") else { return nil }
            return value.hasPrefix(bundleID) ? nil : value
        }
        let appGroup = (info["RoomoteAppGroup"] as? String).flatMap { $0.hasPrefix("group.") ? $0 : nil }
        return AppConfiguration(
            deploymentURL: url,
            displayName: (info["RoomoteDisplayName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Roomote",
            bundleID: bundleID,
            keychainAccessGroup: group,
            appGroup: appGroup
        )
    }

    /// UserDefaults shared with the extensions when an app group is configured.
    public var sharedDefaults: UserDefaults {
        appGroup.flatMap { UserDefaults(suiteName: $0) } ?? .standard
    }
}
