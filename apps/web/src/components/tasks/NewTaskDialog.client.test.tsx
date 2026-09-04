import { fireEvent, render, screen } from '@testing-library/react';

const { onOpenChangeMock } = vi.hoisted(() => ({
  onOpenChangeMock: vi.fn(),
}));

vi.mock('./NewTaskForm', () => ({
  NewTaskForm: ({
    animate,
    allowEmptySession,
    onTaskStarted,
  }: {
    animate?: boolean;
    allowEmptySession?: boolean;
    onTaskStarted: () => void;
  }) => (
    <button
      type="button"
      data-animate={String(animate)}
      data-allow-empty-session={String(allowEmptySession)}
      data-testid="new-task-form"
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

  it('labels the dialog and renders the shared task form', () => {
    render(<NewTaskDialog open onOpenChange={onOpenChangeMock} />);

    const dialog = screen.getByRole('dialog', { name: 'New Session' });

    expect(dialog).toBeInTheDocument();
    expect(dialog).not.toHaveAttribute('aria-describedby');
    expect(screen.getByRole('heading', { name: 'New Session' })).toHaveClass(
      'sr-only',
    );
    expect(
      screen.queryByText(/^Choose where Roomote should work/),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId('new-task-form')).toHaveAttribute(
      'data-animate',
      'false',
    );
    expect(screen.getByTestId('new-task-form')).toHaveAttribute(
      'data-allow-empty-session',
      'true',
    );
  });

  it('closes after the shared form starts a task', () => {
    render(<NewTaskDialog open onOpenChange={onOpenChangeMock} />);

    fireEvent.click(screen.getByRole('button', { name: 'Launch task' }));

    expect(onOpenChangeMock).toHaveBeenCalledWith(false);
  });
});
