import { fireEvent, render, screen } from '@testing-library/react';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import { MemorySavedMessage } from './MemorySavedMessage';

describe('MemorySavedMessage', () => {
  it('uses the standard expandable tool row for saved memory facts', () => {
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

    const toolHeader = screen.getByRole('button', {
      name: 'Saved to memory Completed',
    });
    expect(toolHeader).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toolHeader);
    expect(toolHeader).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByText(/The task retries are capped at three attempts\./),
    ).toBeInTheDocument();
  });
});
