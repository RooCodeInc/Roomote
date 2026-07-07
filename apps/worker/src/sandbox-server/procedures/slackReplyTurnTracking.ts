import { recordChatTurnStart } from '../../mcp/roomote-mcp-server/chat-reply-satisfaction';

export function recordSandboxPromptSlackTurnStart(options: {
  clientMessageId?: string;
  nowMs?: number;
  source?: string;
  stateFilePath?: string;
}): void {
  if (!options.stateFilePath) {
    return;
  }

  const source = options.source?.trim() || 'prompt';
  const clientMessageId = options.clientMessageId?.trim();
  const nowMs = options.nowMs ?? Date.now();

  recordChatTurnStart({
    stateFilePath: options.stateFilePath,
    turnMessageTs: clientMessageId
      ? `${source}:${clientMessageId}`
      : `${source}:${nowMs}`,
    nowMs,
  });
}
