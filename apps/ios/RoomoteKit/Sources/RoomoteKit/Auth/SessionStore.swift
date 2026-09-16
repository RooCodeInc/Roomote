import Foundation
import Security

/// Keychain-backed storage shared between the app and its extensions.
public struct SessionStore: Sendable {
    public enum Key: String, Sendable {
        case token = "session-token"
        case deploymentURL = "deployment-url"
    }

    public let service: String
    public let accessGroup: String?
    /// Unsigned simulator builds have no Keychain entitlement at all; they keep
    /// the token in the shared defaults instead so sign-in survives relaunches.
    private let simulatorFallbackSuite: String?
    private let usesSimulatorFallback: Bool

    public init(service: String, accessGroup: String? = nil, simulatorFallbackSuite: String? = nil) {
        self.service = service
        self.accessGroup = accessGroup
        self.simulatorFallbackSuite = simulatorFallbackSuite
        #if targetEnvironment(simulator)
        self.usesSimulatorFallback = true
        #else
        self.usesSimulatorFallback = false
        #endif
    }

    public init(configuration: AppConfiguration) {
        self.init(
            service: configuration.bundleID,
            accessGroup: configuration.keychainAccessGroup,
            simulatorFallbackSuite: configuration.appGroup
        )
    }

    private var simulatorFallback: UserDefaults? {
        guard usesSimulatorFallback else { return nil }
        return simulatorFallbackSuite.flatMap { UserDefaults(suiteName: $0) } ?? .standard
    }

    // MARK: Token

    public func token() -> String? {
        read(.token)
    }

    public func setToken(_ token: String?) {
        write(.token, value: token)
    }

    // MARK: Deployment override

    public func deploymentURLOverride() -> URL? {
        read(.deploymentURL).flatMap(URL.init(string:))
    }

    public func setDeploymentURLOverride(_ url: URL?) {
        write(.deploymentURL, value: url?.absoluteString)
    }

    public func clear() {
        write(.token, value: nil)
    }

    // MARK: Keychain plumbing

    private func baseQuery(_ key: Key, useGroup: Bool) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key.rawValue,
        ]
        if useGroup, let accessGroup {
            query[kSecAttrAccessGroup as String] = accessGroup
        }
        return query
    }

    private func read(_ key: Key) -> String? {
        for useGroup in [true, false] where useGroup == false || accessGroup != nil {
            var query = baseQuery(key, useGroup: useGroup)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var result: AnyObject?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            if status == errSecSuccess, let data = result as? Data {
                return String(data: data, encoding: .utf8)
            }
            if status != errSecMissingEntitlement {
                return nil
            }
        }
        return simulatorFallback?.string(forKey: fallbackKey(key))
    }

    private func fallbackKey(_ key: Key) -> String {
        "\(service).\(key.rawValue)"
    }

    private func write(_ key: Key, value: String?) {
        var keychainAvailable = false
        for useGroup in [true, false] where useGroup == false || accessGroup != nil {
            let query = baseQuery(key, useGroup: useGroup)
            let deleteStatus = SecItemDelete(query as CFDictionary)
            if deleteStatus == errSecMissingEntitlement { continue }
            keychainAvailable = true
            guard let value, let data = value.data(using: .utf8) else { break }
            var attributes = query
            attributes[kSecValueData as String] = data
            // Background notification actions must be able to read the token
            // before the first unlock of the day would otherwise allow it.
            attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            let addStatus = SecItemAdd(attributes as CFDictionary, nil)
            if addStatus != errSecMissingEntitlement { break }
            keychainAvailable = false
        }
        if !keychainAvailable {
            simulatorFallback?.set(value, forKey: fallbackKey(key))
        }
    }
}
