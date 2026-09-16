import Foundation
import Observation
import RoomoteKit

@MainActor
@Observable
final class TaskDetailModel {
    let taskID: String

    var state: LoadState<Void> = .idle
    var task: RoomoteTask?
    var envelopes: [Envelope] = []
    var streaming: [(eventId: String, text: String)] = []
    var transcriptError: String?
    var actionError: String?
    var steerText = ""
    var isSteering = false
    var isCancelling = false

    private var streamTask: Task<Void, Never>?
    private var client: RoomoteClient { AppModel.shared.client }

    init(taskID: String) {
        self.taskID = taskID
    }

    var isTerminal: Bool { task?.typedState?.isTerminal ?? false }

    func load() async {
        if task == nil { state = .loading }
        do {
            let task = try await client.task(id: taskID)
            self.task = task
            state = .loaded(())
            await loadTranscript()
            startStream()
        } catch {
            if case .cancelled = error as? RoomoteError { return }
            state = .failed(error.localizedDescription)
        }
    }

    func refresh() async {
        if let task = try? await client.task(id: taskID) {
            self.task = task
        }
        await loadTranscript()
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    private func loadTranscript() async {
        do {
            let page = try await client.transcript(taskID: taskID)
            upsert(page.envelopes)
            transcriptError = nil
        } catch {
            if case .cancelled = error as? RoomoteError { return }
            transcriptError = error.localizedDescription
        }
    }

    private func startStream() {
        stop()
        let client = self.client
        let taskID = self.taskID
        let since = envelopes.compactMap(\.ts).max()
        let sse = SSEClient { since in
            try await client.taskStreamRequest(taskID: taskID, since: since)
        }
        streamTask = Task { [weak self] in
            for await event in sse.events(since: since) {
                guard let self, !Task.isCancelled else { break }
                self.handle(event)
            }
        }
    }

    private struct MessagesEvent: Decodable { var messages: [Envelope] }

    private func handle(_ event: SSEEvent) {
        switch event.name {
        case "messages":
            guard let payload = try? event.decode(MessagesEvent.self) else { return }
            upsert(payload.messages)
        case "task":
            guard let update = try? event.decode(TaskStreamUpdate.self), var task else { return }
            if let state = update.state { task.state = state }
            if let run = update.latestRun { task.latestRun = run }
            self.task = task
        case "chunk":
            guard let json = event.json else { return }
            let chunk = json["event"] ?? json
            let eventId = chunk["eventId"]?.stringValue ?? chunk["id"]?.stringValue ?? "stream"
            let text = chunk["text"]?.stringValue ?? chunk["delta"]?.stringValue
            guard let text, !text.isEmpty else { return }
            if envelopes.contains(where: { $0.id == eventId }) { return }
            if let index = streaming.firstIndex(where: { $0.eventId == eventId }) {
                streaming[index].text += text
            } else {
                streaming.append((eventId: eventId, text: text))
            }
        default:
            break
        }
    }

    private func upsert(_ incoming: [Envelope]) {
        guard !incoming.isEmpty else { return }
        var current = envelopes
        for envelope in incoming {
            if let index = current.firstIndex(where: { $0.id == envelope.id }) {
                current[index] = envelope
            } else {
                current.append(envelope)
            }
            streaming.removeAll { $0.eventId == envelope.id }
        }
        envelopes = current.sorted { ($0.ts ?? 0, $0.id) < ($1.ts ?? 0, $1.id) }
    }

    // MARK: Actions

    func steer() async {
        let prompt = steerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !isSteering else { return }
        isSteering = true
        actionError = nil
        defer { isSteering = false }
        do {
            try await client.steer(taskID: taskID, prompt: prompt)
            steerText = ""
        } catch {
            actionError = error.localizedDescription
        }
    }

    func cancel() async {
        isCancelling = true
        actionError = nil
        defer { isCancelling = false }
        do {
            try await client.cancelTask(taskID: taskID)
            if var task { task.state = "cancelled"; self.task = task }
        } catch {
            actionError = error.localizedDescription
        }
    }

    func answer(requestId: String, answers: Answers) async throws {
        try await client.answerTask(taskID: taskID, requestId: requestId, answers: answers)
        envelopes.append(Envelope(raw: .object([
            "id": .string("local-response-\(requestId)"),
            "ts": .number(Date().timeIntervalSince1970 * 1000),
            "eventType": .string(MessageEventType.requestUserInputResponse.rawValue),
            "payload": .object(["requestId": .string(requestId)]),
        ])))
    }
}
