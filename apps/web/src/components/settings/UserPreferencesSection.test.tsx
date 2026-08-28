import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

type PersonalColorTheme = 'light' | 'dark' | 'system';

const { colorThemeState, mindReaderModeState, narrationModeState } = vi.hoisted(
  () => ({
    colorThemeState: {
      colorTheme: 'system' as PersonalColorTheme,
      isLoading: false,
      isUpdating: false,
      setColorTheme: vi.fn(),
    },
    mindReaderModeState: {
      enabled: false,
      isLoading: false,
      isUpdating: false,
      setEnabled: vi.fn(),
    },
    narrationModeState: {
      enabled: false,
      isLoading: false,
      isUpdating: false,
      setEnabled: vi.fn(),
    },
  }),
);

vi.mock('@/hooks/useColorTheme', () => ({
  useColorTheme: () => colorThemeState,
}));

vi.mock('@/hooks/useNarrationMode', () => ({
  useNarrationMode: () => narrationModeState,
}));

vi.mock('@/hooks/useMindReaderMode', () => ({
  useMindReaderMode: () => mindReaderModeState,
}));

vi.mock('@/components/system', () => ({
  Label: ({
    children,
    htmlFor,
    className,
  }: {
    children: ReactNode;
    htmlFor?: string;
    className?: string;
  }) => (
    <label className={className} htmlFor={htmlFor}>
      {children}
    </label>
  ),
  Select: ({
    children,
    disabled,
    onValueChange,
    value,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
    value?: string;
  }) => (
    <select
      aria-label="Color theme"
      disabled={disabled}
      value={value}
      onChange={(event) => onValueChange?.(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  Settings2: () => <svg aria-hidden="true" />,
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
  Section: ({ title, children }: { title: ReactNode; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

import { UserPreferencesSection } from './UserPreferencesSection';

describe('UserPreferencesSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    colorThemeState.colorTheme = 'system' as PersonalColorTheme;
    colorThemeState.isLoading = false;
    colorThemeState.isUpdating = false;
    mindReaderModeState.enabled = false;
    mindReaderModeState.isLoading = false;
    mindReaderModeState.isUpdating = false;
    narrationModeState.enabled = false;
    narrationModeState.isLoading = false;
    narrationModeState.isUpdating = false;
  });

  it('renders user preference controls with the current state', () => {
    colorThemeState.colorTheme = 'dark' as PersonalColorTheme;
    mindReaderModeState.enabled = true;
    narrationModeState.enabled = true;

    render(<UserPreferencesSection />);

    expect(screen.getByText('Preferences')).toBeInTheDocument();
    expect(screen.getByText('Color theme')).toBeInTheDocument();
    expect(screen.getByLabelText('Color theme')).toHaveValue('dark');
    expect(screen.getByText('Mind reader mode')).toHaveClass('font-semibold');
    expect(
      screen.getByText(
        'Automatically expand LLM thoughts by default in conversations.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Toggle mind reader mode')).toBeChecked();
    expect(screen.getByText('Narration mode')).toHaveClass('font-semibold');
    expect(
      screen.getByText(
        'Streamline conversations, keeping only text messages and LLM thoughts.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Toggle narration mode')).toBeChecked();
  });

  it('disables controls while the corresponding preference is loading or updating', () => {
    colorThemeState.isLoading = true;
    mindReaderModeState.isLoading = true;
    narrationModeState.isUpdating = true;

    render(<UserPreferencesSection />);

    expect(screen.getByLabelText('Color theme')).toBeDisabled();
    expect(screen.getByLabelText('Toggle mind reader mode')).toBeDisabled();
    expect(screen.getByLabelText('Toggle narration mode')).toBeDisabled();
  });

  it('updates the color theme immediately when a different option is selected', () => {
    render(<UserPreferencesSection />);

    fireEvent.change(screen.getByLabelText('Color theme'), {
      target: { value: 'light' },
    });

    expect(colorThemeState.setColorTheme).toHaveBeenCalledWith('light');
  });

  it('updates narration mode immediately when the switch changes', () => {
    render(<UserPreferencesSection />);

    fireEvent.click(screen.getByLabelText('Toggle narration mode'));

    expect(narrationModeState.setEnabled).toHaveBeenCalledWith(true);
  });

  it('updates mind reader mode immediately when the switch changes', () => {
    render(<UserPreferencesSection />);

    fireEvent.click(screen.getByLabelText('Toggle mind reader mode'));

    expect(mindReaderModeState.setEnabled).toHaveBeenCalledWith(true);
  });

  it('renders theme choices in a dropdown', () => {
    render(<UserPreferencesSection />);

    const dropdown = screen.getByLabelText('Color theme');

    expect(within(dropdown).getByRole('option', { name: 'Light' })).toHaveValue(
      'light',
    );
    expect(within(dropdown).getByRole('option', { name: 'Dark' })).toHaveValue(
      'dark',
    );
    expect(within(dropdown).getByRole('option', { name: 'Auto' })).toHaveValue(
      'system',
    );
  });
});
