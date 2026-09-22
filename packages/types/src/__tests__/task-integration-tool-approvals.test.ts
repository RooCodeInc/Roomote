import { compileTaskIntegrationToolApprovals } from '../integration-tool-approvals';

const policy = (
  integrationId: string,
  toolName: string,
  mode: 'always_allow' | 'ask' | 'reject',
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
      autoServers: [],
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

  it('gates every default tool of a mounted server while Auto is on', () => {
    expect(
      compileTaskIntegrationToolApprovals({
        serverNames: ['linear', 'my-server'],
        policies: [
          policy('linear', 'delete_issue', 'reject'),
          policy('linear', 'get_issue', 'always_allow'),
          policy('linear', 'save_issue', 'ask'),
        ],
        sessionOverrides: [
          { integrationId: 'linear', toolName: 'list_issues', mode: 'allow' },
        ],
        autoOn: true,
      }),
    ).toMatchObject({
      permission: {
        'linear_*': 'ask',
        'my-server_*': 'ask',
        linear_delete_issue: 'deny',
        linear_get_issue: 'allow',
        linear_save_issue: 'ask',
        linear_list_issues: 'allow',
      },
      autoServers: ['linear', 'my-server'],
    });
  });

  it('denies a native key two different tools flatten to', () => {
    const compiled = compileTaskIntegrationToolApprovals({
      serverNames: ['a', 'a_b'],
      policies: [policy('a', 'b_c', 'ask'), policy('a_b', 'c', 'ask')],
      sessionOverrides: [],
    });
    expect(compiled).toEqual({
      permission: { a_b_c: 'deny' },
      tools: {},
      autoServers: [],
    });
  });
});
