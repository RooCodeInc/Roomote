import { describe, expect, it } from 'vitest';

import {
  buildAutomationResultBlocks,
  buildAutomationResultContentBlocks,
} from '../automation-result-blocks';

describe('automation result blocks', () => {
  it('translates prose markdown and preserves GFM tables as native tables', () => {
    expect(
      buildAutomationResultContentBlocks(
        '**Summary** with [details](https://example.com).\n\n| Name | Result |\n| --- | ---: |\n| Build | **Passed** |',
      ),
    ).toEqual([
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Summary* with <https://example.com|details>.',
        },
      },
      {
        type: 'table',
        column_settings: [
          { align: 'left', is_wrapped: true },
          { align: 'right', is_wrapped: true },
        ],
        rows: [
          [
            {
              type: 'rich_text',
              elements: [
                {
                  type: 'rich_text_section',
                  elements: [
                    { type: 'text', text: 'Name', style: { bold: true } },
                  ],
                },
              ],
            },
            {
              type: 'rich_text',
              elements: [
                {
                  type: 'rich_text_section',
                  elements: [
                    { type: 'text', text: 'Result', style: { bold: true } },
                  ],
                },
              ],
            },
          ],
          [
            {
              type: 'rich_text',
              elements: [
                {
                  type: 'rich_text_section',
                  elements: [{ type: 'text', text: 'Build' }],
                },
              ],
            },
            {
              type: 'rich_text',
              elements: [
                {
                  type: 'rich_text_section',
                  elements: [
                    { type: 'text', text: 'Passed', style: { bold: true } },
                  ],
                },
              ],
            },
          ],
        ],
      },
    ]);
  });

  it('builds the requested container chrome and keeps task and configure actions', () => {
    expect(
      buildAutomationResultBlocks({
        title: 'Daily report',
        iconUrl: 'https://app.example.com/automation-icons/zap.png',
        configureUrl: 'https://app.example.com/automations#custom-automation-1',
        contentText: 'Everything is **healthy**.',
        runTimestamp: 1_700_000_000,
        taskUrl: 'https://app.example.com/task/1',
      }),
    ).toEqual([
      {
        type: 'container',
        block_id: 'roomote_automation_result_container',
        title: { type: 'plain_text', text: 'Daily report', emoji: false },
        subtitle: {
          type: 'mrkdwn',
          text: 'Run <!date^1700000000^{relative}|just now>',
        },
        icon: {
          type: 'image',
          image_url: 'https://app.example.com/automation-icons/zap.png',
          alt_text: 'Daily report automation icon',
        },
        has_header_divider: true,
        child_blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'Everything is *healthy*.' },
          },
          {
            type: 'actions',
            block_id: 'roomote_automation_result_actions',
            elements: [
              {
                type: 'button',
                action_id: 'late_bound_automation_view_task',
                text: {
                  type: 'plain_text',
                  text: 'Go to task',
                  emoji: false,
                },
                url: 'https://app.example.com/task/1',
              },
              {
                type: 'button',
                action_id: 'late_bound_automation_configure',
                text: {
                  type: 'plain_text',
                  text: 'Configure',
                  emoji: false,
                },
                url: 'https://app.example.com/automations#custom-automation-1',
              },
            ],
          },
        ],
      },
    ]);
  });

  it('reserves action capacity for task and configure buttons', () => {
    const [container] = buildAutomationResultBlocks({
      title: 'Audit',
      iconUrl: 'https://app.example.com/automation-icons/wrench.png',
      configureUrl: 'https://app.example.com/automations#audit',
      contentText: 'Finished.',
      taskUrl: 'https://app.example.com/task/1',
      linkedPrUrls: Array.from(
        { length: 30 },
        (_, index) => `https://github.com/acme/app/pull/${index + 1}`,
      ),
    });

    expect(container?.type).toBe('container');
    if (container?.type !== 'container') return;
    const actions = container.child_blocks.filter(
      (block) => block.type === 'actions',
    );
    expect(actions).toHaveLength(2);
    expect(actions[0]?.type).toBe('actions');
    expect(actions[1]?.type).toBe('actions');
    if (actions[0]?.type !== 'actions' || actions[1]?.type !== 'actions')
      return;
    expect(actions[0].elements).toHaveLength(25);
    expect(actions[0].elements?.at(-1)?.action_id).toBe(
      'late_bound_automation_view_task',
    );
    expect(actions[1].elements?.map((element) => element.action_id)).toEqual([
      'late_bound_automation_configure',
    ]);
  });
});
