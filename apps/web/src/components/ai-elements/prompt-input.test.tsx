import {
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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
});
