import Foundation
import Observation
import RoomoteKit

@MainActor
@Observable
final class SessionsListModel {
    var state: LoadState<[Session]> = .idle
    var nextCursor: String?
    var isLoadingMore = false
    var query = ""
    var listError: String?

    private var client: RoomoteClient { AppModel.shared.client }
    private var loadedQuery: String?

    var sessions: [Session] { state.value ?? [] }

    func load(showLoading: Bool = true) async {
        let query = self.query.trimmingCharacters(in: .whitespaces)
        if showLoading, state.value == nil || loadedQuery != query { state = .loading }
        do {
            let page = try await client.sessions(query: query.isEmpty ? nil : query)
            state = .loaded(page.sessions)
            nextCursor = page.nextCursor
            loadedQuery = query
            listError = nil
        } catch {
            if case .cancelled = error as? RoomoteError { return }
            if state.value == nil {
                state = .failed(error.localizedDescription)
            } else {
                listError = error.localizedDescription
            }
        }
    }

    func loadMoreIfNeeded(current: Session) async {
        guard let cursor = nextCursor, !isLoadingMore, let last = sessions.last, last.id == current.id else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        let query = loadedQuery ?? ""
        do {
            let page = try await client.sessions(query: query.isEmpty ? nil : query, before: cursor)
            var merged = sessions
            let known = Set(merged.map(\.id))
            merged.append(contentsOf: page.sessions.filter { !known.contains($0.id) })
            state = .loaded(merged)
            nextCursor = page.sessions.isEmpty ? nil : page.nextCursor
        } catch {
            if case .cancelled = error as? RoomoteError { return }
            listError = error.localizedDescription
        }
    }

    func markRead(id: String) {
        guard var current = state.value, let index = current.firstIndex(where: { $0.id == id }) else { return }
        current[index].unread = false
        state = .loaded(current)
    }
}
