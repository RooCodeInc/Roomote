import Foundation
import RoomoteKit

/// A row in the Session transcript.
enum TranscriptItem: Identifiable {
    case userPrompt(Message)
    case assistant(Message)
    case streaming(eventId: String, text: String)
    case userInput(Message, UserInputRequest, pending: Bool)
    case offer(Message, CapabilityOffer, pending: Bool)
    case tools(id: String, [Message])
    case delegatedTask(id: String, taskId: String, title: String?)
    case cancelled(Message)

    var id: String {
        switch self {
        case .userPrompt(let message), .assistant(let message), .cancelled(let message): message.id
        case .streaming(let eventId, _): "streaming-\(eventId)"
        case .userInput(let message, _, _), .offer(let message, _, _): message.id
        case .tools(let id, _): id
        case .delegatedTask(let id, _, _): id
        }
    }
}

enum TranscriptBuilder {
    static func build(
        messages: [Message],
        streaming: [(eventId: String, text: String)],
        linkedTasks: [LinkedTask] = []
    ) -> [TranscriptItem] {
        let pendingRequests = PendingRequests.pendingRequestIds(in: messages)
        let pendingOffers = PendingRequests.pendingOfferIds(in: messages)
        let titles = Dictionary(linkedTasks.map { ($0.taskId, $0.title) }, uniquingKeysWith: { first, _ in first })
        var items: [TranscriptItem] = []
        var toolBuffer: [Message] = []
        var toolTurn: String?
        var seenTasks: Set<String> = []

        func flushTools() {
            guard let first = toolBuffer.first else { return }
            items.append(.tools(id: "tools-\(first.id)", toolBuffer))
            for message in toolBuffer {
                guard let payload = message.payload, let taskId = DelegatedTask.taskId(in: payload), !seenTasks.contains(taskId) else { continue }
                seenTasks.insert(taskId)
                let title = titles[taskId] ?? nil ?? DelegatedTask.title(in: payload)
                items.append(.delegatedTask(id: "task-\(message.id)", taskId: taskId, title: title))
            }
            toolBuffer = []
            toolTurn = nil
        }

        for message in messages {
            if message.isToolEvent {
                if let toolTurn, toolTurn != message.turnId { flushTools() }
                toolTurn = message.turnId
                toolBuffer.append(message)
                continue
            }
            flushTools()
            switch message.typedEventType {
            case .userPrompt:
                items.append(.userPrompt(message))
            case .assistantMessage:
                if message.text != nil || !message.imageURLs.isEmpty {
                    items.append(.assistant(message))
                }
            case .requestUserInput:
                if let request = message.userInputRequest {
                    items.append(.userInput(message, request, pending: pendingRequests.contains(request.requestId)))
                }
            case .capabilityOffer:
                if let offer = message.capabilityOffer {
                    items.append(.offer(message, offer, pending: pendingOffers.contains(offer.offerId)))
                }
            case .taskCancelled:
                items.append(.cancelled(message))
            case .assistantMessageChunk, .requestUserInputResponse, .capabilityOfferResponse:
                break
            case .toolCall, .toolCallUpdate, .toolResult, .none:
                break
            }
        }
        flushTools()

        // Linked tasks the transcript never mentioned by id still get a card.
        for task in linkedTasks where !seenTasks.contains(task.taskId) {
            seenTasks.insert(task.taskId)
            items.append(.delegatedTask(id: "linked-\(task.taskId)", taskId: task.taskId, title: task.title))
        }

        for chunk in streaming where !chunk.text.isEmpty {
            items.append(.streaming(eventId: chunk.eventId, text: chunk.text))
        }
        return items
    }
}

/// Finds task references inside tool payloads (`taskId` at any of the first levels).
enum DelegatedTask {
    private static let idKeys = ["taskId", "task_id"]
    private static let titleKeys = ["taskTitle", "title", "task_title"]

    static func taskId(in payload: JSONValue) -> String? {
        find(keys: idKeys, in: payload, depth: 0)
    }

    static func title(in payload: JSONValue) -> String? {
        find(keys: titleKeys, in: payload, depth: 0)
    }

    private static func find(keys: [String], in value: JSONValue, depth: Int) -> String? {
        guard depth < 4, let object = value.objectValue else { return nil }
        for key in keys {
            if let string = object[key]?.stringValue, !string.isEmpty { return string }
        }
        for (_, child) in object.sorted(by: { $0.key < $1.key }) {
            if let found = find(keys: keys, in: child, depth: depth + 1) { return found }
        }
        return nil
    }
}
