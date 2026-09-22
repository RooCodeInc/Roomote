import { render, screen } from '@testing-library/react';

const { useSandboxClientMock, useSandboxPendingUserInputRequestsMock } =
  vi.hoisted(() => ({
    useSandboxClientMock: vi.fn(),
    useSandboxPendingUserInputRequestsMock: vi.fn(),
  }));

vi.mock('./hooks', async () => {
  const actual = await vi.importActual<typeof import('./hooks')>('./hooks');

  return {
    ...actual,
    useSandboxClient: useSandboxClientMock,
    useSandboxPendingUserInputRequests: useSandboxPendingUserInputRequestsMock,
  };
});

vi.mock('@/trpc/client', () => ({
  useTRPCClient: () => ({}),
}));

import type { PendingTaskUserInputRequest } from './hooks';
import {
  PendingUserInputRequestPanel,
  PendingUserInputRequestStateProvider,
} from './PendingUserInputRequestPanel';

const pendingRequest: PendingTaskUserInputRequest = {
  requestId: 'rui:panel-test',
  sessionId: 'session-test',
  turnId: 'turn-test',
  callId: 'call-test',
  status: 'pending',
  ts: 0,
  questions: [
    {
      id: 'integration',
      header: 'INTEGRATION',
      question: 'Which integration should I inspect first?',
      isOther: true,
      isSecret: false,
      options: [
        { label: 'Telegram', description: 'Inspect Telegram first.' },
        { label: 'Teams', description: 'Inspect Teams first.' },
      ],
    },
  ],
};

function renderPanel() {
  return render(
    <PendingUserInputRequestStateProvider taskId="task-panel-test">
      <PendingUserInputRequestPanel />
    </PendingUserInputRequestStateProvider>,
  );
}

describe('PendingUserInputRequestPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSandboxClientMock.mockReturnValue({ commands: {} });
  });

  it('renders a live pending question even while the reported task phase is running', () => {
    // A queued/steered follow-up can flip the reported phase back to
    // running while the harness turn is still blocked on the question;
    // the panel must stay answerable as long as the request is pending.
    useSandboxPendingUserInputRequestsMock.mockReturnValue([pendingRequest]);

    renderPanel();

    expect(
      screen.getByText('Which integration should I inspect first?'),
    ).toBeInTheDocument();
    expect(screen.getByText('Telegram')).toBeInTheDocument();
  });

  it('renders nothing when there are no pending requests', () => {
    useSandboxPendingUserInputRequestsMock.mockReturnValue([]);

    const { container } = renderPanel();

    expect(container).toBeEmptyDOMElement();
  });
});
