import { renderHook } from '@testing-library/react';

type PersonalColorTheme = 'light' | 'dark' | 'system';

const { personalPreferencesState } = vi.hoisted(() => ({
  personalPreferencesState: {
    preferences: {
      colorTheme: 'system' as PersonalColorTheme,
      mindReaderMode: false,
      narrationMode: false,
    },
    isLoading: false,
    isUpdating: false,
    setPreferences: vi.fn(),
  },
}));

vi.mock('./usePersonalPreferences', () => ({
  usePersonalPreferences: () => personalPreferencesState,
}));

import { useMindReaderMode } from './useMindReaderMode';

describe('useMindReaderMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    personalPreferencesState.preferences = {
      colorTheme: 'system' as PersonalColorTheme,
      mindReaderMode: false,
      narrationMode: false,
    };
    personalPreferencesState.isLoading = false;
    personalPreferencesState.isUpdating = false;
  });

  it('exposes the current mind-reader state from the shared preferences hook', () => {
    personalPreferencesState.preferences = {
      colorTheme: 'dark' as PersonalColorTheme,
      mindReaderMode: true,
      narrationMode: false,
    };

    const { result } = renderHook(() => useMindReaderMode());

    expect(result.current.enabled).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it('passes mind-reader updates through the shared preferences hook', () => {
    const { result } = renderHook(() => useMindReaderMode());

    result.current.setEnabled(true);

    expect(personalPreferencesState.setPreferences).toHaveBeenCalledWith({
      mindReaderMode: true,
    });
  });
});
