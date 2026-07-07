'use client';

import { useUser } from '../useUser';

/**
 * Hook for managing LLM-enhanced features setting.
 * - Default: true (opt-out model).
 */
export function useLLMEnhancedFeatures() {
  void useUser();

  return {
    enabled: true,
    setEnabled: () => {},
    isLoading: false,
    isUpdating: false,
    isPersonalUser: false,
    canUpdate: false,
  };
}
