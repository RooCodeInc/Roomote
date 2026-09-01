import { createHash, createHmac, randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  acknowledge: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@roomote/db/server', () => ({
  db: {},
  claimCloudInferenceUsage: mocks.claim,
  acknowledgeCloudInferenceUsage: mocks.acknowledge,
  releaseCloudInferenceUsage: mocks.release,
}));

vi.mock('@roomote/env', () => ({
  Env: {
    ROOMOTE_CLOUD_USAGE_URL:
      'https://cloud.example/prefix/internal/v1/usage?source=tenant',
    ROOMOTE_CLOUD_TOKEN_ID: '9d137fea-a018-4432-af24-83ce802b4ed2',
    ROOMOTE_CLOUD_TOKEN_SECRET: 'derived-service-credential',
  },
}));

import { cloudUsageOutboxDrainJob } from './cloud-usage-outbox-drain';

function row(overrides: Record<string, unknown> = {}) {
  return {
    usageId: randomUUID(),
    provider: 'openrouter',
    modelId: 'openai/gpt-5',
    usageType: 'inference',
    inputTokens: 1,
    outputTokens: 2,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 10,
    outcome: 'succeeded',
    completedAt: new Date(),
    credentialOwner: 'tenant',
    estimatedCostMicroUsd: null,
    estimatePricingVersion: null,
    providerReportedCostMicroUsd: null,
    ...overrides,
  };
}

describe('cloud usage outbox drain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('signs the configured request path and query', async () => {
    const usage = row();
    mocks.claim.mockResolvedValue([usage]);
    mocks.acknowledge.mockResolvedValue(undefined);
    mocks.release.mockResolvedValue(undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ acknowledgedUsageIds: [usage.usageId] }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    await cloudUsageOutboxDrainJob();

    const [endpoint, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);
    const body = String(init.body);
    const expected = createHmac('sha256', 'derived-service-credential')
      .update(
        [
          headers.get('x-roomote-timestamp'),
          headers.get('x-roomote-nonce'),
          'POST',
          '/prefix/internal/v1/usage?source=tenant',
          createHash('sha256').update(body).digest('hex'),
        ].join('\n'),
      )
      .digest('hex');
    expect(endpoint.pathname + endpoint.search).toBe(
      '/prefix/internal/v1/usage?source=tenant',
    );
    expect(headers.get('x-roomote-signature')).toBe(expected);
  });

  it('releases a claimed row when DTO validation fails', async () => {
    const invalid = row({ modelId: 'x'.repeat(257) });
    mocks.claim.mockResolvedValue([invalid]);
    mocks.release.mockResolvedValue(undefined);

    await cloudUsageOutboxDrainJob();

    expect(mocks.release).toHaveBeenCalledWith(
      expect.anything(),
      [invalid.usageId],
      expect.any(String),
    );
  });
});
