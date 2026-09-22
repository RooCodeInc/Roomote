import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@roomote/db/server', () => ({
  isDeploymentExperimentEnabled: vi.fn(async () => true),
  listIntegrationToolPolicies: vi.fn(async () => []),
  listIntegrationToolUserPolicies: vi.fn(async () => []),
  upsertIntegrationToolPolicy: vi.fn(),
  upsertIntegrationToolUserPolicy: vi.fn(),
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
  });

  it("writes only the caller's own policy and never the deployment one", async () => {
    await setPersonalIntegrationToolPolicyCommand(auth, input);
    expect(upsertIntegrationToolUserPolicy).toHaveBeenCalledWith({
      ...input,
      userId: 'member-1',
    });
    expect(upsertIntegrationToolPolicy).not.toHaveBeenCalled();
    expect(listIntegrationToolUserPolicies).toHaveBeenCalledWith('member-1');
  });

  it('is inert while the experiment is off', async () => {
    vi.mocked(isDeploymentExperimentEnabled).mockResolvedValue(false);
    expect(await listPersonalIntegrationToolPoliciesCommand(auth)).toEqual([]);
    await expect(
      setPersonalIntegrationToolPolicyCommand(auth, input),
    ).rejects.toThrow('not enabled');
    expect(listIntegrationToolUserPolicies).not.toHaveBeenCalled();
    expect(upsertIntegrationToolUserPolicy).not.toHaveBeenCalled();
  });
});
