import type { CommunicationProvider } from '@roomote/types';

export const ROUTER_DEBUG_NONE = '__none__';
export const ROUTER_DEBUG_ENV_FALLBACK = '__env_fallback__';

export type RouterDebugDestinationSelection =
  | CommunicationProvider
  | typeof ROUTER_DEBUG_NONE
  | typeof ROUTER_DEBUG_ENV_FALLBACK;

export function getRouterDebugDestinationSelection(settings: {
  destination: {
    provider: CommunicationProvider;
    channelId: string;
  } | null;
  disabled: boolean;
  source: 'deployment' | 'env' | 'disabled' | 'none';
}): RouterDebugDestinationSelection {
  if (settings.disabled) {
    return ROUTER_DEBUG_NONE;
  }

  if (settings.source === 'env') {
    return ROUTER_DEBUG_ENV_FALLBACK;
  }

  return settings.destination?.provider ?? ROUTER_DEBUG_NONE;
}

export function buildRouterDebugSettingsInput(
  selection: RouterDebugDestinationSelection,
  channelId: string,
): {
  provider: CommunicationProvider | null;
  channelId: string | null;
  disabled: boolean;
} {
  if (
    selection === ROUTER_DEBUG_NONE ||
    selection === ROUTER_DEBUG_ENV_FALLBACK
  ) {
    return {
      provider: null,
      channelId: null,
      disabled: selection === ROUTER_DEBUG_NONE,
    };
  }

  return {
    provider: selection,
    channelId,
    disabled: false,
  };
}
