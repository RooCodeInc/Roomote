import Foundation
import Observation
import RoomoteKit

@MainActor
@Observable
final class InboxModel {
    var state: LoadState<[InboxItem]> = .idle
    var actionError: String?

    private var client: RoomoteClient { AppModel.shared.client }

    var items: [InboxItem] { state.value ?? [] }

    func load(showLoading: Bool = true) async {
        if showLoading, state.value == nil { state = .loading }
        do {
            let items = try await client.inbox()
            state = .loaded(items.sorted { $0.createdAt > $1.createdAt })
            AppModel.shared.setInboxCount(items.count)
        } catch let error as RoomoteError where error.isUnauthorized {
            state = .failed(error.localizedDescription)
        } catch {
            if case .cancelled = error as? RoomoteError { return }
            if state.value == nil {
                state = .failed(error.localizedDescription)
            } else {
                actionError = error.localizedDescription
            }
        }
    }

    func answer(item: InboxItem, answers: Answers) async throws {
        guard let request = item.request else { return }
        try await client.answer(sessionID: item.routingSessionId, requestId: request.requestId, answers: answers)
        remove(item)
    }

    func respond(item: InboxItem, approve: Bool) async throws {
        guard let offer = item.offer else { return }
        try await client.respondToCapabilityOffer(
            sessionID: item.routingSessionId,
            offerId: offer.offerId,
            capability: offer.capability,
            approve: approve
        )
        remove(item)
    }

    private func remove(_ item: InboxItem) {
        if var current = state.value {
            current.removeAll { $0.id == item.id }
            state = .loaded(current)
            AppModel.shared.setInboxCount(current.count)
        }
    }
}
