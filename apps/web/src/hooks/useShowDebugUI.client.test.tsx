import { renderHook } from '@testing-library/react';

type PersonalColorTheme = 'light' | 'dark' | 'system';

const { personalPreferencesState, usePersonalPreferencesMock, userState } =
  vi.hoisted(() => {
    const personalPreferencesState = {
      preferences: {
        colorTheme: 'system' as PersonalColorTheme,
        narrationMode: false,
        showDebugUI: false,
      },
      isLoading: false,
      isUpdating: false,
      setPreferences: vi.fn(),
    };

    return {
      personalPreferencesState,
      usePersonalPreferencesMock: vi.fn(() => personalPreferencesState),
      userState: {
        isSignedIn: true,
        user: {
          featureFlags: {
            ShowDebugUISetting: true,
          },
        },
      },
    };
  });

vi.mock('./usePersonalPreferences', () => ({
  usePersonalPreferences: (options?: { enabled?: boolean }) =>
    (
      usePersonalPreferencesMock as (options?: {
        enabled?: boolean;
      }) => typeof personalPreferencesState
    )(options),
}));

vi.mock('./useUser', () => ({
  useUser: () =>
    userState.isSignedIn
      ? { isSignedIn: true as const, user: userState.user }
      : { isSignedIn: false as const, user: null, authStatus: 'signed-out' },
}));

import { useShowDebugUI } from './useShowDebugUI';

describe('useShowDebugUI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userState.isSignedIn = true;
    userState.user.featureFlags.ShowDebugUISetting = true;
    personalPreferencesState.preferences = {
      colorTheme: 'system' as PersonalColorTheme,
      narrationMode: false,
      showDebugUI: false,
    };
    personalPreferencesState.isLoading = false;
    personalPreferencesState.isUpdating = false;
  });

  it('gates debug UI off for signed-out users', () => {
    userState.isSignedIn = false;
    const { result } = renderHook(() => useShowDebugUI());

    expect(result.current.canUseDebugUI).toBe(false);
    expect(result.current.isDebugUIVisible).toBe(false);
    expect(usePersonalPreferencesMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('gates debug UI off when the feature flag is disabled', () => {
    userState.user.featureFlags.ShowDebugUISetting = false;

    const { result } = renderHook(() => useShowDebugUI());

    expect(result.current.canUseDebugUI).toBe(false);
    expect(result.current.isDebugUIVisible).toBe(false);
    expect(usePersonalPreferencesMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('keeps debug UI hidden when the preference is disabled', () => {
    const { result } = renderHook(() => useShowDebugUI());

    expect(result.current.canUseDebugUI).toBe(true);
    expect(result.current.isDebugUIVisible).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(usePersonalPreferencesMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it('exposes debug UI when the flag and preference are both enabled', () => {
    personalPreferencesState.preferences = {
      colorTheme: 'system' as PersonalColorTheme,
      narrationMode: false,
      showDebugUI: true,
    };

    const { result } = renderHook(() => useShowDebugUI());

    expect(result.current.canUseDebugUI).toBe(true);
    expect(result.current.isDebugUIVisible).toBe(true);
  });

  it('passes debug-ui updates through the shared preferences hook', () => {
    const { result } = renderHook(() => useShowDebugUI());

    result.current.setDebugUIVisible(true);

    expect(personalPreferencesState.setPreferences).toHaveBeenCalledWith({
      showDebugUI: true,
    });
  });
});
