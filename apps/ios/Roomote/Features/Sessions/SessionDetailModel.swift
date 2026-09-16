import Foundation
import Observation
import RoomoteKit

/// Live state for one Session: persisted messages plus streaming chunks.
@MainActor
@Observable
final class SessionDetailModel {
    let sessionID: String

    var state: LoadState<Void> = .idle
    var session: Session?
    var title: String?
    var model: String?
    var messages: [Message] = []
    /// Streaming assistant text keyed by eventId, in arrival order.
    var streaming: [(eventId: String, text: String)] = []
    var responding = false
    var composerText = ""
    var isSending = false
    var actionError: String?

    private var fastConversationId: String?
    private var streamTask: Task<Void, Never>?
    private var optimisticIds: Set<String> = []

    private var client: RoomoteClient { AppModel.shared.client }

    init(sessionID: String) {
        self.sessionID = sessionID
    }

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return session?.displayTitle ?? "Session"
    }

    // MARK: Loading

    func load() async {
        if messages.isEmpty { state = .loading }
        do {
            async let sessionRequest = client.session(id: sessionID)
            let page = try await client.sessionMessages(id: sessionID)
            fastConversationId = page.sessionId.isEmpty ? nil : page.sessionId
            title = page.title
            model = page.model
            messages = Self.sorted(page.messages)
            state = .loaded(())
            if let session = try? await sessionRequest {
                self.session = session
                if fastConversationId == nil { fastConversationId = session.fastConversationId }
                if title == nil { title = session.title }
                responding = session.isResponding()
            }
            startStream()
            try? await client.markRead(sessionID: sessionID)
        } catch {
            if case .cancelled = error as? RoomoteError { return }
            state = .failed(error.localizedDescription)
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    private func startStream() {
        guard let fastConversationId else { return }
        stop()
        let client = self.client
        let since = messages.map(\.ts).max()
        let sse = SSEClient { since in
            try await client.sessionStreamRequest(fastConversationId: fastConversationId, since: since)
        }
        streamTask = Task { [weak self] in
            for await event in sse.events(since: since) {
                guard let self, !Task.isCancelled else { break }
                self.handle(event)
            }
        }
    }

    // MARK: Stream events

    private struct MessagesEvent: Decodable {
        var messages: [Message]
        var conversationResponding: Bool?
    }

    private struct SessionEvent: Decodable {
        var title: String?
        var conversationResponding: Bool?
    }

    private func handle(_ event: SSEEvent) {
        switch event.name {
        case "messages":
            guard let payload = try? event.decode(MessagesEvent.self) else { return }
            upsert(payload.messages)
            if let responding = payload.conversationResponding { self.responding = responding }
        case "session":
            guard let payload = try? event.decode(SessionEvent.self) else { return }
            if let title = payload.title { self.title = title }
            if let responding = payload.conversationResponding { self.responding = responding }
        case "chunk":
            guard let json = event.json else { return }
            let chunk = json["event"] ?? json
            let eventId = chunk["eventId"]?.stringValue ?? chunk["id"]?.stringValue ?? "stream"
            let text = chunk["text"]?.stringValue
                ?? chunk["delta"]?.stringValue
                ?? chunk["contentBlocks"]?.arrayValue?.compactMap { $0["text"]?.stringValue }.joined()
            guard let text, !text.isEmpty else { return }
            appendChunk(eventId: eventId, text: text)
        default:
            break
        }
    }

    private func appendChunk(eventId: String, text: String) {
        // Ignore chunks for messages that already arrived in persisted form.
        if messages.contains(where: { $0.eventId == eventId }) { return }
        if let index = streaming.firstIndex(where: { $0.eventId == eventId }) {
            streaming[index].text += text
        } else {
            streaming.append((eventId: eventId, text: text))
        }
        responding = true
    }

    private func upsert(_ incoming: [Message]) {
        guard !incoming.isEmpty else { return }
        var current = messages
        for message in incoming {
            if let index = current.firstIndex(where: { $0.id == message.id }) {
                current[index] = message
            } else {
                current.append(message)
            }
            streaming.removeAll { $0.eventId == message.eventId }
            if message.isUserPrompt, let text = message.text {
                // Replace the optimistic copy of a prompt we sent.
                current.removeAll { optimisticIds.contains($0.id) && $0.text == text }
            }
        }
        messages = Self.sorted(current)
    }

    private static func sorted(_ messages: [Message]) -> [Message] {
        messages.sorted {
            if $0.ts != $1.ts { return $0.ts < $1.ts }
            if $0.turnSeq != $1.turnSeq { return $0.turnSeq < $1.turnSeq }
            return $0.id < $1.id
        }
    }

    // MARK: Actions

    func send() async {
        let text = composerText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        isSending = true
        actionError = nil
        let clientMessageId = UUID().uuidString
        let localId = "local-\(clientMessageId)"
        let optimistic = Message(
            id: localId,
            ts: Date().timeIntervalSince1970 * 1000,
            eventType: MessageEventType.userPrompt.rawValue,
            role: "user",
            contentBlocks: [ContentBlock(text: text)],
            userName: AppModel.shared.me?.user.displayName,
            userImageUrl: AppModel.shared.me?.user.imageUrl
        )
        optimisticIds.insert(localId)
        messages.append(optimistic)
        composerText = ""
        defer { isSending = false }
        do {
            try await client.reply(sessionID: sessionID, text: text, clientMessageId: clientMessageId)
            responding = true
            if streamTask == nil { startStream() }
        } catch {
            messages.removeAll { $0.id == localId }
            optimisticIds.remove(localId)
            composerText = text
            actionError = error.localizedDescription
        }
    }

    func answer(requestId: String, answers: Answers) async throws {
        try await client.answer(sessionID: sessionID, requestId: requestId, answers: answers)
        appendLocalResponse(eventType: .requestUserInputResponse, key: "requestId", value: requestId)
    }

    /// Cancels a pending request without answering it.
    func cancelRequest(requestId: String) async throws {
        try await client.answer(sessionID: sessionID, requestId: requestId, answers: [:], resolution: "cancelled")
        appendLocalResponse(eventType: .requestUserInputResponse, key: "requestId", value: requestId)
    }

    func respondToOffer(_ offer: CapabilityOffer, approve: Bool) async throws {
        try await client.respondToCapabilityOffer(sessionID: sessionID, offerId: offer.offerId, capability: offer.capability, approve: approve)
        appendLocalResponse(eventType: .capabilityOfferResponse, key: "offerId", value: offer.offerId)
    }

    /// Hides the inline form immediately; the persisted response replaces it.
    private func appendLocalResponse(eventType: MessageEventType, key: String, value: String) {
        let local = Message(
            id: "local-response-\(value)",
            ts: Date().timeIntervalSince1970 * 1000,
            eventType: eventType.rawValue,
            payload: .object([key: .string(value)])
        )
        messages.append(local)
        responding = true
    }
}
