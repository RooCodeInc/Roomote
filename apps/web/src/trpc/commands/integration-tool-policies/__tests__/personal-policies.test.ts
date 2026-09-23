import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockPersonalFindFirst,
  mockDeploymentFindFirst,
  mockUpdate,
  mockSet,
  mockWhere,
  mockGetMcpIntegration,
} = vi.hoisted(() => ({
  mockPersonalFindFirst: vi.fn(),
  mockDeploymentFindFirst: vi.fn(),
  mockUpdate: vi.fn(),
  mockSet: vi.fn(),
  mockWhere: vi.fn(),
  mockGetMcpIntegration: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  and: vi.fn((...clauses: unknown[]) => clauses),
  customMcpServers: { id: 'custom.id', name: 'custom.name' },
  db: {
    query: {
      customMcpServers: { findFirst: vi.fn() },
      deploymentMcpEnablements: { findFirst: mockDeploymentFindFirst },
      personalMcpServers: { findFirst: mockPersonalFindFirst },
    },
    update: mockUpdate,
  },
  deploymentMcpEnablements: {
    disabledTools: 'deployment.disabledTools',
    mcpId: 'deployment.mcpId',
  },
  eq: vi.fn((column: unknown, value: unknown) => ({ column, value })),
  isDeploymentExperimentEnabled: vi.fn(async () => true),
  listIntegrationToolPolicies: vi.fn(async () => []),
  listIntegrationToolUserPolicies: vi.fn(async () => []),
  personalMcpServers: {
    disabledTools: 'personal.disabledTools',
    id: 'personal.id',
    name: 'personal.name',
    ownerUserId: 'personal.ownerUserId',
  },
  upsertIntegrationToolPolicy: vi.fn(),
  upsertIntegrationToolUserPolicy: vi.fn(),
}));

vi.mock('@roomote/types', () => ({
  getMcpIntegration: mockGetMcpIntegration,
}));

// The Auto mode commands in the same module resolve the decision model; keep
// that out of these personal-policy tests.
vi.mock('@roomote/cloud-agents/server/typesafe-judgment', () => ({
  resolveDecisionModel: vi.fn(async () => null),
}));

vi.mock('../../setup/shared', () => ({ assertAdmin: vi.fn() }));

import {
  isDeploymentExperimentEnabled,
  listIntegrationToolUserPolicies,
  upsertIntegrationToolPolicy,
  upsertIntegrationToolUserPolicy,
} from '@roomote/db/server';

import type { UserAuthSuccess } from '@/types';

import {
  listPersonalIntegrationToolPoliciesCommand,
  setPersonalIntegrationToolPolicyCommand,
} from '../index';

const auth = { userId: 'member-1' } as UserAuthSuccess;
const input = {
  integrationId: 'my-server',
  toolName: 'delete_page',
  mode: 'ask' as const,
};

describe('personal integration tool policy commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isDeploymentExperimentEnabled).mockResolvedValue(true);
    mockPersonalFindFirst.mockResolvedValue({
      id: 'personal-1',
      disabledTools: ['delete_page', 'other'],
    });
    mockDeploymentFindFirst.mockResolvedValue({
      mcpId: 'linear',
      disabledTools: [],
    });
    mockGetMcpIntegration.mockImplementation((integrationId: string) =>
      integrationId === 'linear' ? { id: integrationId } : undefined,
    );
    mockSet.mockReturnValue({ where: mockWhere });
    mockUpdate.mockReturnValue({ set: mockSet });
  });

  it("writes only the caller's own policy and never the deployment one", async () => {
    await setPersonalIntegrationToolPolicyCommand(auth, input);
    expect(upsertIntegrationToolUserPolicy).toHaveBeenCalledWith({
      ...input,
      userId: 'member-1',
    });
    expect(upsertIntegrationToolPolicy).not.toHaveBeenCalled();
    expect(listIntegrationToolUserPolicies).toHaveBeenCalledWith('member-1');
    expect(mockPersonalFindFirst).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith({
      disabledTools: ['other'],
      updatedAt: expect.any(Date),
    });
  });

  it('mirrors a deployment Disable policy into legacy availability state', async () => {
    const deploymentInput = {
      integrationId: 'linear',
      toolName: 'delete_issue',
      mode: 'reject' as const,
    };

    const { setIntegrationToolPolicyCommand } = await import('../index');
    await setIntegrationToolPolicyCommand(auth, deploymentInput);

    expect(mockDeploymentFindFirst).toHaveBeenCalled();
    expect(mockSet).toHaveBeenCalledWith({
      disabledTools: ['delete_issue'],
      updatedAt: expect.any(Date),
    });
  });

  it('needs no experiment: personal policies are always available', async () => {
    await listPersonalIntegrationToolPoliciesCommand(auth);
    await setPersonalIntegrationToolPolicyCommand(auth, input);
    expect(listIntegrationToolUserPolicies).toHaveBeenCalled();
    expect(upsertIntegrationToolUserPolicy).toHaveBeenCalled();
    expect(isDeploymentExperimentEnabled).not.toHaveBeenCalled();
  });
});
