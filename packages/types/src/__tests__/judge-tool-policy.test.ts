import {
  buildSubagentMcpToolFilter,
  EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY,
  isSubagentToolCallAllowed,
  isSubagentToolVisible,
} from '../subagent-tool-policy';

describe('evidence-review subagent tool policy', () => {
  it('allows existing evidence reads and rejects mixed-tool writes', () => {
    expect(
      isSubagentToolCallAllowed(EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY, {
        integrationId: '_roomote_http_integrations',
        toolName: 'integration_request',
        args: { method: 'GET', integrationId: 'session:approved' },
      }),
    ).toBe(true);
    expect(
      isSubagentToolCallAllowed(EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY, {
        integrationId: '_roomote_http_integrations',
        toolName: 'integration_request',
        args: { method: 'POST' },
      }),
    ).toBe(false);
    expect(
      isSubagentToolVisible(EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY, {
        integrationId: '_roomote_http_integrations',
        toolName: 'prepare_session_secret',
      }),
    ).toBe(false);
    expect(
      isSubagentToolCallAllowed(EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY, {
        integrationId: 'roomote',
        toolName: 'manage_tasks',
        args: { action: 'get_summary' },
      }),
    ).toBe(true);
    expect(
      isSubagentToolCallAllowed(EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY, {
        integrationId: 'roomote',
        toolName: 'manage_tasks',
        args: { action: 'start' },
      }),
    ).toBe(false);
    expect(
      isSubagentToolCallAllowed(EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY, {
        integrationId: 'roomote',
        toolName: 'manage_source_control',
        args: { action: 'get_pull_request' },
      }),
    ).toBe(true);
    expect(
      isSubagentToolCallAllowed(EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY, {
        integrationId: 'roomote',
        toolName: 'manage_source_control',
        args: { action: 'create_pull_request_comment' },
      }),
    ).toBe(false);
  });

  it('requires read-only metadata for third-party tools', () => {
    expect(
      isSubagentToolVisible(EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY, {
        integrationId: 'github',
        toolName: 'get_file_contents',
        annotations: { readOnlyHint: true },
      }),
    ).toBe(true);
    expect(
      isSubagentToolVisible(EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY, {
        integrationId: 'github',
        toolName: 'create_issue_comment',
        annotations: { readOnlyHint: false },
      }),
    ).toBe(false);
    expect(
      isSubagentToolVisible(EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY, {
        integrationId: 'custom',
        toolName: 'unannotated',
      }),
    ).toBe(false);
  });

  it('builds fail-closed direct MCP filters with explicit evidence tools', () => {
    const roomote = buildSubagentMcpToolFilter(
      EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY,
      'roomote',
    );
    expect(roomote).toMatchObject({
      'roomote_*': false,
      roomote_get_chat_channel_messages: true,
      roomote_get_chat_message_context: true,
      roomote_list_chat_channels: true,
      roomote_manage_tasks: true,
      roomote_manage_source_control: true,
    });
    expect(roomote).not.toHaveProperty('roomote_show_widget');
    expect(
      buildSubagentMcpToolFilter(
        EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY,
        'custom-tools',
      ),
    ).toEqual({
      'custom-tools_*': false,
    });
    expect(
      buildSubagentMcpToolFilter(
        EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY,
        'gbrain',
      ),
    ).toEqual({});
    expect(
      buildSubagentMcpToolFilter(
        EVIDENCE_REVIEW_SUBAGENT_TOOL_POLICY,
        'supermemory',
      ),
    ).toEqual({
      'supermemory_*': false,
    });
  });
});
