import Foundation

public struct Artifact: Codable, Sendable, Hashable, Identifiable {
    public var id: String
    public var type: String
    public var path: String
    public var contentType: String?
    public var url: String

    public init(id: String, type: String = "general", path: String, contentType: String? = nil, url: String) {
        self.id = id
        self.type = type
        self.path = path
        self.contentType = contentType
        self.url = url
    }

    enum CodingKeys: String, CodingKey { case id, type, path, contentType, url }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if let string = try? container.decode(String.self, forKey: .id) {
            id = string
        } else if let number = try? container.decode(Double.self, forKey: .id) {
            id = String(Int64(number))
        } else {
            id = UUID().uuidString
        }
        type = try container.decodeIfPresent(String.self, forKey: .type) ?? "general"
        path = try container.decodeIfPresent(String.self, forKey: .path) ?? ""
        contentType = try container.decodeIfPresent(String.self, forKey: .contentType)
        url = try container.decodeIfPresent(String.self, forKey: .url) ?? ""
    }

    public var isImage: Bool {
        if let contentType, contentType.lowercased().hasPrefix("image/") { return true }
        let ext = (path as NSString).pathExtension.lowercased()
        return ["png", "jpg", "jpeg", "gif", "webp", "heic"].contains(ext)
    }

    public var fileName: String {
        let name = (path as NSString).lastPathComponent
        return name.isEmpty ? path : name
    }

    public var resolvedURL: URL? { URL(string: url) }
}
