import { compileTaskIntegrationToolApprovals } from '../integration-tool-approvals';

const policy = (
  integrationId: string,
  toolName: string,
  mode: 'auto' | 'ask' | 'reject',
) => ({ integrationId, toolName, mode });

describe('compileTaskIntegrationToolApprovals', () => {
  it('emits ask and deny rules for the mounted servers only', () => {
    expect(
      compileTaskIntegrationToolApprovals({
        serverNames: ['linear', 'my-server'],
        policies: [
          policy('linear', 'save_issue', 'ask'),
          policy('linear', 'delete_issue', 'reject'),
          policy('my-server', 'run.query', 'ask'),
          policy('not-mounted', 'anything', 'ask'),
        ],
        sessionOverrides: [],
      }),
    ).toEqual({
      permission: {
        linear_save_issue: 'ask',
        linear_delete_issue: 'deny',
        // OpenCode sanitizes each half of the native tool name.
        'my-server_run_query': 'ask',
      },
      tools: {
        linear_save_issue: { integrationId: 'linear', toolName: 'save_issue' },
        linear_delete_issue: {
          integrationId: 'linear',
          toolName: 'delete_issue',
        },
        'my-server_run_query': {
          integrationId: 'my-server',
          toolName: 'run.query',
        },
      },
    });
  });

  it("layers the task's session overrides like a Session does", () => {
    const { permission } = compileTaskIntegrationToolApprovals({
      serverNames: ['linear'],
      policies: [
        policy('linear', 'save_issue', 'ask'),
        policy('linear', 'delete_issue', 'reject'),
      ],
      sessionOverrides: [
        // Still asks natively; the ask is then answered without a card.
        { integrationId: 'linear', toolName: 'save_issue', mode: 'allow' },
        { integrationId: 'linear', toolName: 'list_issues', mode: 'ask' },
        { integrationId: 'linear', toolName: 'delete_issue', mode: 'allow' },
        { integrationId: 'linear', toolName: 'get_issue', mode: 'allow' },
      ],
    });
    expect(permission).toEqual({
      linear_save_issue: 'ask',
      linear_list_issues: 'ask',
      linear_delete_issue: 'deny',
    });
  });

  it('holds an auto tool exactly like an ask tool', () => {
    const { permission } = compileTaskIntegrationToolApprovals({
      serverNames: ['linear'],
      policies: [
        policy('linear', 'save_issue', 'auto'),
        policy('linear', 'list_issues', 'auto'),
      ],
      sessionOverrides: [
        { integrationId: 'linear', toolName: 'list_issues', mode: 'allow' },
      ],
    });
    expect(permission).toEqual({
      linear_save_issue: 'ask',
      linear_list_issues: 'ask',
    });
  });

  it('denies a native key two different tools flatten to', () => {
    const compiled = compileTaskIntegrationToolApprovals({
      serverNames: ['a', 'a_b'],
      policies: [policy('a', 'b_c', 'ask'), policy('a_b', 'c', 'ask')],
      sessionOverrides: [],
    });
    expect(compiled).toEqual({ permission: { a_b_c: 'deny' }, tools: {} });
  });

  it('never emits rules for Roomote-internal MCP servers', () => {
    expect(
      compileTaskIntegrationToolApprovals({
        serverNames: ['roomote', 'linear'],
        policies: [
          policy('roomote', 'manage_tasks', 'reject'),
          policy('linear', 'save_issue', 'ask'),
        ],
        sessionOverrides: [
          { integrationId: 'roomote', toolName: 'manage_tasks', mode: 'ask' },
        ],
      }),
    ).toEqual({
      permission: { linear_save_issue: 'ask' },
      tools: {
        linear_save_issue: { integrationId: 'linear', toolName: 'save_issue' },
      },
    });
  });

  it('drops a rule whose native key an internal tool could also flatten to', () => {
    // A custom `roomote_manage` server's `tasks` tool flattens to
    // `roomote_manage_tasks`, the same native key as `roomote` /
    // `manage_tasks`. Gating it would also hold the exempt internal tool,
    // so any key the internal server's tools could flatten to is left
    // ungated natively; unrelated servers still gate normally.
    expect(
      compileTaskIntegrationToolApprovals({
        serverNames: ['roomote', 'roomote_manage', 'linear'],
        policies: [
          policy('roomote_manage', 'tasks', 'ask'),
          policy('roomote_manage', 'status', 'reject'),
          policy('linear', 'save_issue', 'ask'),
        ],
        sessionOverrides: [],
      }),
    ).toEqual({
      permission: { linear_save_issue: 'ask' },
      tools: {
        linear_save_issue: { integrationId: 'linear', toolName: 'save_issue' },
      },
    });
  });
});
