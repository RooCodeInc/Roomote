import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

const { debugUiState, userState } = vi.hoisted(() => ({
  debugUiState: {
    canUseDebugUI: true,
    isDebugUIVisible: false,
    isLoading: false,
    isUpdating: false,
    setDebugUIVisible: vi.fn(),
  },
  userState: {
    featureFlags: {
      ShowDebugUISetting: true,
    },
  },
}));

vi.mock('@/hooks/useShowDebugUI', () => ({
  useShowDebugUI: () => debugUiState,
}));

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => userState,
}));

vi.mock('@/components/system', () => ({
  Bug: () => <svg aria-hidden="true" />,
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    'aria-label': ariaLabel,
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    'aria-label'?: string;
  }) => (
    <input
      type="checkbox"
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
    />
  ),
}));

vi.mock('./Section', () => ({
  Section: ({
    title,
    description,
    action,
    children,
  }: {
    title: ReactNode;
    description?: ReactNode;
    action?: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action}
      {children}
    </section>
  ),
}));

import { ShowDebugUISection } from './ShowDebugUISection';

describe('ShowDebugUISection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    debugUiState.canUseDebugUI = true;
    debugUiState.isDebugUIVisible = false;
    debugUiState.isLoading = false;
    debugUiState.isUpdating = false;
    userState.featureFlags.ShowDebugUISetting = true;
  });

  it('renders the section and current toggle state when the feature flag is enabled', () => {
    debugUiState.isDebugUIVisible = true;

    render(<ShowDebugUISection />);

    expect(screen.getByText('Show Debug UI')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Reveal internal-only diagnostics and controls that stay hidden for normal users.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Toggle debug UI')).toBeChecked();
  });

  it('does not render when the feature flag is disabled', () => {
    debugUiState.canUseDebugUI = false;

    const { container } = render(<ShowDebugUISection />);

    expect(container).toBeEmptyDOMElement();
  });

  it('disables the switch while the preference is loading or updating', () => {
    debugUiState.isUpdating = true;

    render(<ShowDebugUISection />);

    expect(screen.getByLabelText('Toggle debug UI')).toBeDisabled();
  });

  it('updates the preference immediately when the switch changes', () => {
    render(<ShowDebugUISection />);

    fireEvent.click(screen.getByLabelText('Toggle debug UI'));

    expect(debugUiState.setDebugUIVisible).toHaveBeenCalledWith(true);
  });
});
