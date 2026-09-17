import { render, waitFor } from '@testing-library/react';

type PersonalColorTheme = 'light' | 'dark' | 'system';

const { personalPreferencesState, themeState, userState } = vi.hoisted(() => ({
  personalPreferencesState: {
    preferences: {
      colorTheme: 'system' as PersonalColorTheme,
      narrationMode: false,
    },
    hasLoadedPreferences: true,
    isLoading: false,
    refetch: vi.fn(),
  },
  themeState: {
    theme: 'system',
    setTheme: vi.fn(),
  },
  userState: {
    isSignedIn: true,
    user: null,
  },
}));

vi.mock('next-themes', () => ({
  useTheme: () => themeState,
}));

vi.mock('@/hooks/usePersonalPreferences', () => ({
  usePersonalPreferences: () => personalPreferencesState,
}));

vi.mock('@/hooks/useUser', () => ({
  useUser: () => userState,
}));

import { PersonalThemeSync } from './PersonalThemeSync';

describe('PersonalThemeSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    personalPreferencesState.preferences = {
      colorTheme: 'system' as PersonalColorTheme,
      narrationMode: false,
    };
    personalPreferencesState.isLoading = false;
    personalPreferencesState.hasLoadedPreferences = true;
    personalPreferencesState.refetch.mockReset();
    personalPreferencesState.refetch.mockResolvedValue({ isSuccess: true });
    themeState.theme = 'system';
    userState.isSignedIn = true;
  });

  it('applies the saved theme after preferences have loaded', async () => {
    personalPreferencesState.preferences = {
      colorTheme: 'dark' as PersonalColorTheme,
      narrationMode: false,
    };
    themeState.theme = 'system';

    render(<PersonalThemeSync />);

    await waitFor(() => {
      expect(themeState.setTheme).toHaveBeenCalledWith('dark');
    });
  });

  it('does not sync while preferences are still loading', async () => {
    personalPreferencesState.isLoading = true;
    personalPreferencesState.preferences = {
      colorTheme: 'dark' as PersonalColorTheme,
      narrationMode: false,
    };
    themeState.theme = 'system';

    render(<PersonalThemeSync />);

    await waitFor(() => {
      expect(personalPreferencesState.refetch).toHaveBeenCalled();
    });
    expect(themeState.setTheme).not.toHaveBeenCalled();
  });

  it('preserves the cached theme through an initial load failure, optimistic updates, and recovery', async () => {
    personalPreferencesState.refetch.mockResolvedValue({ isSuccess: false });
    personalPreferencesState.hasLoadedPreferences = false;
    themeState.theme = 'dark';
    window.localStorage.setItem('roomote-color-theme', 'dark');

    const { rerender, unmount } = render(<PersonalThemeSync />);

    await waitFor(() => {
      expect(personalPreferencesState.refetch).toHaveBeenCalled();
    });

    expect(themeState.setTheme).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('roomote-color-theme')).toBe('dark');

    personalPreferencesState.hasLoadedPreferences = true;
    rerender(<PersonalThemeSync />);

    expect(themeState.setTheme).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('roomote-color-theme')).toBe('dark');

    unmount();
    personalPreferencesState.refetch.mockReset();
    personalPreferencesState.refetch.mockResolvedValue({ isSuccess: true });
    personalPreferencesState.preferences = {
      colorTheme: 'light',
      narrationMode: false,
    };
    render(<PersonalThemeSync />);

    await waitFor(() => {
      expect(themeState.setTheme).toHaveBeenCalledWith('light');
    });
  });

  it('does not override browser storage when the viewer is signed out', () => {
    userState.isSignedIn = false;
    themeState.theme = 'dark';

    render(<PersonalThemeSync />);

    expect(themeState.setTheme).not.toHaveBeenCalled();
  });

  it('clears the Roomote theme cache and resets to system after sign-out', () => {
    themeState.theme = 'dark';
    window.localStorage.setItem('roomote-color-theme', 'dark');

    const { rerender } = render(<PersonalThemeSync />);

    userState.isSignedIn = false;
    rerender(<PersonalThemeSync />);

    expect(themeState.setTheme).toHaveBeenCalledWith('system');
    expect(window.localStorage.getItem('roomote-color-theme')).toBeNull();
  });

  it('backfills the Roomote theme storage key when the page theme already matches the saved preference', async () => {
    personalPreferencesState.preferences = {
      colorTheme: 'light' as PersonalColorTheme,
      narrationMode: false,
    };
    themeState.theme = 'light';
    window.localStorage.removeItem('roomote-color-theme');

    render(<PersonalThemeSync />);

    await waitFor(() => {
      expect(window.localStorage.getItem('roomote-color-theme')).toBe('light');
    });
    expect(themeState.setTheme).not.toHaveBeenCalled();
  });

  it('backfills a legitimate system preference after it has loaded', async () => {
    themeState.theme = 'system';
    window.localStorage.setItem('roomote-color-theme', 'dark');

    render(<PersonalThemeSync />);

    await waitFor(() => {
      expect(window.localStorage.getItem('roomote-color-theme')).toBe('system');
    });
    expect(themeState.setTheme).not.toHaveBeenCalled();
  });
});
