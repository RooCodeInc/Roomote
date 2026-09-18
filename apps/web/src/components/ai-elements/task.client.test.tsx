import { fireEvent, render, screen } from '@testing-library/react';

import { Task, TaskContent, TaskTrigger } from './task';

describe('Task', () => {
  it('keeps nested task chevron state scoped to its own trigger', () => {
    render(
      <div className="group" data-state="open">
        <Task defaultOpen={false}>
          <TaskTrigger title="Search repository" />
          <TaskContent>Hidden task details</TaskContent>
        </Task>
      </div>,
    );

    const trigger = screen.getByText('Search repository').parentElement!;
    const chevron = trigger.querySelector('.lucide-chevron-down');

    expect(trigger).toHaveAttribute('data-state', 'closed');
    expect(trigger).toHaveClass('group/task-trigger');
    expect(chevron).toHaveClass(
      'group-data-[state=open]/task-trigger:rotate-180',
    );

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('data-state', 'open');
    expect(screen.getByText('Hidden task details')).toBeVisible();
  });
});
