import Foundation
import XCTest
@testable import RoomoteKit

final class PendingRequestTests: XCTestCase {
    private func request(_ id: String, requestId: String, status: String? = "pending") -> Message {
        var payload: [String: JSONValue] = ["requestId": .string(requestId), "questions": .array([])]
        if let status { payload["status"] = .string(status) }
        return Message(id: id, ts: 1, eventType: MessageEventType.requestUserInput.rawValue, payload: .object(payload))
    }

    private func response(_ id: String, requestId: String) -> Message {
        Message(id: id, ts: 2, eventType: MessageEventType.requestUserInputResponse.rawValue, payload: .object(["requestId": .string(requestId)]))
    }

    func testRequestWithoutResponseIsPending() {
        let pending = PendingRequests.userInput(in: [request("a", requestId: "r1")])
        XCTAssertEqual(pending.map(\.id), ["a"])
    }

    func testRequestWithResponseIsNotPending() {
        let messages = [request("a", requestId: "r1"), response("b", requestId: "r1"), request("c", requestId: "r2")]
        XCTAssertEqual(PendingRequests.userInput(in: messages).map(\.id), ["c"])
        XCTAssertEqual(PendingRequests.pendingRequestIds(in: messages), ["r2"])
    }

    func testTerminalStatusIsNotPending() {
        XCTAssertTrue(PendingRequests.userInput(in: [request("a", requestId: "r1", status: "cancelled")]).isEmpty)
        XCTAssertEqual(PendingRequests.userInput(in: [request("a", requestId: "r1", status: nil)]).count, 1)
    }

    func testCapabilityOffers() {
        let offer = Message(id: "o", ts: 1, eventType: MessageEventType.capabilityOffer.rawValue,
                            payload: .object(["offerId": .string("x"), "capability": .string("source_control"), "message": .string("Connect GitHub?")]))
        let reply = Message(id: "r", ts: 2, eventType: MessageEventType.capabilityOfferResponse.rawValue, payload: .object(["offerId": .string("x")]))
        XCTAssertEqual(PendingRequests.capabilityOffers(in: [offer]).count, 1)
        XCTAssertEqual(offer.capabilityOffer?.capabilityTitle, "Source control")
        XCTAssertTrue(PendingRequests.capabilityOffers(in: [offer, reply]).isEmpty)
    }
}
