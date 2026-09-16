import Foundation

public struct Me: Codable, Sendable, Hashable {
    public struct User: Codable, Sendable, Hashable, Identifiable {
        public var id: String
        public var name: String?
        public var email: String?
        public var imageUrl: String?
        public var isAdmin: Bool

        public init(id: String, name: String? = nil, email: String? = nil, imageUrl: String? = nil, isAdmin: Bool = false) {
            self.id = id
            self.name = name
            self.email = email
            self.imageUrl = imageUrl
            self.isAdmin = isAdmin
        }

        enum CodingKeys: String, CodingKey { case id, name, email, imageUrl, isAdmin }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            name = try container.decodeIfPresent(String.self, forKey: .name)
            email = try container.decodeIfPresent(String.self, forKey: .email)
            imageUrl = try container.decodeIfPresent(String.self, forKey: .imageUrl)
            isAdmin = try container.decodeIfPresent(Bool.self, forKey: .isAdmin) ?? false
        }

        public var displayName: String { name?.isEmpty == false ? name! : (email ?? "Signed in") }
    }

    public struct Features: Codable, Sendable, Hashable {
        public var voice: Bool
        public var push: Bool

        public init(voice: Bool = false, push: Bool = false) {
            self.voice = voice
            self.push = push
        }

        enum CodingKeys: String, CodingKey { case voice, push }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            voice = try container.decodeIfPresent(Bool.self, forKey: .voice) ?? false
            push = try container.decodeIfPresent(Bool.self, forKey: .push) ?? false
        }
    }

    public struct Deployment: Codable, Sendable, Hashable {
        public var appUrl: String
        public var features: Features

        public init(appUrl: String, features: Features = Features()) {
            self.appUrl = appUrl
            self.features = features
        }

        enum CodingKeys: String, CodingKey { case appUrl, features }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            appUrl = try container.decodeIfPresent(String.self, forKey: .appUrl) ?? ""
            features = try container.decodeIfPresent(Features.self, forKey: .features) ?? Features()
        }
    }

    public var user: User
    public var deployment: Deployment

    public init(user: User, deployment: Deployment) {
        self.user = user
        self.deployment = deployment
    }
}
