import UserNotifications
import RoomoteKit

/// Passes Roomote pushes through unchanged so `mutable-content` keeps working.
///
/// TODO: download image attachments (for example a task's visual-proof
/// artifact) using the shared Keychain token and attach them with
/// `UNNotificationAttachment` before calling the content handler.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttemptContent: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        bestAttemptContent = content

        if let payload = PushPayload(userInfo: request.content.userInfo),
           content.threadIdentifier.isEmpty,
           let thread = payload.routingSessionId ?? payload.taskId {
            content.threadIdentifier = thread
        }
        contentHandler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        if let contentHandler, let bestAttemptContent {
            contentHandler(bestAttemptContent)
        }
    }
}
