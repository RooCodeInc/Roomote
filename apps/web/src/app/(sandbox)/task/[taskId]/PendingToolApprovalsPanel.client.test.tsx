import { render, screen } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
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
    expect(mocks.approvalsHook).toHaveBeenCalledWith('session-1');
  });

  it('renders nothing without a Session', () => {
    mocks.parentSession = null;
    const { container } = render(<PendingToolApprovalsPanel taskId="task-1" />);
    expect(container.innerHTML).toBe('');
    expect(mocks.approvalsHook).toHaveBeenLastCalledWith(undefined);
  });
});
