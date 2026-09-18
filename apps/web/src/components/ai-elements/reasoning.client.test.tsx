import { fireEvent, render, screen } from '@testing-library/react';

import { Reasoning, ReasoningContent, ReasoningTrigger } from './reasoning';

describe('ReasoningContent', () => {
  it('preserves single-line breaks inside reasoning bubbles', () => {
    const { container } = render(
      <Reasoning open defaultOpen={false}>
        <ReasoningContent>
          {'Examining HTML and PWA Updates\nInvesting Code Updates in PWA'}
        </ReasoningContent>
      </Reasoning>,
    );

    expect(container.querySelector('br')).not.toBeNull();
  });

  it('keeps nested reasoning icon state scoped to its own trigger', () => {
    render(
      <div className="group" data-state="open">
        <Reasoning defaultOpen={false}>
          <ReasoningTrigger />
          <ReasoningContent>Hidden thought</ReasoningContent>
        </Reasoning>
      </div>,
    );

    const trigger = screen.getByRole('button', { name: 'Thought for a bit' });
    const caret = trigger.querySelector('.lucide-chevron-up');
    const lightbulb = trigger.querySelector('.lucide-lightbulb');

    expect(trigger).toHaveAttribute('data-state', 'closed');
    expect(trigger).toHaveClass('group/collapsible-icon-trigger');
    expect(caret).toHaveClass(
      'group-data-[state=open]/collapsible-icon-trigger:opacity-100',
    );
    expect(lightbulb).toHaveClass(
      'group-data-[state=open]/collapsible-icon-trigger:opacity-0',
    );

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('data-state', 'open');
    expect(screen.getByText('Hidden thought')).toBeVisible();
  });
});
