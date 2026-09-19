import { fireEvent, render, screen } from '@testing-library/react';

import {
  TodoListSection,
  TodoListSectionContent,
  TodoListSectionLabel,
  TodoListSectionTrigger,
} from './todo-list';

describe('TodoListSection', () => {
  it('keeps nested section icon state scoped to its own trigger', () => {
    render(
      <div className="group" data-state="open">
        <TodoListSection defaultOpen={false}>
          <TodoListSectionTrigger>
            <TodoListSectionLabel label="Completed tasks" />
          </TodoListSectionTrigger>
          <TodoListSectionContent>Hidden tasks</TodoListSectionContent>
        </TodoListSection>
      </div>,
    );

    const trigger = screen.getByRole('button', { name: 'Completed tasks' });
    const caret = trigger.querySelector('.lucide-chevron-up');
    const listIcon = trigger.querySelector('.lucide-list-checks');

    expect(trigger).toHaveAttribute('data-state', 'closed');
    expect(trigger).toHaveClass('group/collapsible-icon-trigger');
    expect(caret).toHaveClass(
      'group-data-[state=open]/collapsible-icon-trigger:opacity-100',
    );
    expect(listIcon).toHaveClass(
      'group-data-[state=open]/collapsible-icon-trigger:opacity-0',
    );

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('data-state', 'open');
    expect(screen.getByText('Hidden tasks')).toBeVisible();
  });
});
