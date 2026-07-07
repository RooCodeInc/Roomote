import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { TaskPromptInput } from './TaskPromptInput';

function renderPromptInput(submitDisabledReason?: string) {
  return render(
    <TaskPromptInput
      isBusy={false}
      promptText="Fix the login bug"
      onPromptTextChange={() => {}}
      onSubmit={() => {}}
      placeholder="Describe a task"
      submitDisabledReason={submitDisabledReason}
    />,
  );
}

describe('TaskPromptInput', () => {
  it('explains why the send button is disabled when hovering it', async () => {
    const reason = 'Create an environment before starting a task.';

    renderPromptInput(reason);

    const submitButton = screen.getByRole('button', { name: 'Submit' });
    expect(submitButton).toBeDisabled();

    const tooltipTrigger = submitButton.parentElement as HTMLElement;
    fireEvent.pointerMove(tooltipTrigger, { pointerType: 'mouse' });

    await waitFor(() => {
      expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
    });
  });

  it('keeps the send button enabled without a disabled reason', () => {
    renderPromptInput();

    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
  });
});
