import Foundation
import Observation
import UIKit
import UniformTypeIdentifiers
import RoomoteKit

@MainActor
@Observable
final class ShareModel {
    var text = ""
    var images: [UIImage] = []
    var isLoadingItems = true
    var isSending = false
    var error: String?
    var isSignedIn = false
    var deploymentHost = ""

    private let configuration: AppConfiguration
    private let store: SessionStore
    private var client: RoomoteClient?

    init(bundle: Bundle = .main) {
        configuration = AppConfiguration.load(from: bundle)
        store = SessionStore(configuration: configuration)
        let baseURL = store.deploymentURLOverride() ?? configuration.deploymentURL
        deploymentHost = baseURL.host ?? baseURL.absoluteString
        if let token = store.token() {
            client = RoomoteClient(baseURL: baseURL, token: token)
            isSignedIn = true
        }
    }

    var canSend: Bool {
        isSignedIn && !isSending && !isLoadingItems
            && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty)
    }

    // MARK: Attachments

    func load(items: [NSExtensionItem]) async {
        defer { isLoadingItems = false }
        var textParts: [String] = []
        if let subject = items.first?.attributedContentText?.string, !subject.isEmpty {
            textParts.append(subject)
        }
        for item in items {
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    if let data = try? await load(provider, type: .url), let string = String(data: data, encoding: .utf8) {
                        appendUnique(string, to: &textParts)
                        continue
                    }
                }
                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    if let data = try? await load(provider, type: .image), let image = UIImage(data: data) {
                        images.append(image)
                        continue
                    }
                }
                if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    if let data = try? await load(provider, type: .plainText), let string = String(data: data, encoding: .utf8) {
                        appendUnique(string, to: &textParts)
                    }
                }
            }
        }
        if text.isEmpty {
            text = textParts.joined(separator: "\n\n")
        }
    }

    private func appendUnique(_ value: String, to parts: inout [String]) {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !parts.contains(trimmed) else { return }
        parts.append(trimmed)
    }

    private func load(_ provider: NSItemProvider, type: UTType) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadDataRepresentation(for: type) { data, error in
                if let data {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                }
            }
        }
    }

    // MARK: Send

    func send() async -> Bool {
        guard let client, canSend else { return false }
        isSending = true
        error = nil
        defer { isSending = false }
        let dataURLs = images.compactMap(Self.dataURL(for:))
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            _ = try await client.createSession(text: body.isEmpty ? "Shared from iOS" : body, images: dataURLs.isEmpty ? nil : dataURLs)
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    private static func dataURL(for image: UIImage) -> String? {
        let maxSide: CGFloat = 1568
        let scale = min(1, maxSide / max(image.size.width, image.size.height))
        let target = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: target)
        let resized = renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
        guard let data = resized.jpegData(compressionQuality: 0.8) else { return nil }
        return "data:image/jpeg;base64," + data.base64EncodedString()
    }
}
