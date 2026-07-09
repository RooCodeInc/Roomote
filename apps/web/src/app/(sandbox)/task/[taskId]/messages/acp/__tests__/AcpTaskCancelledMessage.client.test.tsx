import { render, screen } from '@testing-library/react';
import { ACP_ENVELOPE_EVENT_TYPES } from '@roomote/types';

import { AcpTaskCancelledMessage } from '../AcpTaskCancelledMessage';
import type { AcpUiMessage } from '../types';

function buildMarker(
  payload: Record<string, unknown> = {},
): AcpUiMessage {
  return {
    id: 'cancel-1',
    ts: 1200,
    role: 'system',
    kind: 'task_cancelled',
    partial: false,
    sessionId: 'ses_1',
    updateType: ACP_ENVELOPE_EVENT_TYPES.TaskCancelled,
    data: { sessionId: 'ses_1', ...payload },
  };
}

describe('AcpTaskCancelledMessage', () => {
  it('names the user who stopped the task', () => {
    render(<AcpTaskCancelledMessage msg={buildMarker({ cancelledByName: 'Daniel' })} />);

    expect(screen.getByTestId('task-cancelled-marker')).toHaveTextContent(
      'Stopped by Daniel',
    );
  });

  it('falls back to a generic label without attribution', () => {
    render(<AcpTaskCancelledMessage msg={buildMarker()} />);

    expect(screen.getByTestId('task-cancelled-marker')).toHaveTextContent(
      'Stopped',
    );
  });
});
