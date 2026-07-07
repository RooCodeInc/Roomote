import { fireEvent, render, screen } from '@testing-library/react';

import { QueuedMessagesContent } from './QueuedMessages';
import type { QueuedMessage } from './types';

function createQueuedMessage(id: string, text: string): QueuedMessage {
  return {
    id,
    text,
    timestamp: Number(id),
  };
}

function createDataTransfer(): DataTransfer {
  const values = new Map<string, string>();

  return {
    dropEffect: 'move',
    effectAllowed: 'move',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: vi.fn((format?: string) => {
      if (format) {
        values.delete(format);
        return;
      }

      values.clear();
    }),
    getData: vi.fn((format: string) => values.get(format) ?? ''),
    setData: vi.fn((format: string, value: string) => {
      values.set(format, value);
    }),
    setDragImage: vi.fn(),
  } as unknown as DataTransfer;
}

describe('QueuedMessagesContent', () => {
  let getBoundingClientRectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getBoundingClientRectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        right: 320,
        bottom: 40,
        left: 0,
        width: 320,
        height: 40,
        toJSON: () => ({}),
      } as DOMRect);
  });

  afterEach(() => {
    getBoundingClientRectSpy.mockRestore();
  });

  it('calls onReorderQueuedMessage when a queued item is dropped onto another item', () => {
    const onReorderQueuedMessage = vi.fn();

    render(
      <QueuedMessagesContent
        queuedMessages={[
          createQueuedMessage('1', 'First queued follow-up'),
          createQueuedMessage('2', 'Second queued follow-up'),
          createQueuedMessage('3', 'Third queued follow-up'),
        ]}
        canReorder={true}
        onReorderQueuedMessage={onReorderQueuedMessage}
      />,
    );

    const handles = screen.getAllByRole('button', {
      name: /Reorder queued message/i,
    });
    const firstQueuedItem = screen
      .getByText('First queued follow-up')
      .closest('li');
    const dataTransfer = createDataTransfer();

    expect(firstQueuedItem).toBeTruthy();

    fireEvent.dragStart(handles[2]!, { dataTransfer });
    fireEvent.dragOver(firstQueuedItem!, { clientY: 5, dataTransfer });
    fireEvent.drop(firstQueuedItem!, { clientY: 5, dataTransfer });
    fireEvent.dragEnd(handles[2]!, { dataTransfer });

    expect(onReorderQueuedMessage).toHaveBeenCalledWith({
      queuedMessageId: '3',
      targetQueuedMessageId: '1',
      position: 'after',
    });
  });

  it('allows the queued content column to shrink so right-side actions stay visible', () => {
    render(
      <QueuedMessagesContent
        queuedMessages={[
          createQueuedMessage(
            '1',
            '<github-pr-follow-up>ThisGitHubPRmentionwasroutedintotheexistingRoomotetaskforthesamepullrequest</github-pr-follow-up>',
          ),
        ]}
        canSteer={true}
        onSteerQueuedMessage={vi.fn()}
      />,
    );

    expect(screen.getByLabelText('Send now')).toBeTruthy();
    expect(
      screen.getByText(
        /<github-pr-follow-up>ThisGitHubPRmentionwasroutedintotheexistingRoomotetask/,
      ),
    ).toHaveClass('min-w-0');
  });
});
