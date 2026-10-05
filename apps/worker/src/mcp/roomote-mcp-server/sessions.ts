import {
  getSessionMessages,
  getSessionSummary,
  searchSessions,
  sendMessageToSession,
  startSession,
} from './tasks-api-client.js';
import { catchError, jsonResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';
import type { RoomoteMessageAttachment } from '@roomote/types';

export async function handleStartSession(
  params: { message: string; attachments?: RoomoteMessageAttachment[] },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    return jsonResult(
      await startSession(config, params.message, params.attachments),
    );
  } catch (error) {
    return catchError(error);
  }
}

export async function handleSearchSessions(
  params: {
    query?: string;
    status?: string;
    limit?: number;
    cursor?: string;
  },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    return jsonResult(await searchSessions(config, params));
  } catch (error) {
    return catchError(error);
  }
}

export async function handleGetSessionSummary(
  sessionId: string,
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    return jsonResult(await getSessionSummary(config, sessionId));
  } catch (error) {
    return catchError(error);
  }
}

export async function handleGetSessionMessages(
  params: { sessionId: string; limit?: number },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    return jsonResult(
      await getSessionMessages(config, params.sessionId, params.limit),
    );
  } catch (error) {
    return catchError(error);
  }
}

export async function handleSendSessionMessage(
  params: {
    sessionId: string;
    message: string;
    attachments?: RoomoteMessageAttachment[];
  },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    return jsonResult(
      await sendMessageToSession(
        config,
        params.sessionId,
        params.message,
        params.attachments,
      ),
    );
  } catch (error) {
    return catchError(error);
  }
}
