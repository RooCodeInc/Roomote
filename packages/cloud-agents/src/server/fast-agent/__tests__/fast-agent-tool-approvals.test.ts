import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../integration-tool-auto-evaluation', () => ({
  describeIntegrationToolAutoDeny: vi.fn(
    (evaluation: { unavailable?: string }) =>
      evaluation.unavailable === 'no_model'
        ? 'no decision model is configured to check it'
        : evaluation.unavailable === 'error'
          ? 'the automatic check failed'
          : 'it was assessed as risky',
  ),
  resolveIntegrationToolAutoDecision: vi.fn(async () => ({
    action: 'run',
    mode: 'off',
  })),
  resolveIntegrationToolAutoState: vi.fn(async () => ({
    mode: 'off',
    settings: { mode: 'off', policy: '' },
    model: null,
  })),
}));

vi.mock('@roomote/db/server', () => ({
  cancelOpenIntegrationToolApprovals: vi.fn(async () => 0),
  db: {},
  getSessionForFastConversation: vi.fn(),
  expireIntegrationToolApproval: vi.fn(async () => undefined),
  fingerprintIntegrationToolCall: vi.fn(() => 'fingerprint'),
  getIntegrationToolApproval: vi.fn(),
  claimAutoApprovedIntegrationToolApproval: vi.fn(async () => true),
  insertAutoApprovedIntegrationToolApproval: vi.fn(async () => ({
    approvalId: 'auto-approval-1',
  })),
  insertAutoRejectedIntegrationToolApproval: vi.fn(async () => ({
    approvalId: 'auto-rejection-1',
  })),
  insertIntegrationToolApproval: vi.fn(),
  isDeploymentExperimentEnabled: vi.fn(async () => true),
  listIntegrationToolPolicies: vi.fn(async () => []),
  listIntegrationToolSessionOverrides: vi.fn(async () => []),
  listIntegrationToolUserPolicies: vi.fn(async () => []),
  markIntegrationToolApprovalConsumed: vi.fn(async () => true),
}));

import {
  claimAutoApprovedIntegrationToolApproval,
  expireIntegrationToolApproval,
  getIntegrationToolApproval,
  getSessionForFastConversation,
  insertAutoApprovedIntegrationToolApproval,
  insertAutoRejectedIntegrationToolApproval,
  insertIntegrationToolApproval,
  isDeploymentExperimentEnabled,
  listIntegrationToolPolicies,
  listIntegrationToolSessionOverrides,
  listIntegrationToolUserPolicies,
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
  resolveFastAgentToolApprovalSession,
  shouldDisposeInstanceForToolApprovalRules,
} from '../fast-agent-tool-approvals';
import {
  resolveIntegrationToolAutoDecision,
  resolveIntegrationToolAutoState,
} from '../../integration-tool-auto-evaluation';
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

  it('applies the most restrictive mode to an ambiguous flattened key while unaffected tools keep their policies', () => {
    // `a`/`b_c` and `a_b`/`c` both flatten to `a_b_c`: the shared key gets
    // the most restrictive mode among the colliding tools, so it can never
    // execute ungated, and unaffected tools are untouched.
    const ambiguous = [
      {
        id: 'a',
        name: 'A',
        description: '',
        tools: [
          { name: 'b_c', description: '', inputSchema: {} },
          { name: 'unrelated', description: '', inputSchema: {} },
        ],
      } as unknown as FastAgentIntegration,
      {
        id: 'a_b',
        name: 'AB',
        description: '',
        tools: [{ name: 'c', description: '', inputSchema: {} }],
      } as unknown as FastAgentIntegration,
    ];
    const rules = buildIntegrationToolApprovalRules(ambiguous, [
      {
        policyId: 'p1',
        integrationId: 'a',
        toolName: 'b_c',
        mode: 'ask',
        updatedAt: '',
        createdAt: '',
      },
      {
        policyId: 'p2',
        integrationId: 'a',
        toolName: 'unrelated',
        mode: 'ask',
        updatedAt: '',
        createdAt: '',
      },
    ]);
    expect(rules).toContainEqual({
      permission: 'a_b_c',
      pattern: '*',
      action: 'ask',
    });
    expect(rules.filter((rule) => rule.permission === 'a_b_c')).toHaveLength(1);
    expect(rules).toContainEqual({
      permission: 'a_unrelated',
      pattern: '*',
      action: 'ask',
    });
  });

  it('denies an ambiguous key even when one colliding tool is configured Always reject and the other is default', () => {
    const ambiguous = [
      {
        id: 'a',
        name: 'A',
        description: '',
        tools: [{ name: 'b_c', description: '', inputSchema: {} }],
      } as unknown as FastAgentIntegration,
      {
        id: 'a_b',
        name: 'AB',
        description: '',
        tools: [{ name: 'c', description: '', inputSchema: {} }],
      } as unknown as FastAgentIntegration,
    ];
    const rules = buildIntegrationToolApprovalRules(ambiguous, [
      {
        policyId: 'p1',
        integrationId: 'a_b',
        toolName: 'c',
        mode: 'reject',
        updatedAt: '',
        createdAt: '',
      },
    ]);
    expect(rules).toEqual([
      { permission: 'a_b_c', pattern: '*', action: 'deny' },
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

describe('buildIntegrationToolApprovalRules with mounted server names', () => {
  const mounted = (id: string, toolName: string) =>
    ({
      id,
      name: id,
      description: '',
      tools: [{ name: toolName, description: '', inputSchema: {} }],
    }) as unknown as FastAgentIntegration;
  const ask = (integrationId: string, toolName: string) => ({
    policyId: `${integrationId}/${toolName}`,
    integrationId,
    toolName,
    mode: 'ask' as const,
    updatedAt: '',
    createdAt: '',
  });

  it('keys a rule on the unique mount name when sanitized ids collide', () => {
    // `foo.bar` and `foo_bar` both sanitize to `foo_bar`; the second mounts
    // under a suffixed name, and its policy must follow it there.
    const rules = buildIntegrationToolApprovalRules(
      [mounted('foo.bar', 'read'), mounted('foo_bar', 'read')],
      [ask('foo_bar', 'read')],
    );
    expect(rules).toEqual([
      { permission: 'foo_bar__roomote_2_read', pattern: '*', action: 'ask' },
    ]);
  });

  it('applies the most restrictive mode when two tools flatten to one native key', () => {
    // `a`/`b_c` and `a_b`/`c` both flatten to `a_b_c`. The native rule cannot
    // tell them apart, so a gated tool must never run ungated through the
    // other one's default allow.
    const integrations = [mounted('a', 'b_c'), mounted('a_b', 'c')];
    expect(
      buildIntegrationToolApprovalRules(integrations, [ask('a_b', 'c')]),
    ).toEqual([{ permission: 'a_b_c', pattern: '*', action: 'ask' }]);
    expect(
      buildIntegrationToolApprovalRules(integrations, [
        ask('a', 'b_c'),
        { ...ask('a_b', 'c'), mode: 'reject' as const },
      ]),
    ).toEqual([{ permission: 'a_b_c', pattern: '*', action: 'deny' }]);
  });
});

describe('buildIntegrationToolApprovalRules with session overrides', () => {
  const policy = (toolName: string, mode: 'ask' | 'reject') => ({
    policyId: toolName,
    integrationId: 'mock-slack',
    toolName,
    mode,
    updatedAt: '',
    createdAt: '',
  });
  const override = (toolName: string, mode: 'allow' | 'ask') => ({
    integrationId: 'mock-slack',
    toolName,
    mode,
  });

  it('gates a default-allow tool the requester asked to be asked about', () => {
    expect(
      buildIntegrationToolApprovalRules(
        integrations,
        [],
        [override('read_channel', 'ask')],
      ),
    ).toEqual([
      {
        permission: codeModeToolKey('mock-slack', 'read_channel'),
        pattern: '*',
        action: 'ask',
      },
    ]);
  });

  it('keeps the native ask under a session allow so the rules never change', () => {
    const policies = [policy('post_message', 'ask')];
    const withOverride = buildIntegrationToolApprovalRules(
      integrations,
      policies,
      [override('post_message', 'allow')],
    );
    expect(withOverride).toEqual(
      buildIntegrationToolApprovalRules(integrations, policies),
    );
  });

  it('makes every default tool ask while Auto is on, and names them', () => {
    const autoToolKeys = new Set<string>();
    const rules = buildIntegrationToolApprovalRules(
      integrations,
      [policy('post_message', 'ask'), policy('delete_channel', 'reject')],
      [],
      { autoOn: true, autoToolKeys },
    );
    expect(rules).toEqual(
      expect.arrayContaining([
        {
          permission: codeModeToolKey('mock-slack', 'read_channel'),
          pattern: '*',
          action: 'ask',
        },
        {
          permission: codeModeToolKey('mock-slack', 'post_message'),
          pattern: '*',
          action: 'ask',
        },
        {
          permission: codeModeToolKey('mock-slack', 'delete_channel'),
          pattern: '*',
          action: 'deny',
        },
      ]),
    );
    // Only the default tool is Auto's; the manual ask and reject are not.
    expect([...autoToolKeys]).toEqual([
      JSON.stringify(['mock-slack', 'read_channel']),
    ]);
  });

  it('leaves a stored Always allow and a session allow out of Auto', () => {
    const autoToolKeys = new Set<string>();
    const rules = buildIntegrationToolApprovalRules(
      integrations,
      [{ ...policy('post_message', 'ask'), mode: 'always_allow' as const }],
      [
        {
          integrationId: 'mock-slack',
          toolName: 'read_channel',
          mode: 'allow',
        },
      ],
      { autoOn: true, autoToolKeys },
    );
    expect(rules.map((rule) => rule.permission)).toEqual([
      codeModeToolKey('mock-slack', 'delete_channel'),
    ]);
    expect(autoToolKeys.size).toBe(1);
  });

  it('never lets a session override loosen a deployment reject', () => {
    expect(
      buildIntegrationToolApprovalRules(
        integrations,
        [policy('delete_channel', 'reject')],
        [override('delete_channel', 'allow')],
      ),
    ).toEqual([
      {
        permission: codeModeToolKey('mock-slack', 'delete_channel'),
        pattern: '*',
        action: 'deny',
      },
    ]);
  });

  it('ignores overrides for tools the actor is not authorized to mount', () => {
    expect(
      buildIntegrationToolApprovalRules(
        integrations,
        [],
        [override('tool_the_actor_cannot_see', 'ask')],
      ),
    ).toEqual([]);
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

  it('layers the Session overrides on the deployment policies', async () => {
    vi.mocked(listIntegrationToolPolicies).mockResolvedValueOnce([]);
    vi.mocked(listIntegrationToolSessionOverrides).mockResolvedValueOnce([
      { integrationId: 'mock-slack', toolName: 'read_channel', mode: 'ask' },
    ]);
    const resolved = await resolveFastAgentToolApprovalRules({
      integrations,
      sessionId: 'session-id',
    });
    expect(listIntegrationToolSessionOverrides).toHaveBeenCalledWith(
      'session-id',
    );
    expect(resolved?.rules).toEqual([
      {
        permission: codeModeToolKey('mock-slack', 'read_channel'),
        pattern: '*',
        action: 'ask',
      },
    ]);
  });

  it('asks about every default tool once Auto mode is on', async () => {
    vi.mocked(resolveIntegrationToolAutoState).mockResolvedValueOnce({
      mode: 'on',
      settings: { mode: 'on', policy: '' },
      model: 'judgment',
    });
    vi.mocked(listIntegrationToolPolicies).mockResolvedValueOnce([]);
    vi.mocked(listIntegrationToolSessionOverrides).mockResolvedValueOnce([]);
    const resolved = await resolveFastAgentToolApprovalRules({
      integrations,
      sessionId: 'session-id',
    });
    expect(resolved?.rules).toHaveLength(3);
    expect(resolved?.autoToolKeys.size).toBe(3);
  });

  it("tightens with the requester's personal policies and never loosens a deployment one", async () => {
    const policy = (toolName: string, mode: 'allow' | 'ask' | 'reject') => ({
      policyId: `${toolName}-${mode}`,
      integrationId: 'mock-slack',
      toolName,
      mode,
      updatedAt: '',
      createdAt: '',
    });
    vi.mocked(listIntegrationToolPolicies).mockResolvedValueOnce([
      policy('delete_channel', 'reject'),
      policy('post_message', 'ask'),
    ]);
    vi.mocked(listIntegrationToolUserPolicies).mockResolvedValueOnce([
      policy('delete_channel', 'ask'),
      policy('post_message', 'reject'),
      policy('read_channel', 'ask'),
    ]);
    const resolved = await resolveFastAgentToolApprovalRules({
      integrations,
      sessionId: 'session-id',
      ownerUserId: 'owner-id',
    });
    // The owner is the only one who can decide, so theirs are the personal
    // policies that apply, whoever sent the turn.
    expect(listIntegrationToolUserPolicies).toHaveBeenCalledWith('owner-id');
    expect(
      Object.fromEntries(
        resolved!.rules.map((rule) => [rule.permission, rule.action]),
      ),
    ).toEqual({
      [codeModeToolKey('mock-slack', 'delete_channel')]: 'deny',
      [codeModeToolKey('mock-slack', 'post_message')]: 'deny',
      [codeModeToolKey('mock-slack', 'read_channel')]: 'ask',
    });
  });

  it('governs a custom server by its own policy layer only, since names can coincide', async () => {
    const policy = (toolName: string) => ({
      policyId: toolName,
      integrationId: 'mock-slack',
      toolName,
      mode: 'reject' as const,
      updatedAt: '',
      createdAt: '',
    });
    vi.mocked(listIntegrationToolPolicies).mockResolvedValueOnce([
      policy('read_channel'),
    ]);
    vi.mocked(listIntegrationToolUserPolicies).mockResolvedValueOnce([
      policy('post_message'),
    ]);
    const resolved = await resolveFastAgentToolApprovalRules({
      integrations: [
        { ...integrations[0]!, toolApprovalPolicyScope: 'personal' },
      ],
      ownerUserId: 'owner-id',
    });
    // A shared server of the same name has the deployment policy; this
    // personal one must only see its owner's.
    expect(resolved?.rules.map((rule) => rule.permission)).toEqual([
      codeModeToolKey('mock-slack', 'post_message'),
    ]);
  });

  it('reads no personal policies without a Session owner', async () => {
    await resolveFastAgentToolApprovalRules({ integrations });
    expect(listIntegrationToolUserPolicies).not.toHaveBeenCalled();
  });

  it('is inactive without the experiment', async () => {
    vi.mocked(isDeploymentExperimentEnabled).mockResolvedValueOnce(false);
    expect(
      await resolveFastAgentToolApprovalRules({ integrations }),
    ).toBeUndefined();
    expect(isDeploymentExperimentEnabled).toHaveBeenCalledWith(
      'integrationToolApprovals',
    );
  });

  it('applies the most restrictive mode to a colliding flattened key so it never runs ungated', async () => {
    // `a`/`b_c` and `a_b`/`c` both flatten to `a_b_c`. With an `ask` policy
    // on one of them, the shared key asks (never silently executes); with a
    // `reject` policy, it denies. The bridge resolves which tool actually
    // runs from the paused call's child record and fails closed when it
    // cannot (covered below).
    const ambiguous = [
      {
        id: 'a',
        name: 'A',
        description: '',
        tools: [{ name: 'b_c', description: '', inputSchema: {} }],
      } as unknown as FastAgentIntegration,
      {
        id: 'a_b',
        name: 'AB',
        description: '',
        tools: [{ name: 'c', description: '', inputSchema: {} }],
      } as unknown as FastAgentIntegration,
    ];
    vi.mocked(listIntegrationToolPolicies).mockResolvedValueOnce([
      {
        policyId: 'p1',
        integrationId: 'a',
        toolName: 'b_c',
        mode: 'ask',
        updatedAt: '',
        createdAt: '',
      },
    ]);
    const resolved = await resolveFastAgentToolApprovalRules({
      integrations: ambiguous,
    });
    expect(resolved?.rules).toEqual([
      { permission: 'a_b_c', pattern: '*', action: 'ask' },
    ]);

    vi.mocked(listIntegrationToolPolicies).mockResolvedValueOnce([
      {
        policyId: 'p2',
        integrationId: 'a_b',
        toolName: 'c',
        mode: 'reject',
        updatedAt: '',
        createdAt: '',
      },
    ]);
    const rejected = await resolveFastAgentToolApprovalRules({
      integrations: ambiguous,
    });
    expect(rejected?.rules).toEqual([
      { permission: 'a_b_c', pattern: '*', action: 'deny' },
    ]);
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
  const tool = { serverName: 'mock-slack', toolName: 'post_message' };

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

  it('shows the paused call, not an earlier call to the same tool in one script', () => {
    expect(
      extractApprovalCallArgs(
        {
          input: { code: 'two calls' },
          toolCalls: [
            { tool: 'mock-slack.post_message', input: { channel: 'first' } },
            { tool: 'mock-slack.read_channel', input: { channel: 'other' } },
            { tool: 'mock-slack.post_message', input: { channel: 'second' } },
          ],
        },
        tool,
      ),
    ).toEqual({ channel: 'second' });
  });
});

describe('resolveFastAgentToolApprovalSession', () => {
  it('records approvals under the unified Session bound to the Fast conversation', async () => {
    vi.mocked(getSessionForFastConversation).mockResolvedValueOnce({
      id: 'unified-session',
      ownerUserId: 'owner-1',
    } as never);
    // A participant sent the turn; the owner is still the one who decides.
    expect(
      await resolveFastAgentToolApprovalSession('conversation', 'participant'),
    ).toEqual({
      sessionId: 'unified-session',
      ownerUserId: 'owner-1',
      deciderUserId: 'owner-1',
    });
    expect(getSessionForFastConversation).toHaveBeenCalledWith(
      expect.anything(),
      'conversation',
    );
  });

  it('falls back to the conversation id so an unbound ask fails closed', async () => {
    vi.mocked(getSessionForFastConversation).mockResolvedValueOnce(null);
    expect(
      await resolveFastAgentToolApprovalSession('conversation', 'acting-user'),
    ).toEqual({
      sessionId: 'conversation',
      ownerUserId: undefined,
      deciderUserId: 'acting-user',
    });
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
      reply: vi.fn(
        async (
          _requestId: string,
          _response: 'once' | 'reject',
          _message?: string,
        ) => undefined,
      ),
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
    vi.mocked(listIntegrationToolSessionOverrides).mockResolvedValue([]);
    vi.mocked(insertIntegrationToolApproval).mockResolvedValue({
      approvalId: 'approval-1',
      integrationId: 'mock-slack',
      toolName: 'post_message',
      argsSummary: { channel: 'C1', text: 'hi' },
      status: 'pending',
      taskId: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
  });

  it('runs a default tool Auto finds routine, and denies one it finds risky', async () => {
    const evaluation = {
      recommendation: 'approve' as const,
      answers: {},
      evaluatedAt: '',
    };
    vi.mocked(resolveIntegrationToolAutoDecision).mockResolvedValue({
      action: 'approve',
      mode: 'on',
      evaluation,
    });
    const autoBridge = () =>
      createFastAgentToolApprovalBridge({
        sessionId: 'session-id',
        userId: 'user-id',
        integrations,
        autoToolKeys: new Set([JSON.stringify(['mock-slack', 'post_message'])]),
        userRequest: 'Tell the team we shipped.',
      });

    // Routine: the reservation-and-claim path, the model's view on the
    // audit row, no decider, no card.
    const on = helpers();
    autoBridge().handleAsk(ask, on);
    await vi.waitFor(() =>
      expect(on.reply).toHaveBeenCalledWith('req-1', 'once'),
    );
    expect(resolveIntegrationToolAutoDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 'mock-slack',
        toolName: 'post_message',
        args: { channel: 'C1', text: 'hi' },
        userRequest: 'Tell the team we shipped.',
      }),
    );
    expect(insertIntegrationToolApproval).not.toHaveBeenCalled();
    expect(insertAutoApprovedIntegrationToolApproval).toHaveBeenCalledWith(
      { sessionId: 'session-id', userId: 'user-id' },
      expect.objectContaining({
        nativeRequestId: 'req-1',
        decidedBy: 'model',
        autoEvaluation: evaluation,
      }),
    );

    // Risky: no card, a terminal auto_rejected audit row, and a tool error
    // to the model naming Auto mode and the reason.
    const riskyEvaluation = { ...evaluation, recommendation: 'deny' as const };
    vi.mocked(resolveIntegrationToolAutoDecision).mockResolvedValue({
      action: 'deny',
      mode: 'on',
      evaluation: riskyEvaluation,
    });
    const unsure = helpers();
    autoBridge().handleAsk({ ...ask, requestId: 'req-2' }, unsure);
    await vi.waitFor(() =>
      expect(unsure.reply).toHaveBeenCalledWith(
        'req-2',
        'reject',
        expect.stringContaining('Auto mode blocked this tool call'),
      ),
    );
    expect(unsure.reply.mock.calls[0]![2]).toContain('assessed as risky');
    expect(insertIntegrationToolApproval).not.toHaveBeenCalled();
    expect(insertAutoRejectedIntegrationToolApproval).toHaveBeenCalledWith(
      { sessionId: 'session-id', userId: 'user-id' },
      expect.objectContaining({
        nativeRequestId: 'req-2',
        autoEvaluation: riskyEvaluation,
      }),
    );

    // Auto failing outright fails closed to the same denial.
    vi.mocked(resolveIntegrationToolAutoDecision).mockRejectedValue(
      new Error('settings unavailable'),
    );
    const failing = helpers();
    autoBridge().handleAsk({ ...ask, requestId: 'req-3' }, failing);
    await vi.waitFor(() =>
      expect(failing.reply).toHaveBeenCalledWith(
        'req-3',
        'reject',
        expect.stringContaining('Auto mode blocked this tool call'),
      ),
    );
    expect(insertIntegrationToolApproval).not.toHaveBeenCalled();
    expect(insertAutoRejectedIntegrationToolApproval).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        nativeRequestId: 'req-3',
        autoEvaluation: expect.objectContaining({
          recommendation: 'deny',
          unavailable: 'error',
        }),
      }),
    );

    // A manual Ask first tool (not in the Auto set) never reaches the model.
    vi.mocked(resolveIntegrationToolAutoDecision).mockClear();
    const manual = helpers();
    bridge().handleAsk({ ...ask, requestId: 'req-4' }, manual);
    await vi.waitFor(() => expect(manual.reply).toHaveBeenCalled());
    expect(resolveIntegrationToolAutoDecision).not.toHaveBeenCalled();
  });

  it('never consults Auto for a tool the requester asked to decide themselves', async () => {
    vi.mocked(listIntegrationToolSessionOverrides).mockResolvedValue([
      { integrationId: 'mock-slack', toolName: 'post_message', mode: 'ask' },
    ]);
    vi.mocked(getIntegrationToolApproval).mockResolvedValue({
      status: 'rejected',
    } as never);
    const helperMocks = helpers();
    createFastAgentToolApprovalBridge({
      sessionId: 'session-id',
      userId: 'user-id',
      integrations,
      autoToolKeys: new Set([JSON.stringify(['mock-slack', 'post_message'])]),
    }).handleAsk(ask, helperMocks);
    await vi.waitFor(() => expect(helperMocks.reply).toHaveBeenCalled());
    expect(resolveIntegrationToolAutoDecision).not.toHaveBeenCalled();
    expect(insertIntegrationToolApproval).toHaveBeenCalled();
  });

  it('relays an ask once without a card when the requester allowed the tool for the session', async () => {
    vi.mocked(listIntegrationToolSessionOverrides).mockResolvedValue([
      { integrationId: 'mock-slack', toolName: 'post_message', mode: 'allow' },
    ]);
    const helperMocks = helpers();
    bridge().handleAsk(ask, helperMocks);
    await vi.waitFor(() => expect(helperMocks.reply).toHaveBeenCalled());

    expect(listIntegrationToolSessionOverrides).toHaveBeenCalledWith(
      'session-id',
    );
    expect(insertAutoApprovedIntegrationToolApproval).toHaveBeenCalledWith(
      { sessionId: 'session-id', userId: 'user-id' },
      expect.objectContaining({
        integrationId: 'mock-slack',
        toolName: 'post_message',
        nativeRequestId: 'req-1',
        argsSummary: { channel: 'C1', text: 'hi' },
      }),
    );
    expect(helperMocks.reply).toHaveBeenCalledTimes(1);
    expect(helperMocks.reply).toHaveBeenCalledWith('req-1', 'once');
    expect(insertIntegrationToolApproval).not.toHaveBeenCalled();
  });

  it('rejects instead of auto-allowing when the disable sweep wins the reservation claim', async () => {
    // The reservation is written as an unrelayed `approved` decision; the
    // disable sweep cancels those, so a lost claim means the call rejects
    // and no terminal auto_approved record exists for it.
    vi.mocked(listIntegrationToolSessionOverrides).mockResolvedValue([
      { integrationId: 'mock-slack', toolName: 'post_message', mode: 'allow' },
    ]);
    vi.mocked(claimAutoApprovedIntegrationToolApproval).mockResolvedValue(
      false,
    );
    const helperMocks = helpers();
    bridge().handleAsk(ask, helperMocks);
    await vi.waitFor(() =>
      expect(helperMocks.reply).toHaveBeenCalledWith(
        'req-1',
        'reject',
        'Tool approvals were disabled; the call was not run.',
      ),
    );
    expect(claimAutoApprovedIntegrationToolApproval).toHaveBeenCalledWith({
      approvalId: 'auto-approval-1',
      requesterUserId: 'user-id',
    });
    expect(helperMocks.reply).not.toHaveBeenCalledWith('req-1', 'once');
    expect(insertIntegrationToolApproval).not.toHaveBeenCalled();
  });

  it('still asks when the session override is for a different tool or mode', async () => {
    vi.mocked(listIntegrationToolSessionOverrides).mockResolvedValue([
      { integrationId: 'mock-slack', toolName: 'read_channel', mode: 'allow' },
      { integrationId: 'mock-slack', toolName: 'post_message', mode: 'ask' },
    ]);
    vi.mocked(getIntegrationToolApproval).mockResolvedValue({
      status: 'rejected',
    } as never);
    const helperMocks = helpers();
    bridge().handleAsk(ask, helperMocks);
    await vi.waitFor(() => expect(helperMocks.reply).toHaveBeenCalled());

    expect(insertIntegrationToolApproval).toHaveBeenCalled();
    expect(insertAutoApprovedIntegrationToolApproval).not.toHaveBeenCalled();
    expect(helperMocks.reply).toHaveBeenCalledWith(
      'req-1',
      'reject',
      expect.any(String),
    );
  });

  it('rejects instead of running unrecorded when the auto-approval audit write fails', async () => {
    vi.mocked(listIntegrationToolSessionOverrides).mockResolvedValue([
      { integrationId: 'mock-slack', toolName: 'post_message', mode: 'allow' },
    ]);
    vi.mocked(insertAutoApprovedIntegrationToolApproval).mockRejectedValueOnce(
      new Error('write failed'),
    );
    const helperMocks = helpers();
    bridge().handleAsk(ask, helperMocks);
    await vi.waitFor(() => expect(helperMocks.reply).toHaveBeenCalled());

    expect(helperMocks.reply).toHaveBeenCalledTimes(1);
    expect(helperMocks.reply).toHaveBeenCalledWith(
      'req-1',
      'reject',
      expect.any(String),
    );
  });

  it('rejects the ask when an approved once cannot be delivered, instead of leaving the session paused', async () => {
    vi.mocked(getIntegrationToolApproval).mockResolvedValue({
      status: 'approved',
    } as never);
    const helperMocks = helpers();
    helperMocks.reply.mockRejectedValueOnce(new Error('unresponsive'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      bridge().handleAsk(ask, helperMocks);
      await vi.waitFor(() =>
        expect(helperMocks.reply).toHaveBeenCalledTimes(2),
      );
    } finally {
      warn.mockRestore();
    }
    expect(helperMocks.reply).toHaveBeenNthCalledWith(
      1,
      'req-1',
      'once',
      undefined,
    );
    expect(helperMocks.reply).toHaveBeenNthCalledWith(
      2,
      'req-1',
      'reject',
      expect.any(String),
    );
  });

  it('fails closed without a card for tools outside the mounted catalog', async () => {
    const helperMocks = helpers();
    bridge().handleAsk({ ...ask, permission: 'unknown_tool' }, helperMocks);
    await vi.waitFor(() =>
      expect(helperMocks.reply).toHaveBeenCalledWith(
        'req-1',
        'reject',
        'The approval identity of this tool call is ambiguous; the call was not run.',
      ),
    );
    expect(insertIntegrationToolApproval).not.toHaveBeenCalled();
  });

  it('rejects an approved decision without executing when the experiment is disabled before the relay', async () => {
    vi.mocked(getIntegrationToolApproval).mockResolvedValue({
      status: 'approved',
    } as never);
    vi.mocked(isDeploymentExperimentEnabled)
      .mockResolvedValueOnce(true) // top-of-loop check
      .mockResolvedValue(false); // approved-branch re-check and beyond
    const helperMocks = helpers();
    bridge().handleAsk(ask, helperMocks);
    await vi.waitFor(() =>
      expect(helperMocks.reply).toHaveBeenCalledWith(
        'req-1',
        'reject',
        'Tool approvals were disabled; the call was not run.',
      ),
    );
    expect(markIntegrationToolApprovalConsumed).not.toHaveBeenCalled();
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
      taskId: null,
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      createdAt: new Date().toISOString(),
    });
    vi.mocked(getIntegrationToolApproval).mockResolvedValue({
      status: 'pending',
      taskId: null,
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

  it('resolves a colliding flattened key from the paused call child record instead of the first pair', async () => {
    const colliding = [
      {
        id: 'a',
        name: 'A',
        description: '',
        tools: [{ name: 'b_c', description: '', inputSchema: {} }],
      } as unknown as FastAgentIntegration,
      {
        id: 'a_b',
        name: 'AB',
        description: '',
        tools: [{ name: 'c', description: '', inputSchema: {} }],
      } as unknown as FastAgentIntegration,
    ];
    vi.mocked(getIntegrationToolApproval).mockResolvedValue({
      status: 'approved',
    } as never);
    vi.mocked(markIntegrationToolApprovalConsumed).mockResolvedValue(true);
    const helperMocks = {
      fetchCallArgs: vi.fn(async () => ({
        input: { code: 'return await tools.a_b.c({ x: 1 })' },
        toolCalls: [{ tool: 'a_b.c', input: { x: 1 } }],
      })),
      reply: vi.fn(async () => undefined),
    };
    createFastAgentToolApprovalBridge({
      sessionId: 'session-id',
      userId: 'user-id',
      integrations: colliding,
    }).handleAsk({ ...ask, permission: 'a_b_c' }, helperMocks as never);
    await vi.waitFor(() =>
      expect(helperMocks.reply).toHaveBeenCalledWith(
        'req-1',
        'once',
        undefined,
      ),
    );
    // The card and audit record the tool that actually executes (a_b/c with
    // its own arguments), never the first colliding pair.
    expect(insertIntegrationToolApproval).toHaveBeenCalledWith(
      { sessionId: 'session-id', userId: 'user-id' },
      expect.objectContaining({
        integrationId: 'a_b',
        toolName: 'c',
        argsSummary: { x: 1 },
      }),
    );
  });

  it('fails closed without a card when a colliding flattened key cannot be resolved from the child record', async () => {
    const colliding = [
      {
        id: 'a',
        name: 'A',
        description: '',
        tools: [{ name: 'b_c', description: '', inputSchema: {} }],
      } as unknown as FastAgentIntegration,
      {
        id: 'a_b',
        name: 'AB',
        description: '',
        tools: [{ name: 'c', description: '', inputSchema: {} }],
      } as unknown as FastAgentIntegration,
    ];
    const helperMocks = {
      fetchCallArgs: vi.fn(async () => undefined),
      reply: vi.fn(async () => undefined),
    };
    createFastAgentToolApprovalBridge({
      sessionId: 'session-id',
      userId: 'user-id',
      integrations: colliding,
    }).handleAsk({ ...ask, permission: 'a_b_c' }, helperMocks as never);
    await vi.waitFor(() =>
      expect(helperMocks.reply).toHaveBeenCalledWith(
        'req-1',
        'reject',
        'The approval identity of this tool call is ambiguous; the call was not run.',
      ),
    );
    expect(insertIntegrationToolApproval).not.toHaveBeenCalled();
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
