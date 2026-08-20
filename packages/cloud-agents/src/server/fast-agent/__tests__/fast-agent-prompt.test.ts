import { RunStatus } from '@roomote/types';

import { buildFastAgentSystemPrompt } from '../fast-agent-prompt';
import { FAST_AGENT_BRAIN_INSTRUCTIONS } from '../fast-agent-constants';

describe('buildFastAgentSystemPrompt', () => {
  it('describes native OpenCode tools and Roomote orchestration policy', () => {
    const prompt = buildFastAgentSystemPrompt({
      availableEnvironments: [
        {
          id: 'env-1',
          name: 'App',
          description: 'Main app',
          repositoryNames: ['Roomote/example-app'],
        },
      ],
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
    expect(prompt).toContain('Task ID: task-2 | Update docs | pending');
    expect(prompt).toContain('Existing active tasks do not block');
    expect(prompt).toContain('send_chat_reply');
    expect(prompt).toContain('send_chat_reaction');
    expect(prompt).toContain('launch_task');
    expect(prompt).toContain('manage_tasks');
    expect(prompt).toContain('integration_call');
    expect(prompt).toContain(
      'These reads use the same deployment authorization semantics as delegated Roomote tasks.',
    );
    expect(prompt).toContain(
      'Use "launch_task", "send_task_message", or "cancel_task" for task changes',
    );
    expect(prompt).not.toContain('roomote_fast_');
    expect(prompt).toContain(
      'Tool arguments, results, and reasoning are retained natively',
    );
    expect(prompt).toContain('never encode it as a string');
    expect(prompt).toContain(
      'The runtime rejects those calls until an acknowledgement',
    );
    expect(prompt).toContain('kickoffMessage');
    expect(prompt).not.toContain('Each structured output');
    expect(prompt).not.toContain('toolArguments');
    expect(prompt).toContain('no local filesystem, shell');
  });

  it('includes native Brain guidance when Brain is available', () => {
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
    expect(prompt).toContain('narrowest native integration call');
    expect(prompt).toContain('one useful Brain result is usually enough');
    expect(prompt).toContain(
      "Never expose Brain's `source` field, architecture, or other internal provenance metadata",
    );
    expect(prompt).toContain('Do not add a `Source:` line for Brain results');
    expect(prompt).not.toContain('automatically performs one Brain query');
  });

  it('drives actionable messages through evidence and execution', () => {
    const prompt = buildFastAgentSystemPrompt({ availableEnvironments: [] });

    expect(prompt).toContain(
      'including declarative feedback. Do not require explicit words',
    );
    expect(prompt).toContain(
      "inspect the relevant sources, verify the user's premise, diagnose what is happening",
    );
    expect(prompt).toContain(
      'Do not stop at acknowledgement, agreement, speculation, restatement, or a plan',
    );
    expect(prompt).toContain(
      'Use deployment integrations as relevant sources of truth',
    );
    expect(prompt).toContain(
      'Ask for clarification only when ambiguity blocks meaningful investigation',
    );
    expect(prompt).toContain(
      'regardless of whether the message is phrased as a question, request, or declarative feedback',
    );
    expect(prompt).toContain(
      'A message that requires repository or workspace inspection, execution, change, or validation should be delegated',
    );
    expect(prompt).not.toContain(
      'A question that requires repository or workspace inspection',
    );
    expect(prompt).not.toContain(
      'Do not launch a task merely to answer a question or make a plan',
    );
    expect(prompt).toContain(
      'When an answer is shallow, uncertain, blocked, or incomplete',
    );
    expect(prompt).toContain(
      'If an available integration or delegated task can perform that step, offer to do it',
    );
    expect(prompt).toContain(
      'Do not add generic next-step boilerplate to complete answers',
    );
  });

  it('adapts native chat tool guidance for Discord', () => {
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

  it('uses native terminal tools for delegated-task platform events', () => {
    const prompt = buildFastAgentSystemPrompt({
      availableEnvironments: [],
      turnSource: 'platform_event',
      retryTaskStartAvailable: true,
    });

    expect(prompt).toContain('post exactly one closeout');
    expect(prompt).toContain('ignore_event');
    expect(prompt).toContain('retry_task_start');
    expect(prompt).toContain('only when the failure appears transient');
    expect(prompt).toContain('creates a separate delegated task');
    expect(prompt).toContain(
      'a platform event has no incoming chat message to react to',
    );
    expect(prompt).toContain(
      'Pull-request-opened events contain authoritative pull request metadata',
    );
  });

  it('does not offer retry when the platform event is ineligible', () => {
    const prompt = buildFastAgentSystemPrompt({
      availableEnvironments: [],
      turnSource: 'platform_event',
    });

    expect(prompt).toContain(
      'No failed-start retry tool is available for this event',
    );
    expect(prompt).not.toContain(
      'Call `retry_task_start` only when the failure appears transient',
    );
  });

  it('grounds first-person requests in current Slack message attributes', () => {
    const prompt = buildFastAgentSystemPrompt({ availableEnvironments: [] });

    expect(prompt).toContain(
      'attributes on the current `<slack_message>` identify its sender',
    );
    expect(prompt).toContain(
      'If an account-specific request needs a GitHub identity and `sender_github` is absent, ask',
    );
  });
});
