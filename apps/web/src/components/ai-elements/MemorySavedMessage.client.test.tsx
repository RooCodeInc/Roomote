import { fireEvent, render, screen } from '@testing-library/react';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import { MemorySavedMessage } from './MemorySavedMessage';

describe('MemorySavedMessage', () => {
  it('renders task and session save facts behind an expandable indication', () => {
    render(
      <MemorySavedMessage
        message={
          {
            id: 'memory-saved',
            ts: 1,
            role: 'system',
            partial: false,
            sessionId: null,
            updateType: ACP_ENVELOPE_EVENT_TYPES.MemorySaved,
            kind: 'text',
            data: {
              memories: ['The task retries are capped at three attempts.'],
            },
          } as never
        }
      />,
    );

    const summary = screen.getByText('Saved to memory');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(summary);
    expect(summary.closest('details')).toHaveAttribute('open');
    expect(
      screen.getByText('The task retries are capped at three attempts.'),
    ).toBeInTheDocument();
  });
});
