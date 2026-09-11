import { describe, expect, it, vi } from 'vitest';

vi.mock('@roomote/cloud-agents/server', () => ({
  getAvailableEnvironments: vi.fn(),
  resolveApiBaseUrl: vi.fn(() => null),
}));
vi.mock('@roomote/db/server', () => ({
  db: {},
  eq: vi.fn(),
  repositories: {},
}));
vi.mock('@roomote/sdk/server', () => ({
  resolveUserMcpServerConfigs: vi.fn(),
}));

import {
  formatVoiceWorkspaceContext,
  voiceContextVocabulary,
  type VoiceWorkspaceContext,
} from './voice-context';

const context: VoiceWorkspaceContext = {
  repositoryNames: ['RooCodeInc/Roomote', 'RooCodeInc/Roo-Code'],
  environments: [
    {
      name: 'Roomote',
      description: 'main product',
      repositoryNames: ['RooCodeInc/Roomote'],
    },
    { name: 'Docs', repositoryNames: [] },
  ],
  integrationNames: ['GitHub', 'Slack'],
};

describe('formatVoiceWorkspaceContext', () => {
  it('lists every repository, the environments, and the integrations', () => {
    const text = formatVoiceWorkspaceContext(context);

    expect(text).toContain(
      'Repositories the backend can work in (it can also run against all of them at once): RooCodeInc/Roomote, RooCodeInc/Roo-Code.',
    );
    expect(text).toContain('- Roomote (main product): RooCodeInc/Roomote');
    expect(text).toContain('- Docs');
    expect(text).not.toContain('no repositories listed');
    expect(text).toContain('Integrations the backend can use: GitHub, Slack.');
  });

  it('falls back to a generic statement when nothing is known', () => {
    expect(
      formatVoiceWorkspaceContext({
        repositoryNames: [],
        environments: [],
        integrationNames: [],
      }),
    ).toBe(
      'The backend has access to the repositories and environments configured for this deployment.',
    );
  });
});

describe('voiceContextVocabulary', () => {
  it('dedupes repository, environment, and integration names', () => {
    expect(voiceContextVocabulary(context)).toEqual([
      'RooCodeInc/Roomote',
      'RooCodeInc/Roo-Code',
      'Roomote',
      'Docs',
      'GitHub',
      'Slack',
    ]);
  });
});
