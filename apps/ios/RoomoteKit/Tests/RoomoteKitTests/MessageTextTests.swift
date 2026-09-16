import Foundation
import XCTest
@testable import RoomoteKit

final class MessageTextTests: XCTestCase {
    func testTextJoinsTextBlocksOnly() throws {
        let json = """
        {"id":"m1","eventId":"e1","turnId":"t1","turnSeq":1,"ts":1700000000000,
         "eventType":"roomote_runtime.assistant_message","role":"assistant",
         "contentBlocks":[{"type":"text","text":"Hello"},{"type":"image","url":"https://x/img.png"},{"type":"text","text":"world"}],
         "payload":null,"userName":null,"userImageUrl":null,"createdAt":"2026-09-15T10:20:30Z"}
        """
        let message = try JSONCoding.decoder.decode(Message.self, from: Data(json.utf8))
        XCTAssertEqual(message.text, "Hello\nworld")
        XCTAssertEqual(message.imageURLs.map(\.absoluteString), ["https://x/img.png"])
        XCTAssertTrue(message.isAssistantMessage)
        XCTAssertNil(message.payload)
    }

    func testTextIsNilWithoutBlocks() {
        let message = Message(id: "m", ts: 0, eventType: "roomote_runtime.tool_call", payload: .object(["title": .string("Read file")]))
        XCTAssertNil(message.text)
        XCTAssertTrue(message.isToolEvent)
        XCTAssertEqual(message.toolTitle, "Read file")
    }

    func testUnknownEventTypeIsToolRow() {
        let message = Message(id: "m", ts: 0, eventType: "roomote_runtime.something_new")
        XCTAssertNil(message.typedEventType)
        XCTAssertTrue(message.isToolEvent)
    }

    func testUserInputRequestPayloadDecodes() throws {
        let json = """
        {"id":"m2","eventId":"e2","turnId":"t1","turnSeq":2,"ts":1700000001000,
         "eventType":"roomote_runtime.request_user_input","role":"assistant","contentBlocks":null,
         "payload":{"requestId":"r1","status":"pending","questions":[
            {"id":"q1","header":"Env","question":"Which one?","isOther":true,"isSecret":false,"multiple":false,
             "options":[{"id":"o1","label":"Staging","description":""},{"id":null,"label":"Prod","description":"careful"}]}]},
         "userName":null,"userImageUrl":null,"createdAt":"2026-09-15T10:20:31Z"}
        """
        let message = try JSONCoding.decoder.decode(Message.self, from: Data(json.utf8))
        let request = try XCTUnwrap(message.userInputRequest)
        XCTAssertEqual(request.requestId, "r1")
        XCTAssertEqual(request.questions.first?.options?.map(\.answerValue), ["o1", "Prod"])
        XCTAssertTrue(request.questions.first!.allowsFreeText)
    }

    func testEnvelopeTextExtraction() throws {
        let envelope = try JSONCoding.decoder.decode(
            Envelope.self,
            from: Data(#"{"id":"e1","ts":5,"eventType":"roomote_runtime.assistant_message","contentBlocks":[{"type":"text","text":"Done"}]}"#.utf8)
        )
        XCTAssertEqual(envelope.text, "Done")
        XCTAssertEqual(envelope.ts, 5)
        let bare = Envelope(raw: .object(["eventType": .string("roomote_runtime.tool_result"), "payload": .object(["output": .string("ok"), "title": .string("bash")])]))
        XCTAssertEqual(bare.text, "ok")
        XCTAssertEqual(bare.toolTitle, "bash")
        XCTAssertTrue(bare.isToolEvent)
    }
}
