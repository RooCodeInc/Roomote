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

function SuggestedPrompt() {
  const [promptText, setPromptText] = useState('');

  return (
    <TaskPromptInput
      isBusy={false}
      promptText={promptText}
      onPromptTextChange={setPromptText}
      onSubmit={() => {}}
      placeholder="Describe a task"
      promptSuggestion="Add regression tests for authentication callback validation across every supported login flow"
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

  it('shows an accessible focus hint and accepts an empty suggestion with Tab', () => {
    render(<SuggestedPrompt />);
    const suggestion =
      'Add regression tests for authentication callback validation across every supported login flow';
    const textarea = screen.getByPlaceholderText(suggestion);

    expect(
      screen.queryByRole('button', { name: 'Insert suggested task' }),
    ).not.toBeInTheDocument();
    fireEvent.focus(textarea);
    expect(
      screen.getByRole('button', { name: 'Insert suggested task' }),
    ).toHaveTextContent('Tab to accept');
    expect(textarea).toHaveAccessibleDescription(
      `Suggested task: ${suggestion}. Press Tab to accept or Escape to dismiss.`,
    );

    const tabEvent = createEvent.keyDown(textarea, { key: 'Tab', code: 'Tab' });
    fireEvent(textarea, tabEvent);

    expect(tabEvent.defaultPrevented).toBe(true);
    expect(textarea).toHaveValue(suggestion);
    expect(
      screen.queryByRole('button', { name: 'Insert suggested task' }),
    ).not.toBeInTheDocument();
  });

  it('accepts an empty suggestion on touch pointer down before focus can blur', () => {
    render(<SuggestedPrompt />);
    const suggestion =
      'Add regression tests for authentication callback validation across every supported login flow';
    const textarea = screen.getByPlaceholderText(suggestion);

    fireEvent.focus(textarea);
    const hint = screen.getByRole('button', {
      name: 'Insert suggested task',
    });
    const pointerDown = createEvent.pointerDown(hint, { cancelable: true });
    Object.defineProperty(pointerDown, 'pointerType', { value: 'touch' });
    fireEvent(hint, pointerDown);

    expect(textarea).toHaveValue(suggestion);
    expect(hint).not.toBeInTheDocument();
  });

  it('preserves normal Tab behavior after typing and during IME composition', () => {
    render(<SuggestedPrompt />);
    const textarea = screen.getByRole('textbox');

    fireEvent.change(textarea, { target: { value: 'Write my own task' } });
    const typedTab = createEvent.keyDown(textarea, { key: 'Tab', code: 'Tab' });
    fireEvent(textarea, typedTab);
    expect(typedTab.defaultPrevented).toBe(false);
    expect(textarea).toHaveValue('Write my own task');

    fireEvent.change(textarea, { target: { value: '' } });
    fireEvent.compositionStart(textarea);
    const composingTab = createEvent.keyDown(textarea, {
      key: 'Tab',
      code: 'Tab',
      isComposing: true,
    });
    fireEvent(textarea, composingTab);
    expect(composingTab.defaultPrevented).toBe(false);
    expect(textarea).toHaveValue('');
  });

  it('preserves normal Tab behavior when no suggestion is displayed', () => {
    render(
      <TaskPromptInput
        isBusy={false}
        promptText=""
        onPromptTextChange={() => {}}
        onSubmit={() => {}}
        placeholder=""
      />,
    );
    const textarea = screen.getByRole('textbox');
    const tabEvent = createEvent.keyDown(textarea, {
      key: 'Tab',
      code: 'Tab',
    });

    fireEvent(textarea, tabEvent);

    expect(tabEvent.defaultPrevented).toBe(false);
    expect(textarea).toHaveValue('');
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

  it('shows the live voice toggle only when voice controls are provided', () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <TaskPromptInput
        isBusy={false}
        promptText=""
        onPromptTextChange={() => {}}
        onSubmit={() => {}}
        placeholder="Describe a task"
      />,
    );
    expect(
      screen.queryByRole('button', { name: /^voice conversation$/i }),
    ).not.toBeInTheDocument();

    rerender(
      <TaskPromptInput
        isBusy={false}
        promptText=""
        onPromptTextChange={() => {}}
        onSubmit={() => {}}
        placeholder="Describe a task"
        voice={{ active: false, onToggle }}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: /^voice conversation$/i }),
    );
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
