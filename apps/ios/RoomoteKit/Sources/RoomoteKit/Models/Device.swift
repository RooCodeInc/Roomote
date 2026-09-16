import Foundation

public struct NotificationCategories: Codable, Sendable, Hashable {
    public var userInput: Bool
    public var capabilityOffer: Bool
    public var taskSettled: Bool
    public var reply: Bool

    public init(userInput: Bool = true, capabilityOffer: Bool = true, taskSettled: Bool = true, reply: Bool = true) {
        self.userInput = userInput
        self.capabilityOffer = capabilityOffer
        self.taskSettled = taskSettled
        self.reply = reply
    }

    enum CodingKeys: String, CodingKey {
        case userInput = "user_input"
        case capabilityOffer = "capability_offer"
        case taskSettled = "task_settled"
        case reply
    }

    public static let all = NotificationCategories()
}

public struct DeviceRegistration: Codable, Sendable, Hashable {
    public var platform: String
    public var environment: String
    public var bundleId: String
    public var appVersion: String
    public var deviceName: String
    public var categories: NotificationCategories?

    public init(
        platform: String = "ios",
        environment: String,
        bundleId: String,
        appVersion: String,
        deviceName: String,
        categories: NotificationCategories? = nil
    ) {
        self.platform = platform
        self.environment = environment
        self.bundleId = bundleId
        self.appVersion = appVersion
        self.deviceName = deviceName
        self.categories = categories
    }
}

public struct SuccessResponse: Codable, Sendable {
    public var success: Bool?
    public init(success: Bool? = true) { self.success = success }
}

public struct EmptyBody: Codable, Sendable {
    public init() {}
}
