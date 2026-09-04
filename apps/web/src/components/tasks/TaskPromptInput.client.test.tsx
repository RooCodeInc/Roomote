import { useState } from 'react';
import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';

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

function KeyboardPrompt({
  onSubmit,
  isBusy = false,
  submitDisabledReason,
}: {
  onSubmit: () => void;
  isBusy?: boolean;
  submitDisabledReason?: string;
}) {
  const [promptText, setPromptText] = useState('Fix the login bug');

  return (
    <TaskPromptInput
      isBusy={isBusy}
      promptText={promptText}
      onPromptTextChange={setPromptText}
      onSubmit={onSubmit}
      placeholder="Describe a task"
      submitWithMetaKey={false}
      submitDisabledReason={submitDisabledReason}
    />
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

  it('submits on Enter in plain-Enter mode', async () => {
    const onSubmit = vi.fn();
    render(<KeyboardPrompt onSubmit={onSubmit} />);

    fireEvent.keyDown(screen.getByRole('textbox'), {
      key: 'Enter',
      code: 'Enter',
    });

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
  });

  it('advertises the Enter shortcut in plain-Enter mode', async () => {
    render(<KeyboardPrompt onSubmit={() => {}} />);

    fireEvent.pointerMove(screen.getByRole('button', { name: 'Submit' }), {
      pointerType: 'mouse',
    });

    await waitFor(() => {
      expect(screen.getAllByText('Send (Enter)').length).toBeGreaterThan(0);
    });
  });

  it('allows Shift+Enter to insert a newline without submitting', () => {
    const onSubmit = vi.fn();
    render(<KeyboardPrompt onSubmit={onSubmit} />);
    const textarea = screen.getByRole('textbox');
    const shiftEnter = createEvent.keyDown(textarea, {
      key: 'Enter',
      code: 'Enter',
      shiftKey: true,
    });

    fireEvent(textarea, shiftEnter);
    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: 'Fix the login bug\n' } });
    expect(textarea).toHaveValue('Fix the login bug\n');
  });

  it('does not submit Enter while an IME composition is active', () => {
    const onSubmit = vi.fn();
    render(<KeyboardPrompt onSubmit={onSubmit} />);
    const textarea = screen.getByRole('textbox');

    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'busy', props: { isBusy: true } },
    {
      name: 'disabled',
      props: { submitDisabledReason: 'Session creation is unavailable.' },
    },
  ])('does not submit Enter while the composer is $name', ({ props }) => {
    const onSubmit = vi.fn();
    render(<KeyboardPrompt onSubmit={onSubmit} {...props} />);

    fireEvent.keyDown(screen.getByRole('textbox'), {
      key: 'Enter',
      code: 'Enter',
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
