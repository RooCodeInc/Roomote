import SwiftUI
import RoomoteKit

/// Capability offer message with Approve / Dismiss. Callers wrap it in a card.
struct CapabilityOfferForm: View {
    let offer: CapabilityOffer
    let onRespond: (_ approve: Bool) async throws -> Void

    @State private var busy: Bool? = nil
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(offer.capabilityTitle)
                .font(RoomoteTheme.font(12, weight: .medium))
                .foregroundStyle(RoomoteTheme.mutedForeground)
            if !offer.message.isEmpty {
                MarkdownText(text: offer.message)
            }
            if let error {
                Text(error).font(RoomoteTheme.font(12)).foregroundStyle(RoomoteTheme.destructive)
            }
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                SmallButton(title: "Dismiss", kind: .ghost, busy: busy == false) { Task { await respond(false) } }
                SmallButton(title: "Approve", kind: .primary, busy: busy == true) { Task { await respond(true) } }
            }
            .disabled(busy != nil)
        }
    }

    private func respond(_ approve: Bool) async {
        busy = approve
        error = nil
        defer { busy = nil }
        do {
            try await onRespond(approve)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
