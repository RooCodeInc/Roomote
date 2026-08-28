import { fireEvent, render, screen } from '@testing-library/react';

const { onOpenChangeMock } = vi.hoisted(() => ({
  onOpenChangeMock: vi.fn(),
}));

vi.mock('@/app/(authenticated)/home/Home', () => ({
  NewTaskForm: ({
    presentation,
    onTaskStarted,
  }: {
    presentation: string;
    onTaskStarted: () => void;
  }) => (
    <button
      type="button"
      data-testid="new-task-form"
      data-presentation={presentation}
      onClick={onTaskStarted}
    >
      Launch task
    </button>
  ),
}));

import { NewTaskDialog } from './NewTaskDialog';

describe('NewTaskDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('labels the dialog and renders the shared compact task form', () => {
    render(<NewTaskDialog open onOpenChange={onOpenChangeMock} />);

    expect(
      screen.getByRole('dialog', { name: 'New Session' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('new-task-form')).toHaveAttribute(
      'data-presentation',
      'dialog',
    );
  });

  it('closes after the shared form starts a task', () => {
    render(<NewTaskDialog open onOpenChange={onOpenChangeMock} />);

    fireEvent.click(screen.getByRole('button', { name: 'Launch task' }));

    expect(onOpenChangeMock).toHaveBeenCalledWith(false);
  });
});
