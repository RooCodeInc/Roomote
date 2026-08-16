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
      'the next action for one orchestration step, not necessarily the final answer for the user turn',
    );
    expect(prompt).toContain(
      'call exactly once or only at the end applies only to the current model invocation',
    );
    expect(prompt).toContain(
      'Do not add a reaction to every Fast mode message',
    );
    expect(prompt).toContain(
      'When you plan to initiate an integration or task tool action, first send a brief "ack"',
    );
    expect(prompt).toContain(
      'This requirement applies only to model-initiated tool use',
    );
    expect(prompt).toContain(
      'The automatic Brain integration preflight is exempt because it runs before your first decision, when you cannot yet send an acknowledgement',
    );
    expect(prompt).toContain(
      'If the answer is immediate and needs no model-initiated tool, skip the acknowledgement and send the "closeout" directly',
    );
    expect(prompt).toContain(
      'An "ack" or "progress" does not end the turn. Continue using the tools you need, then send a "closeout"',
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
          tools: [{ name: 'search' }, { name: 'query' }],
        },
      ],
    });

    expect(prompt).toContain('Brain [integrationId: gbrain]');
    expect(prompt).toContain('lightweight conversational context');
    expect(prompt).toContain(
      'automatically performs one Brain `search` before making its first decision',
    );
    expect(prompt).toContain(
      'Use Brain `query` only as an escalation when the automatic search is insufficient',
    );
    expect(prompt).toContain('one useful Brain result is usually enough');
    expect(prompt).toContain(
      "Never expose Brain's `source` field or other internal provenance metadata",
    );
    expect(prompt).toContain('Do not add a `Source:` line for Brain results');
    expect(prompt).not.toContain('cite pages when relying on them');
    expect(prompt).not.toContain('sequential preflight');
    expect(prompt).not.toContain('proof of coverage');
    expect(prompt).toContain('- search:');
    expect(prompt).toContain('- query:');
    expect(prompt).toContain('make multiple integration calls');
    expect(prompt).not.toContain('at most one integration call');
    expect(prompt).not.toContain('integration calls per user turn');
    expect(prompt).not.toContain('save_task_memory');
  });
});
