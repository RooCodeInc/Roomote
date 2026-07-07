// pnpm test src/hooks/__tests__/useAuthState.test.ts

import { renderHook, act } from '@testing-library/react';
import { useSessionStorage } from 'usehooks-ts';
import { useSearchParams } from 'next/navigation';

import { AuthStateParam } from '@/types';

import { useMount } from '@/hooks/useMount';

import { useAuthState, useSetAuthState } from '../useAuthState';

const mockSetState = vi.fn();
const mockSetAuthRedirect = vi.fn();
const mockUseMount = vi.fn();

vi.mock('usehooks-ts', () => ({
  useSessionStorage: vi.fn(),
}));

vi.mock('@/hooks/useMount', () => ({
  useMount: vi.fn(),
}));

const mockSearchParams = new Map<string, string>();

vi.mock('next/navigation', () => ({
  useSearchParams: vi.fn(() => ({
    get: (key: string) => mockSearchParams.get(key) || null,
  })),
}));

const mockedUseSessionStorage = vi.mocked(useSessionStorage);
const mockedUseMount = vi.mocked(useMount);
const mockedUseSearchParams = vi.mocked(useSearchParams);

describe('useAuthState', () => {
  beforeEach(() => {
    mockSearchParams.clear();

    mockedUseSessionStorage.mockImplementation(
      (key: string, defaultValue: unknown) => {
        if (key === AuthStateParam.State) {
          return [defaultValue, mockSetState, vi.fn()];
        }
        if (key === AuthStateParam.AuthRedirect) {
          return [defaultValue, mockSetAuthRedirect, vi.fn()];
        }
        return [defaultValue, vi.fn(), vi.fn()];
      },
    );

    mockedUseMount.mockImplementation(mockUseMount);

    mockedUseSearchParams.mockReturnValue({
      get: (key: string) => mockSearchParams.get(key) || null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  describe('initialization', () => {
    it('should initialize with undefined values when no search params are present', () => {
      const { result } = renderHook(() => useAuthState());

      expect(result.current.state).toBeUndefined();
      expect(result.current.authRedirect).toBeUndefined();
      expect(result.current.params).toBeUndefined();
      expect(typeof result.current.set).toBe('function');
    });

    it('should initialize with values from search params', () => {
      mockSearchParams.set(AuthStateParam.State, 'test-state');
      mockSearchParams.set(AuthStateParam.AuthRedirect, 'test-redirect');

      mockedUseSessionStorage.mockImplementation(
        (key: string, defaultValue: unknown) => {
          if (key === AuthStateParam.State) {
            return ['test-state', mockSetState, vi.fn()];
          }
          if (key === AuthStateParam.AuthRedirect) {
            return ['test-redirect', mockSetAuthRedirect, vi.fn()];
          }
          return [defaultValue, vi.fn(), vi.fn()];
        },
      );

      const { result } = renderHook(() => useAuthState());

      expect(result.current.state).toBe('test-state');
      expect(result.current.authRedirect).toBe('test-redirect');
      expect(result.current.params).toBeInstanceOf(URLSearchParams);
      expect(result.current.params?.get(AuthStateParam.State)).toBe(
        'test-state',
      );
      expect(result.current.params?.get(AuthStateParam.AuthRedirect)).toBe(
        'test-redirect',
      );
    });

    it('should use EXTENSION_URI_SCHEME as default authRedirect in params when authRedirect is undefined', () => {
      mockedUseSessionStorage.mockImplementation(
        (key: string, defaultValue: unknown) => {
          if (key === AuthStateParam.State) {
            return ['test-state', mockSetState, vi.fn()];
          }
          if (key === AuthStateParam.AuthRedirect) {
            return [undefined, mockSetAuthRedirect, vi.fn()];
          }
          return [defaultValue, vi.fn(), vi.fn()];
        },
      );

      const { result } = renderHook(() => useAuthState());

      expect(result.current.state).toBe('test-state');
      expect(result.current.authRedirect).toBeUndefined();
      expect(result.current.params).toBeInstanceOf(URLSearchParams);
      expect(result.current.params?.get(AuthStateParam.State)).toBe(
        'test-state',
      );
      expect(result.current.params?.get(AuthStateParam.AuthRedirect)).toBe('/');
    });
  });

  describe('params generation', () => {
    it('should not generate params when state is undefined', () => {
      mockedUseSessionStorage.mockImplementation(
        (key: string, defaultValue: unknown) => {
          if (key === AuthStateParam.State) {
            return [undefined, mockSetState, vi.fn()];
          }
          if (key === AuthStateParam.AuthRedirect) {
            return ['test-redirect', mockSetAuthRedirect, vi.fn()];
          }
          return [defaultValue, vi.fn(), vi.fn()];
        },
      );

      const { result } = renderHook(() => useAuthState());

      expect(result.current.state).toBeUndefined();
      expect(result.current.authRedirect).toBe('test-redirect');
      expect(result.current.params).toBeUndefined();
    });

    it('should generate params when state is defined', () => {
      mockedUseSessionStorage.mockImplementation(
        (key: string, defaultValue: unknown) => {
          if (key === AuthStateParam.State) {
            return ['test-state', mockSetState, vi.fn()];
          }
          if (key === AuthStateParam.AuthRedirect) {
            return ['test-redirect', mockSetAuthRedirect, vi.fn()];
          }
          return [defaultValue, vi.fn(), vi.fn()];
        },
      );

      const { result } = renderHook(() => useAuthState());

      expect(result.current.params).toBeInstanceOf(URLSearchParams);
      expect(result.current.params?.get(AuthStateParam.State)).toBe(
        'test-state',
      );
      expect(result.current.params?.get(AuthStateParam.AuthRedirect)).toBe(
        'test-redirect',
      );
    });
  });

  describe('set function', () => {
    it('should call setState and setAuthRedirect with correct values', () => {
      const { result } = renderHook(() => useAuthState());

      const newAuthState = {
        state: 'new-state',
        authRedirect: 'new-redirect',
      };

      act(() => {
        result.current.set(newAuthState);
      });

      expect(mockSetState).toHaveBeenCalledWith('new-state');
      expect(mockSetAuthRedirect).toHaveBeenCalledWith('new-redirect');
    });

    it('should handle undefined values in set function', () => {
      const { result } = renderHook(() => useAuthState());

      const newAuthState = {
        state: undefined,
        authRedirect: undefined,
      };

      act(() => {
        result.current.set(newAuthState);
      });

      expect(mockSetState).toHaveBeenCalledWith(undefined);
      expect(mockSetAuthRedirect).toHaveBeenCalledWith(undefined);
    });
  });

  describe('return value structure', () => {
    it('should return all expected properties', () => {
      const { result } = renderHook(() => useAuthState());

      expect(result.current).toHaveProperty('state');
      expect(result.current).toHaveProperty('authRedirect');
      expect(result.current).toHaveProperty('params');
      expect(result.current).toHaveProperty('set');
      expect(typeof result.current.set).toBe('function');
    });
  });
});

describe('useSetAuthState', () => {
  beforeEach(() => {
    mockSearchParams.clear();

    mockedUseSessionStorage.mockImplementation(
      (key: string, defaultValue: unknown) => {
        if (key === AuthStateParam.State) {
          return [defaultValue, mockSetState, vi.fn()];
        }
        if (key === AuthStateParam.AuthRedirect) {
          return [defaultValue, mockSetAuthRedirect, vi.fn()];
        }
        return [defaultValue, vi.fn(), vi.fn()];
      },
    );

    mockedUseMount.mockImplementation((callback) => {
      mockUseMount.mockImplementation(callback);
    });

    mockedUseSearchParams.mockReturnValue({
      get: (key: string) => mockSearchParams.get(key) || null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  });

  it('should not call set when state is undefined', () => {
    mockedUseSessionStorage.mockImplementation(
      (key: string, defaultValue: unknown) => {
        if (key === AuthStateParam.State) {
          return [undefined, mockSetState, vi.fn()];
        }
        if (key === AuthStateParam.AuthRedirect) {
          return [undefined, mockSetAuthRedirect, vi.fn()];
        }
        return [defaultValue, vi.fn(), vi.fn()];
      },
    );

    renderHook(() => useSetAuthState());

    expect(mockedUseMount).toHaveBeenCalled();

    // Execute the mount callback
    const mountCallback = mockedUseMount.mock.calls[0]?.[0];
    expect(mountCallback).toBeDefined();
    mountCallback?.();

    expect(mockSetState).not.toHaveBeenCalled();
    expect(mockSetAuthRedirect).not.toHaveBeenCalled();
  });

  it('should call set when state is defined', () => {
    mockedUseSessionStorage.mockImplementation(
      (key: string, defaultValue: unknown) => {
        if (key === AuthStateParam.State) {
          return ['test-state', mockSetState, vi.fn()];
        }
        if (key === AuthStateParam.AuthRedirect) {
          return ['test-redirect', mockSetAuthRedirect, vi.fn()];
        }
        return [defaultValue, vi.fn(), vi.fn()];
      },
    );

    renderHook(() => useSetAuthState());

    expect(mockedUseMount).toHaveBeenCalled();

    // Execute the mount callback
    const mountCallback = mockedUseMount.mock.calls[0]?.[0];
    expect(mountCallback).toBeDefined();
    mountCallback?.();

    expect(mockSetState).toHaveBeenCalledWith('test-state');
    expect(mockSetAuthRedirect).toHaveBeenCalledWith('test-redirect');
  });

  it('should use EXTENSION_URI_SCHEME as default authRedirect when undefined', () => {
    mockedUseSessionStorage.mockImplementation(
      (key: string, defaultValue: unknown) => {
        if (key === AuthStateParam.State) {
          return ['test-state', mockSetState, vi.fn()];
        }
        if (key === AuthStateParam.AuthRedirect) {
          return [undefined, mockSetAuthRedirect, vi.fn()];
        }
        return [defaultValue, vi.fn(), vi.fn()];
      },
    );

    renderHook(() => useSetAuthState());

    expect(mockedUseMount).toHaveBeenCalled();

    const mountCallback = mockedUseMount.mock.calls[0]?.[0];
    expect(mountCallback).toBeDefined();
    mountCallback?.();

    expect(mockSetState).toHaveBeenCalledWith('test-state');
    expect(mockSetAuthRedirect).toHaveBeenCalledWith('/');
  });
});
