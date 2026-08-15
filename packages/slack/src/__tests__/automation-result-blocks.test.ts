import { describe, expect, it } from 'vitest';

import {
  buildAutomationResultBlocks,
  buildAutomationResultContentBlocks,
  formatAutomationResultSubtitle,
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

  it('keeps tables inside tilde code fences as verbatim prose', () => {
    const text = '~~~md\n| Name |\n| --- |\n| Demo |\n~~~';

    expect(buildAutomationResultContentBlocks(text)).toEqual([
      {
        type: 'section',
        text: { type: 'mrkdwn', text },
      },
    ]);
  });

  it('converts markdown lists into supported container child sections', () => {
    expect(buildAutomationResultContentBlocks('- First\n- Second')).toEqual([
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '- First\n- Second' },
      },
    ]);
  });

  it('preserves pipes inside variable-length inline code table cells', () => {
    const blocks = buildAutomationResultContentBlocks(
      '| Value |\n| --- |\n| ``a|b`` |',
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('table');
    if (blocks[0]?.type !== 'table') return;
    expect(blocks[0].rows).toHaveLength(2);
    expect(JSON.stringify(blocks[0].rows[1])).toContain('a|b');
  });

  it('uses sections for oversized table fallbacks', () => {
    const rows = Array.from({ length: 100 }, (_, index) => `| ${index} |`);
    const blocks = buildAutomationResultContentBlocks(
      ['| Value |', '| --- |', ...rows].join('\n'),
    );

    expect(blocks.length).toBeGreaterThan(0);
    expect(blocks.every((block) => block.type === 'section')).toBe(true);
  });

  it('builds the requested container chrome and keeps task and configure actions', () => {
    expect(
      buildAutomationResultBlocks({
        title: 'Daily report',
        iconUrl: 'https://app.example.com/automation-icons/zap.png',
        configureUrl: 'https://app.example.com/automations#custom-automation-1',
        contentBlocks: [
          { type: 'markdown', text: 'Everything is **healthy**.' },
        ],
        subtitle: {
          type: 'plain_text',
          text: formatAutomationResultSubtitle({
            trigger: 'Weekly',
            model: 'GPT 5.6 High',
            costMicroUsd: 560_000,
            durationMs: 157_000,
          }),
        },
        taskUrl: 'https://app.example.com/task/1',
      }),
    ).toEqual([
      {
        type: 'container',
        width: 'full',
        block_id: 'roomote_automation_result_container',
        title: { type: 'plain_text', text: 'Daily report', emoji: false },
        subtitle: {
          type: 'plain_text',
          text: 'Weekly · GPT 5.6 High · $0.56 · 02:37s',
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

  it('formats automation result metadata with zero-value padding', () => {
    expect(
      formatAutomationResultSubtitle({
        trigger: 'Manual',
        model: 'Kimi K3 Medium',
        costMicroUsd: 200_000,
        durationMs: 37_900,
      }),
    ).toBe('Manual · Kimi K3 Medium · $0.20 · 00:37s');

    expect(
      formatAutomationResultSubtitle({
        trigger: 'Daily',
        model: 'GPT 5.6 Max',
        costMicroUsd: 0,
        durationMs: 608_000,
      }),
    ).toBe('Daily · GPT 5.6 Max · $0.00 · 10:08s');
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

  it('puts full width on the container when rebuilding a result', () => {
    const [container] = buildAutomationResultBlocks({
      title: 'Audit',
      iconUrl: 'https://app.example.com/automation-icons/wrench.png',
      configureUrl: 'https://app.example.com/automations#audit',
      contentBlocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'Finished.' },
        },
      ],
    });

    expect(container?.type).toBe('container');
    if (container?.type !== 'container') return;
    expect(container.width).toBe('full');
    expect(container.child_blocks[0]).toEqual({
      type: 'section',
      text: { type: 'mrkdwn', text: 'Finished.' },
    });
  });
});
