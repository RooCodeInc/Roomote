import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { usageBatchV1Schema } from '../usage-ledger';

const payload = () => ({
  schemaVersion: 1,
  events: [
    {
      kind: 'inference',
      schemaVersion: 1,
      usageId: randomUUID(),
      provider: 'openrouter',
      usageType: 'inference',
      outcome: 'succeeded',
      completedAt: new Date().toISOString(),
      credentialOwner: 'roomote',
    },
  ],
});

describe('central usage ledger contract', () => {
  it('serializes only the privacy-safe allowlist', () => {
    expect(usageBatchV1Schema.safeParse(payload()).success).toBe(true);
  });

  it.each([
    'deploymentId',
    'workspaceId',
    'organizationId',
    'accountId',
    'userId',
    'sessionId',
    'taskId',
    'runId',
    'repositoryId',
    'requestId',
    'prompt',
    'requestBody',
    'responseBody',
    'toolArguments',
    'headers',
    'error',
    'details',
    'metadata',
    'url',
    'name',
  ])('rejects forbidden field %s', (field) => {
    const value = payload();
    Object.assign(value.events[0]!, { [field]: 'forbidden' });
    expect(usageBatchV1Schema.safeParse(value).success).toBe(false);
  });
});
