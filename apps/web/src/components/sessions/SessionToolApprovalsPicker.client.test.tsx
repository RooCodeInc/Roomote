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

import {
  SessionToolApprovalsPicker,
  ToolApprovalsPicker,
} from './SessionToolApprovalsPicker';

const chip = () =>
  screen.getByRole('button', { name: /^Tool approvals for this session/ });
const openMenu = () => fireEvent.click(chip());
const option = (name: RegExp) => screen.getByRole('option', { name });

describe('ToolApprovalsPicker', () => {
  it('names the current mode on the chip and lists both modes with what they do', () => {
    render(<ToolApprovalsPicker mode="run" onModeChange={vi.fn()} />);
    expect(chip()).toHaveTextContent('Run');
    openMenu();
    expect(screen.getByText('Tool approvals')).toBeInTheDocument();
    expect(option(/^Run/)).toHaveAttribute('aria-selected', 'true');
    expect(option(/^Auto/)).toHaveAttribute('aria-selected', 'false');
    // Run is honest about the per-tool choices that still apply.
    expect(
      screen.getByText(
        'Tools run without a check, unless set to Always ask or Disable.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Roomote checks each tool call and asks before risky ones.',
      ),
    ).toBeInTheDocument();
  });

  it('changes the mode from the list and closes it', () => {
    const onModeChange = vi.fn();
    const { rerender } = render(
      <ToolApprovalsPicker mode="run" onModeChange={onModeChange} />,
    );
    openMenu();
    fireEvent.click(option(/^Auto/));
    expect(onModeChange).toHaveBeenLastCalledWith('auto');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    rerender(<ToolApprovalsPicker mode="auto" onModeChange={onModeChange} />);
    expect(chip()).toHaveTextContent('Auto');
    openMenu();
    // Picking the mode already in effect changes nothing.
    fireEvent.click(option(/^Auto/));
    expect(onModeChange).toHaveBeenCalledTimes(1);
    openMenu();
    fireEvent.click(option(/^Run/));
    expect(onModeChange).toHaveBeenLastCalledWith('run');
  });

  it('keeps explaining Auto while it cannot be chosen, and can always leave it', () => {
    const onModeChange = vi.fn();
    const { rerender } = render(
      <ToolApprovalsPicker
        mode="run"
        available={false}
        onModeChange={onModeChange}
      />,
    );
    openMenu();
    expect(option(/^Auto/)).toBeDisabled();
    expect(option(/^Auto/)).toHaveTextContent(
      'Roomote checks each tool call and asks before risky ones. Not available yet.',
    );
    fireEvent.click(option(/^Run/));

    rerender(
      <ToolApprovalsPicker
        mode="auto"
        available={false}
        onModeChange={onModeChange}
      />,
    );
    openMenu();
    expect(option(/^Run/)).toBeEnabled();
    fireEvent.click(option(/^Run/));
    expect(onModeChange).toHaveBeenLastCalledWith('run');
  });

  it('says when Auto paused itself and offers to resume it', () => {
    const onResume = vi.fn();
    const { rerender } = render(
      <ToolApprovalsPicker
        mode="auto"
        paused
        onModeChange={vi.fn()}
        onResume={onResume}
      />,
    );
    expect(chip()).toHaveTextContent('Auto paused');
    openMenu();
    expect(
      screen.getByText(
        'Auto couldn’t check tool calls, so tools will ask before running.',
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume Auto' }));
    expect(onResume).toHaveBeenCalledOnce();

    // Nothing to resume with while calls still cannot be checked.
    rerender(
      <ToolApprovalsPicker
        mode="auto"
        paused
        available={false}
        onModeChange={vi.fn()}
        onResume={onResume}
      />,
    );
    openMenu();
    expect(
      screen.queryByRole('button', { name: 'Resume Auto' }),
    ).not.toBeInTheDocument();
  });
});

describe('SessionToolApprovalsPicker', () => {
  beforeEach(() => {
    auto.state = { available: true, enabled: false, suspended: false };
    auto.isSaving = false;
    auto.setEnabled.mockClear();
  });

  it('renders nothing until the mode is offered for the session', () => {
    auto.state = undefined;
    const { container } = render(
      <SessionToolApprovalsPicker sessionId="session-1" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('starts in Run and turns Auto on and off for this session', () => {
    const { rerender } = render(
      <SessionToolApprovalsPicker sessionId="session-1" />,
    );
    expect(chip()).toHaveTextContent('Run');
    openMenu();
    fireEvent.click(option(/^Auto/));
    expect(auto.setEnabled).toHaveBeenLastCalledWith(true);

    auto.state = { available: true, enabled: true, suspended: true };
    rerender(<SessionToolApprovalsPicker sessionId="session-1" />);
    expect(chip()).toHaveTextContent('Auto paused');
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: 'Resume Auto' }));
    expect(auto.setEnabled).toHaveBeenLastCalledWith(true);
    openMenu();
    fireEvent.click(option(/^Run/));
    expect(auto.setEnabled).toHaveBeenLastCalledWith(false);
  });

  it('holds the chip while a change is saving', () => {
    auto.isSaving = true;
    render(<SessionToolApprovalsPicker sessionId="session-1" />);
    expect(chip()).toBeDisabled();
  });
});
