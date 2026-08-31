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

  it('builds top-level header, Markdown, images, and actions', () => {
    expect(
      buildAutomationResultBlocks({
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
      }),
    ).toEqual([
      {
        type: 'context',
        block_id: 'roomote_automation_result_header',
        elements: [
          {
            type: 'image',
            image_url: 'https://app.example.com/automation-icons/zap.png',
            alt_text: 'Daily report automation icon',
          },
          {
            type: 'plain_text',
            text: 'Daily report',
            emoji: false,
          },
          {
            type: 'plain_text',
            text: 'Weekly · GPT 5.6 High · $0.56 · 2m 37s',
          },
        ],
      },
      { type: 'markdown', text: '  ## Summary\n- Healthy  ' },
      {
        type: 'image',
        image_url: 'https://app.example.com/proof.png',
        alt_text: 'Proof',
      },
      {
        type: 'actions',
        block_id: 'roomote_automation_result_actions',
        elements: [
          {
            type: 'button',
            action_id: 'late_bound_automation_view_task',
            text: { type: 'plain_text', text: 'Go to task', emoji: false },
            url: 'https://app.example.com/task/1',
          },
          {
            type: 'overflow',
            action_id: 'late_bound_automation_configure',
            options: [
              {
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

  it('places additional actions before a custom Configure overflow', () => {
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
          type: 'overflow',
          action_id: 'late_bound_automation_configure',
          options: [
            expect.objectContaining({
              text: expect.objectContaining({ text: 'Configure alert' }),
            }),
          ],
        }),
      ],
    });
  });

  it('places Configure in the first available section accessory', () => {
    const [container] = buildAutomationResultBlocks({
      title: 'Merge Announcer',
      iconUrl: 'https://app.example.com/automation-icons/git-merge.png',
      configureUrl: 'https://app.example.com/automations#merge-announcer',
      contentBlocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: 'The release branch was updated.' },
        },
      ],
      additionalActions: [
        {
          type: 'button',
          action_id: 'view_changes',
          text: { type: 'plain_text', text: 'View changes' },
          url: 'https://github.com/acme/app/compare/one...two',
        },
      ],
    });

    expect(container?.type).toBe('container');
    if (container?.type !== 'container') return;
    expect(container.child_blocks).toEqual([
      expect.objectContaining({
        type: 'section',
        accessory: {
          type: 'overflow',
          action_id: 'late_bound_automation_configure',
          options: [
            {
              text: {
                type: 'plain_text',
                text: 'Configure',
                emoji: false,
              },
              url: 'https://app.example.com/automations#merge-announcer',
            },
          ],
        },
      }),
      expect.objectContaining({
        type: 'actions',
        elements: [expect.objectContaining({ action_id: 'view_changes' })],
      }),
    ]);
  });

  it('reserves action capacity for task and configure controls', () => {
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

    const actions = blocks.filter((block) => block.type === 'actions');
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

  it('reserves top-level block capacity for automation chrome', () => {
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

    expect(blocks).toHaveLength(50);
    expect(blocks[0]?.type).toBe('context');
    expect(blocks[1]).toEqual({ type: 'markdown', text: '## Summary' });
    expect(blocks.at(-1)?.type).toBe('actions');
    expect(blocks).not.toContainEqual(
      expect.objectContaining({
        image_url: 'https://app.example.com/proof-48.png',
      }),
    );
  });
});
