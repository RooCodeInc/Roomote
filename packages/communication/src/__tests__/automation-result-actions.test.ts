import { describe, expect, it } from 'vitest';

import {
  buildAutomationResultLinkActionRows,
  buildAutomationResultLinkButtonRows,
} from '../automation-result-actions';

describe('automation result actions', () => {
  it('keeps Slack and link-only provider actions ordered and labeled alike', () => {
    const params = {
      configureUrl: 'https://app.example.com/automations#weekly-scan',
      linkedPrUrls: ['https://github.com/acme/app/pull/12'],
      taskUrl: 'https://app.example.com/task/1',
      additionalActions: [
        {
          actionId: 'late_bound_automation_view_session',
          text: 'Follow',
          url: 'https://app.example.com/sessions/1',
        },
      ],
    };

    expect(buildAutomationResultLinkButtonRows(params)).toEqual([
      buildAutomationResultLinkActionRows(params)[0]!.map(({ text, url }) => ({
        text,
        url,
      })),
    ]);
    expect(
      buildAutomationResultLinkButtonRows(params)[0]?.map(({ text }) => text),
    ).toEqual(['Follow', 'See PR', 'Go to task', 'Configure']);
  });

  it('keeps Configure available when the primary action row is full', () => {
    const rows = buildAutomationResultLinkButtonRows({
      configureUrl: 'https://app.example.com/automations#audit',
      additionalActions: Array.from({ length: 25 }, (_, index) => ({
        actionId: `action-${index + 1}`,
        text: `Action ${index + 1}`,
        url: `https://app.example.com/actions/${index + 1}`,
      })),
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveLength(25);
    expect(rows[1]).toEqual([
      {
        text: 'Configure',
        url: 'https://app.example.com/automations#audit',
      },
    ]);
  });
});
