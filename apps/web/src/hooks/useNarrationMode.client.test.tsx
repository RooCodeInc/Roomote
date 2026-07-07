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

vi.mock('./usePersonalPreferences', () => ({
  usePersonalPreferences: () => personalPreferencesState,
}));

import { useNarrationMode } from './useNarrationMode';

describe('useNarrationMode', () => {
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

  it('exposes the current narration-mode state from the shared preferences hook', () => {
    personalPreferencesState.preferences = {
      colorTheme: 'dark' as PersonalColorTheme,
      narrationMode: true,
      showDebugUI: false,
    };

    const { result } = renderHook(() => useNarrationMode());

    expect(result.current.enabled).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it('passes narration-mode updates through the shared preferences hook', () => {
    const { result } = renderHook(() => useNarrationMode());

    result.current.setEnabled(true);

    expect(personalPreferencesState.setPreferences).toHaveBeenCalledWith({
      narrationMode: true,
    });
  });
});
