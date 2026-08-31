import { describe, expect, it } from 'vitest';

const resolveThreadReplyLinkedPrsMock = vi.hoisted(() => vi.fn());

vi.mock('@roomote/communication', () => ({
  resolveThreadReplyLinkedPrs: resolveThreadReplyLinkedPrsMock,
}));

import {
  buildAutomationRootFooterBlocks,
  refreshAutomationRootFooter,
} from '../automation-root-footer';

function getActions(
  blocks: ReturnType<typeof buildAutomationRootFooterBlocks>,
) {
  const actionsBlock = blocks.find((block) => block.type === 'actions');

  return actionsBlock?.type === 'actions' ? (actionsBlock.elements ?? []) : [];
}

describe('buildAutomationRootFooterBlocks', () => {
  it('uses unique action IDs for multiple pull requests', () => {
    const actions = getActions(
      buildAutomationRootFooterBlocks({
        automationLabel: 'Demo automation',
        linkedPrUrls: [
          'https://github.com/org/repo/pull/1',
          'https://github.com/org/repo/pull/2',
        ],
        taskUrl: 'https://roomote.dev/task/1',
      }),
    );

    expect(actions.map((action) => action.action_id)).toEqual([
      'late_bound_automation_view_pr_1',
      'late_bound_automation_view_pr_2',
      'late_bound_automation_view_task',
    ]);
  });

  it('caps pull request buttons so the task action fits Slack limits', () => {
    const actions = getActions(
      buildAutomationRootFooterBlocks({
        automationLabel: 'Demo automation',
        linkedPrUrls: Array.from(
          { length: 30 },
          (_, index) => `https://github.com/org/repo/pull/${index + 1}`,
        ),
        taskUrl: 'https://roomote.dev/task/1',
      }),
    );

    expect(actions).toHaveLength(25);
    expect(actions.at(-1)?.action_id).toBe('late_bound_automation_view_task');
  });
});

describe('refreshAutomationRootFooter', () => {
  it('replaces every prior automation action row at the Slack action limit', async () => {
    resolveThreadReplyLinkedPrsMock.mockResolvedValue(
      Array.from({ length: 30 }, (_, index) => ({
        prUrl: `https://github.com/org/repo/pull/${index + 1}`,
      })),
    );
    const updateMessage = vi.fn().mockResolvedValue(true);

    await expect(
      refreshAutomationRootFooter({
        slack: {
          getMessageBlocks: vi.fn().mockResolvedValue([
            {
              type: 'container',
              block_id: 'roomote_automation_result_container',
              title: { type: 'plain_text', text: 'Audit' },
              subtitle: { type: 'plain_text', text: 'Stale metadata' },
              child_blocks: [
                {
                  type: 'section',
                  block_id: 'roomote_automation_result_settings',
                  text: { type: 'plain_text', text: '\u200B' },
                  accessory: {
                    type: 'button',
                    action_id: 'late_bound_automation_configure',
                  },
                },
                {
                  type: 'section',
                  text: { type: 'mrkdwn', text: 'Finished.' },
                },
                {
                  type: 'actions',
                  block_id: 'roomote_automation_result_actions',
                  elements: [],
                },
                {
                  type: 'actions',
                  block_id: 'roomote_automation_result_actions_2',
                  elements: [
                    {
                      action_id: 'late_bound_automation_configure',
                    },
                  ],
                },
              ],
            },
          ]),
          updateMessage,
        },
        channelId: 'C123',
        messageTs: '1700000000.000001',
        automationLabel: 'Audit',
        automationIconUrl:
          'https://app.example.com/automation-icons/wrench.png',
        configureUrl: 'https://app.example.com/automations#audit',
        subtitle: {
          type: 'plain_text',
          text: 'Weekly · GPT 5.6 High · $0.56 · 02:37s',
        },
        taskUrl: 'https://app.example.com/task/1',
        taskId: 'task-1',
      }),
    ).resolves.toBe(true);

    const blocks = updateMessage.mock.calls[0]?.[0]?.message?.blocks ?? [];
    expect(blocks[0]?.subtitle).toEqual({
      type: 'plain_text',
      text: 'Weekly · GPT 5.6 High · $0.56 · 02:37s',
    });
    const actionIds = blocks
      .flatMap(
        (block: { child_blocks?: Array<Record<string, unknown>> }) =>
          block.child_blocks ?? [],
      )
      .filter((block: { type?: unknown }) => block.type === 'actions')
      .flatMap(
        (block: { elements?: Array<{ action_id?: string }> }) =>
          block.elements ?? [],
      )
      .map((element: { action_id?: string }) => element.action_id);
    expect(
      actionIds.filter((id: string | undefined) =>
        id?.includes('automation_configure'),
      ),
    ).toEqual(['late_bound_automation_configure']);
    expect(blocks[0]?.child_blocks).not.toContainEqual(
      expect.objectContaining({
        block_id: 'roomote_automation_result_settings',
      }),
    );
    expect(
      actionIds.filter((id: string | undefined) => id?.includes('view_pr')),
    ).toHaveLength(24);
  });

  it('migrates top-level Markdown into the structured result container', async () => {
    resolveThreadReplyLinkedPrsMock.mockResolvedValue([]);
    const updateMessage = vi.fn().mockResolvedValue(true);
    const markdown =
      '  ## Report\n- [Finding](<https://x.com/example/status/1>)\n\n| Item | Result |\n| --- | --- |\n| Link | Found |  ';

    await expect(
      refreshAutomationRootFooter({
        slack: {
          getMessageBlocks: vi.fn().mockResolvedValue([
            {
              type: 'context',
              block_id: 'roomote_automation_result_header',
              elements: [
                { type: 'image', image_url: 'https://example.com/zap.png' },
                { type: 'plain_text', text: 'Audit' },
                { type: 'plain_text', text: 'Saved metadata' },
              ],
            },
            { type: 'markdown', text: markdown },
            {
              type: 'actions',
              block_id: 'roomote_automation_result_actions',
              elements: [],
            },
          ]),
          updateMessage,
        },
        channelId: 'C123',
        messageTs: '1700000000.000001',
        automationLabel: 'Audit',
        automationIconUrl: 'https://example.com/zap.png',
        configureUrl: 'https://example.com/automations#audit',
      }),
    ).resolves.toBe(true);

    const blocks = updateMessage.mock.calls[0]?.[0]?.message?.blocks ?? [];
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({
      type: 'container',
      title: { text: 'Audit' },
      subtitle: { type: 'plain_text', text: 'Saved metadata' },
      child_blocks: expect.arrayContaining([
        expect.objectContaining({ type: 'rich_text' }),
        expect.objectContaining({
          type: 'table',
          rows: expect.arrayContaining([
            expect.arrayContaining([
              expect.objectContaining({ type: 'rich_text' }),
            ]),
          ]),
        }),
        expect.objectContaining({ type: 'actions' }),
      ]),
    });
    expect(blocks).not.toContainEqual({ type: 'markdown', text: markdown });
    expect(
      blocks.flatMap(
        (block: { child_blocks?: Array<{ block_id?: string }> }) =>
          block.child_blocks?.filter(
            (child) => child.block_id === 'roomote_automation_result_actions',
          ) ?? [],
      ),
    ).toHaveLength(1);
  });
});
