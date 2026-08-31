import { render } from '@testing-library/react';

import { TaskAutomationIcon } from './TaskAutomationIcon';

describe('TaskAutomationIcon', () => {
  it('uses the configured automation icon', () => {
    const { container } = render(
      <TaskAutomationIcon automationKey="review_code" />,
    );

    expect(container.querySelector('.lucide-git-pull-request')).not.toBeNull();
  });

  it('uses the merge icon for merged pull request summaries', () => {
    const { container } = render(
      <TaskAutomationIcon automationKey="announcer" />,
    );

    expect(container.querySelector('.octicon-git-merge')).not.toBeNull();
  });

  it('uses a bot icon for custom and unknown automations', () => {
    const { container, rerender } = render(
      <TaskAutomationIcon automationKey="custom_automation" />,
    );

    expect(container.querySelector('.lucide-bot')).not.toBeNull();

    rerender(<TaskAutomationIcon automationKey="future_automation" />);

    expect(container.querySelector('.lucide-bot')).not.toBeNull();
  });
});
