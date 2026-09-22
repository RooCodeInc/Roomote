import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  experimentEnabled: true,
  parentSession: { sessionId: 'session-1' } as { sessionId: string } | null,
  pending: [] as { approvalId: string; taskId: string | null }[],
  approvalsHook: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => ({ data: mocks.parentSession }),
}));
vi.mock('@/trpc/client', () => ({
  useTRPC: () => ({
    sessions: { forTask: { queryOptions: (input: unknown) => input } },
  }),
}));
vi.mock('@/hooks/useIntegrationToolApprovalsExperiment', () => ({
  useIntegrationToolApprovalsExperiment: () => ({
    enabled: mocks.experimentEnabled,
  }),
}));
vi.mock('@/hooks/useSessionIntegrationToolApprovals', () => ({
  useSessionIntegrationToolApprovals: (...args: unknown[]) => {
    mocks.approvalsHook(...args);
    return { data: { pending: mocks.pending } };
  },
}));
vi.mock('@/components/sessions/PendingIntegrationToolApprovals', () => ({
  PendingIntegrationToolApprovals: ({
    sessionId,
    pending,
  }: {
    sessionId: string;
    pending: { approvalId: string }[];
  }) => (
    <div data-testid="approvals" data-session={sessionId}>
      {pending.map((approval) => approval.approvalId).join(',')}
    </div>
  ),
}));

import { PendingToolApprovalsPanel } from './PendingToolApprovalsPanel';

describe('PendingToolApprovalsPanel', () => {
  beforeEach(() => {
    mocks.experimentEnabled = true;
    mocks.parentSession = { sessionId: 'session-1' };
    mocks.pending = [
      { approvalId: 'mine', taskId: 'task-1' },
      { approvalId: 'sibling-task', taskId: 'task-2' },
      { approvalId: 'session-agent', taskId: null },
    ];
  });

  it("shows its Session's card with only the asks this task raised", () => {
    render(<PendingToolApprovalsPanel taskId="task-1" />);
    const card = screen.getByTestId('approvals');
    expect(card.dataset.session).toBe('session-1');
    expect(card.textContent).toBe('mine');
    expect(mocks.approvalsHook).toHaveBeenCalledWith('session-1', true);
  });

  it('renders nothing without a Session, and reads nothing with the experiment off', () => {
    mocks.parentSession = null;
    mocks.experimentEnabled = false;
    const { container } = render(<PendingToolApprovalsPanel taskId="task-1" />);
    expect(container.innerHTML).toBe('');
    expect(mocks.approvalsHook).toHaveBeenLastCalledWith(undefined, false);
  });
});
