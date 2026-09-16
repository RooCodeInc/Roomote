import Foundation
import XCTest
@testable import RoomoteKit

final class DateDecodingTests: XCTestCase {
    private struct Box: Decodable { var at: Date }

    func testFractionalSecondsDecode() throws {
        let data = Data(#"{"at":"2026-09-15T10:20:30.123Z"}"#.utf8)
        let box = try JSONCoding.decoder.decode(Box.self, from: data)
        XCTAssertEqual(box.at.timeIntervalSince1970, 1_789_467_630.123, accuracy: 0.001)
    }

    func testWholeSecondsDecode() throws {
        let data = Data(#"{"at":"2026-09-15T10:20:30Z"}"#.utf8)
        let box = try JSONCoding.decoder.decode(Box.self, from: data)
        XCTAssertEqual(box.at.timeIntervalSince1970, 1_789_467_630, accuracy: 0.001)
    }

    func testNumericOffsetDecodes() throws {
        let data = Data(#"{"at":"2026-09-15T12:20:30.5+02:00"}"#.utf8)
        let box = try JSONCoding.decoder.decode(Box.self, from: data)
        XCTAssertEqual(box.at.timeIntervalSince1970, 1_789_467_630.5, accuracy: 0.001)
    }

    func testEpochMillisecondsDecode() throws {
        let data = Data(#"{"at":1789467630123}"#.utf8)
        let box = try JSONCoding.decoder.decode(Box.self, from: data)
        XCTAssertEqual(box.at.timeIntervalSince1970, 1_789_467_630.123, accuracy: 0.001)
    }

    func testGarbageFails() {
        let data = Data(#"{"at":"yesterday"}"#.utf8)
        XCTAssertThrowsError(try JSONCoding.decoder.decode(Box.self, from: data))
    }

    func testSessionDecodesContractShape() throws {
        let json = """
        {"id":"s1","fastConversationId":"fc1","title":null,"ownerName":"Ada","ownerImageUrl":null,
         "sourceSurface":"web","sourceTrigger":null,"activityAt":"2026-09-15T10:20:30.000Z",
         "createdAt":"2026-09-15T10:00:00Z","cachedStatus":null,"respondingUntil":"2026-09-15T10:21:00Z",
         "archivedAt":null,"unread":true,"linkedTasks":[],"pullRequests":[{"url":"https://x/1","number":1,"repository":"a/b","status":"open"}]}
        """
        let session = try JSONCoding.decoder.decode(Session.self, from: Data(json.utf8))
        XCTAssertEqual(session.displayTitle, "Untitled session")
        XCTAssertTrue(session.unread)
        XCTAssertEqual(session.pullRequests.first?.title, "a/b#1")
        XCTAssertTrue(session.isResponding(at: Date(timeIntervalSince1970: 1_789_467_640)))
        XCTAssertFalse(session.isResponding(at: Date(timeIntervalSince1970: 1_789_467_700)))
    }

    func testTaskCursorAcceptsNumbers() throws {
        let page = try JSONCoding.decoder.decode(TasksPage.self, from: Data(#"{"tasks":[],"nextCursor":42}"#.utf8))
        XCTAssertEqual(page.nextCursor, "42")
        let objectPage = try JSONCoding.decoder.decode(TranscriptPage.self, from: Data(#"{"envelopes":[],"nextCursor":{"ts":1,"id":"x"}}"#.utf8))
        XCTAssertNotNil(objectPage.nextCursor)
        XCTAssertTrue(objectPage.nextCursor!.contains("\"ts\""))
    }
}
