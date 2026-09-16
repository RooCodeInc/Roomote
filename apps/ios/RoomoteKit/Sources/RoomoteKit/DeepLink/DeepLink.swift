import Foundation

public enum DeepLink: Equatable, Sendable, Hashable {
    case session(id: String)
    case task(id: String)
    case auth(code: String?)

    public static let scheme = "roomote"

    /// Parses `roomote://` links and universal `https://<host>/sessions/<id>` /
    /// `/task/<id>` links. When `deploymentHost` is given, universal links must
    /// match it.
    public init?(url: URL, deploymentHost: String? = nil) {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let scheme = components.scheme?.lowercased()
        let pathSegments = components.path.split(separator: "/").map(String.init).filter { !$0.isEmpty }

        if scheme == DeepLink.scheme {
            // roomote://sessions/<id> parses with host "sessions" and path "/<id>".
            let segments = [components.host?.lowercased()].compactMap { $0 } + pathSegments
            guard let link = DeepLink.link(from: segments, queryItems: components.queryItems ?? []) else { return nil }
            self = link
            return
        }

        guard scheme == "https" || scheme == "http" else { return nil }
        if let deploymentHost, let host = components.host,
           host.caseInsensitiveCompare(deploymentHost) != .orderedSame {
            return nil
        }
        guard let link = DeepLink.link(from: pathSegments, queryItems: components.queryItems ?? []),
              link.isRoute else {
            return nil
        }
        self = link
    }

    private static func link(from segments: [String], queryItems: [URLQueryItem]) -> DeepLink? {
        guard let first = segments.first?.lowercased() else { return nil }
        switch first {
        case "sessions", "session":
            guard segments.count >= 2, let id = segments.dropFirst().first, !id.isEmpty else { return nil }
            return .session(id: id.removingPercentEncoding ?? id)
        case "tasks", "task":
            guard segments.count >= 2, let id = segments.dropFirst().first, !id.isEmpty else { return nil }
            return .task(id: id.removingPercentEncoding ?? id)
        case "auth":
            return .auth(code: queryItems.first(where: { $0.name == "code" })?.value)
        default:
            return nil
        }
    }

    private var isRoute: Bool {
        if case .auth = self { return false }
        return true
    }

    /// Canonical `roomote://` URL for the link.
    public var url: URL? {
        switch self {
        case .session(let id): URL(string: "\(DeepLink.scheme)://sessions/\(RoomoteClient.escape(id))")
        case .task(let id): URL(string: "\(DeepLink.scheme)://tasks/\(RoomoteClient.escape(id))")
        case .auth(let code):
            if let code { URL(string: "\(DeepLink.scheme)://auth?code=\(code)") } else { URL(string: "\(DeepLink.scheme)://auth") }
        }
    }
}
