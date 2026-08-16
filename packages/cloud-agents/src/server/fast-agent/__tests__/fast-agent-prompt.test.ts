import { buildFastAgentSystemPrompt } from '../fast-agent-prompt';
import { BRAIN_MCP_READ_INSTRUCTIONS } from '@roomote/types';

describe('buildFastAgentSystemPrompt', () => {
  it('uses the default Roomote tone guidance', () => {
    const prompt = buildFastAgentSystemPrompt({
      availableEnvironments: [
        {
          id: 'env-1',
          name: 'App',
          description: 'Main app',
          repositoryNames: ['Roomote/example-app'],
        },
      ],
      availableIntegrations: [],
      activeTaskId: 'task-1',
    });

    expect(prompt).toContain(
      'You are a deeply pragmatic, effective software engineer.',
    );
    expect(prompt).toContain('Roomote/example-app');
    expect(prompt).toContain('conversational orchestrator');
    expect(prompt).toContain('Task ID: task-1');
    expect(prompt).toContain('let me know how it goes');
    expect(prompt).toContain('no local filesystem, shell');
    expect(prompt).not.toContain(
      'Use the following organization-specific tone of voice for user-facing communication:',
    );
  });

  it('includes read-only Brain guidance when Brain is available', () => {
    const prompt = buildFastAgentSystemPrompt({
      availableEnvironments: [],
      availableIntegrations: [
        {
          id: 'gbrain',
          name: 'Brain',
          description: 'Deployment memory',
          instructions: BRAIN_MCP_READ_INSTRUCTIONS,
          tools: [{ name: 'query' }],
        },
      ],
    });

    expect(prompt).toContain('Brain [integrationId: gbrain]');
    expect(prompt).toContain('Treat Brain recall as a sequential preflight');
    expect(prompt).toContain('- query:');
    expect(prompt).toContain('make multiple integration calls');
    expect(prompt).not.toContain('at most one integration call');
    expect(prompt).not.toContain('integration calls per user turn');
    expect(prompt).not.toContain('save_task_memory');
  });
});
