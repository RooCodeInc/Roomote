import { act, renderHook } from '@testing-library/react';

import { useWorkspaceStorage } from '../useWorkspaceStorage';

const mockUseUser = vi.fn();

vi.mock('@/hooks/useUser', () => ({
  useAuthorizedUser: () => {
    const result = mockUseUser();

    if (!result) {
      throw new Error('Missing mocked authorized user');
    }

    return result;
  },
}));

describe('useWorkspaceStorage', () => {
  beforeEach(() => {
    localStorage.clear();
    mockUseUser.mockReset();
  });

  it('stores workspace selections under the deployment key', () => {
    mockUseUser.mockReturnValue({});

    const { result } = renderHook(() => useWorkspaceStorage());

    act(() => {
      result.current.setWorkspace({
        workspace: { type: 'environment', id: 'env-1' },
      });
    });

    expect(result.current.workspace).toEqual({
      workspace: { type: 'environment', id: 'env-1' },
    });
    expect(
      JSON.parse(
        localStorage.getItem('roomote-workspace:deployment') ?? 'null',
      ),
    ).toEqual({
      workspace: { type: 'environment', id: 'env-1' },
    });
  });

  it('restores the deployment workspace selection', () => {
    localStorage.setItem(
      'roomote-workspace:deployment',
      JSON.stringify({
        workspace: { type: 'environment', id: 'env-1' },
      }),
    );

    mockUseUser.mockReturnValue({});
    const { result } = renderHook(() => useWorkspaceStorage());

    expect(result.current.workspace.workspace).toEqual({
      type: 'environment',
      id: 'env-1',
    });
  });
});
