import { ACP_LIVE_EVENT_TYPES } from '@roomote/types';

import type { AcpUiMessage } from './types';
import { shouldHideAcpMessage } from './message-visibility';

function mcpToolCallMessage(
  toolName: string,
  serverName = 'browser-mcp',
): AcpUiMessage {
  return {
    id: `tool-call-${toolName}`,
    ts: 1,
    role: 'tool',
    kind: 'tool_call',
    partial: false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_call',
    text: toolName,
    data: {
      toolCallId: 'call-1',
      title: `${serverName}/${toolName}`,
      kind: 'mcp',
      status: 'completed',
      isExecute: false,
      isRead: false,
      isMcp: true,
      mcpServerName: serverName,
      mcpToolName: toolName,
      serverName,
      toolName,
      command: null,
    },
  };
}

function mcpToolResultMessage(
  toolName: string,
  serverName = 'browser-mcp',
): AcpUiMessage {
  return {
    id: `tool-result-${toolName}`,
    ts: 1,
    role: 'tool',
    kind: 'tool_result',
    partial: false,
    sessionId: 'session-1',
    updateType: 'roomote_runtime.tool_call_update',
    text: toolName,
    data: {
      toolCallId: 'call-1',
      kind: 'mcp',
      title: `${serverName}/${toolName}`,
      isExecute: false,
      isMcp: true,
      mcpServerName: serverName,
      mcpToolName: toolName,
      serverName,
      toolName,
      command: null,
      exitCode: null,
      output: '',
      status: 'completed',
    },
  };
}

describe('message visibility helpers', () => {
  it('does not hide assistant replies by default', () => {
    const message = {
      id: 'assistant-1',
      ts: 1,
      role: 'assistant',
      kind: 'text',
      partial: true,
      sessionId: 'session-1',
      updateType: 'roomote_runtime.assistant_message_chunk',
      text: '2',
      data: {},
    } satisfies AcpUiMessage;

    expect(shouldHideAcpMessage(message)).toBe(false);
  });

  it('hides messages explicitly flagged as hidden in the transcript', () => {
    const message = {
      id: 'user-1',
      ts: 1,
      role: 'user',
      kind: 'text',
      partial: false,
      visibleInTranscript: false,
      sessionId: 'session-1',
      updateType: 'roomote_runtime.user_prompt',
      text: 'What is 1 + 1?',
      data: {},
    } satisfies AcpUiMessage;

    expect(shouldHideAcpMessage(message)).toBe(true);
  });

  it('does not hide regular user messages', () => {
    const message = {
      id: 'user-normal',
      ts: 1,
      role: 'user',
      kind: 'text',
      partial: false,
      sessionId: 'session-1',
      updateType: 'roomote_runtime.user_prompt',
      text: 'Tell me a pirate joke!',
      data: {},
    } satisfies AcpUiMessage;

    expect(shouldHideAcpMessage(message)).toBe(false);
  });

  it('hides unknown ACP control updates from the transcript', () => {
    const message = {
      id: 'config-option-update',
      ts: 1,
      role: 'assistant',
      kind: 'unknown',
      partial: false,
      sessionId: 'session-1',
      updateType: ACP_LIVE_EVENT_TYPES.ConfigOptionUpdate,
      text: 'Approval Preset changed',
      data: {
        sessionUpdate: 'config_option_update',
        configOptions: [],
      },
    } satisfies AcpUiMessage;

    expect(shouldHideAcpMessage(message)).toBe(true);
  });

  it('hides deny-listed MCP tool_call messages', () => {
    expect(shouldHideAcpMessage(mcpToolCallMessage('browser_click'))).toBe(
      true,
    );
    expect(shouldHideAcpMessage(mcpToolCallMessage('browser_fill_form'))).toBe(
      true,
    );
    expect(shouldHideAcpMessage(mcpToolCallMessage('browser_run_code'))).toBe(
      true,
    );
  });

  it('hides deny-listed MCP tool_result messages', () => {
    expect(shouldHideAcpMessage(mcpToolResultMessage('browser_wait_for'))).toBe(
      true,
    );
    expect(
      shouldHideAcpMessage(mcpToolResultMessage('browser_fill_form')),
    ).toBe(true);
    expect(shouldHideAcpMessage(mcpToolResultMessage('browser_run_code'))).toBe(
      true,
    );
  });

  it('does not hide non-denied MCP tools', () => {
    expect(shouldHideAcpMessage(mcpToolCallMessage('browser_type'))).toBe(
      false,
    );
  });

  it('does not hide same-name MCP tools from non-browser-mcp sources', () => {
    expect(
      shouldHideAcpMessage(
        mcpToolCallMessage('browser_click', 'third-party-browser'),
      ),
    ).toBe(false);
    expect(
      shouldHideAcpMessage(
        mcpToolResultMessage('browser_navigate', 'third-party-browser'),
      ),
    ).toBe(false);
  });
});
