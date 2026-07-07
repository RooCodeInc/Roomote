import { useCallback } from 'react';
import { useLocalStorage } from 'usehooks-ts';

const STORAGE_KEY_PREFIX = 'roomote-workspace';

export type WorkspaceSelection = {
  workspace?:
    | { type: 'repository'; value: string }
    | { type: 'environment'; id: string }
    | { type: 'auto' };
};

const DEFAULT_WORKSPACE: WorkspaceSelection = {
  workspace: { type: 'auto' },
};

/**
 * Hook to persist workspace selection (repository/environment) in localStorage.
 * Returns the stored workspace selection and a setter function.
 */
export function useWorkspaceStorage() {
  const [workspace, setStoredWorkspace] = useLocalStorage<WorkspaceSelection>(
    `${STORAGE_KEY_PREFIX}:deployment`,
    DEFAULT_WORKSPACE,
  );

  const setWorkspace = useCallback(
    (selection: Partial<WorkspaceSelection>) =>
      setStoredWorkspace((prev) => {
        const {
          harness: _legacyHarness,
          harnessPreference: _legacyHarnessPreference,
          ...cleanPrev
        } = prev as WorkspaceSelection & {
          harness?: unknown;
          harnessPreference?: unknown;
        };

        return { ...cleanPrev, ...selection };
      }),
    [setStoredWorkspace],
  );

  return { workspace, setWorkspace };
}
