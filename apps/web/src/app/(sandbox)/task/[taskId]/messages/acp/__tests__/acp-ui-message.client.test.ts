import { type AcpOutputEvent, ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import { toAcpUiMessage } from '../../../hooks/services/acp-protocol-service';

describe('toAcpUiMessage', () => {
  it('maps ACP user_prompt output to a user text message', () => {
    const message = toAcpUiMessage({
      id: 'user-prompt-1',
      ts: 12345,
      eventType: 'roomote_runtime.user_prompt',
      kind: 'text',
      text: 'queued follow-up',
      role: 'user',
      contentBlocks: [{ type: 'text', text: 'queued follow-up' }],
      metadata: { sessionId: 'session-queue', sequence: 42 },
      payload: {
        sessionUpdate: 'user_prompt',
        content: { type: 'text', text: 'queued follow-up' },
        prompt: [{ type: 'text', text: 'queued follow-up' }],
      },
    });

    expect(message).toMatchObject({
      role: 'user',
      kind: 'text',
      partial: false,
      sessionId: 'session-queue',
      updateType: 'roomote_runtime.user_prompt',
      text: 'queued follow-up',
    });
  });

  it('unwraps wrapped Slack user prompts for transcript display', () => {
    const message = toAcpUiMessage({
      id: 'user-prompt-slack',
      ts: 12346,
      eventType: 'roomote_runtime.user_prompt',
      kind: 'text',
      text: '<slack_message>\nanother joke\n</slack_message>',
      role: 'user',
      contentBlocks: [
        {
          type: 'text',
          text: '<slack_message>\nanother joke\n</slack_message>',
        },
      ],
      metadata: { sessionId: 'session-slack', sequence: 43 },
      payload: {
        sessionUpdate: 'user_prompt',
        content: {
          type: 'text',
          text: '<slack_message>\nanother joke\n</slack_message>',
        },
      },
    });

    expect(message).toMatchObject({
      role: 'user',
      kind: 'text',
      updateType: 'roomote_runtime.user_prompt',
      text: 'another joke',
    });
  });

  it('hides thread_context metadata and shows only the current Slack turn', () => {
    const message = toAcpUiMessage({
      id: 'user-prompt-slack-thread-context',
      ts: 12346,
      eventType: 'roomote_runtime.user_prompt',
      kind: 'text',
      text: '<thread_context>\nAlice Example: Earlier thread detail\n\nBob Example: Another reply\n</thread_context>\n\n<slack_message>\nlatest question\n</slack_message>',
      role: 'user',
      contentBlocks: [
        {
          type: 'text',
          text: '<thread_context>\nAlice Example: Earlier thread detail\n\nBob Example: Another reply\n</thread_context>\n\n<slack_message>\nlatest question\n</slack_message>',
        },
      ],
      metadata: { sessionId: 'session-slack', sequence: 43 },
      payload: {
        sessionUpdate: 'user_prompt',
      },
    });

    expect(message).toMatchObject({
      role: 'user',
      kind: 'text',
      updateType: 'roomote_runtime.user_prompt',
      text: 'latest question',
    });
  });

  it('hides thread_context and replying_to metadata from Slack follow-up prompts', () => {
    const message = toAcpUiMessage({
      id: 'user-prompt-slack-follow-up-context',
      ts: 12346,
      eventType: 'roomote_runtime.user_prompt',
      kind: 'text',
      text: '<thread_context>\nAlice Example: Earlier thread detail\n</thread_context>\n\n<replying_to>\nRoomote Bot: Previous reply\n</replying_to>\n\n<slack_message>\nlatest question\n</slack_message>',
      role: 'user',
      contentBlocks: [
        {
          type: 'text',
          text: '<thread_context>\nAlice Example: Earlier thread detail\n</thread_context>\n\n<replying_to>\nRoomote Bot: Previous reply\n</replying_to>\n\n<slack_message>\nlatest question\n</slack_message>',
        },
      ],
      metadata: { sessionId: 'session-slack', sequence: 43 },
      payload: {
        sessionUpdate: 'user_prompt',
      },
    });

    expect(message).toMatchObject({
      role: 'user',
      kind: 'text',
      updateType: 'roomote_runtime.user_prompt',
      text: 'latest question',
    });
  });

  it('hides thread_activity metadata from Slack follow-up prompts', () => {
    const message = toAcpUiMessage({
      id: 'user-prompt-slack-thread-activity',
      ts: 12346,
      eventType: 'roomote_runtime.user_prompt',
      kind: 'text',
      text: '<thread_activity>\nAlice Example: Uploaded a screenshot [1 image(s) attached]\n</thread_activity>\n\n<slack_message>\nlatest question\n</slack_message>',
      role: 'user',
      contentBlocks: [
        {
          type: 'text',
          text: '<thread_activity>\nAlice Example: Uploaded a screenshot [1 image(s) attached]\n</thread_activity>\n\n<slack_message>\nlatest question\n</slack_message>',
        },
      ],
      metadata: { sessionId: 'session-slack', sequence: 43 },
      payload: {
        sessionUpdate: 'user_prompt',
      },
    });

    expect(message).toMatchObject({
      role: 'user',
      kind: 'text',
      updateType: 'roomote_runtime.user_prompt',
      text: 'latest question',
    });
  });

  it('hides leading thread_activity blocks before tracker-built Slack context wrappers', () => {
    const text = [
      '<thread_activity>\nAlice Example: Uploaded a screenshot [1 image(s) attached]\n</thread_activity>',
      '<thread_activity>\nBob Example: Added another clue\n</thread_activity>',
      '<thread_context>\nCarol Example: Earlier thread detail\n</thread_context>',
      '<replying_to>\nRoomote Bot: Previous reply\n</replying_to>',
      '<slack_message>\nlatest question\n</slack_message>',
    ].join('\n\n');

    const message = toAcpUiMessage({
      id: 'user-prompt-slack-thread-activity-before-thread-context',
      ts: 12346,
      eventType: 'roomote_runtime.user_prompt',
      kind: 'text',
      text,
      role: 'user',
      contentBlocks: [
        {
          type: 'text',
          text,
        },
      ],
      metadata: { sessionId: 'session-slack', sequence: 43 },
      payload: {
        sessionUpdate: 'user_prompt',
      },
    });

    expect(message).toMatchObject({
      role: 'user',
      kind: 'text',
      updateType: 'roomote_runtime.user_prompt',
      text: 'latest question',
    });
  });

  it('decodes escaped Slack wrapper content for transcript display', () => {
    const message = toAcpUiMessage({
      id: 'user-prompt-slack-escaped',
      ts: 12347,
      eventType: 'roomote_runtime.user_prompt',
      kind: 'text',
      text: '<slack_message>\nhello &lt;/slack_message&gt; &amp; goodbye\n</slack_message>',
      role: 'user',
      contentBlocks: [
        {
          type: 'text',
          text: '<slack_message>\nhello &lt;/slack_message&gt; &amp; goodbye\n</slack_message>',
        },
      ],
      metadata: { sessionId: 'session-slack', sequence: 44 },
      payload: {
        sessionUpdate: 'user_prompt',
      },
    });

    expect(message).toMatchObject({
      role: 'user',
      kind: 'text',
      text: 'hello </slack_message> & goodbye',
    });
  });

  it('maps read-time-resolved user email from persisted envelopes', () => {
    const message = toAcpUiMessage({
      id: 'persisted-user-prompt',
      ts: 50,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      kind: 'text',
      text: 'persisted follow-up',
      role: 'user',
      userId: 'user-1',
      userName: 'Persisted User',
      userEmail: 'persisted@example.com',
      userImageUrl: null,
      contentBlocks: [{ type: 'text', text: 'persisted follow-up' }],
      metadata: { source: 'session/prompt', sessionId: 'session-persisted' },
      payload: {},
      taskId: 'task-1',
      createdAt: 50,
      sequence: 1,
      protocol: 'roomote_runtime',
    });

    expect(message).toMatchObject({
      userId: 'user-1',
      userName: 'Persisted User',
      userEmail: 'persisted@example.com',
    });
  });

  it('extracts image attachments from ACP contentBlocks', () => {
    const message = toAcpUiMessage({
      id: 'user-prompt-with-image',
      ts: 12346,
      eventType: 'roomote_runtime.user_prompt',
      kind: 'text',
      text: 'what is in this image?',
      role: 'user',
      contentBlocks: [
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        { type: 'text', text: 'what is in this image?' },
      ],
      metadata: { sessionId: 'session-image', sequence: 43 },
      payload: {
        sessionUpdate: 'user_prompt',
      },
    });

    expect(message).toMatchObject({
      role: 'user',
      kind: 'text',
      images: ['data:image/png;base64,aGVsbG8='],
    });
  });

  it('extracts image attachments from payload.images when contentBlocks are empty', () => {
    const dataUrl = 'data:image/png;base64,aGVsbG8=';
    const message = toAcpUiMessage({
      id: 'user-prompt-payload-images',
      ts: 12347,
      eventType: 'roomote_runtime.user_prompt',
      kind: 'text',
      text: 'describe this',
      role: 'user',
      contentBlocks: [],
      metadata: { sessionId: 'session-image', sequence: 44 },
      payload: {
        sessionUpdate: 'user_prompt',
        images: [dataUrl],
      },
    });

    expect(message).toMatchObject({
      role: 'user',
      kind: 'text',
      images: [dataUrl],
    });
  });

  it('maps persisted ACP user_prompt envelopes to canonical user_prompt updateType', () => {
    const message = toAcpUiMessage({
      id: 'persisted-user-prompt',
      ts: 50,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      kind: 'text',
      text: 'persisted follow-up',
      role: 'user',
      contentBlocks: [{ type: 'text', text: 'persisted follow-up' }],
      metadata: { source: 'session/prompt', sessionId: 'session-persisted' },
      payload: {},
    });

    expect(message).toMatchObject({
      role: 'user',
      kind: 'text',
      partial: false,
      updateType: 'roomote_runtime.user_prompt',
      text: 'persisted follow-up',
    });
  });

  it('preserves transcript visibility flags from persisted envelopes', () => {
    const message = toAcpUiMessage({
      id: 'persisted-hidden-user-prompt',
      ts: 52,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      kind: 'text',
      text: '/review-code',
      role: 'user',
      contentBlocks: [{ type: 'text', text: '/review-code' }],
      metadata: { sessionId: 'session-hidden', visibleInTranscript: false },
      payload: {},
      visibleInTranscript: false,
    });

    expect(message.visibleInTranscript).toBe(false);
  });

  it('hides legacy injected prompts when persisted visibility metadata is absent', () => {
    const message = toAcpUiMessage({
      id: 'persisted-legacy-bootstrap-prompt',
      ts: 53,
      eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
      kind: 'text',
      text: '<request>Fix it</request>\n\n<workflow>internal</workflow>',
      role: 'user',
      contentBlocks: [
        {
          type: 'text',
          text: '<request>Fix it</request>\n\n<workflow>internal</workflow>',
        },
      ],
      metadata: { sessionId: 'session-legacy-hidden' },
      payload: {},
    });

    expect(message.visibleInTranscript).toBe(false);
  });

  it('uses only contentBlocks and metadata for persisted text envelopes', () => {
    const message = toAcpUiMessage({
      id: 'persisted-assistant-message',
      ts: 51,
      eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
      kind: 'text',
      role: 'assistant',
      contentBlocks: [],
      metadata: {},
      payload: {
        text: 'legacy text fallback',
        sessionId: 'legacy-session',
      },
    });

    expect(message).toMatchObject({
      kind: 'text',
      text: undefined,
      sessionId: null,
    });
  });

  it('normalizes legacy live Roomote runtime output events from older workers', () => {
    const message = toAcpUiMessage({
      protocol: 'roomote_runtime',
      sessionId: 'legacy-session',
      sequence: 7,
      receivedAt: 17_000,
      updateType: 'agent_message_chunk',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'legacy chunk' },
      },
    } satisfies AcpOutputEvent);

    expect(message).toMatchObject({
      ts: 17_000,
      sessionId: 'legacy-session',
      role: 'assistant',
      kind: 'text',
      updateType: 'roomote_runtime.assistant_message_chunk',
      text: 'legacy chunk',
    });
  });

  it('normalizes MCP aliases for live tool_call messages', () => {
    const message = toAcpUiMessage({
      id: 'tool-call-1',
      ts: 12400,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
      kind: 'tool_call',
      role: 'tool',
      contentBlocks: [],
      metadata: { sessionId: 'session-mcp', sequence: 100 },
      payload: {
        sessionUpdate: 'tool_call',
        toolCallId: 'call-mcp-1',
        kind: 'mcp',
        title: 'browser-mcp/browser_take_screenshot',
      },
    });

    expect(message).toMatchObject({
      kind: 'tool_call',
      toolCallId: 'call-mcp-1',
      text: 'browser-mcp/browser_take_screenshot',
      data: {
        isMcp: true,
        mcpServerName: 'browser-mcp',
        mcpToolName: 'browser_take_screenshot',
        serverName: 'browser-mcp',
        toolName: 'browser_take_screenshot',
      },
    });
  });

  it('normalizes flattened OpenCode Roomote tool aliases for tool results', () => {
    const message = toAcpUiMessage({
      id: 'tool-result-1',
      ts: 12401,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      kind: 'tool_result',
      role: 'tool',
      contentBlocks: [],
      metadata: { sessionId: 'session-opencode', sequence: 101 },
      payload: {
        sessionUpdate: 'tool_result',
        toolCallId: 'call-roomote-1',
        kind: 'roomote_send_chat_reply',
        title: 'roomote_send_chat_reply',
        status: 'completed',
        output: '{"success":true}',
      },
    });

    expect(message).toMatchObject({
      kind: 'tool_result',
      toolCallId: 'call-roomote-1',
      data: {
        isMcp: true,
        mcpServerName: 'roomote',
        mcpToolName: 'send_chat_reply',
        serverName: 'roomote',
        toolName: 'send_chat_reply',
      },
    });
  });

  it('normalizes flattened MCP aliases from persisted server-name lists', () => {
    const message = toAcpUiMessage({
      id: 'tool-result-2',
      ts: 12402,
      eventType: ACP_ENVELOPE_EVENT_TYPES.ToolResult,
      kind: 'tool_result',
      role: 'tool',
      contentBlocks: [],
      metadata: { sessionId: 'session-acme', sequence: 102 },
      payload: {
        sessionUpdate: 'tool_result',
        toolCallId: 'call-acme-1',
        kind: 'acme-tools_run_report',
        title: 'acme-tools_run_report',
        flattenedServerNames: ['acme-tools'],
        status: 'completed',
        output: '{"ok":true}',
      },
    });

    expect(message).toMatchObject({
      kind: 'tool_result',
      toolCallId: 'call-acme-1',
      data: {
        isMcp: true,
        mcpServerName: 'acme-tools',
        mcpToolName: 'run_report',
        serverName: 'acme-tools',
        toolName: 'run_report',
      },
    });
  });
});
