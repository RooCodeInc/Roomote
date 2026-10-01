import { fireEvent, render, screen } from '@testing-library/react';

const auto = vi.hoisted(() => ({
  state: undefined as
    | { available: boolean; enabled: boolean; suspended: boolean }
    | undefined,
  isSaving: false,
  setEnabled: vi.fn(),
}));

vi.mock('@/hooks/useSessionAutoToolApprovals', () => ({
  useSessionAutoToolApprovals: () => auto,
}));

import { SessionAutoToolApprovals } from './SessionAutoToolApprovals';

const HELP =
  'Let Roomote decide when something is worth interrupting for approval.';
const toggle = () => screen.getByRole('switch', { name: 'Auto-approval' });

describe('SessionAutoToolApprovals', () => {
  beforeEach(() => {
    auto.state = { available: true, enabled: false, suspended: false };
    auto.isSaving = false;
    auto.setEnabled.mockClear();
  });

  it('renders nothing until Auto is offered for the session', () => {
    auto.state = undefined;
    const { container } = render(
      <SessionAutoToolApprovals sessionId="session-1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('starts off and turns on and off for this session', () => {
    const { rerender } = render(
      <SessionAutoToolApprovals sessionId="session-1" />,
    );
    expect(toggle()).not.toBeChecked();
    expect(screen.getByText(HELP)).toBeInTheDocument();
    fireEvent.click(toggle());
    expect(auto.setEnabled).toHaveBeenLastCalledWith(true);

    auto.state = { available: true, enabled: true, suspended: false };
    rerender(<SessionAutoToolApprovals sessionId="session-1" />);
    expect(toggle()).toBeChecked();
    fireEvent.click(toggle());
    expect(auto.setEnabled).toHaveBeenLastCalledWith(false);
  });

  it('cannot be turned on while nothing can assess calls, but can always be turned off', () => {
    auto.state = { available: false, enabled: false, suspended: false };
    const { rerender } = render(
      <SessionAutoToolApprovals sessionId="session-1" />,
    );
    expect(toggle()).toBeDisabled();
    expect(
      screen.getByText('Auto mode isn’t available yet.'),
    ).toBeInTheDocument();

    auto.state = { available: false, enabled: true, suspended: false };
    rerender(<SessionAutoToolApprovals sessionId="session-1" />);
    expect(toggle()).toBeEnabled();
    fireEvent.click(toggle());
    expect(auto.setEnabled).toHaveBeenLastCalledWith(false);
  });

  it('says when Auto paused itself and lets the owner resume it', () => {
    auto.state = { available: true, enabled: true, suspended: true };
    const { rerender } = render(
      <SessionAutoToolApprovals sessionId="session-1" />,
    );
    expect(toggle()).toBeChecked();
    expect(
      screen.getByText(
        'Paused because calls couldn’t be checked. Tools ask you before running.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(auto.setEnabled).toHaveBeenLastCalledWith(true);

    // Nothing to resume with while calls still cannot be assessed.
    auto.state = { available: false, enabled: true, suspended: true };
    rerender(<SessionAutoToolApprovals sessionId="session-1" />);
    expect(
      screen.queryByRole('button', { name: 'Resume' }),
    ).not.toBeInTheDocument();
  });

  it('holds the switch while a change is saving', () => {
    auto.isSaving = true;
    render(<SessionAutoToolApprovals sessionId="session-1" />);
    expect(toggle()).toBeDisabled();
  });
});
