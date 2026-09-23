import { describe, expect, it } from 'vitest';

import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import { buildTaskActivityDigest } from './task-activity-digest';

const assistant = (text: string) => ({
  eventType: ACP_ENVELOPE_EVENT_TYPES.AssistantMessage,
  contentBlocks: [{ type: 'text' as const, text }],
  payload: { text },
});

const toolCall = (toolName: string, title = toolName) => ({
  eventType: ACP_ENVELOPE_EVENT_TYPES.ToolCall,
  contentBlocks: [],
  payload: { toolName, title },
});

describe('buildTaskActivityDigest', () => {
  it('returns null when nothing was produced', () => {
    expect(buildTaskActivityDigest([])).toBeNull();
    expect(buildTaskActivityDigest([assistant('   ')])).toBeNull();
  });

  it('keeps narration, the latest plan, questions, and tool titles', () => {
    const digest = buildTaskActivityDigest([
      assistant('The failure starts in the permissions check.'),
      {
        eventType: ACP_ENVELOPE_EVENT_TYPES.Plan,
        contentBlocks: [],
        payload: { entries: [{ content: 'Old plan', status: 'pending' }] },
      },
      toolCall('bash', 'pnpm test'),
      {
        eventType: ACP_ENVELOPE_EVENT_TYPES.Plan,
        contentBlocks: [],
        payload: {
          entries: [
            { content: 'Reproduce', status: 'completed' },
            { content: 'Fix check', status: 'in_progress' },
            { content: 'Add test', status: 'pending' },
          ],
        },
      },
      {
        eventType: ACP_ENVELOPE_EVENT_TYPES.RequestUserInput,
        contentBlocks: [],
        payload: {
          questions: [
            {
              header: 'Migration',
              question: 'Keep the old column?',
              options: [{ label: 'Keep' }, { label: 'Drop' }],
            },
          ],
        },
      },
    ]);

    expect(digest).toEqual({
      toolsOnly: false,
      items: [
        {
          kind: 'assistant_message',
          text: 'The failure starts in the permissions check.',
        },
        {
          kind: 'plan',
          text: '[done] Reproduce\n[doing] Fix check\n[todo] Add test',
        },
        {
          kind: 'question',
          text: 'Keep the old column? (options: Keep, Drop)',
        },
        { kind: 'tools', text: 'pnpm test' },
      ],
    });
  });

  it('marks tool-only activity and skips tools that already reach the Session', () => {
    expect(
      buildTaskActivityDigest([
        toolCall('report_to_parent_session'),
        toolCall('read', 'Read src/index.ts'),
        toolCall('read', 'Read src/index.ts'),
      ]),
    ).toEqual({
      toolsOnly: true,
      items: [{ kind: 'tools', text: 'Read src/index.ts' }],
    });
  });

  it('drops provider retry notices from the narration', () => {
    expect(
      buildTaskActivityDigest([
        assistant(
          'Provider error: Bad Gateway: Failed to reach the provider\n\nRetrying now.',
        ),
        toolCall('bash', 'git status'),
      ]),
    ).toEqual({
      toolsOnly: true,
      items: [{ kind: 'tools', text: 'git status' }],
    });
  });

  it('keeps only the most recent narration', () => {
    const digest = buildTaskActivityDigest(
      ['one', 'two', 'three', 'four', 'five'].map(assistant),
    );

    expect(digest?.items.map((item) => item.text)).toEqual([
      'two',
      'three',
      'four',
      'five',
    ]);
  });
});
