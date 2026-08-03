import { renderHook } from '@testing-library/react';

const { personalPreferencesState } = vi.hoisted(() => ({
  personalPreferencesState: {
    preferences: {
      colorTheme: 'system' as const,
      narrationMode: false,
      showCommandOutput: false,
    },
    isLoading: false,
    isUpdating: false,
    setPreferences: vi.fn(),
  },
}));

vi.mock('./usePersonalPreferences', () => ({
  usePersonalPreferences: () => personalPreferencesState,
}));

import { useShowCommandOutput } from './useShowCommandOutput';

describe('useShowCommandOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    personalPreferencesState.preferences.showCommandOutput = false;
    personalPreferencesState.isLoading = false;
    personalPreferencesState.isUpdating = false;
  });

  it('exposes command output visibility from personal preferences', () => {
    personalPreferencesState.preferences.showCommandOutput = true;

    const { result } = renderHook(() => useShowCommandOutput());

    expect(result.current.enabled).toBe(true);
  });

  it('updates command output visibility through personal preferences', () => {
    const { result } = renderHook(() => useShowCommandOutput());

    result.current.setEnabled(true);

    expect(personalPreferencesState.setPreferences).toHaveBeenCalledWith({
      showCommandOutput: true,
    });
  });
});
