import { renderHook } from '@testing-library/react';

type PersonalColorTheme = 'light' | 'dark' | 'system';

const { personalPreferencesState } = vi.hoisted(() => ({
  personalPreferencesState: {
    preferences: {
      colorTheme: 'system' as PersonalColorTheme,
      narrationMode: false,
      showDebugUI: false,
    },
    isLoading: false,
    isUpdating: false,
    setPreferences: vi.fn(),
  },
}));

const setThemeMock = vi.fn();

vi.mock('next-themes', () => ({
  useTheme: () => ({
    setTheme: setThemeMock,
  }),
}));

vi.mock('./usePersonalPreferences', () => ({
  usePersonalPreferences: () => personalPreferencesState,
}));

import { useColorTheme } from './useColorTheme';

describe('useColorTheme', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    personalPreferencesState.preferences = {
      colorTheme: 'system' as PersonalColorTheme,
      narrationMode: false,
      showDebugUI: false,
    };
    personalPreferencesState.isLoading = false;
    personalPreferencesState.isUpdating = false;
  });

  it('exposes the current color theme from the shared preferences hook', () => {
    personalPreferencesState.preferences = {
      colorTheme: 'dark' as PersonalColorTheme,
      narrationMode: true,
      showDebugUI: false,
    };

    const { result } = renderHook(() => useColorTheme());

    expect(result.current.colorTheme).toBe('dark');
    expect(result.current.isLoading).toBe(false);
  });

  it('passes theme updates through the shared preferences hook', () => {
    const { result } = renderHook(() => useColorTheme());

    result.current.setColorTheme('light');

    expect(setThemeMock).toHaveBeenCalledWith('light');
    expect(personalPreferencesState.setPreferences).toHaveBeenCalledWith({
      colorTheme: 'light',
    });
  });
});
