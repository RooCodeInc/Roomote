import Foundation

/// Finds requests that are still waiting on the user in a message list.
public enum PendingRequests {
    static let terminalStatuses: Set<String> = [
        "submitted", "cancelled", "canceled", "completed", "dismissed", "answered", "resolved", "expired", "closed",
    ]

    /// `request_user_input` messages without a matching response and not marked terminal.
    public static func userInput(in messages: [Message]) -> [Message] {
        let answered = Set(messages.compactMap { message -> String? in
            guard message.typedEventType == .requestUserInputResponse else { return nil }
            return message.requestId
        })
        return messages.filter { message in
            guard message.typedEventType == .requestUserInput, let requestId = message.requestId else { return false }
            if answered.contains(requestId) { return false }
            if let status = message.payload?["status"]?.stringValue?.lowercased(), terminalStatuses.contains(status) {
                return false
            }
            return true
        }
    }

    /// `capability_offer` messages without a matching response.
    public static func capabilityOffers(in messages: [Message]) -> [Message] {
        let resolved = Set(messages.compactMap { message -> String? in
            guard message.typedEventType == .capabilityOfferResponse else { return nil }
            return message.offerId
        })
        return messages.filter { message in
            guard message.typedEventType == .capabilityOffer, let offerId = message.offerId else { return false }
            if resolved.contains(offerId) { return false }
            if let status = message.payload?["status"]?.stringValue?.lowercased(), terminalStatuses.contains(status) {
                return false
            }
            return true
        }
    }

    public static func pendingRequestIds(in messages: [Message]) -> Set<String> {
        Set(userInput(in: messages).compactMap(\.requestId))
    }

    public static func pendingOfferIds(in messages: [Message]) -> Set<String> {
        Set(capabilityOffers(in: messages).compactMap(\.offerId))
    }
}
