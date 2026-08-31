import {
  getSessionMessages,
  getSessionSummary,
  searchSessions,
  sendMessageToSession,
  startSession,
} from './tasks-api-client.js';
import { catchError, jsonResult } from './tool-result.js';
import type { RoomoteConfig, ToolResult } from './types.js';

export async function handleStartSession(
  message: string,
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    return jsonResult(await startSession(config, message));
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
  params: { sessionId: string; message: string },
  config: RoomoteConfig,
): Promise<ToolResult> {
  try {
    return jsonResult(
      await sendMessageToSession(config, params.sessionId, params.message),
    );
  } catch (error) {
    return catchError(error);
  }
}
