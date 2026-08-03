import { render } from '@testing-library/react';

type PersonalColorTheme = 'light' | 'dark' | 'system';

const { personalPreferencesState, themeState, userState } = vi.hoisted(() => ({
  personalPreferencesState: {
    preferences: {
      colorTheme: 'system' as PersonalColorTheme,
      narrationMode: false,
    },
    isLoading: false,
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
    themeState.theme = 'system';
    userState.isSignedIn = true;
  });

  it('applies the saved theme after preferences have loaded', () => {
    personalPreferencesState.preferences = {
      colorTheme: 'dark' as PersonalColorTheme,
      narrationMode: false,
    };
    themeState.theme = 'system';

    render(<PersonalThemeSync />);

    expect(themeState.setTheme).toHaveBeenCalledWith('dark');
  });

  it('does not sync while preferences are still loading', () => {
    personalPreferencesState.isLoading = true;
    personalPreferencesState.preferences = {
      colorTheme: 'dark' as PersonalColorTheme,
      narrationMode: false,
    };
    themeState.theme = 'system';

    render(<PersonalThemeSync />);

    expect(themeState.setTheme).not.toHaveBeenCalled();
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

  it('backfills the Roomote theme storage key when the page theme already matches the saved preference', () => {
    personalPreferencesState.preferences = {
      colorTheme: 'light' as PersonalColorTheme,
      narrationMode: false,
    };
    themeState.theme = 'light';
    window.localStorage.removeItem('roomote-color-theme');

    render(<PersonalThemeSync />);

    expect(themeState.setTheme).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('roomote-color-theme')).toBe('light');
  });
});
