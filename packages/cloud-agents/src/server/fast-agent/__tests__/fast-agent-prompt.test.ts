import { buildFastAgentSystemPrompt } from '../fast-agent-prompt';

describe('buildFastAgentSystemPrompt', () => {
  it('uses the default Roomote tone guidance when no style guidance is provided', () => {
    const prompt = buildFastAgentSystemPrompt({
      availableEnvironments: [],
      hasGitHubTools: false,
    });

    expect(prompt).toContain(
      'You are a deeply pragmatic, effective software engineer.',
    );
    expect(prompt).not.toContain(
      'Use the following organization-specific tone of voice for user-facing communication:',
    );
  });

  it('layers organization-specific style guidance on the default Roomote tone when style guidance is provided', () => {
    const prompt = buildFastAgentSystemPrompt({
      availableEnvironments: [
        {
          id: 'env-1',
          name: 'App',
          description: 'Main app',
          repositoryNames: ['Roomote/example-app'],
        },
      ],
      hasGitHubTools: true,
      styleGuidance: 'Be concise, calm, and slightly formal.',
    });

    expect(prompt).toContain(
      'You are a deeply pragmatic, effective software engineer.',
    );
    expect(prompt).toContain(
      'Use the following organization-specific tone of voice for user-facing communication:',
    );
    expect(prompt).toContain('Be concise, calm, and slightly formal.');
    expect(prompt).toContain('Roomote/example-app');
  });

  it('falls back to the default Roomote tone when style guidance is empty', () => {
    const prompt = buildFastAgentSystemPrompt({
      availableEnvironments: [],
      hasGitHubTools: true,
      styleGuidance: '',
    });

    expect(prompt).not.toContain(
      'Use the following organization-specific tone of voice for user-facing communication:',
    );
    expect(prompt).toContain(
      'You are a deeply pragmatic, effective software engineer.',
    );
  });
});
