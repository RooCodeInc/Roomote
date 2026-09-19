import { describe, expect, it } from 'vitest';

import {
  buildAutomationResultBlocks,
  buildAutomationResultContentBlocks,
  formatAutomationResultSubtitle,
} from '../automation-result-blocks';

describe('automation result blocks', () => {
  it('preserves report Markdown for Slack to render', () => {
    const text = `  ${[
      '## Devin by Cognition',
      '### [Team stopped using Claude Tag](<https://x.com/example/status/1>)',
      '- Time: 2 hours ago',
      '',
      '| Name | Result |',
      '| --- | ---: |',
      '| Build | **Passed** |',
    ].join('\n')}  `;

    expect(buildAutomationResultContentBlocks(text)).toEqual([
      { type: 'markdown', text },
    ]);
  });

  it('does not escape angle-bracket Markdown link destinations', () => {
    const text = '[Report](<https://x.com/example/status/1>)';

    expect(buildAutomationResultContentBlocks(text)).toEqual([
      { type: 'markdown', text },
    ]);
    expect(buildAutomationResultContentBlocks(text)).not.toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining('&lt;'),
      }),
    );
  });

  it('omits empty report content', () => {
    expect(buildAutomationResultContentBlocks('  \n')).toEqual([]);
  });

  it('builds a container with formatted Markdown, images, metadata, and actions', () => {
    const [container] = buildAutomationResultBlocks({
      title: 'Daily report',
      iconUrl: 'https://app.example.com/automation-icons/zap.png',
      configureUrl: 'https://app.example.com/automations#custom-automation-1',
      contentBlocks: [
        { type: 'markdown', text: '  ## Summary\n- Healthy  ' },
        {
          type: 'image',
          image_url: 'https://app.example.com/proof.png',
          alt_text: 'Proof',
        },
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
    });

    expect(container).toMatchObject({
      type: 'container',
      width: 'full',
      title: { text: 'Daily report' },
      subtitle: {
        type: 'plain_text',
        text: 'Weekly · GPT 5.6 High · $0.56 · 2m 37s',
      },
      icon: {
        image_url: 'https://app.example.com/automation-icons/zap.png',
      },
    });
    if (container?.type !== 'container') return;
    expect(container.child_blocks).toContainEqual({
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [{ type: 'text', text: 'Summary', style: { bold: true } }],
        },
        {
          type: 'rich_text_list',
          style: 'bullet',
          elements: [
            {
              type: 'rich_text_section',
              elements: [{ type: 'text', text: 'Healthy  ' }],
            },
          ],
        },
      ],
    });
    expect(container.child_blocks).toContainEqual({
      type: 'image',
      image_url: 'https://app.example.com/proof.png',
      alt_text: 'Proof',
    });
    expect(container.child_blocks.at(-1)).toMatchObject({
      type: 'actions',
      elements: [
        { action_id: 'late_bound_automation_view_task' },
        { action_id: 'late_bound_automation_configure' },
      ],
    });
  });

  it('preserves report paragraphs without spacing list items or trailing content', () => {
    const [container] = buildAutomationResultBlocks({
      title: 'Release report',
      iconUrl: 'https://app.example.com/automation-icons/zap.png',
      configureUrl: 'https://app.example.com/automations#release',
      contentText: [
        "## What's new",
        '',
        'Roomote is faster.',
        '',
        '## Highlights',
        '',
        '- Faster setup',
        '',
        '- Better cards',
        '',
        'See all changes.',
      ].join('\n'),
    });

    expect(container?.type).toBe('container');
    if (container?.type !== 'container') return;
    expect(container.child_blocks).toContainEqual({
      type: 'rich_text',
      elements: [
        {
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: "What's new", style: { bold: true } },
            { type: 'text', text: '\n\n' },
          ],
        },
        {
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: 'Roomote is faster.' },
            { type: 'text', text: '\n\n' },
          ],
        },
        {
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: 'Highlights', style: { bold: true } },
            { type: 'text', text: '\n\n' },
          ],
        },
        {
          type: 'rich_text_list',
          style: 'bullet',
          elements: [
            {
              type: 'rich_text_section',
              elements: [{ type: 'text', text: 'Faster setup' }],
            },
            {
              type: 'rich_text_section',
              elements: [{ type: 'text', text: 'Better cards' }],
            },
          ],
        },
        {
          type: 'rich_text_section',
          elements: [{ type: 'text', text: '\n\n' }],
        },
        {
          type: 'rich_text_section',
          elements: [{ type: 'text', text: 'See all changes.' }],
        },
      ],
    });
  });

  it('preserves nested ordered lists in automation reports', () => {
    const [container] = buildAutomationResultBlocks({
      title: 'Nested report',
      iconUrl: 'https://app.example.com/automation-icons/zap.png',
      configureUrl: 'https://app.example.com/automations#nested',
      contentText: ['- Parent', '  1. First child', '- Sibling'].join('\n'),
    });

    expect(container?.type).toBe('container');
    if (container?.type !== 'container') return;
    expect(container.child_blocks).toContainEqual({
      type: 'rich_text',
      elements: expect.arrayContaining([
        expect.objectContaining({
          type: 'rich_text_list',
          style: 'bullet',
          elements: [
            expect.objectContaining({
              elements: [{ type: 'text', text: 'Parent' }],
            }),
          ],
        }),
        expect.objectContaining({
          type: 'rich_text_list',
          style: 'ordered',
          indent: 1,
          elements: [
            expect.objectContaining({
              elements: [{ type: 'text', text: 'First child' }],
            }),
          ],
        }),
      ]),
    });
  });

  it('leaves explicitly provided native tables unchanged', () => {
    const table = {
      type: 'table' as const,
      rows: [[{ type: 'raw_text' as const, text: 'Result' }]],
    };

    const [container] = buildAutomationResultBlocks({
      title: 'Build report',
      iconUrl: 'https://app.example.com/automation-icons/wrench.png',
      configureUrl: 'https://app.example.com/automations#build-report',
      contentBlocks: [table],
    });

    expect(container?.type).toBe('container');
    if (container?.type !== 'container') return;
    expect(container.child_blocks).toContainEqual(table);
  });

  it('converts Markdown tables into native table children', () => {
    const [container] = buildAutomationResultBlocks({
      title: 'Build report',
      iconUrl: 'https://app.example.com/automation-icons/wrench.png',
      configureUrl: 'https://app.example.com/automations#build-report',
      contentText: [
        '**Summary**',
        '',
        '| Name | Result |',
        '| --- | ---: |',
        '| Build | **Passed** |',
        '| `a|b` | Inline code |',
        '| a\\|b | Escaped pipe |',
        '| [Report](<https://example.com/report>) | `ready` |',
      ].join('\n'),
    });

    expect(container?.type).toBe('container');
    if (container?.type !== 'container') return;
    const table = container.child_blocks.find(
      (block) => block.type === 'table',
    );
    expect(table?.type).toBe('table');
    if (table?.type !== 'table') return;
    expect(table.column_settings).toEqual([
      { align: 'left', is_wrapped: true },
      { align: 'right', is_wrapped: true },
    ]);
    expect(table.rows).toHaveLength(5);
    const serializedRows = JSON.stringify(table.rows);
    expect(serializedRows).toContain('"text":"a|b"');
    expect(serializedRows).toContain('"url":"https://example.com/report"');
    expect(serializedRows).toContain('"style":{"code":true}');
  });

  it('keeps data visualizations top-level because containers do not support them', () => {
    const chart = {
      type: 'data_visualization' as const,
      title: 'Traffic sources',
      chart: {
        type: 'pie' as const,
        segments: [{ label: 'Search', value: 65 }],
      },
    };

    const blocks = buildAutomationResultBlocks({
      title: 'Traffic report',
      iconUrl: 'https://app.example.com/automation-icons/chart.png',
      configureUrl: 'https://app.example.com/automations#traffic',
      contentBlocks: [chart],
    });

    expect(blocks.map((block) => block.type)).toEqual([
      'data_visualization',
      'container',
    ]);
    expect(blocks[0]).toEqual(chart);
    expect(blocks[1]).toMatchObject({
      type: 'container',
      title: { text: 'Traffic report' },
      child_blocks: [
        expect.objectContaining({
          type: 'actions',
          block_id: 'roomote_automation_result_actions',
        }),
      ],
    });
  });

  it('formats automation result metadata with compact duration units', () => {
    expect(
      formatAutomationResultSubtitle({
        trigger: 'Manual',
        model: 'Kimi K3 Medium',
        costMicroUsd: 200_000,
        durationMs: 37_900,
      }),
    ).toBe('Manual · Kimi K3 Medium · $0.20 · 37s');

    expect(
      formatAutomationResultSubtitle({
        trigger: 'Weekly',
        model: 'GPT 5.6 Max',
        costMicroUsd: 0,
        durationMs: 93_784_000,
      }),
    ).toBe('Weekly · GPT 5.6 Max · $0.00 · 1d 2h 3m 4s');
  });

  it.each([
    [999_990_000, '$999.99'],
    [1_000_000_000, '$1,000.00'],
    [1_234_560_000, '$1,234.56'],
    [0, '$0.00'],
    [1_000, '$0.00'],
    [10_000, '$0.01'],
  ])('formats %s micro-USD as %s in subtitles', (costMicroUsd, expected) => {
    expect(
      formatAutomationResultSubtitle({
        trigger: 'Manual',
        model: 'Kimi K3 Medium',
        costMicroUsd,
        durationMs: 37_900,
      }),
    ).toBe(`Manual · Kimi K3 Medium · ${expected} · 37s`);
  });

  it('places additional actions before a custom Configure label', () => {
    const blocks = buildAutomationResultBlocks({
      title: 'Usage alert',
      iconUrl: 'https://app.example.com/automation-icons/battery-warning.png',
      configureUrl: 'https://app.example.com/automations#provider-usage-limit',
      configureLabel: 'Configure alert',
      additionalActions: [
        {
          type: 'button',
          action_id: 'manage_models',
          text: { type: 'plain_text', text: 'Manage models', emoji: false },
          url: 'https://app.example.com/settings/models',
        },
      ],
    });

    const [container] = blocks;
    expect(container?.type).toBe('container');
    if (container?.type !== 'container') return;
    expect(container.child_blocks.at(-1)).toEqual({
      type: 'actions',
      block_id: 'roomote_automation_result_actions',
      elements: [
        expect.objectContaining({ action_id: 'manage_models' }),
        expect.objectContaining({
          action_id: 'late_bound_automation_configure',
          text: expect.objectContaining({ text: 'Configure alert' }),
        }),
      ],
    });
  });

  it('reserves action capacity for task and configure buttons', () => {
    const blocks = buildAutomationResultBlocks({
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

    const actions = blocks.flatMap((block) =>
      block.type === 'container'
        ? block.child_blocks.filter((child) => child.type === 'actions')
        : [],
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

  it('splits long reports into bounded containers and keeps actions last', () => {
    const blocks = buildAutomationResultBlocks({
      title: 'Audit',
      iconUrl: 'https://app.example.com/automation-icons/wrench.png',
      configureUrl: 'https://app.example.com/automations#audit',
      contentBlocks: [
        { type: 'markdown', text: '## Summary' },
        ...Array.from({ length: 48 }, (_, index) => ({
          type: 'image' as const,
          image_url: `https://app.example.com/proof-${index + 1}.png`,
          alt_text: `Proof ${index + 1}`,
        })),
      ],
    });

    expect(blocks).toHaveLength(5);
    expect(blocks.every((block) => block.type === 'container')).toBe(true);
    expect(
      blocks.every(
        (block) =>
          block.type !== 'container' || block.child_blocks.length <= 10,
      ),
    ).toBe(true);
    const first = blocks[0];
    expect(first?.type).toBe('container');
    if (first?.type !== 'container') return;
    expect(first.child_blocks[0]).toMatchObject({ type: 'rich_text' });
    const last = blocks.at(-1);
    expect(last?.type).toBe('container');
    if (last?.type !== 'container') return;
    expect(last.child_blocks).toContainEqual(
      expect.objectContaining({
        image_url: 'https://app.example.com/proof-48.png',
      }),
    );
    expect(last.child_blocks.at(-1)?.type).toBe('actions');
  });

  it('caps normalized reports while reserving the final actions container', () => {
    const blocks = buildAutomationResultBlocks({
      title: 'Audit',
      iconUrl: 'https://app.example.com/automation-icons/wrench.png',
      configureUrl: 'https://app.example.com/automations#audit',
      contentBlocks: Array.from({ length: 500 }, (_, index) => ({
        type: 'markdown' as const,
        text: `Finding ${index + 1}`,
      })),
    });

    expect(blocks).toHaveLength(50);
    expect(blocks.every((block) => block.type === 'container')).toBe(true);
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain('Finding 499');
    expect(serialized).not.toContain('Finding 500');
    const last = blocks.at(-1);
    expect(last?.type).toBe('container');
    if (last?.type !== 'container') return;
    expect(last.child_blocks).toHaveLength(10);
    expect(last.child_blocks.at(-1)).toMatchObject({
      type: 'actions',
      block_id: 'roomote_automation_result_actions',
    });
  });

  it('reserves two final action rows when normalized content reaches the limit', () => {
    const blocks = buildAutomationResultBlocks({
      title: 'Audit',
      iconUrl: 'https://app.example.com/automation-icons/wrench.png',
      configureUrl: 'https://app.example.com/automations#audit',
      contentBlocks: Array.from({ length: 500 }, (_, index) => ({
        type: 'markdown' as const,
        text: `Finding ${index + 1}`,
      })),
      taskUrl: 'https://app.example.com/task/1',
      linkedPrUrls: Array.from(
        { length: 30 },
        (_, index) => `https://github.com/acme/app/pull/${index + 1}`,
      ),
    });

    expect(blocks).toHaveLength(50);
    expect(
      blocks.every(
        (block) =>
          block.type !== 'container' || block.child_blocks.length <= 10,
      ),
    ).toBe(true);
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain('Finding 498');
    expect(serialized).not.toContain('Finding 499');
    const last = blocks.at(-1);
    expect(last?.type).toBe('container');
    if (last?.type !== 'container') return;
    expect(last.child_blocks).toHaveLength(10);
    expect(
      last.child_blocks.filter((block) => block.type === 'actions'),
    ).toHaveLength(2);
  });

  it('budgets trailing rich text after top-level charts', () => {
    const blocks = buildAutomationResultBlocks({
      title: 'Traffic report',
      iconUrl: 'https://app.example.com/automation-icons/chart.png',
      configureUrl: 'https://app.example.com/automations#traffic',
      contentBlocks: [
        ...Array.from({ length: 49 }, (_, index) => ({
          type: 'data_visualization' as const,
          title: `Chart ${index + 1}`,
          chart: {
            type: 'pie' as const,
            segments: [{ label: 'Search', value: index + 1 }],
          },
        })),
        ...Array.from({ length: 15 }, (_, index) => ({
          type: 'markdown' as const,
          text: `Finding ${index + 1}`,
        })),
      ],
    });

    expect(blocks).toHaveLength(50);
    expect(
      blocks.slice(0, 49).every((block) => block.type === 'data_visualization'),
    ).toBe(true);
    const last = blocks.at(-1);
    expect(last?.type).toBe('container');
    if (last?.type !== 'container') return;
    expect(last.child_blocks).toHaveLength(10);
    const serialized = JSON.stringify(last);
    expect(serialized).toContain('Finding 9');
    expect(serialized).not.toContain('Finding 10');
    expect(last.child_blocks.at(-1)).toMatchObject({
      type: 'actions',
      block_id: 'roomote_automation_result_actions',
    });
  });

  it('reserves the final container when top-level charts reach the block limit', () => {
    const blocks = buildAutomationResultBlocks({
      title: 'Traffic report',
      iconUrl: 'https://app.example.com/automation-icons/chart.png',
      configureUrl: 'https://app.example.com/automations#traffic',
      contentBlocks: Array.from({ length: 50 }, (_, index) => ({
        type: 'data_visualization' as const,
        title: `Chart ${index + 1}`,
        chart: {
          type: 'pie' as const,
          segments: [{ label: 'Search', value: index + 1 }],
        },
      })),
    });

    expect(blocks).toHaveLength(50);
    expect(
      blocks.slice(0, 49).every((block) => block.type === 'data_visualization'),
    ).toBe(true);
    expect(blocks[48]).toMatchObject({ title: 'Chart 49' });
    expect(blocks).not.toContainEqual(
      expect.objectContaining({ title: 'Chart 50' }),
    );
    expect(blocks[49]).toMatchObject({
      type: 'container',
      child_blocks: [
        expect.objectContaining({
          type: 'actions',
          block_id: 'roomote_automation_result_actions',
        }),
      ],
    });
  });
});
