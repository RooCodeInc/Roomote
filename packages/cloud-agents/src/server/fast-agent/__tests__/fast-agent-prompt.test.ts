import { buildFastAgentSystemPrompt } from '../fast-agent-prompt';
import { FAST_AGENT_BRAIN_INSTRUCTIONS } from '../fast-agent-constants';

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
    expect(prompt).toContain('send_chat_reply');
    expect(prompt).toContain('send_chat_reaction_emoji');
    expect(prompt).toContain('There is no implicit final response');
    expect(prompt).toContain(
      'Do not add a reaction to every Fast mode message',
    );
    expect(prompt).toContain('"purpose"');
    expect(prompt).not.toContain('Use "respond"');
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
          instructions: FAST_AGENT_BRAIN_INSTRUCTIONS,
          tools: [{ name: 'query' }],
        },
      ],
    });

    expect(prompt).toContain('Brain [integrationId: gbrain]');
    expect(prompt).toContain('lightweight conversational context');
    expect(prompt).toContain(
      'automatically performs one Brain query before making its first decision',
    );
    expect(prompt).toContain('one useful Brain result is usually enough');
    expect(prompt).toContain(
      "Never expose Brain's `source` field or other internal provenance metadata",
    );
    expect(prompt).toContain('Do not add a `Source:` line for Brain results');
    expect(prompt).not.toContain('cite pages when relying on them');
    expect(prompt).not.toContain('sequential preflight');
    expect(prompt).not.toContain('proof of coverage');
    expect(prompt).toContain('- query:');
    expect(prompt).toContain('make multiple integration calls');
    expect(prompt).not.toContain('at most one integration call');
    expect(prompt).not.toContain('integration calls per user turn');
    expect(prompt).not.toContain('save_task_memory');
  });
});
