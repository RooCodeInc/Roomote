import { buildFastAgentSystemPrompt } from '../fast-agent-prompt';
import { FAST_AGENT_BRAIN_INSTRUCTIONS } from '../fast-agent-constants';
import { RunStatus } from '@roomote/types';

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
      activeTasks: [
        { taskId: 'task-1', title: 'Fix API', status: RunStatus.Running },
        { taskId: 'task-2', title: 'Update docs', status: RunStatus.Pending },
      ],
    });

    expect(prompt).toContain(
      'You are a deeply pragmatic, effective software engineer.',
    );
    expect(prompt).toContain('Roomote/example-app');
    expect(prompt).toContain('conversational orchestrator');
    expect(prompt).toContain('Task ID: task-1');
    expect(prompt).toContain('Task ID: task-2 | Update docs | pending');
    expect(prompt).toContain('Existing active tasks do not block');
    expect(prompt).toContain('ask which active task the user means');
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
      'Before initiating an integration, sending a message to an active task, or canceling a task, first send a brief "ack"',
    );
    expect(prompt).toContain(
      'This requirement applies only to model-initiated tool use',
    );
    expect(prompt).toContain(
      'The automatic Brain integration preflight is exempt because it runs before your first decision, when you cannot yet send an acknowledgement',
    );
    expect(prompt).toContain(
      'For "launch_task", do not send a separate acknowledgement first. The runtime posts exactly one kickoff with the task link before making the child runnable, then ends this turn.',
    );
    expect(prompt).toContain(
      'A successful "launch_task" is the exception because the runtime posts and persists its parent-owned kickoff before queueing the child.',
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
      "If Brain has limited context, say what you found and offer to look deeper instead of investigating every possibility before replying. Don't apologize for not knowing everything.",
    );
    expect(prompt).toContain(
      "Never expose Brain's `source` field, architecture, or other internal provenance metadata in a user-facing reply. This includes source IDs, page or entity IDs, storage paths, raw record keys, presence or absence of records or profiles, and similar implementation details.",
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

  it('adapts chat lifecycle guidance for Discord', () => {
    const prompt = buildFastAgentSystemPrompt({
      availableEnvironments: [],
      surface: 'discord',
    });

    expect(prompt).toContain('fast mode on Discord');
    expect(prompt).toContain('Emoji reactions are unavailable on this surface');
    expect(prompt).not.toContain('<slack_modern_markdown>');
    expect(prompt).not.toContain(
      'attributes on the current `<slack_message>` identify its sender',
    );
  });

  it('limits delegated-task platform events to one terminal reply', () => {
    const prompt = buildFastAgentSystemPrompt({
      availableEnvironments: [],
      platformEvent: true,
      retryTaskStartAvailable: true,
    });

    expect(prompt).toContain(
      'emit exactly one "send_chat_reply" with purpose "closeout"',
    );
    expect(prompt).toContain('Never use "ack" or "progress"');
    expect(prompt).toContain('Use "ignore_event"');
    expect(prompt).toContain('The normal orchestration tools remain available');
    expect(prompt).toContain(
      'the event is context, not a new human instruction',
    );
    expect(prompt).toContain(
      'includes the full secret-redacted error and its machine-readable errorCode',
    );
    expect(prompt).toContain(
      'Use "retry_task_start" only when the failure appears transient',
    );
    expect(prompt).toContain('"launch_task" creates a separate delegated task');
    expect(prompt).toContain(
      'creates a separate delegated task; it does not retry the task associated with this event',
    );
    expect(prompt).not.toContain(
      'Do not use integrations, send messages to tasks, cancel tasks',
    );
    expect(prompt).toContain(
      'a platform event has no incoming chat message to react to',
    );
    expect(prompt).toContain(
      'Pull-request-opened events contain authoritative, user-presentable pull request metadata',
    );
    expect(prompt).toContain(
      'unless that exact pull request URL was already reported in this conversation',
    );
    expect(prompt).toContain(
      "Task-settled events include the task's current pullRequests list",
    );
  });

  it('does not offer a failed-start retry for ineligible platform events', () => {
    const prompt = buildFastAgentSystemPrompt({
      availableEnvironments: [],
      platformEvent: true,
    });

    expect(prompt).toContain(
      'No failed-start retry action is available for this event',
    );
    expect(prompt).not.toContain(
      'Use "retry_task_start" only when the failure appears transient',
    );
    expect(prompt).toContain('"launch_task" creates a separate delegated task');
  });

  it('grounds first-person requests in current Slack message attributes', () => {
    const prompt = buildFastAgentSystemPrompt({
      availableEnvironments: [],
    });

    expect(prompt).toContain(
      'attributes on the current `<slack_message>` identify its sender',
    );
    expect(prompt).toContain(
      'If an account-specific request needs a GitHub identity and `sender_github` is absent, ask',
    );
    expect(prompt).not.toContain('## Current User Identity');
  });
});
