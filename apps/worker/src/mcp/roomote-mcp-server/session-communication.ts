import {
  getFastSessionMessages,
  sendMessageToFastSession,
} from './tasks-api-client.js';
import {
  catchError,
  errorResult,
  successResult,
  textResult,
} from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

const MESSAGE_TEXT_LIMIT = 500;

export async function handleGetFastSessionMessages(
  params: { sessionId: string; limit?: number },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const result = await getFastSessionMessages(config, params.sessionId, {
      limit: params.limit,
    });
    if (result.messages.length === 0) {
      return textResult('No messages found for this Fast session.');
    }

    const lines = result.messages.map((message) => {
      const text = message.text
        ? message.text.length > MESSAGE_TEXT_LIMIT
          ? `${message.text.slice(0, MESSAGE_TEXT_LIMIT)}...`
          : message.text
        : '(no text)';
      return `[${message.role ?? 'unknown'}] (${message.eventType})\n${text}`;
    });

    return textResult(
      [
        `Latest ${result.messages.length} message(s) for Fast session ${params.sessionId}:`,
        '',
        ...lines,
      ].join('\n\n'),
    );
  } catch (error) {
    return catchError(error);
  }
}

export async function handleSendFastSessionMessage(
  params: { sessionId: string; message: string },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    const result = await sendMessageToFastSession(config, params.sessionId, {
      message: params.message,
    });
    if (!result.success) {
      return errorResult(result.error || 'Failed to send message');
    }
    return successResult({
      message: `Message sent to Fast session ${params.sessionId}.`,
    });
  } catch (error) {
    return catchError(error);
  }
}
