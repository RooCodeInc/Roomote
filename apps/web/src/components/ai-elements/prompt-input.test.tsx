import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { useState } from 'react';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const { mobileViewport } = vi.hoisted(() => ({
  mobileViewport: { value: false },
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mobileViewport.value,
}));

import {
  PromptInput,
  PromptInputBody,
  PromptInputTextarea,
  usePromptInputAttachments,
} from './prompt-input';

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

function AttachmentCount() {
  const attachments = usePromptInputAttachments();

  return <div data-testid="attachment-count">{attachments.files.length}</div>;
}

function createClipboardData(input: {
  items: DataTransferItem[];
  values?: Record<string, string>;
}): DataTransfer {
  return {
    items: input.items,
    getData: (type: string) => input.values?.[type] ?? '',
  } as unknown as DataTransfer;
}

function createClipboardFileItem(file: File): DataTransferItem {
  return {
    kind: 'file',
    type: file.type,
    getAsFile: () => file,
  } as DataTransferItem;
}

function createClipboardStringItem(type: string): DataTransferItem {
  return {
    kind: 'string',
    type,
    getAsFile: () => null,
  } as DataTransferItem;
}

describe('PromptInput', () => {
  beforeEach(() => {
    mobileViewport.value = false;
  });

  beforeAll(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:attachment'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  afterAll(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: originalCreateObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: originalRevokeObjectURL,
    });
  });

  it('uses password-manager-safe defaults for the prompt form', () => {
    const { container } = render(
      <PromptInput onSubmit={() => {}}>
        <PromptInputBody>
          <PromptInputTextarea aria-label="Prompt" />
        </PromptInputBody>
      </PromptInput>,
    );

    const form = container.querySelector('form');

    expect(form).toHaveAttribute('autocomplete', 'off');
    expect(form).toHaveAttribute('method', 'post');
    expect(form).toHaveAttribute('id');
    expect(form).toHaveAttribute('name');
    expect(form?.getAttribute('id')).toMatch(/^prompt-input-form-/);
    expect(form?.getAttribute('name')).toMatch(/^prompt-input-form-/);
  });

  it('gives the prompt textarea a stable opt-out id and ignore attributes', () => {
    render(
      <PromptInput onSubmit={() => {}}>
        <PromptInputBody>
          <PromptInputTextarea aria-label="Prompt" />
        </PromptInputBody>
      </PromptInput>,
    );

    const textarea = screen.getByLabelText('Prompt');

    expect(textarea).toHaveAttribute('autocomplete', 'off');
    expect(textarea).toHaveAttribute('data-1p-ignore');
    expect(textarea).toHaveAttribute('data-op-ignore', 'true');
    expect(textarea).toHaveAttribute('id');
    expect(textarea.getAttribute('id')).toMatch(/^prompt-input-textarea-/);
  });

  it('releases prompt focus when Escape is pressed', () => {
    render(
      <PromptInput onSubmit={() => {}}>
        <PromptInputBody>
          <PromptInputTextarea aria-label="Prompt" />
        </PromptInputBody>
      </PromptInput>,
    );
    const textarea = screen.getByLabelText('Prompt');

    textarea.focus();
    expect(textarea).toHaveFocus();

    fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape' });

    expect(textarea).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it('keeps prompt focus when an external handler consumes Escape', () => {
    render(
      <PromptInput onSubmit={() => {}}>
        <PromptInputBody>
          <PromptInputTextarea
            aria-label="Prompt"
            onKeyDown={(event) => event.preventDefault()}
          />
        </PromptInputBody>
      </PromptInput>,
    );
    const textarea = screen.getByLabelText('Prompt');

    textarea.focus();
    fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape' });

    expect(textarea).toHaveFocus();
  });

  it('accepts attachments that match extension-based filters', () => {
    const { container } = render(
      <PromptInput accept=".md,.pdf" onSubmit={() => {}}>
        <AttachmentCount />
        <PromptInputBody>
          <PromptInputTextarea aria-label="Prompt" />
        </PromptInputBody>
      </PromptInput>,
    );

    const input = container.querySelector('input[type="file"]');

    expect(input).toBeInstanceOf(HTMLInputElement);

    fireEvent.change(input!, {
      target: {
        files: [new File(['# Notes'], 'notes.MD', { type: 'text/markdown' })],
      },
    });

    expect(screen.getByTestId('attachment-count')).toHaveTextContent('1');
  });

  it('keeps prompt text and attachments when a rejected submit fails', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Extracted text from "notes.txt" would exceed the 200,000 character limit for attachments (total 200,001 characters). Remove or shorten the attachment and try again.',
        ),
      );
    const { container } = render(
      <PromptInput accept=".md" onSubmit={onSubmit}>
        <AttachmentCount />
        <PromptInputBody>
          <PromptInputTextarea aria-label="Prompt" />
        </PromptInputBody>
        <button type="submit">Send</button>
      </PromptInput>,
    );

    const input = container.querySelector('input[type="file"]');
    fireEvent.change(input!, {
      target: {
        files: [new File(['# Notes'], 'notes.md', { type: 'text/markdown' })],
      },
    });

    const textarea = screen.getByLabelText('Prompt');
    fireEvent.change(textarea, { target: { value: 'Summarize the notes' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId('attachment-count')).toHaveTextContent('1'),
    );
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('1');
    expect(textarea).toHaveValue('Summarize the notes');
  });

  it('accepts text attachments through a text wildcard filter', () => {
    const { container } = render(
      <PromptInput accept="text/*,.pdf" onSubmit={() => {}}>
        <AttachmentCount />
        <PromptInputBody>
          <PromptInputTextarea aria-label="Prompt" />
        </PromptInputBody>
      </PromptInput>,
    );

    const input = container.querySelector('input[type="file"]');

    expect(input).toBeInstanceOf(HTMLInputElement);

    fireEvent.change(input!, {
      target: {
        files: [new File(['Build output'], 'LICENSE', { type: 'text/plain' })],
      },
    });

    expect(screen.getByTestId('attachment-count')).toHaveTextContent('1');
  });

  it('treats image-only clipboard files as attachments', () => {
    render(
      <PromptInput accept="image/*" onSubmit={() => {}}>
        <AttachmentCount />
        <PromptInputBody>
          <PromptInputTextarea aria-label="Prompt" />
        </PromptInputBody>
      </PromptInput>,
    );

    const textarea = screen.getByLabelText('Prompt');
    const pastedImage = new File(['image'], 'image.png', { type: 'image/png' });
    const pasteEvent = createEvent.paste(textarea, {
      clipboardData: createClipboardData({
        items: [createClipboardFileItem(pastedImage)],
      }),
    });

    fireEvent(textarea, pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('1');
  });

  it('lets spreadsheet-style clipboard text paste instead of creating an image attachment', () => {
    render(
      <PromptInput accept="image/*" onSubmit={() => {}}>
        <AttachmentCount />
        <PromptInputBody>
          <PromptInputTextarea aria-label="Prompt" />
        </PromptInputBody>
      </PromptInput>,
    );

    const textarea = screen.getByLabelText('Prompt');
    const pastedPreviewImage = new File(['preview'], 'image.png', {
      type: 'image/png',
    });
    const pasteEvent = createEvent.paste(textarea, {
      clipboardData: createClipboardData({
        items: [
          createClipboardFileItem(pastedPreviewImage),
          createClipboardStringItem('text/plain'),
          createClipboardStringItem('text/html'),
        ],
        values: {
          'text/plain': 'Name\tAmount\nAlice\t42',
          'text/html':
            '<table><tr><td>Name</td><td>Amount</td></tr><tr><td>Alice</td><td>42</td></tr></table>',
        },
      }),
    });

    fireEvent(textarea, pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('0');
  });

  it('still attaches copied images when clipboard html is not tabular', () => {
    render(
      <PromptInput accept="image/*" onSubmit={() => {}}>
        <AttachmentCount />
        <PromptInputBody>
          <PromptInputTextarea aria-label="Prompt" />
        </PromptInputBody>
      </PromptInput>,
    );

    const textarea = screen.getByLabelText('Prompt');
    const pastedImage = new File(['image'], 'image.png', { type: 'image/png' });
    const pasteEvent = createEvent.paste(textarea, {
      clipboardData: createClipboardData({
        items: [
          createClipboardFileItem(pastedImage),
          createClipboardStringItem('text/html'),
        ],
        values: {
          'text/html': '<img src="https://example.com/image.png" />',
        },
      }),
    });

    fireEvent(textarea, pasteEvent);

    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(screen.getByTestId('attachment-count')).toHaveTextContent('1');
  });

  it('submits on plain Enter by default', () => {
    const onSubmit = vi.fn();

    render(
      <PromptInput clearOnSubmit={false} onSubmit={onSubmit}>
        <PromptInputBody>
          <PromptInputTextarea aria-label="Prompt" />
        </PromptInputBody>
        <button type="submit">Send</button>
      </PromptInput>,
    );

    const textarea = screen.getByLabelText('Prompt');

    expect(textarea).toHaveAttribute('enterkeyhint', 'send');
    fireEvent.change(textarea, { target: { value: 'Wake up and continue' } });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    return waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
        text: 'Wake up and continue',
        files: [],
      });
    });
  });

  it('leaves mobile Enter to insert a newline without submitting', () => {
    mobileViewport.value = true;
    const onSubmit = vi.fn();
    const onKeyDown = vi.fn();

    render(
      <PromptInput clearOnSubmit={false} onSubmit={onSubmit}>
        <PromptInputBody>
          <PromptInputTextarea aria-label="Prompt" onKeyDown={onKeyDown} />
        </PromptInputBody>
        <button type="submit">Send</button>
      </PromptInput>,
    );

    const textarea = screen.getByLabelText('Prompt');
    const enter = createEvent.keyDown(textarea, {
      key: 'Enter',
      code: 'Enter',
    });

    expect(textarea).toHaveAttribute('enterkeyhint', 'enter');
    fireEvent.change(textarea, { target: { value: 'First line' } });
    fireEvent(textarea, enter);

    expect(enter.defaultPrevented).toBe(false);
    expect(onKeyDown).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: 'First line\n' } });
    expect(textarea).toHaveValue('First line\n');
  });

  it('leaves desktop Shift+Enter to insert a newline without submitting', () => {
    const onSubmit = vi.fn();

    render(
      <PromptInput clearOnSubmit={false} onSubmit={onSubmit}>
        <PromptInputBody>
          <PromptInputTextarea aria-label="Prompt" />
        </PromptInputBody>
        <button type="submit">Send</button>
      </PromptInput>,
    );

    const textarea = screen.getByLabelText('Prompt');
    const shiftEnter = createEvent.keyDown(textarea, {
      key: 'Enter',
      code: 'Enter',
      shiftKey: true,
    });

    fireEvent(textarea, shiftEnter);

    expect(shiftEnter.defaultPrevented).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('requires Cmd/Ctrl+Enter when submitWithMetaKey is enabled', () => {
    const onSubmit = vi.fn();

    render(
      <PromptInput clearOnSubmit={false} onSubmit={onSubmit}>
        <PromptInputBody>
          <PromptInputTextarea aria-label="Prompt" submitWithMetaKey />
        </PromptInputBody>
        <button type="submit">Send</button>
      </PromptInput>,
    );

    const textarea = screen.getByLabelText('Prompt');

    fireEvent.change(textarea, { target: { value: 'Wake up and continue' } });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, {
      key: 'Enter',
      code: 'Enter',
      ctrlKey: true,
    });

    return waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
        text: 'Wake up and continue',
        files: [],
      });
    });
  });

  it.each(['keyboard', 'button'] as const)(
    'restores composer focus after a successful %s submit',
    async (submissionMethod) => {
      let resolveSubmit: (() => void) | undefined;
      const onSubmit = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSubmit = resolve;
          }),
      );

      function FocusHarness() {
        const [submitting, setSubmitting] = useState(false);

        return (
          <PromptInput
            keepFocusOnSubmit
            onSubmit={async () => {
              setSubmitting(true);
              try {
                await onSubmit();
              } finally {
                setSubmitting(false);
              }
            }}
          >
            <PromptInputBody>
              <PromptInputTextarea aria-label="Prompt" disabled={submitting} />
            </PromptInputBody>
            <button type="submit">Send</button>
          </PromptInput>
        );
      }

      render(<FocusHarness />);

      const textarea = screen.getByLabelText('Prompt');
      textarea.focus();
      fireEvent.change(textarea, { target: { value: 'Continue' } });

      if (submissionMethod === 'keyboard') {
        fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });
      } else {
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      }

      await waitFor(() => expect(textarea).toBeDisabled());
      resolveSubmit?.();

      await waitFor(() => {
        expect(textarea).not.toBeDisabled();
        expect(textarea).toHaveFocus();
      });
    },
  );

  it('does not restore composer focus after an outside interaction while submitting', async () => {
    let resolveSubmit: (() => void) | undefined;

    render(
      <>
        <PromptInput
          keepFocusOnSubmit
          onSubmit={() =>
            new Promise<void>((resolve) => {
              resolveSubmit = resolve;
            })
          }
        >
          <PromptInputBody>
            <PromptInputTextarea aria-label="Prompt" />
          </PromptInputBody>
          <button type="submit">Send</button>
        </PromptInput>
        <button type="button">Other control</button>
      </>,
    );

    const textarea = screen.getByLabelText('Prompt');
    textarea.focus();
    fireEvent.change(textarea, { target: { value: 'Continue' } });
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    const otherControl = screen.getByRole('button', { name: 'Other control' });
    fireEvent.pointerDown(otherControl);
    otherControl.focus();
    resolveSubmit?.();

    await waitFor(() => expect(otherControl).toHaveFocus());
  });
});
