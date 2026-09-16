import Foundation
import Observation
import UIKit
import UserNotifications
import RoomoteKit

/// Push registration state shared with Settings.
@MainActor
@Observable
final class NotificationManager {
    private unowned let app: AppModel
    private let defaults: UserDefaults

    private(set) var deviceToken: String?
    private(set) var categories: NotificationCategories
    private(set) var authorizationStatus: UNAuthorizationStatus = .notDetermined
    var registrationError: String?
    private(set) var lastSyncError: String?

    private static let tokenKey = "push.deviceToken"
    private static let categoriesKey = "push.categories"

    init(app: AppModel) {
        self.app = app
        self.defaults = app.configuration.sharedDefaults
        self.deviceToken = defaults.string(forKey: Self.tokenKey)
        if let data = defaults.data(forKey: Self.categoriesKey),
           let stored = try? JSONDecoder().decode(NotificationCategories.self, from: data) {
            categories = stored
        } else {
            categories = .all
        }
    }

    static var environment: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }

    static var appVersion: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let short = info["CFBundleShortVersionString"] as? String ?? "0"
        let build = info["CFBundleVersion"] as? String ?? "0"
        return "\(short) (\(build))"
    }

    // MARK: Categories

    static func registerCategories() {
        let reply = UNTextInputNotificationAction(
            identifier: PushAction.reply.rawValue,
            title: "Reply",
            options: [.authenticationRequired],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Your answer"
        )
        let open = UNNotificationAction(identifier: PushAction.open.rawValue, title: "Open", options: [.foreground])
        let approve = UNNotificationAction(identifier: PushAction.approve.rawValue, title: "Approve", options: [.authenticationRequired])
        let decline = UNNotificationAction(identifier: PushAction.decline.rawValue, title: "Decline", options: [.destructive, .authenticationRequired])

        let categories: Set<UNNotificationCategory> = [
            UNNotificationCategory(identifier: PushCategory.userInput.rawValue, actions: [reply, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: PushCategory.capabilityOffer.rawValue, actions: [approve, decline, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: PushCategory.taskSettled.rawValue, actions: [open], intentIdentifiers: []),
            UNNotificationCategory(identifier: PushCategory.reply.rawValue, actions: [open], intentIdentifiers: []),
        ]
        UNUserNotificationCenter.current().setNotificationCategories(categories)
    }

    // MARK: Registration

    func requestAuthorizationAndRegister() async {
        let center = UNUserNotificationCenter.current()
        do {
            _ = try await center.requestAuthorization(options: [.alert, .badge, .sound])
        } catch {
            registrationError = error.localizedDescription
        }
        await refreshAuthorizationStatus()
        UIApplication.shared.registerForRemoteNotifications()
    }

    func refreshAuthorizationStatus() async {
        authorizationStatus = await Self.currentAuthorizationStatus()
    }

    /// Runs off the main actor so the non-Sendable settings object never crosses isolation.
    private nonisolated static func currentAuthorizationStatus() async -> UNAuthorizationStatus {
        await withCheckedContinuation { continuation in
            UNUserNotificationCenter.current().getNotificationSettings { settings in
                continuation.resume(returning: settings.authorizationStatus)
            }
        }
    }

    func didRegister(deviceToken data: Data) {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        deviceToken = hex
        defaults.set(hex, forKey: Self.tokenKey)
        registrationError = nil
        Task { await syncRegistration() }
    }

    func syncRegistration() async {
        guard let deviceToken, app.isSignedIn else { return }
        let registration = DeviceRegistration(
            environment: Self.environment,
            bundleId: Bundle.main.bundleIdentifier ?? app.configuration.bundleID,
            appVersion: Self.appVersion,
            deviceName: UIDevice.current.name,
            categories: categories
        )
        do {
            try await app.client.registerDevice(token: deviceToken, registration: registration)
            lastSyncError = nil
        } catch {
            lastSyncError = error.localizedDescription
        }
    }

    func setCategories(_ categories: NotificationCategories) {
        self.categories = categories
        if let data = try? JSONEncoder().encode(categories) {
            defaults.set(data, forKey: Self.categoriesKey)
        }
        Task { await syncRegistration() }
    }

    func unregisterDevice() async {
        guard let deviceToken else { return }
        try? await app.client.unregisterDevice(token: deviceToken)
    }
}
