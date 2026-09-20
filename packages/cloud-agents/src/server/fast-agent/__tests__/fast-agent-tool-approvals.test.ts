import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@roomote/db/server', () => ({
  cancelOpenIntegrationToolApprovals: vi.fn(async () => 0),
  expireIntegrationToolApproval: vi.fn(async () => undefined),
  fingerprintIntegrationToolCall: vi.fn(() => 'fingerprint'),
  getIntegrationToolApproval: vi.fn(),
  insertIntegrationToolApproval: vi.fn(),
  isDeploymentExperimentEnabled: vi.fn(async () => true),
  listIntegrationToolPolicies: vi.fn(async () => []),
  markIntegrationToolApprovalConsumed: vi.fn(async () => true),
}));

import {
  expireIntegrationToolApproval,
  getIntegrationToolApproval,
  insertIntegrationToolApproval,
  isDeploymentExperimentEnabled,
  markIntegrationToolApprovalConsumed,
} from '@roomote/db/server';

import {
  buildIntegrationToolApprovalRules,
  codeModeToolKey,
  createFastAgentToolApprovalBridge,
  extractApprovalCallArgs,
  hashIntegrationToolApprovalRules,
  integrationToolApprovalRulesToConfig,
  resolveFastAgentToolApprovalRules,
  shouldDisposeInstanceForToolApprovalRules,
} from '../fast-agent-tool-approvals';
import type { FastAgentIntegration } from '../fast-agent-integration-broker';

const integrations: FastAgentIntegration[] = [
  {
    id: 'mock-slack',
    name: 'Mock Slack',
    description: '',
    tools: [
      { name: 'read_channel', description: '', inputSchema: {} },
      { name: 'post_message', description: '', inputSchema: {} },
      { name: 'delete_channel', description: '', inputSchema: {} },
    ],
  } as unknown as FastAgentIntegration,
];

describe('buildIntegrationToolApprovalRules', () => {
  it('maps ask and reject policies to native ask and deny rules by code-mode tool key', () => {
    const rules = buildIntegrationToolApprovalRules(integrations, [
      {
        policyId: 'p1',
        integrationId: 'mock-slack',
        toolName: 'post_message',
        mode: 'ask',
        updatedAt: '',
        createdAt: '',
      },
      {
        policyId: 'p2',
        integrationId: 'mock-slack',
        toolName: 'delete_channel',
        mode: 'reject',
        updatedAt: '',
        createdAt: '',
      },
    ]);
    expect(rules).toEqual([
      { permission: 'mock-slack_post_message', pattern: '*', action: 'ask' },
      { permission: 'mock-slack_delete_channel', pattern: '*', action: 'deny' },
    ]);
  });

  it('leaves unconfigured tools without rules, preserving default allow', () => {
    expect(buildIntegrationToolApprovalRules(integrations, [])).toEqual([]);
  });

  it('never lets distinct integration/tool pairs share one policy entry', () => {
    // Regression: a delimiter-less composite key makes `a`/`bc` and `ab`/`c`
    // the same map entry, so one pair's mode would gate the other.
    const collidingIntegrations = [
      {
        id: 'a',
        name: 'A',
        description: '',
        tools: [{ name: 'bc', description: '', inputSchema: {} }],
      } as unknown as FastAgentIntegration,
      {
        id: 'ab',
        name: 'AB',
        description: '',
        tools: [{ name: 'c', description: '', inputSchema: {} }],
      } as unknown as FastAgentIntegration,
    ];
    const rules = buildIntegrationToolApprovalRules(collidingIntegrations, [
      {
        policyId: 'p1',
        integrationId: 'a',
        toolName: 'bc',
        mode: 'ask',
        updatedAt: '',
        createdAt: '',
      },
    ]);
    expect(rules).toEqual([
      { permission: 'a_bc', pattern: '*', action: 'ask' },
    ]);
  });

  it('never materializes rules for tools the actor is not authorized to mount', () => {
    const rules = buildIntegrationToolApprovalRules(integrations, [
      {
        policyId: 'p1',
        integrationId: 'mock-slack',
        toolName: 'tool_the_actor_cannot_see',
        mode: 'ask',
        updatedAt: '',
        createdAt: '',
      },
    ]);
    expect(rules).toEqual([]);
  });
});

describe('hashIntegrationToolApprovalRules', () => {
  it('is stable across rule order and changes with the rules', () => {
    const first = hashIntegrationToolApprovalRules([
      { permission: 'a', pattern: '*', action: 'ask' },
      { permission: 'b', pattern: '*', action: 'deny' },
    ]);
    const reordered = hashIntegrationToolApprovalRules([
      { permission: 'b', pattern: '*', action: 'deny' },
      { permission: 'a', pattern: '*', action: 'ask' },
    ]);
    const changed = hashIntegrationToolApprovalRules([
      { permission: 'a', pattern: '*', action: 'ask' },
    ]);
    expect(first).toBe(reordered);
    expect(first).not.toBe(changed);
  });
});

describe('resolveFastAgentToolApprovalRules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is inactive without code mode or without the experiment', async () => {
    expect(
      await resolveFastAgentToolApprovalRules({
        codeModeIntegrationsEffective: false,
        integrations,
      }),
    ).toBeUndefined();
    vi.mocked(isDeploymentExperimentEnabled).mockResolvedValueOnce(false);
    expect(
      await resolveFastAgentToolApprovalRules({
        codeModeIntegrationsEffective: true,
        integrations,
      }),
    ).toBeUndefined();
    expect(isDeploymentExperimentEnabled).toHaveBeenCalledWith(
      'integrationToolApprovals',
    );
  });
});

describe('integrationToolApprovalRulesToConfig', () => {
  it('compiles rules into OpenCode config-permission shape', () => {
    expect(
      integrationToolApprovalRulesToConfig([
        { permission: 'mock-slack_post_message', pattern: '*', action: 'ask' },
        {
          permission: 'mock-slack_delete_channel',
          pattern: '*',
          action: 'deny',
        },
      ]),
    ).toEqual({
      'mock-slack_post_message': 'ask',
      'mock-slack_delete_channel': 'deny',
    });
    expect(integrationToolApprovalRulesToConfig([])).toEqual({});
  });
});

describe('shouldDisposeInstanceForToolApprovalRules', () => {
  it('never disposes on an unknown record: after a restart the instance is fresh, not stale', () => {
    // Restart/legacy-equivalence cases: there is no live instance to
    // refresh, and disposing would be a false-positive cache break.
    expect(
      shouldDisposeInstanceForToolApprovalRules({
        recordedHash: undefined,
        currentHash: null,
      }),
    ).toBe(false);
    expect(
      shouldDisposeInstanceForToolApprovalRules({
        recordedHash: undefined,
        currentHash: 'hash-a',
      }),
    ).toBe(false);
  });

  it('disposes when the cached instance booted with different rules', () => {
    expect(
      shouldDisposeInstanceForToolApprovalRules({
        recordedHash: 'hash-a',
        currentHash: 'hash-b',
      }),
    ).toBe(true);
    // Experiment turned off: the recorded gated instance must be refreshed
    // back to the ungated config.
    expect(
      shouldDisposeInstanceForToolApprovalRules({
        recordedHash: 'hash-a',
        currentHash: null,
      }),
    ).toBe(true);
    expect(
      shouldDisposeInstanceForToolApprovalRules({
        recordedHash: null,
        currentHash: 'hash-a',
      }),
    ).toBe(true);
  });

  it('preserves the cached instance on unchanged effective policies, including ordering-equivalent rules', () => {
    expect(
      shouldDisposeInstanceForToolApprovalRules({
        recordedHash: 'hash-a',
        currentHash: 'hash-a',
      }),
    ).toBe(false);
    expect(
      shouldDisposeInstanceForToolApprovalRules({
        recordedHash: null,
        currentHash: null,
      }),
    ).toBe(false);
  });
});

describe('ordering-equivalent policies share one hash', () => {
  it('hashIntegrationToolApprovalRules is order-insensitive, so a reordered edit does not dispose the instance', () => {
    const first = hashIntegrationToolApprovalRules([
      { permission: 'b_tool', pattern: '*', action: 'deny' },
      { permission: 'a_tool', pattern: '*', action: 'ask' },
    ]);
    const reordered = hashIntegrationToolApprovalRules([
      { permission: 'a_tool', pattern: '*', action: 'ask' },
      { permission: 'b_tool', pattern: '*', action: 'deny' },
    ]);
    expect(first).toBe(reordered);
    expect(
      shouldDisposeInstanceForToolApprovalRules({
        recordedHash: first,
        currentHash: reordered,
      }),
    ).toBe(false);
  });
});

describe('extractApprovalCallArgs', () => {
  const tool = { integrationId: 'mock-slack', toolName: 'post_message' };

  it('returns a plain call input directly', () => {
    expect(extractApprovalCallArgs({ input: { channel: 'C1' } }, tool)).toEqual(
      { channel: 'C1' },
    );
  });

  it('prefers the gated child call arguments out of a code-mode execute part', () => {
    expect(
      extractApprovalCallArgs(
        {
          input: { code: 'return await tools.mock_slack.post_message({})' },
          toolCalls: [
            {
              tool: 'mock-slack.post_message',
              input: { channel: 'C1', text: 'hi' },
            },
          ],
        },
        tool,
      ),
    ).toEqual({ channel: 'C1', text: 'hi' });
  });

  it('falls back to the script when the child call is not tracked', () => {
    const code = { code: 'return 1' };
    expect(
      extractApprovalCallArgs({ input: code, toolCalls: [] }, tool),
    ).toEqual(code);
    expect(extractApprovalCallArgs(undefined, tool)).toBeUndefined();
  });
});

describe('tool approval bridge', () => {
  const ask = {
    requestId: 'req-1',
    sessionId: 'opencode-session',
    permission: codeModeToolKey('mock-slack', 'post_message'),
    messageId: 'message-1',
    callId: 'call-1',
  };

  function helpers() {
    return {
      fetchCallArgs: vi.fn(async () => ({
        input: { channel: 'C1', text: 'hi' },
      })),
      reply: vi.fn(async () => undefined),
    };
  }

  function bridge() {
    return createFastAgentToolApprovalBridge({
      sessionId: 'session-id',
      userId: 'user-id',
      integrations,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDeploymentExperimentEnabled).mockResolvedValue(true);
    vi.mocked(insertIntegrationToolApproval).mockResolvedValue({
      approvalId: 'approval-1',
      integrationId: 'mock-slack',
      toolName: 'post_message',
      argsSummary: { channel: 'C1', text: 'hi' },
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
  });

  it('ignores asks for tools outside the mounted catalog', () => {
    const helperMocks = helpers();
    bridge().handleAsk({ ...ask, permission: 'unknown_tool' }, helperMocks);
    expect(insertIntegrationToolApproval).not.toHaveBeenCalled();
  });

  it('records the ask with the paused call arguments and relays an approved decision once', async () => {
    vi.mocked(getIntegrationToolApproval).mockResolvedValue({
      status: 'approved',
    } as never);
    const helperMocks = helpers();
    bridge().handleAsk(ask, helperMocks);
    await vi.waitFor(() =>
      expect(helperMocks.reply).toHaveBeenCalledWith(
        'req-1',
        'once',
        undefined,
      ),
    );
    expect(insertIntegrationToolApproval).toHaveBeenCalledWith(
      { sessionId: 'session-id', userId: 'user-id' },
      expect.objectContaining({
        integrationId: 'mock-slack',
        toolName: 'post_message',
        nativeRequestId: 'req-1',
        argsSummary: { channel: 'C1', text: 'hi' },
      }),
    );
    expect(markIntegrationToolApprovalConsumed).toHaveBeenCalledWith({
      approvalId: 'approval-1',
      requesterUserId: 'user-id',
    });
  });

  it('rejects the native ask when the requester rejects', async () => {
    vi.mocked(getIntegrationToolApproval).mockResolvedValue({
      status: 'rejected',
    } as never);
    const helperMocks = helpers();
    bridge().handleAsk(ask, helperMocks);
    await vi.waitFor(() =>
      expect(helperMocks.reply).toHaveBeenCalledWith(
        'req-1',
        'reject',
        'The requester rejected this tool call.',
      ),
    );
    expect(markIntegrationToolApprovalConsumed).not.toHaveBeenCalled();
  });

  it('fails the native ask closed when the approved row was already claimed', async () => {
    vi.mocked(getIntegrationToolApproval).mockResolvedValue({
      status: 'approved',
    } as never);
    vi.mocked(markIntegrationToolApprovalConsumed).mockResolvedValue(false);
    const helperMocks = helpers();
    bridge().handleAsk(ask, helperMocks);
    await vi.waitFor(() =>
      expect(helperMocks.reply).toHaveBeenCalledWith(
        'req-1',
        'reject',
        'The approval for this tool call is no longer valid.',
      ),
    );
  });

  it('expires an unanswered approval and rejects the native ask', async () => {
    vi.mocked(insertIntegrationToolApproval).mockResolvedValue({
      approvalId: 'approval-1',
      integrationId: 'mock-slack',
      toolName: 'post_message',
      argsSummary: {},
      status: 'pending',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    vi.mocked(getIntegrationToolApproval).mockResolvedValue({
      status: 'pending',
    } as never);
    const helperMocks = helpers();
    bridge().handleAsk(ask, helperMocks);
    await vi.waitFor(() =>
      expect(helperMocks.reply).toHaveBeenCalledWith(
        'req-1',
        'reject',
        'The requester did not answer in time; the tool call was not run.',
      ),
    );
    expect(expireIntegrationToolApproval).toHaveBeenCalledWith('approval-1');
  });

  it('dedupes repeated events for the same native request', async () => {
    vi.mocked(getIntegrationToolApproval).mockResolvedValue({
      status: 'approved',
    } as never);
    const helperMocks = helpers();
    const instance = bridge();
    instance.handleAsk(ask, helperMocks);
    instance.handleAsk(ask, helperMocks);
    await vi.waitFor(() => expect(helperMocks.reply).toHaveBeenCalledTimes(1));
    expect(insertIntegrationToolApproval).toHaveBeenCalledTimes(1);
  });

  it('notifies chat surfaces once per approval', async () => {
    vi.mocked(getIntegrationToolApproval).mockResolvedValue({
      status: 'approved',
    } as never);
    const notify = vi.fn(async () => undefined);
    const helperMocks = helpers();
    createFastAgentToolApprovalBridge({
      sessionId: 'session-id',
      userId: 'user-id',
      integrations,
      notify,
    }).handleAsk(ask, helperMocks);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
  });
});
