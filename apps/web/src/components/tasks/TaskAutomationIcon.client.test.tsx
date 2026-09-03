import { render } from '@testing-library/react';

import { TaskAutomationIcon } from './TaskAutomationIcon';

describe('TaskAutomationIcon', () => {
  it.each([
    ['review_code', 'git-pull-request.png'],
    ['call_roomote_via_emoji', 'smile.png'],
    ['slack_channel_auto_start', 'messages-square.png'],
    ['platform_issue_alerts', 'bell-electric.png'],
  ])('uses the generated asset for %s', (automationKey, asset) => {
    const { container } = render(
      <TaskAutomationIcon automationKey={automationKey} />,
    );

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      expect.stringContaining(asset),
    );
  });

  it('uses the generated Slack asset for registered automations', () => {
    const { container } = render(
      <TaskAutomationIcon automationKey="announcer" />,
    );

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      expect.stringContaining('git-merge.png'),
    );
  });

  it('uses the generated fallback asset for custom and unknown automations', () => {
    const { container, rerender } = render(
      <TaskAutomationIcon automationKey="custom_automation" />,
    );

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      expect.stringContaining('zap.png'),
    );

    rerender(<TaskAutomationIcon automationKey="future_automation" />);

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      expect.stringContaining('zap.png'),
    );
  });
});
