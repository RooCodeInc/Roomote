import Foundation
import Observation
import RoomoteKit

@MainActor
@Observable
final class TasksListModel {
    var state: LoadState<[RoomoteTask]> = .idle
    var nextCursor: String?
    var isLoadingMore = false
    var listError: String?

    private var client: RoomoteClient { AppModel.shared.client }

    var tasks: [RoomoteTask] { state.value ?? [] }

    func load(showLoading: Bool = true) async {
        if showLoading, state.value == nil { state = .loading }
        do {
            let page = try await client.tasks()
            state = .loaded(page.tasks)
            nextCursor = page.nextCursor
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

    func loadMoreIfNeeded(current: RoomoteTask) async {
        guard let cursor = nextCursor, !isLoadingMore, tasks.last?.id == current.id else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let page = try await client.tasks(cursor: cursor)
            var merged = tasks
            let known = Set(merged.map(\.id))
            merged.append(contentsOf: page.tasks.filter { !known.contains($0.id) })
            state = .loaded(merged)
            nextCursor = page.tasks.isEmpty ? nil : page.nextCursor
        } catch {
            if case .cancelled = error as? RoomoteError { return }
            listError = error.localizedDescription
        }
    }
}
