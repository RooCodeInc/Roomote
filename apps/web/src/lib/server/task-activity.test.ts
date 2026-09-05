import { db, runFactory, taskFactory, taskMessages } from '@roomote/db/server';
import {
  ACP_ENVELOPE_EVENT_TYPES,
  ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
  type TaskMessageEventType,
  type TaskMessageRole,
} from '@roomote/types';

import {
  TASK_ACTIVITY_LINE_MAX_CHARS,
  formatTaskActivityLine,
  getLatestTaskActivityLine,
} from './task-activity';

async function createRunWithTask(taskId: string) {
  const task = await taskFactory.create({ id: taskId, title: 'Starter task' });
  const run = await runFactory.create({ taskId: task.id });
  return { task, run };
}

function messageRow(
  run: { id: number; taskId: string },
  {
    ts,
    eventType,
    text,
    role = 'assistant',
  }: {
    ts: number;
    eventType: TaskMessageEventType;
    text: string;
    role?: TaskMessageRole;
  },
) {
  return {
    runId: run.id,
    taskId: run.taskId,
    ts,
    eventType,
    role,
    protocol: ROOMOTE_RUNTIME_TASK_MESSAGE_PROTOCOL,
    contentBlocks: [{ type: 'text', text }],
    payload: {},
  };
}

describe('getLatestTaskActivityLine', () => {
  it('returns the latest assistant message, ignoring prompts and reasoning', async () => {
    const { run } = await createRunWithTask('task-activity-latest');

    await db.insert(taskMessages).values([
      messageRow(run, {
        ts: 1_000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        text: 'Set up the demo environment',
      }),
      messageRow(run, {
        ts: 2_000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        text: 'Looking into the checkout flow.',
      }),
      messageRow(run, {
        ts: 3_000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantThought,
        text: 'Internal reasoning that must stay hidden',
      }),
      messageRow(run, {
        ts: 4_000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        text: 'Running the test suite now.',
      }),
    ]);

    await expect(getLatestTaskActivityLine(run.id)).resolves.toBe(
      'Running the test suite now.',
    );
  });

  it('skips transient provider-error and retry narration', async () => {
    const { run } = await createRunWithTask('task-activity-transient');

    await db.insert(taskMessages).values([
      messageRow(run, {
        ts: 1_000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        text: 'Fixing the login bug.',
      }),
      messageRow(run, {
        ts: 2_000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        text: 'Provider error: upstream timed out',
      }),
      messageRow(run, {
        ts: 3_000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        text: 'Retrying after a rate limit',
      }),
    ]);

    await expect(getLatestTaskActivityLine(run.id)).resolves.toBe(
      'Fixing the login bug.',
    );
  });

  it('keeps the last eligible line behind a long transient retry storm', async () => {
    const { run } = await createRunWithTask('task-activity-retry-storm');

    await db.insert(taskMessages).values([
      messageRow(run, {
        ts: 1_000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        text: 'Fixing the login bug.',
      }),
      // More transient rows than one scan batch, so the eligible message is
      // only reachable by continuing past the first page.
      ...Array.from({ length: 25 }, (_, index) =>
        messageRow(run, {
          ts: 2_000 + index,
          eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
          text: `Retrying after a rate limit (attempt ${index + 1})`,
        }),
      ),
    ]);

    await expect(getLatestTaskActivityLine(run.id)).resolves.toBe(
      'Fixing the login bug.',
    );
  });

  it('returns null when the run has produced no assistant messages', async () => {
    const { run } = await createRunWithTask('task-activity-empty');

    await db.insert(taskMessages).values([
      messageRow(run, {
        ts: 1_000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.UserPrompt,
        role: 'user',
        text: 'Set up the demo environment',
      }),
    ]);

    await expect(getLatestTaskActivityLine(run.id)).resolves.toBeNull();
  });

  it('does not read messages from other runs', async () => {
    const { run } = await createRunWithTask('task-activity-own-run');
    const { run: otherRun } = await createRunWithTask('task-activity-other');

    await db.insert(taskMessages).values([
      messageRow(otherRun, {
        ts: 1_000,
        eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
        text: 'Activity from an unrelated run',
      }),
    ]);

    await expect(getLatestTaskActivityLine(run.id)).resolves.toBeNull();
  });
});

describe('formatTaskActivityLine', () => {
  it('flattens markdown structure to one plain line', () => {
    expect(
      formatTaskActivityLine(
        '## Progress\n\n- Updated `checkout.ts`\n- **Fixed** the [flaky test](https://example.com)\n\n```ts\nconst x = 1;\n```',
      ),
    ).toBe('Progress Updated checkout.ts Fixed the flaky test');
  });

  it('keeps underscores in identifiers intact', () => {
    expect(formatTaskActivityLine('Querying task_run_events now')).toBe(
      'Querying task_run_events now',
    );
  });

  it('truncates long text with an ellipsis', () => {
    const line = formatTaskActivityLine('word '.repeat(100));
    expect(line?.length).toBeLessThanOrEqual(TASK_ACTIVITY_LINE_MAX_CHARS);
    expect(line?.endsWith('…')).toBe(true);
  });

  it('returns null for whitespace-only input', () => {
    expect(formatTaskActivityLine('   \n  ')).toBeNull();
  });
});
