import { describe, expect, it } from 'vitest';

import { buildAutomationRootFooterBlocks } from '../automation-root-footer';

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
