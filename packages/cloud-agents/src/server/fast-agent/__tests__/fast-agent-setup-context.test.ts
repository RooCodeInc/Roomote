import { describe, expect, it, vi } from 'vitest';

vi.mock('@roomote/db/server', () => ({
  db: {},
  deploymentSettings: {},
  eq: vi.fn(),
  sessions: {},
  sql: vi.fn(),
}));

import {
  buildFastAgentSetupAdapter,
  dropIrrelevantOfferQualifiers,
} from '../fast-agent-setup-context';

function setupContext(snapshot: Record<string, unknown>) {
  return {
    sessionId: 'session-1',
    fastConversationId: 'conversation-1',
    setupSnapshot: JSON.stringify(snapshot),
    starterTaskOptions: [],
  };
}

function offerWith(snapshot: Record<string, unknown>) {
  const { offerCapability } = buildFastAgentSetupAdapter(
    setupContext(snapshot),
  );
  if (!offerCapability) throw new Error('offerCapability missing');
  return offerCapability;
}

const allOfferable = {
  capabilities: {
    source_control: { canOffer: true },
    integrations: { canOffer: true },
  },
  sourceControl: {
    providers: [{ provider: 'github', connected: false, repositoryCount: 0 }],
  },
  integrationAvailability: {
    offerableIntegrationIds: ['linear', 'notion'],
  },
};

describe('setup capability offers', () => {
  it('keeps only the qualifiers that apply to the offered capability', () => {
    expect(
      dropIrrelevantOfferQualifiers({
        capability: 'integrations',
        message: 'Connect your tools.',
        provider: 'github',
        integrationIds: [],
      }),
    ).toEqual({ capability: 'integrations', message: 'Connect your tools.' });
    expect(
      dropIrrelevantOfferQualifiers({
        capability: 'source_control',
        message: 'Connect a repository.',
        provider: 'github',
        integrationIds: ['linear'],
      }),
    ).toEqual({
      capability: 'source_control',
      message: 'Connect a repository.',
      provider: 'github',
    });
  });

  it('accepts an integrations offer that carries a stale source-control provider', async () => {
    await expect(
      offerWith(allOfferable)({
        capability: 'integrations',
        message: 'Connect your tools.',
        provider: 'github',
        integrationIds: ['linear'],
      }),
    ).resolves.toEqual({
      capability: 'integrations',
      message: 'Connect your tools.',
      integrationIds: ['linear'],
    });
  });

  it('accepts a source-control offer that carries an integration list', async () => {
    await expect(
      offerWith(allOfferable)({
        capability: 'source_control',
        message: 'Connect a repository.',
        provider: 'github',
        integrationIds: ['not-an-integration'],
      }),
    ).resolves.toEqual({
      capability: 'source_control',
      message: 'Connect a repository.',
      provider: 'github',
    });
  });

  it('still validates qualifiers that apply to the offered capability', async () => {
    await expect(
      offerWith(allOfferable)({
        capability: 'source_control',
        message: 'Connect a repository.',
        provider: 'gitlab',
      }),
    ).rejects.toThrow('That source-control provider is not available.');
    await expect(
      offerWith(allOfferable)({
        capability: 'integrations',
        message: 'Connect your tools.',
        integrationIds: ['not-an-integration'],
      }),
    ).rejects.toThrow('An offered integration was not found.');
  });
});

describe('setup adapter scope', () => {
  const launchSnapshot = {
    ...allOfferable,
    rail: { source: 'ready', firstWork: 'pending', compute: 'ready' },
  };

  it('keeps capability offers without setup-only controls in ordinary Sessions', async () => {
    const adapter = buildFastAgentSetupAdapter(setupContext(launchSnapshot), {
      setupSession: false,
    });

    expect(adapter.assertTaskLaunch).toBeUndefined();
    expect(adapter.resolveUserInputPreset).toBeUndefined();
    await expect(
      adapter.offerCapability!({
        capability: 'integrations',
        message: 'Connect Notion.',
        integrationIds: ['notion'],
      }),
    ).resolves.toMatchObject({
      capability: 'integrations',
      integrationIds: ['notion'],
    });
  });

  it('retains task launch gates in the setup Session', async () => {
    const adapter = buildFastAgentSetupAdapter(setupContext(launchSnapshot), {
      setupSession: true,
    });

    expect(adapter.resolveUserInputPreset).toEqual(expect.any(Function));
    await expect(adapter.assertTaskLaunch!()).rejects.toThrow(
      'Choose your first work before starting a task.',
    );
  });
});
